/// faraday-helper — lightweight elevated filesystem helper (Zig implementation).
///
/// Speaks a length-prefixed binary protocol over a Unix domain socket (macOS/Linux)
/// or a named pipe (Windows).
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const proto = @import("proto.zig");
const ops = @import("ops.zig");
const watch = @import("watch.zig");

const Allocator = std.mem.Allocator;

// ── Argument parsing ─────────────────────────────────────────────────

const Args = struct {
    socket_path: []const u8,
    token: []const u8,
};

fn parseArgs() !Args {
    var socket_path: ?[]const u8 = null;
    var token: ?[]const u8 = null;

    var args = std.process.args();
    _ = args.next(); // skip argv[0]
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--socket")) {
            socket_path = args.next();
        } else if (std.mem.eql(u8, arg, "--token")) {
            token = args.next();
        }
    }

    return .{
        .socket_path = socket_path orelse return error.MissingSocketArg,
        .token = token orelse return error.MissingTokenArg,
    };
}

// ── Connection ───────────────────────────────────────────────────────

fn connectUnix(path: []const u8) !posix.fd_t {
    const addr = try std.net.Address.initUnix(path);
    const sock = try posix.socket(posix.AF.UNIX, posix.SOCK.STREAM, 0);
    errdefer posix.close(sock);
    try posix.connect(sock, &addr.any, addr.getOsSockLen());
    return sock;
}

// ── Protocol helpers ─────────────────────────────────────────────────

fn sendAuth(allocator: Allocator, fd: posix.fd_t, token: []const u8) !void {
    var w = proto.Writer.init(allocator);
    defer w.deinit();
    try w.u8_(@intFromEnum(proto.MsgType.auth));
    try w.raw(token);
    try proto.writeMsg(fd, w.slice());
}

fn sendResponse(allocator: Allocator, fd: posix.fd_t, id: u32, payload: []const u8) !void {
    var w = proto.Writer.init(allocator);
    defer w.deinit();
    try w.u8_(@intFromEnum(proto.MsgType.response));
    try w.u32_(id);
    try w.raw(payload);
    try proto.writeMsg(fd, w.slice());
}

fn sendError(allocator: Allocator, fd: posix.fd_t, id: u32, code: []const u8, message: []const u8) !void {
    var w = proto.Writer.init(allocator);
    defer w.deinit();
    try w.u8_(@intFromEnum(proto.MsgType.err));
    try w.u32_(id);
    try w.str_(code);
    try w.str_(message);
    try proto.writeMsg(fd, w.slice());
}

fn sendEvent(allocator: Allocator, fd: posix.fd_t, watch_id: []const u8, kind: proto.EventType, name: ?[]const u8) !void {
    var w = proto.Writer.init(allocator);
    defer w.deinit();
    try w.u8_(@intFromEnum(proto.MsgType.event));
    try w.str_(watch_id);
    try w.u8_(@intFromEnum(kind));
    if (name) |n| {
        try w.u8_(1);
        try w.str_(n);
    } else {
        try w.u8_(0);
    }
    try proto.writeMsg(fd, w.slice());
}

// ── Request dispatch ─────────────────────────────────────────────────

fn dispatch(
    method: proto.Method,
    reader: *proto.Reader,
    out: *proto.Writer,
    watcher: *watch.Watcher,
    fdt: *ops.FdTable,
    allocator: Allocator,
) !void {
    switch (method) {
        .ping => {},
        .entries => try ops.entries(try reader.str(), out),
        .stat => try ops.stat(try reader.str(), out),
        .exists => try ops.exists(try reader.str(), out),
        .read_file => try ops.readFile(try reader.str(), out, allocator),
        .open => try ops.open(try reader.str(), out, fdt),
        .read => {
            const fd_id = try reader.str();
            const offset: i64 = @intFromFloat(try reader.f64_());
            const length: usize = @intFromFloat(try reader.f64_());
            try ops.read(fd_id, offset, length, out, fdt, allocator);
        },
        .close => ops.close(try reader.str(), fdt),
        .watch => {
            const wid = try reader.str();
            const path = try reader.str();
            try out.u8_(if (watcher.addWatch(wid, path)) 1 else 0);
        },
        .unwatch => watcher.removeWatch(try reader.str()),
        _ => return error.NotImplemented,
    }
}

