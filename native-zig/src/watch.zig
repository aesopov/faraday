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

    /// Pollable fd for the main loop (kqueue/inotify). Returns -1 on unsupported platforms.
    pub fn pollFd(self: *const Watcher) posix.fd_t {
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

    fn fd(self: *const KqueueImpl) posix.fd_t {
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

const InotifyImpl = struct {
    const Handle = i32; // inotify watch descriptor

    ifd: posix.fd_t,
    watches: std.ArrayList(Watcher.WatchEntry) = .empty,
    parent_dead: bool = false,

    fn init(_: Allocator) !InotifyImpl {
        return .{
            .ifd = try posix.inotify_init1(.{ .NONBLOCK = true, .CLOEXEC = true }),
        };
    }

    fn deinit(self: *InotifyImpl, allocator: Allocator) void {
        for (self.watches.items) |e| {
            posix.inotify_rm_watch(self.ifd, e.handle);
            allocator.free(e.id);
            allocator.free(e.path);
        }
        self.watches.deinit(allocator);
        posix.close(self.ifd);
    }

    fn fd(self: *const InotifyImpl) posix.fd_t {
        return self.ifd;
    }

    fn add(self: *InotifyImpl, allocator: Allocator, id: []const u8, path: []const u8) !void {
        self.remove(allocator, id);
        const mask = std.os.linux.IN{ .CREATE = true, .DELETE = true, .MODIFY = true, .MOVED_FROM = true, .MOVED_TO = true, .DELETE_SELF = true, .MOVE_SELF = true };
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
                posix.inotify_rm_watch(self.ifd, e.handle);
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
            const name: ?[]const u8 = if (ev.len > 0) std.mem.sliceTo(@as([*:0]const u8, @ptrCast(&ev.name)), 0) else null;
            const mask = ev.mask;
            if (mask & (std.os.linux.IN.DELETE_SELF | std.os.linux.IN.MOVE_SELF) != 0)
                cb(wid, "errored", null)
            else if (mask & (std.os.linux.IN.CREATE | std.os.linux.IN.MOVED_TO) != 0)
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

    fn watchParent(_: *InotifyImpl, _: posix.pid_t) void {
        // Linux uses prctl(PR_SET_PDEATHSIG) instead — handled in main.
    }
};

// ── Stub for unsupported platforms ───────────────────────────────────

const NoopImpl = struct {
    const Handle = i32;
    parent_dead: bool = false,

    fn init(_: Allocator) !NoopImpl {
        return .{};
    }
    fn deinit(_: *NoopImpl, _: Allocator) void {}
    fn fd(_: *const NoopImpl) posix.fd_t {
        return -1;
    }
    fn add(_: *NoopImpl, _: Allocator, _: []const u8, _: []const u8) !void {
        return error.NotSupported;
    }
    fn remove(_: *NoopImpl, _: Allocator, _: []const u8) void {}
    fn process(_: *NoopImpl, _: EventCallback) void {}
    fn watchParent(_: *NoopImpl, _: posix.pid_t) void {}
};
