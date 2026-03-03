/// N-API addon — exposes Zig filesystem operations to Node.js via napigen.
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const napigen = @import("napigen");
const ops = @import("ops.zig");
const watch_mod = @import("watch.zig");
const fsevents_mod = if (builtin.os.tag == .macos) @import("fsevents.zig") else struct {};

const Allocator = std.mem.Allocator;

// Use FSEvents on macOS for comprehensive file monitoring;
// kqueue only fires for directory structural changes, not file modifications.
const WatcherImpl = if (builtin.os.tag == .macos) fsevents_mod.FSEventsWatcher else watch_mod.Watcher;

var g_fdt: ops.FdTable = undefined;
var g_fdt_inited = false;

fn getFdt() *ops.FdTable {
    if (!g_fdt_inited) {
        g_fdt = ops.FdTable.init(napigen.allocator);
        g_fdt_inited = true;
    }
    return &g_fdt;
}

/// Throw a JS Error with both .code (e.g. "EACCES") and .message (e.g. "AccessDenied").
fn throwWithCode(js: *napigen.JsContext, err: anyerror) !napigen.napi_value {
    const code = ops.errorCode(err);
    const name = @errorName(err);
    var cv: napigen.napi_value = undefined;
    _ = napigen.napi.napi_create_string_utf8(js.env, code.ptr, code.len, &cv);
    var mv: napigen.napi_value = undefined;
    _ = napigen.napi.napi_create_string_utf8(js.env, name.ptr, name.len, &mv);
    var ev: napigen.napi_value = undefined;
    _ = napigen.napi.napi_create_error(js.env, cv, mv, &ev);
    _ = napigen.napi.napi_throw(js.env, ev);
    return try js.undefined();
}

// ── FS operations ────────────────────────────────────────────────────

fn napiEntries(js: *napigen.JsContext, dir_path: []const u8) !napigen.napi_value {
    var arena = std.heap.ArenaAllocator.init(napigen.allocator);
    defer arena.deinit();
    const list = ops.entries(dir_path, arena.allocator()) catch |err| return throwWithCode(js, err);
    return try js.createArrayFrom(list.items);
}

fn napiStat(js: *napigen.JsContext, file_path: []const u8) !napigen.napi_value {
    const result = ops.stat(file_path) catch |err| return throwWithCode(js, err);
    return try js.write(result);
}

fn napiExists(_: *napigen.JsContext, file_path: []const u8) !bool {
    return ops.exists(file_path);
}

fn napiOpen(js: *napigen.JsContext, file_path: []const u8) !napigen.napi_value {
    const id = ops.open(file_path, getFdt()) catch |err| return throwWithCode(js, err);
    return try js.createString(id);
}

fn napiRead(js: *napigen.JsContext, fd_id: []const u8, offset: f64, length: f64) !napigen.napi_value {
    const data = ops.read(fd_id, @intFromFloat(offset), @intFromFloat(length), getFdt(), napigen.allocator) catch |err| return throwWithCode(js, err);
    defer napigen.allocator.free(data);
    var result: napigen.napi_value = undefined;
    try napigen.check(napigen.napi.napi_create_buffer_copy(js.env, data.len, data.ptr, null, &result));
    return result;
}

fn napiClose(_: *napigen.JsContext, fd_id: []const u8) !void {
    ops.close(fd_id, getFdt());
}

// ── Watch support ────────────────────────────────────────────────────

var g_watcher: ?WatcherImpl = null;
var g_watch_thread: ?std.Thread = null; // only used on non-macOS
var g_watch_mutex: std.Thread.Mutex = .{};
var g_watch_stop: std.atomic.Value(bool) = std.atomic.Value(bool).init(false);
var g_tsfn: napigen.napi.napi_threadsafe_function = null;