fn handleRequest(
    allocator: Allocator,
    fd: posix.fd_t,
    payload: []const u8,
    watcher: *watch.Watcher,
    fdt: *ops.FdTable,
) void {
    var reader = proto.Reader{ .data = payload };
    const id = reader.u32_() catch return;
    const method_byte = reader.u8_() catch return;
    const method: proto.Method = @enumFromInt(method_byte);

    var out = proto.Writer.init(allocator);
    defer out.deinit();

    dispatch(method, &reader, &out, watcher, fdt, allocator) catch |err| {
        sendError(allocator, fd, id, ops.errorCode(err), @errorName(err)) catch {};
        return;
    };
    sendResponse(allocator, fd, id, out.slice()) catch {};
}

// ── Watch event callback (needs socket fd via closure workaround) ────

var g_sock_fd: posix.fd_t = -1;
var g_allocator: Allocator = undefined;

fn onWatchEvent(watch_id: []const u8, kind_str: []const u8, name: ?[]const u8) void {
    const kind: proto.EventType = if (std.mem.eql(u8, kind_str, "appeared"))
        .appeared
    else if (std.mem.eql(u8, kind_str, "disappeared"))
        .disappeared
    else if (std.mem.eql(u8, kind_str, "modified"))
        .modified
    else if (std.mem.eql(u8, kind_str, "errored"))
        .errored
    else
        .unknown;
    sendEvent(g_allocator, g_sock_fd, watch_id, kind, name) catch {};
}

// ── Main loop ────────────────────────────────────────────────────────

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = parseArgs() catch {
        std.debug.print("Usage: faraday-helper --socket <path> --token <hex>\n", .{});
        std.process.exit(1);
    };

    // Parent death detection (Linux)
    if (comptime builtin.os.tag == .linux) {
        const linux = std.os.linux;
        _ = linux.prctl(@intFromEnum(linux.PR.SET_PDEATHSIG), @as(usize, linux.SIG.HUP), 0, 0, 0);
        if (linux.getppid() == 1) std.process.exit(1);
    }

    // Signal handling (Unix)
    if (comptime builtin.os.tag != .windows) {
        const handler = posix.Sigaction{
            .handler = .{ .handler = struct {
                fn h(_: c_int) callconv(.c) void {
                    // will cause poll/read to fail with EINTR
                }
            }.h },
            .mask = std.mem.zeroes(posix.sigset_t),
            .flags = 0,
        };
        posix.sigaction(posix.SIG.HUP, &handler, null);
        posix.sigaction(posix.SIG.TERM, &handler, null);
    }

    const fd = try connectUnix(args.socket_path);
    defer posix.close(fd);
    g_sock_fd = fd;
    g_allocator = allocator;

    try sendAuth(allocator, fd, args.token);

    var watcher = try watch.Watcher.init(allocator);
    defer watcher.deinit();

    // Parent monitoring (macOS: via kqueue)
    if (comptime builtin.os.tag == .macos) {
        watcher.watchParent(posix.system.getppid());
    }

    var fdt = ops.FdTable.init(allocator);
    defer fdt.deinit();

    var msg_reader = proto.MsgReader.init(allocator);
    defer msg_reader.deinit();

    const watch_fd = watcher.pollFd();
    const nfds: usize = if (watch_fd >= 0) 2 else 1;

    while (true) {
        var pfds = [2]posix.pollfd{
            .{ .fd = fd, .events = posix.POLL.IN, .revents = 0 },
            .{ .fd = watch_fd, .events = posix.POLL.IN, .revents = 0 },
        };

        _ = posix.poll(pfds[0..nfds], -1) catch break;

        if (pfds[0].revents & posix.POLL.IN != 0) {
            const n = msg_reader.fill(fd) catch break;
            if (n == 0) break; // EOF — parent closed socket

            while (try msg_reader.nextMsg(allocator)) |msg| {
                defer allocator.free(msg);
                if (msg.len > 0 and msg[0] == @intFromEnum(proto.MsgType.request)) {
                    handleRequest(allocator, fd, msg[1..], &watcher, &fdt);
                }
            }
        }

        if (pfds[0].revents & (posix.POLL.HUP | posix.POLL.ERR) != 0)
            break;

        if (nfds > 1 and pfds[1].revents & posix.POLL.IN != 0) {
            watcher.process(onWatchEvent);
            if (watcher.parentDied()) break;
        }
    }
}
