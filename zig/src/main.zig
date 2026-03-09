/// frdye — lightweight elevated filesystem helper (Zig implementation).
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

fn parseArgs(allocator: Allocator) !Args {
    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();

    var socket_path: ?[]const u8 = null;
    var token: ?[]const u8 = null;

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

fn connect(path: []const u8) !proto.File {
    if (comptime builtin.os.tag == .windows) {
        return connectNamedPipe(path);
    } else {
        return connectUnix(path);
    }
}

fn connectUnix(path: []const u8) !proto.File {
    const addr = try std.net.Address.initUnix(path);
    const sock = try posix.socket(posix.AF.UNIX, posix.SOCK.STREAM, 0);
    errdefer posix.close(sock);
    try posix.connect(sock, &addr.any, addr.getOsSockLen());
    return .{ .handle = sock };
}

fn connectNamedPipe(path: []const u8) !proto.File {
    const w = std.os.windows;
    // Convert UTF-8 pipe path to wide string for CreateFileW
    var w_buf: [260]u16 = undefined;
    const w_len = try std.unicode.utf8ToUtf16Le(&w_buf, path);
    w_buf[w_len] = 0;
    const w_path: [*:0]const u16 = @ptrCast(w_buf[0..w_len :0]);
    const handle = w.kernel32.CreateFileW(
        w_path,
        w.GENERIC_READ | w.GENERIC_WRITE,
        0,
        null,
        w.OPEN_EXISTING,
        w.FILE_FLAG_OVERLAPPED,
        null,
    );
    if (handle == w.INVALID_HANDLE_VALUE) {
        return error.ConnectionRefused;
    }
    return .{ .handle = handle };
}

// ── Protocol helpers ─────────────────────────────────────────────────

fn sendAuth(allocator: Allocator, file: proto.File, token: []const u8) !void {
    var w = proto.Writer.init(allocator);
    defer w.deinit();
    try w.u8_(@intFromEnum(proto.MsgType.auth));
    try w.raw(token);
    try proto.writeMsg(file, w.slice());
}

fn sendResponse(allocator: Allocator, file: proto.File, id: u32, payload: []const u8) !void {
    var w = proto.Writer.init(allocator);
    defer w.deinit();
    try w.u8_(@intFromEnum(proto.MsgType.response));
    try w.u32_(id);
    try w.raw(payload);
    try proto.writeMsg(file, w.slice());
}

fn sendError(allocator: Allocator, file: proto.File, id: u32, code: []const u8, message: []const u8) !void {
    var w = proto.Writer.init(allocator);
    defer w.deinit();
    try w.u8_(@intFromEnum(proto.MsgType.err));
    try w.u32_(id);
    try w.str_(code);
    try w.str_(message);
    try proto.writeMsg(file, w.slice());
}

fn sendEvent(allocator: Allocator, file: proto.File, watch_id: []const u8, kind: proto.EventType, name: ?[]const u8) !void {
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
    try proto.writeMsg(file, w.slice());
}

// ── Request dispatch ─────────────────────────────────────────────────

/// Encode an entry kind string as a compact u8 for the wire protocol.
/// Must stay in sync with KIND_MAP in fsProxy.ts.
/// 0=unknown 1=file 2=directory 3=symlink 4=block_device
/// 5=char_device 6=named_pipe 7=socket 8=whiteout
fn kindCode(kind: []const u8) u8 {
    if (std.mem.eql(u8, kind, "file")) return 1;
    if (std.mem.eql(u8, kind, "directory")) return 2;
    if (std.mem.eql(u8, kind, "symlink")) return 3;
    if (std.mem.eql(u8, kind, "block_device")) return 4;
    if (std.mem.eql(u8, kind, "char_device")) return 5;
    if (std.mem.eql(u8, kind, "named_pipe")) return 6;
    if (std.mem.eql(u8, kind, "socket")) return 7;
    if (std.mem.eql(u8, kind, "whiteout")) return 8;
    return 0;
}

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
        .entries => {
            var arena = std.heap.ArenaAllocator.init(allocator);
            defer arena.deinit();
            const list = try ops.entries(try reader.str(), arena.allocator());
            try out.u32_(@intCast(list.items.len));
            for (list.items) |item| {
                try out.str_(item.name);
                try out.u8_(kindCode(item.kind));
                try out.f64_(item.size);
                try out.f64_(item.mtimeMs);
                try out.u32_(item.mode);
                try out.u32_(item.nlink);
                try out.u8_(if (item.hidden) 1 else 0);
                if (item.linkTarget) |t| {
                    try out.u8_(1);
                    try out.str_(t);
                } else {
                    try out.u8_(0);
                }
            }
        },
        .stat => {
            const result = try ops.stat(try reader.str());
            try out.f64_(result.size);
            try out.f64_(result.mtimeMs);
        },
        .exists => {
            try out.u8_(if (ops.exists(try reader.str())) 1 else 0);
        },
        .open => {
            const handle = try ops.open(try reader.str(), fdt);
            try out.f64_(@floatFromInt(ops.handleToI32(handle)));
        },
        .read => {
            const fd: i32 = @intFromFloat(try reader.f64_());
            const offset: i64 = @intFromFloat(try reader.f64_());
            const length: usize = @intFromFloat(try reader.f64_());
            const data = try ops.read(ops.i32ToHandle(fd), offset, length, fdt, allocator);
            defer allocator.free(data);
            try out.bytes(data);
        },
        .close => ops.close(ops.i32ToHandle(@intFromFloat(try reader.f64_())), fdt),
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
    file: proto.File,
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
        sendError(allocator, file, id, ops.errorCode(err), @errorName(err)) catch {};
        return;
    };
    sendResponse(allocator, file, id, out.slice()) catch {};
}

