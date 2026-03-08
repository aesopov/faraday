/// Directory watching — kqueue (macOS), inotify (Linux), ReadDirectoryChangesW (Windows).
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const Allocator = std.mem.Allocator;

pub const EventCallback = *const fn (watch_id: []const u8, kind: []const u8, name: ?[]const u8) void;

// ── Public interface (delegates to platform impl) ────────────────────

pub const Watcher = struct {
    impl: Impl,
    allocator: Allocator,

    const Impl = switch (builtin.os.tag) {
        .macos => KqueueImpl,
        .linux => InotifyImpl,
        .windows => WindowsImpl,
        else => NoopImpl,
    };

    const WatchEntry = struct {
        id: []u8,
        path: []u8,
        handle: Impl.Handle,
    };

    pub fn init(allocator: Allocator) !Watcher {
        return .{
            .impl = try Impl.init(allocator),
            .allocator = allocator,
        };
    }

    pub fn deinit(self: *Watcher) void {
        self.impl.deinit(self.allocator);
    }

    pub fn addWatch(self: *Watcher, id: []const u8, path: []const u8) bool {
        self.impl.add(self.allocator, id, path) catch return false;
        return true;
    }

    pub fn removeWatch(self: *Watcher, id: []const u8) void {
        self.impl.remove(self.allocator, id);
    }

    /// Pollable fd for the main loop (kqueue/inotify). Returns null on Windows.
    pub fn pollFd(self: *const Watcher) ?posix.fd_t {
        return self.impl.fd();
    }

    pub fn process(self: *Watcher, cb: EventCallback) void {
        self.impl.process(cb);
    }

    pub fn watchParent(self: *Watcher, ppid: posix.pid_t) void {
        self.impl.watchParent(ppid);
    }

    pub fn parentDied(self: *const Watcher) bool {
        return self.impl.parent_dead;
    }

    /// Fill `buf` with event HANDLEs for WaitForMultipleObjects (Windows only).
    /// Returns the number of handles written.
    pub fn fillEventHandles(self: *const Watcher, buf: []std.os.windows.HANDLE) usize {
        if (comptime builtin.os.tag != .windows) return 0;
        var n: usize = 0;
        for (self.impl.watches.items) |e| {
            if (n >= buf.len) break;
            if (e.handle.pending) {
                buf[n] = e.handle.event;
                n += 1;
            }
        }
        return n;
    }

    /// Process a directory change event by its handle index (Windows only).
    /// `handle_idx` corresponds to the order returned by `fillEventHandles`.
    pub fn processEventAt(self: *Watcher, handle_idx: usize, cb: EventCallback) void {
        if (comptime builtin.os.tag != .windows) return;
        self.impl.processEventAt(handle_idx, cb);
    }
};

// ── macOS: kqueue ────────────────────────────────────────────────────

const KqueueImpl = struct {
    const Handle = posix.fd_t; // directory fd registered with kqueue

    kq: posix.fd_t,
    watches: std.ArrayList(Watcher.WatchEntry) = .empty,
    parent_dead: bool = false,

    fn init(_: Allocator) !KqueueImpl {
        return .{
            .kq = try posix.kqueue(),
        };
    }

    fn deinit(self: *KqueueImpl, allocator: Allocator) void {
        for (self.watches.items) |e| {
            posix.close(e.handle);
            allocator.free(e.id);
            allocator.free(e.path);
        }
        self.watches.deinit(allocator);
        posix.close(self.kq);
    }

    fn fd(self: *const KqueueImpl) ?posix.fd_t {
        return self.kq;
    }

    fn add(self: *KqueueImpl, allocator: Allocator, id: []const u8, path: []const u8) !void {
        self.remove(allocator, id);

        const dir_fd = try posix.open(path, .{ .ACCMODE = .RDONLY, .EVTONLY = true }, 0);
        errdefer posix.close(dir_fd);

        var changelist = [1]posix.Kevent{.{
            .ident = @intCast(dir_fd),
            .filter = posix.system.EVFILT.VNODE,
            .flags = posix.system.EV.ADD | posix.system.EV.ENABLE | posix.system.EV.CLEAR,
            .fflags = posix.system.NOTE.WRITE | posix.system.NOTE.DELETE | posix.system.NOTE.RENAME | posix.system.NOTE.REVOKE,
            .data = 0,
            .udata = 0,
        }};
        _ = try posix.kevent(self.kq, &changelist, &.{}, null);

        try self.watches.append(allocator, .{
            .id = try allocator.dupe(u8, id),
            .path = try allocator.dupe(u8, path),
            .handle = dir_fd,
        });
    }

    fn remove(self: *KqueueImpl, allocator: Allocator, id: []const u8) void {
        for (self.watches.items, 0..) |e, i| {
            if (std.mem.eql(u8, e.id, id)) {
                posix.close(e.handle);
                allocator.free(e.id);
                allocator.free(e.path);
                _ = self.watches.orderedRemove(i);
                return;
            }
        }
    }

    fn findById(self: *const KqueueImpl, ident: usize) ?[]const u8 {
        for (self.watches.items) |e| {
            if (@as(usize, @intCast(e.handle)) == ident) return e.id;
        }
        return null;
    }

    fn process(self: *KqueueImpl, cb: EventCallback) void {
        var events: [32]posix.Kevent = undefined;
        var ts = posix.timespec{ .sec = 0, .nsec = 0 };
        const n = posix.kevent(self.kq, &.{}, &events, &ts) catch return;

        for (events[0..n]) |ev| {
            if (ev.filter == posix.system.EVFILT.PROC) {
                self.parent_dead = true;
                continue;
            }
            const wid = self.findById(ev.ident) orelse continue;
            if (ev.fflags & (posix.system.NOTE.DELETE | posix.system.NOTE.RENAME | posix.system.NOTE.REVOKE) != 0)
                cb(wid, "errored", null)
            else
                cb(wid, "unknown", null);
        }
    }

    fn watchParent(self: *KqueueImpl, ppid: posix.pid_t) void {
        var changelist = [1]posix.Kevent{.{
            .ident = @intCast(ppid),
            .filter = posix.system.EVFILT.PROC,
            .flags = posix.system.EV.ADD,
            .fflags = posix.system.NOTE.EXIT,
            .data = 0,
            .udata = 0,
        }};
        _ = posix.kevent(self.kq, &changelist, &.{}, null) catch {};
    }
};