const WatchEvent = struct {
    watch_id: []u8,
    kind: []u8,
    name: ?[]u8,

    fn create(alloc: Allocator, watch_id: []const u8, kind: []const u8, name: ?[]const u8) !*WatchEvent {
        const self = try alloc.create(WatchEvent);
        errdefer alloc.destroy(self);
        self.* = .{
            .watch_id = try alloc.dupe(u8, watch_id),
            .kind = try alloc.dupe(u8, kind),
            .name = if (name) |n| try alloc.dupe(u8, n) else null,
        };
        return self;
    }

    fn destroy(self: *WatchEvent, alloc: Allocator) void {
        alloc.free(self.watch_id);
        alloc.free(self.kind);
        if (self.name) |n| alloc.free(n);
        alloc.destroy(self);
    }
};

/// Called from the watch thread when kqueue/inotify delivers an event.
fn onWatchEvent(watch_id: []const u8, kind: []const u8, name: ?[]const u8) void {
    const tsfn = g_tsfn orelse return;
    const event = WatchEvent.create(napigen.allocator, watch_id, kind, name) catch return;
    const status = napigen.napi.napi_call_threadsafe_function(tsfn, event, napigen.napi.napi_tsfn_nonblocking);
    if (status != napigen.napi.napi_ok) {
        event.destroy(napigen.allocator);
    }
}

/// Threadsafe function callback — runs on the main JS thread.
fn tsfnCallJs(env: napigen.napi_env, js_callback: napigen.napi_value, _: ?*anyopaque, data: ?*anyopaque) callconv(.c) void {
    const event: *WatchEvent = @ptrCast(@alignCast(data orelse return));
    defer event.destroy(napigen.allocator);

    var wid: napigen.napi_value = undefined;
    _ = napigen.napi.napi_create_string_utf8(env, event.watch_id.ptr, event.watch_id.len, &wid);
    var kind: napigen.napi_value = undefined;
    _ = napigen.napi.napi_create_string_utf8(env, event.kind.ptr, event.kind.len, &kind);
    var name: napigen.napi_value = undefined;
    if (event.name) |n| {
        _ = napigen.napi.napi_create_string_utf8(env, n.ptr, n.len, &name);
    } else {
        _ = napigen.napi.napi_get_null(env, &name);
    }

    var args = [3]napigen.napi_value{ wid, kind, name };
    var global: napigen.napi_value = undefined;
    _ = napigen.napi.napi_get_global(env, &global);
    _ = napigen.napi.napi_call_function(env, global, js_callback, 3, &args, null);
}

fn watchPollUnix() void {
    const fd = blk: {
        g_watch_mutex.lock();
        defer g_watch_mutex.unlock();
        const w = &(g_watcher orelse return);
        break :blk w.pollFd() orelse return;
    };

    var pfds = [1]posix.pollfd{.{ .fd = fd, .events = posix.POLL.IN, .revents = 0 }};
    _ = posix.poll(&pfds, 200) catch return;

    if (pfds[0].revents & posix.POLL.IN != 0) {
        g_watch_mutex.lock();
        defer g_watch_mutex.unlock();
        if (g_watcher) |*w| w.process(onWatchEvent);
    }
}

fn watchPollWindows() void {
    if (comptime builtin.os.tag != .windows) return;

    const w = std.os.windows;
    var handles: [64]w.HANDLE = undefined;
    const n = blk: {
        g_watch_mutex.lock();
        defer g_watch_mutex.unlock();
        const watcher = &(g_watcher orelse return);
        break :blk watcher.fillEventHandles(&handles);
    };

    if (n == 0) {
        std.time.sleep(200_000_000);
        return;
    }

    const result = w.kernel32.WaitForMultipleObjectsEx(@intCast(n), &handles, 0, 200, 0);
    const idx = result -% w.WAIT_OBJECT_0;

    if (idx < n) {
        g_watch_mutex.lock();
        defer g_watch_mutex.unlock();
        if (g_watcher) |*watcher| watcher.processEventAt(idx, onWatchEvent);
    }
}

fn watchThreadFn() void {
    while (!g_watch_stop.load(.acquire)) {
        if (comptime builtin.os.tag == .windows)
            watchPollWindows()
        else
            watchPollUnix();
    }
}

