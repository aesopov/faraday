/// Filesystem API exposed to Node.js via zigar.
///
/// Watch events use a push model: call setWatchCallback() with a JS function
/// that receives (watch_id, kind, name) on each filesystem event. Zigar
/// wraps the callback as a napi_threadsafe_function for cross-thread safety.
///
/// On macOS, FSEventsWatcher is used for file-level modification detection.
/// On Linux, inotify is used. On Windows, ReadDirectoryChangesW.
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const ops = @import("ops.zig");
const watch_mod = @import("watch.zig");
const fsevents = if (builtin.os.tag == .macos) @import("fsevents.zig") else struct {};
const zigar = @import("zigar");

pub fn startup() !void {
    try zigar.thread.use();
}

pub fn shutdown() void {
    zigar.thread.end();
}

// ── Directory listing ──────────────────────────────────────────────

pub fn entries(dir_path: []const u8, allocator: std.mem.Allocator) ![]const ops.EntryInfo {
    const list = try ops.entries(dir_path, allocator);
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
        g_fdt = ops.FdTable.init(std.heap.c_allocator);
        g_fdt_init = true;
    }
    return &g_fdt;
}

pub fn open(file_path: []const u8) !i32 {
    return ops.handleToI32(try ops.open(file_path, getFdt()));
}

pub fn read(fd: i32, offset: i64, length: usize, allocator: std.mem.Allocator) ![]u8 {
    return ops.read(ops.i32ToHandle(fd), offset, length, getFdt(), allocator);
}

pub fn close(fd: i32) void {
    ops.close(ops.i32ToHandle(fd), getFdt());
}

// ── Watch ──────────────────────────────────────────────────────────

/// JS callback type — zigar auto-wraps JS functions into this signature
/// and handles cross-thread dispatch via napi_threadsafe_function.
pub const WatchCallback = *const fn (watch_id: []const u8, kind: []const u8, name: ?[]const u8) void;

var g_watch_callback: ?WatchCallback = null;

// macOS: FSEventsWatcher detects file modifications via FSEvents + GCD.
// Events are buffered and drained by the watchThread (std.Thread.spawn'd,
// which zigar can safely use for cross-thread JS callbacks).
// Linux/Windows: kqueue/inotify watcher with a polling thread.
var g_fsevents_watcher: if (builtin.os.tag == .macos) ?fsevents.FSEventsWatcher else void =
    if (builtin.os.tag == .macos) null else {};
var g_watcher: ?watch_mod.Watcher = null;
var g_watch_thread: ?std.Thread = null;
var g_watch_mu: std.Thread.Mutex = .{};
var g_watch_stop = std.atomic.Value(bool).init(false);

/// Called from the watch thread — zigar marshals this to the JS main thread.
fn onWatchEvent(watch_id: []const u8, kind: []const u8, name: ?[]const u8) void {
    if (g_watch_callback) |cb| cb(watch_id, kind, name);
}

pub fn setWatchCallback(cb: ?WatchCallback) void {
    // Release the old Zig-to-JS bridge to free memory and allow GC of the JS function.
    if (g_watch_callback) |old| zigar.function.release(old);
    g_watch_callback = cb;
}

pub fn watch(watch_id: []const u8, dir_path: []const u8) !bool {
    std.fs.accessAbsolute(dir_path, .{}) catch |err| return err;

    if (comptime builtin.os.tag == .macos) {
        g_watch_mu.lock();
        defer g_watch_mu.unlock();

        if (g_fsevents_watcher == null) {
            g_fsevents_watcher = try fsevents.FSEventsWatcher.init(std.heap.c_allocator);
        }
        _ = g_fsevents_watcher.?.addWatch(watch_id, dir_path);

        if (g_watch_thread == null) {
            g_watch_stop.store(false, .release);
            g_watch_thread = try std.Thread.spawn(.{}, watchThread, .{});
        }
        return true;
    }

    g_watch_mu.lock();
    defer g_watch_mu.unlock();

    if (g_watcher == null) {
        g_watcher = try watch_mod.Watcher.init(std.heap.c_allocator);
    }
    _ = g_watcher.?.addWatch(watch_id, dir_path);

    if (g_watch_thread == null) {
        g_watch_stop.store(false, .release);
        g_watch_thread = try std.Thread.spawn(.{}, watchThread, .{});
    }
    return true;
}

pub fn unwatch(watch_id: []const u8) void {
    if (comptime builtin.os.tag == .macos) {
        if (g_fsevents_watcher) |*w| w.removeWatch(watch_id);
        return;
    }
    g_watch_mu.lock();
    defer g_watch_mu.unlock();
    if (g_watcher) |*w| w.removeWatch(watch_id);
}

fn watchThread() void {
    while (!g_watch_stop.load(.acquire)) {
        if (comptime builtin.os.tag == .macos)
            watchPollMacOS()
        else if (comptime builtin.os.tag == .windows)
            watchPollWindows()
        else
            watchPollUnix();
    }
}

fn watchPollMacOS() void {
    // FSEvents fires callbacks on a GCD thread which buffers events.
    // We drain them here on a std.Thread.spawn'd thread so zigar can
    // safely dispatch to the JS main thread.
    std.Thread.sleep(100_000_000); // 100ms
    if (comptime builtin.os.tag == .macos) {
        if (g_fsevents_watcher) |*w| w.drainEvents(onWatchEvent);
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
        if (g_watcher) |*w| w.process(onWatchEvent);
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
        if (g_watcher) |*watcher| watcher.processEventAt(idx, onWatchEvent);
    }
}