// ── Linux: inotify ───────────────────────────────────────────────────

/// Safe wrapper: calls inotify_rm_watch via raw syscall so that EINVAL
/// (which the kernel returns when a watch is auto-removed after
/// IN_DELETE_SELF / IN_MOVE_SELF) is silently ignored instead of
/// triggering the `unreachable` in posix.inotify_rm_watch.
fn inotifyRmWatchSafe(ifd: posix.fd_t, wd: i32) void {
    _ = std.os.linux.inotify_rm_watch(ifd, wd);
}

const InotifyImpl = struct {
    const Handle = i32; // inotify watch descriptor

    ifd: posix.fd_t,
    allocator: Allocator,
    watches: std.ArrayList(Watcher.WatchEntry) = .empty,
    parent_dead: bool = false,

    fn init(allocator: Allocator) !InotifyImpl {
        return .{
            .ifd = try posix.inotify_init1(std.os.linux.IN.NONBLOCK | std.os.linux.IN.CLOEXEC),
            .allocator = allocator,
        };
    }

    fn deinit(self: *InotifyImpl, allocator: Allocator) void {
        for (self.watches.items) |e| {
            inotifyRmWatchSafe(self.ifd, e.handle);
            allocator.free(e.id);
            allocator.free(e.path);
        }
        self.watches.deinit(allocator);
        posix.close(self.ifd);
    }

    fn fd(self: *const InotifyImpl) ?posix.fd_t {
        return self.ifd;
    }

    fn add(self: *InotifyImpl, allocator: Allocator, id: []const u8, path: []const u8) !void {
        self.remove(allocator, id);
        const linux = std.os.linux;
        const mask: u32 = linux.IN.CREATE | linux.IN.DELETE | linux.IN.MODIFY | linux.IN.MOVED_FROM | linux.IN.MOVED_TO | linux.IN.DELETE_SELF | linux.IN.MOVE_SELF;
        const wd = try posix.inotify_add_watch(self.ifd, path, mask);
        try self.watches.append(allocator, .{
            .id = try allocator.dupe(u8, id),
            .path = try allocator.dupe(u8, path),
            .handle = wd,
        });
    }

    fn remove(self: *InotifyImpl, allocator: Allocator, id: []const u8) void {
        for (self.watches.items, 0..) |e, i| {
            if (std.mem.eql(u8, e.id, id)) {
                inotifyRmWatchSafe(self.ifd, e.handle);
                allocator.free(e.id);
                allocator.free(e.path);
                _ = self.watches.orderedRemove(i);
                return;
            }
        }
    }

    fn findById(self: *const InotifyImpl, wd: i32) ?[]const u8 {
        for (self.watches.items) |e| {
            if (e.handle == wd) return e.id;
        }
        return null;
    }

    fn process(self: *InotifyImpl, cb: EventCallback) void {
        var buf: [4096]u8 align(@alignOf(std.os.linux.inotify_event)) = undefined;
        const n = posix.read(self.ifd, &buf) catch return;
        var off: usize = 0;
        while (off < n) {
            const ev: *const std.os.linux.inotify_event = @alignCast(@ptrCast(buf[off..]));
            const wid = self.findById(ev.wd) orelse {
                off += @sizeOf(std.os.linux.inotify_event) + ev.len;
                continue;
            };
            const name: ?[]const u8 = ev.getName();
            const mask = ev.mask;
            if (mask & (std.os.linux.IN.DELETE_SELF | std.os.linux.IN.MOVE_SELF) != 0) {
                // Kernel auto-removes the wd here; remove from our list so
                // a subsequent unwatch() doesn't call inotify_rm_watch on a
                // stale (already-removed) descriptor.
                self.removeByWd(ev.wd);
                cb(wid, "errored", null);
            } else if (mask & (std.os.linux.IN.CREATE | std.os.linux.IN.MOVED_TO) != 0)
                cb(wid, "appeared", name)
            else if (mask & (std.os.linux.IN.DELETE | std.os.linux.IN.MOVED_FROM) != 0)
                cb(wid, "disappeared", name)
            else if (mask & std.os.linux.IN.MODIFY != 0)
                cb(wid, "modified", name)
            else
                cb(wid, "unknown", name);
            off += @sizeOf(std.os.linux.inotify_event) + ev.len;
        }
    }

    fn removeByWd(self: *InotifyImpl, wd: i32) void {
        for (self.watches.items, 0..) |e, i| {
            if (e.handle == wd) {
                self.allocator.free(e.id);
                self.allocator.free(e.path);
                _ = self.watches.orderedRemove(i);
                return;
            }
        }
    }

    fn watchParent(_: *InotifyImpl, _: posix.pid_t) void {
        // Linux uses prctl(PR_SET_PDEATHSIG) instead — handled in main.
    }
};