// ── Watch event callback (needs socket file via closure workaround) ──

var g_sock: proto.File = .{ .handle = if (builtin.os.tag == .windows) std.os.windows.INVALID_HANDLE_VALUE else -1 };
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
    sendEvent(g_allocator, g_sock, watch_id, kind, name) catch {};
}

// ── Main loop ────────────────────────────────────────────────────────

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = parseArgs(allocator) catch {
        std.debug.print("Usage: frdye --socket <path> --token <hex>\n", .{});
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
            .handler = .{
                .handler = struct {
                    fn h(_: c_int) callconv(.c) void {
                        // will cause poll/read to fail with EINTR
                    }
                }.h,
            },
            .mask = std.mem.zeroes(posix.sigset_t),
            .flags = 0,
        };
        posix.sigaction(posix.SIG.HUP, &handler, null);
        posix.sigaction(posix.SIG.TERM, &handler, null);
    }

    const sock = try connect(args.socket_path);
    defer sock.close();
    g_sock = sock;
    g_allocator = allocator;

    try sendAuth(allocator, sock, args.token);

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

    if (comptime builtin.os.tag == .windows) {
        const w = std.os.windows;

        // Create auto-reset event for overlapped pipe reads
        const pipe_event = try w.CreateEventExW(null, null, 0, w.EVENT_ALL_ACCESS);
        defer w.CloseHandle(pipe_event);

        var pipe_overlapped = std.mem.zeroes(w.OVERLAPPED);
        pipe_overlapped.hEvent = pipe_event;
        var pipe_buf: [4096]u8 = undefined;
        var pipe_read_pending = false;

        while (true) {
            // Issue overlapped ReadFile if not already pending
            if (!pipe_read_pending) {
                pipe_overlapped = std.mem.zeroes(w.OVERLAPPED);
                pipe_overlapped.hEvent = pipe_event;
                if (w.kernel32.ReadFile(sock.handle, &pipe_buf, pipe_buf.len, null, &pipe_overlapped) != 0) {
                    // Completed synchronously — process immediately
                    const bytes = w.GetOverlappedResult(sock.handle, &pipe_overlapped, false) catch break;
                    if (bytes == 0) break;
                    try msg_reader.feed(pipe_buf[0..bytes]);
                    while (try msg_reader.nextMsg(allocator)) |msg| {
                        defer allocator.free(msg);
                        if (msg.len > 0 and msg[0] == @intFromEnum(proto.MsgType.request))
                            handleRequest(allocator, sock, msg[1..], &watcher, &fdt);
                    }
                    continue; // try issuing next read immediately
                }
                if (w.GetLastError() != .IO_PENDING) break; // real error
                pipe_read_pending = true;
            }

            // Collect handles: [pipe_event, ...watcher_events]
            var handles: [w.MAXIMUM_WAIT_OBJECTS]w.HANDLE = undefined;
            handles[0] = pipe_event;
            const n_watch = watcher.fillEventHandles(handles[1..]);
            const n_handles: u32 = @intCast(1 + n_watch);

            const result = w.kernel32.WaitForMultipleObjectsEx(n_handles, &handles, 0, w.INFINITE, 0);
            if (result == w.WAIT_FAILED) break;

            const idx = result -% w.WAIT_OBJECT_0;
            if (idx == 0) {
                // Pipe data ready
                pipe_read_pending = false;
                const bytes = w.GetOverlappedResult(sock.handle, &pipe_overlapped, false) catch break;
                if (bytes == 0) break; // EOF
                try msg_reader.feed(pipe_buf[0..bytes]);
                while (try msg_reader.nextMsg(allocator)) |msg| {
                    defer allocator.free(msg);
                    if (msg.len > 0 and msg[0] == @intFromEnum(proto.MsgType.request))
                        handleRequest(allocator, sock, msg[1..], &watcher, &fdt);
                }
            } else if (idx > 0 and idx <= n_watch) {
                // Directory watch event
                watcher.processEventAt(idx - 1, onWatchEvent);
            } else {
                break; // unexpected result
            }
        }
    } else {
        // Unix: poll on socket + optional watch fd
        const watch_fd = watcher.pollFd();
        const nfds: usize = if (watch_fd != null) 2 else 1;

        while (true) {
            var pfds = [2]posix.pollfd{
                .{ .fd = sock.handle, .events = posix.POLL.IN, .revents = 0 },
                .{ .fd = watch_fd orelse sock.handle, .events = posix.POLL.IN, .revents = 0 },
            };

            _ = posix.poll(pfds[0..nfds], -1) catch break;

            if (pfds[0].revents & posix.POLL.IN != 0) {
                const n = msg_reader.fill(sock) catch break;
                if (n == 0) break; // EOF — parent closed socket

                while (try msg_reader.nextMsg(allocator)) |msg| {
                    defer allocator.free(msg);
                    if (msg.len > 0 and msg[0] == @intFromEnum(proto.MsgType.request)) {
                        handleRequest(allocator, sock, msg[1..], &watcher, &fdt);
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
}
