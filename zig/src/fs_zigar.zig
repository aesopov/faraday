/// Filesystem API exposed to Node.js via zigar.
///
/// Watch events use a polling model: call pollWatchEvents() periodically
/// (e.g. every 50ms) to retrieve accumulated events from the watch thread.
///
/// On macOS, kqueue detects directory structural changes (create/delete/rename)
/// but not file content modifications. For content changes the TypeScript
/// layer can supplement with periodic stat polling.
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const ops = @import("ops.zig");
const watch_mod = @import("watch.zig");

const alloc = std.heap.c_allocator;

// ── Directory listing ──────────────────────────────────────────────

var entries_arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);

pub fn entries(dir_path: []const u8) ![]const ops.EntryInfo {
    _ = entries_arena.reset(.free_all);
    const list = try ops.entries(dir_path, entries_arena.allocator());
    return list.items;
}

// ── Stat / exists ──────────────────────────────────────────────────

pub fn stat(file_path: []const u8) !ops.StatResult {
    return ops.stat(file_path);
}

pub fn exists(file_path: []const u8) bool {
    return ops.exists(file_path);
}

// ── File I/O ───────────────────────────────────────────────────────

var g_fdt: ops.FdTable = undefined;
var g_fdt_init = false;
var g_fdt_mu: std.Thread.Mutex = .{};

fn getFdt() *ops.FdTable {
    g_fdt_mu.lock();
    defer g_fdt_mu.unlock();
    if (!g_fdt_init) {
        g_fdt = ops.FdTable.init(alloc);
        g_fdt_init = true;
    }
    return &g_fdt;
}

pub fn open(file_path: []const u8) ![]const u8 {
    return ops.open(file_path, getFdt());
}

/// Returns a mutable slice allocated with c_allocator.
/// Zigar creates an external ArrayBuffer backed by this memory and
/// frees it when the JS wrapper is garbage-collected.
pub fn read(fd_id: []const u8, offset: i64, length: usize) ![]u8 {
    return ops.read(fd_id, offset, length, getFdt(), alloc);
}

pub fn close(fd_id: []const u8) void {
    ops.close(fd_id, getFdt());
}

// ── Watch ──────────────────────────────────────────────────────────

pub const WatchEvent = struct {
    watch_id: []const u8,
    kind: []const u8,
    name: ?[]const u8,
};

const MAX_EVENTS = 256;
const Slot = struct {
    wid: [128]u8 = undefined,
    wid_len: u8 = 0,
    kind: [16]u8 = undefined,
    kind_len: u8 = 0,
    name: [512]u8 = undefined,
    name_len: u16 = 0,
    has_name: bool = false,
};

var ev_queue: [MAX_EVENTS]Slot = undefined;
var ev_count: usize = 0;
var ev_mu: std.Thread.Mutex = .{};

fn pushEvent(watch_id: []const u8, kind: []const u8, name: ?[]const u8) void {
    ev_mu.lock();
    defer ev_mu.unlock();
    if (ev_count >= MAX_EVENTS) {
        std.mem.copyForwards(Slot, ev_queue[0 .. MAX_EVENTS - 1], ev_queue[1..MAX_EVENTS]);
        ev_count = MAX_EVENTS - 1;
    }
    const s = &ev_queue[ev_count];
    ev_count += 1;
    const wl = @min(watch_id.len, s.wid.len);
    @memcpy(s.wid[0..wl], watch_id[0..wl]);
    s.wid_len = @intCast(wl);
    const kl = @min(kind.len, s.kind.len);
    @memcpy(s.kind[0..kl], kind[0..kl]);
    s.kind_len = @intCast(kl);
    if (name) |n| {
        const nl = @min(n.len, s.name.len);
        @memcpy(s.name[0..nl], n[0..nl]);
        s.name_len = @intCast(nl);
        s.has_name = true;
    } else {
        s.name_len = 0;
        s.has_name = false;
    }
}

var poll_arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);

/// Drain all pending watch events. The returned slice is valid until the
/// next call to pollWatchEvents().
pub fn pollWatchEvents() []const WatchEvent {
    _ = poll_arena.reset(.free_all);
    const a = poll_arena.allocator();

    ev_mu.lock();
    const n = ev_count;
    ev_count = 0;
    const snapshot = a.dupe(Slot, ev_queue[0..n]) catch {
        ev_mu.unlock();
        return &.{};
    };
    ev_mu.unlock();

    const result = a.alloc(WatchEvent, n) catch return &.{};
    for (snapshot, 0..) |s, i| {
        result[i] = .{
            .watch_id = a.dupe(u8, s.wid[0..s.wid_len]) catch "",
            .kind = a.dupe(u8, s.kind[0..s.kind_len]) catch "",
            .name = if (s.has_name) a.dupe(u8, s.name[0..s.name_len]) catch null else null,
        };
    }
    return result;
}

var g_watcher: ?watch_mod.Watcher = null;
var g_watch_thread: ?std.Thread = null;
var g_watch_mu: std.Thread.Mutex = .{};
var g_watch_stop = std.atomic.Value(bool).init(false);

pub fn watch(watch_id: []const u8, dir_path: []const u8) !bool {
    std.fs.accessAbsolute(dir_path, .{}) catch |err| return err;

    g_watch_mu.lock();
    defer g_watch_mu.unlock();

    if (g_watcher == null) {
        g_watcher = try watch_mod.Watcher.init(alloc);
    }
    _ = g_watcher.?.addWatch(watch_id, dir_path);

    if (g_watch_thread == null) {
        g_watch_stop.store(false, .release);
        g_watch_thread = try std.Thread.spawn(.{}, watchThread, .{});
    }
    return true;
}

pub fn unwatch(watch_id: []const u8) void {
    g_watch_mu.lock();
    defer g_watch_mu.unlock();
    if (g_watcher) |*w| w.removeWatch(watch_id);
}

fn watchThread() void {
    while (!g_watch_stop.load(.acquire)) {
        if (comptime builtin.os.tag == .windows)
            watchPollWindows()
        else
            watchPollUnix();
    }
}

fn watchPollUnix() void {
    const fd = blk: {
        g_watch_mu.lock();
        defer g_watch_mu.unlock();
        const w = &(g_watcher orelse return);
        break :blk w.pollFd() orelse return;
    };

    var pfds = [1]posix.pollfd{.{ .fd = fd, .events = posix.POLL.IN, .revents = 0 }};
    _ = posix.poll(&pfds, 200) catch return;

    if (pfds[0].revents & posix.POLL.IN != 0) {
        g_watch_mu.lock();
        defer g_watch_mu.unlock();
        if (g_watcher) |*w| w.process(pushEvent);
    }
}

fn watchPollWindows() void {
    if (comptime builtin.os.tag != .windows) return;
    const w = std.os.windows;
    var handles: [64]w.HANDLE = undefined;
    const n = blk: {
        g_watch_mu.lock();
        defer g_watch_mu.unlock();
        const watcher = &(g_watcher orelse return);
        break :blk watcher.fillEventHandles(&handles);
    };
    if (n == 0) {
        std.Thread.sleep(200_000_000);
        return;
    }
    const result = w.kernel32.WaitForMultipleObjectsEx(@intCast(n), &handles, 0, 200, 0);
    const idx = result -% w.WAIT_OBJECT_0;
    if (idx < n) {
        g_watch_mu.lock();
        defer g_watch_mu.unlock();
        if (g_watcher) |*watcher| watcher.processEventAt(idx, pushEvent);
    }
}