// ── Windows: ReadDirectoryChangesW ──────────────────────────────────

const WindowsImpl = struct {
    const w = std.os.windows;

    /// Per-watch state. Heap-allocated so OVERLAPPED pointers remain stable
    /// across ArrayList reallocations (ReadDirectoryChangesW holds a reference).
    const WatchState = struct {
        dir_handle: w.HANDLE,
        event: w.HANDLE,
        overlapped: w.OVERLAPPED,
        buf: [4096]u8 align(@alignOf(w.FILE_NOTIFY_INFORMATION)),
        pending: bool,
    };

    const Handle = *WatchState;

    watches: std.ArrayList(Watcher.WatchEntry) = .empty,
    parent_dead: bool = false,

    fn init(_: Allocator) !WindowsImpl {
        return .{};
    }

    fn deinit(self: *WindowsImpl, allocator: Allocator) void {
        for (self.watches.items) |e| {
            cancelAndClose(e.handle);
            allocator.free(e.id);
            allocator.free(e.path);
            allocator.destroy(e.handle);
        }
        self.watches.deinit(allocator);
    }

    fn fd(_: *const WindowsImpl) ?posix.fd_t {
        return null; // Windows uses fillEventHandles / WaitForMultipleObjects
    }

    fn add(self: *WindowsImpl, allocator: Allocator, id: []const u8, path: []const u8) !void {
        self.remove(allocator, id);

        // Convert UTF-8 path to wide string
        var w_buf: [std.fs.max_path_bytes]u16 = undefined;
        const w_len = try std.unicode.utf8ToUtf16Le(&w_buf, path);
        w_buf[w_len] = 0;
        const w_path: [*:0]const u16 = @ptrCast(w_buf[0..w_len :0]);

        // Open directory for reading changes (overlapped)
        const dir_handle = w.kernel32.CreateFileW(
            w_path,
            w.FILE_LIST_DIRECTORY,
            w.FILE_SHARE_READ | w.FILE_SHARE_WRITE | w.FILE_SHARE_DELETE,
            null,
            w.OPEN_EXISTING,
            w.FILE_FLAG_BACKUP_SEMANTICS | w.FILE_FLAG_OVERLAPPED,
            null,
        );
        if (dir_handle == w.INVALID_HANDLE_VALUE) return error.AccessDenied;
        errdefer w.CloseHandle(dir_handle);

        // Create auto-reset event
        const event = try w.CreateEventExW(null, null, 0, w.EVENT_ALL_ACCESS);
        errdefer w.CloseHandle(event);

        const state = try allocator.create(WatchState);
        state.* = .{
            .dir_handle = dir_handle,
            .event = event,
            .overlapped = std.mem.zeroes(w.OVERLAPPED),
            .buf = undefined,
            .pending = false,
        };
        state.overlapped.hEvent = event;

        issueRead(state);

        try self.watches.append(allocator, .{
            .id = try allocator.dupe(u8, id),
            .path = try allocator.dupe(u8, path),
            .handle = state,
        });
    }

    fn remove(self: *WindowsImpl, allocator: Allocator, id: []const u8) void {
        for (self.watches.items, 0..) |e, i| {
            if (std.mem.eql(u8, e.id, id)) {
                cancelAndClose(e.handle);
                allocator.free(e.id);
                allocator.free(e.path);
                allocator.destroy(e.handle);
                _ = self.watches.orderedRemove(i);
                return;
            }
        }
    }

    fn process(_: *WindowsImpl, _: EventCallback) void {
        // Not used on Windows — main loop calls processEventAt directly.
    }

    fn processEventAt(self: *WindowsImpl, handle_idx: usize, cb: EventCallback) void {
        // Map handle_idx back to the watch entry (matches fillEventHandles order)
        var idx: usize = 0;
        for (self.watches.items) |*e| {
            if (!e.handle.pending) continue;
            if (idx == handle_idx) {
                const bytes = w.GetOverlappedResult(e.handle.dir_handle, &e.handle.overlapped, false) catch {
                    cb(e.id, "errored", null);
                    e.handle.pending = false;
                    return;
                };
                if (bytes > 0) {
                    parseNotifications(e.id, &e.handle.buf, cb);
                }
                // Re-issue read for next batch of changes
                issueRead(e.handle);
                return;
            }
            idx += 1;
        }
    }

    fn issueRead(state: *WatchState) void {
        state.overlapped = std.mem.zeroes(w.OVERLAPPED);
        state.overlapped.hEvent = state.event;
        state.pending = w.kernel32.ReadDirectoryChangesW(
            state.dir_handle,
            @ptrCast(&state.buf),
            state.buf.len,
            w.FALSE, // don't watch subtree
            @bitCast(w.FileNotifyChangeFilter{
                .file_name = true,
                .dir_name = true,
                .size = true,
                .last_write = true,
            }),
            null,
            &state.overlapped,
            null,
        ) != 0;
    }

    fn cancelAndClose(state: *WatchState) void {
        if (state.pending) {
            _ = w.kernel32.CancelIo(state.dir_handle);
            // Wait for the cancellation to complete
            _ = w.GetOverlappedResult(state.dir_handle, &state.overlapped, true) catch {};
        }
        w.CloseHandle(state.event);
        w.CloseHandle(state.dir_handle);
    }

    fn parseNotifications(watch_id: []const u8, buf: []const u8, cb: EventCallback) void {
        var off: usize = 0;
        while (off < buf.len) {
            if (off + @sizeOf(w.FILE_NOTIFY_INFORMATION) > buf.len) break;
            const info: *const w.FILE_NOTIFY_INFORMATION = @alignCast(@ptrCast(buf[off..]));
            const name_offset = off + @sizeOf(w.FILE_NOTIFY_INFORMATION);
            const name_end = name_offset + info.FileNameLength;
            if (name_end > buf.len) break;

            // Convert wide char filename to UTF-8
            const wide_name: [*]const u16 = @alignCast(@ptrCast(buf[name_offset..]));
            const wide_len = info.FileNameLength / 2;
            var name_buf: [std.fs.max_path_bytes]u8 = undefined;
            const name: ?[]const u8 = if (wide_len > 0) blk: {
                const n = std.unicode.utf16LeToUtf8(&name_buf, wide_name[0..wide_len]) catch break :blk null;
                break :blk name_buf[0..n];
            } else null;

            const kind: []const u8 = switch (info.Action) {
                w.FILE_ACTION_ADDED, w.FILE_ACTION_RENAMED_NEW_NAME => "appeared",
                w.FILE_ACTION_REMOVED, w.FILE_ACTION_RENAMED_OLD_NAME => "disappeared",
                w.FILE_ACTION_MODIFIED => "modified",
                else => "unknown",
            };
            cb(watch_id, kind, name);

            if (info.NextEntryOffset == 0) break;
            off += info.NextEntryOffset;
        }
    }

    fn watchParent(_: *WindowsImpl, _: posix.pid_t) void {}
};

// ── Stub for unsupported platforms ───────────────────────────────────

const NoopImpl = struct {
    const Handle = i32;
    parent_dead: bool = false,

    fn init(_: Allocator) !NoopImpl {
        return .{};
    }
    fn deinit(_: *NoopImpl, _: Allocator) void {}
    fn fd(_: *const NoopImpl) ?posix.fd_t {
        return null;
    }
    fn add(_: *NoopImpl, _: Allocator, _: []const u8, _: []const u8) !void {
        return error.NotSupported;
    }
    fn remove(_: *NoopImpl, _: Allocator, _: []const u8) void {}
    fn process(_: *NoopImpl, _: EventCallback) void {}
    fn watchParent(_: *NoopImpl, _: posix.pid_t) void {}
};