fn ensureWatcher() !*WatcherImpl {
    if (g_watcher == null) {
        g_watcher = try WatcherImpl.init(napigen.allocator);
        if (comptime builtin.os.tag == .macos) {
            // Set callback for FSEvents (GCD dispatch queue delivers events)
            g_watcher.?.callback = onWatchEvent;
        }
    }
    return &g_watcher.?;
}

fn ensureWatchThread() !void {
    if (comptime builtin.os.tag == .macos) return; // FSEvents handles threading
    if (g_watch_thread != null) return;
    g_watch_stop.store(false, .release);
    g_watch_thread = try std.Thread.spawn(.{}, watchThreadFn, .{});
}

fn napiSetWatchCallback(js: *napigen.JsContext, callback: napigen.napi_value) !void {
    if (g_tsfn != null) {
        _ = napigen.napi.napi_release_threadsafe_function(g_tsfn, napigen.napi.napi_tsfn_release);
        g_tsfn = null;
    }

    var resource_name: napigen.napi_value = undefined;
    _ = napigen.napi.napi_create_string_utf8(js.env, "faraday_watch", 13, &resource_name);

    try napigen.check(napigen.napi.napi_create_threadsafe_function(
        js.env,
        callback,
        null,
        resource_name,
        0, // unlimited queue
        1, // initial_thread_count
        null,
        null,
        null,
        tsfnCallJs,
        &g_tsfn,
    ));
}

fn napiWatch(js: *napigen.JsContext, watch_id: []const u8, dir_path: []const u8) !napigen.napi_value {
    // Throw EACCES so ipcHandlers can escalate to the elevated helper
    std.fs.accessAbsolute(dir_path, .{}) catch |err| {
        if (err == error.AccessDenied) return throwWithCode(js, err);
        return try js.write(.{ .ok = false });
    };

    g_watch_mutex.lock();
    defer g_watch_mutex.unlock();
    const w = ensureWatcher() catch return try js.write(.{ .ok = false });
    ensureWatchThread() catch return try js.write(.{ .ok = false });
    return try js.write(.{ .ok = w.addWatch(watch_id, dir_path) });
}

fn napiUnwatch(_: *napigen.JsContext, watch_id: []const u8) !void {
    g_watch_mutex.lock();
    defer g_watch_mutex.unlock();
    if (g_watcher) |*w| w.removeWatch(watch_id);
}

fn cleanupWatch(_: ?*anyopaque) callconv(.c) void {
    g_watch_stop.store(true, .release);
    if (g_tsfn != null) {
        _ = napigen.napi.napi_release_threadsafe_function(g_tsfn, napigen.napi.napi_tsfn_abort);
        g_tsfn = null;
    }
    if (g_watch_thread) |t| {
        t.detach();
        g_watch_thread = null;
    }
    if (g_watcher) |*w| {
        w.deinit();
        g_watcher = null;
    }
}

// ── Module init ──────────────────────────────────────────────────────

comptime {
    napigen.defineModule(initModule);
}

fn initModule(js: *napigen.JsContext, exports: napigen.napi_value) anyerror!napigen.napi_value {
    try js.setNamedProperty(exports, "entries", try js.createFunction(napiEntries));
    try js.setNamedProperty(exports, "stat", try js.createFunction(napiStat));
    try js.setNamedProperty(exports, "exists", try js.createFunction(napiExists));
    try js.setNamedProperty(exports, "open", try js.createFunction(napiOpen));
    try js.setNamedProperty(exports, "read", try js.createFunction(napiRead));
    try js.setNamedProperty(exports, "close", try js.createFunction(napiClose));
    try js.setNamedProperty(exports, "setWatchCallback", try js.createFunction(napiSetWatchCallback));
    try js.setNamedProperty(exports, "watch", try js.createFunction(napiWatch));
    try js.setNamedProperty(exports, "unwatch", try js.createFunction(napiUnwatch));
    _ = napigen.napi.napi_add_env_cleanup_hook(js.env, cleanupWatch, null);
    return exports;
}
