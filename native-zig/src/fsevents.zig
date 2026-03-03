/// macOS FSEvents-based directory watcher.
/// Unlike kqueue (which only fires for directory structural changes),
/// FSEvents fires for file content modifications too.
const std = @import("std");
const Allocator = std.mem.Allocator;
const watch_common = @import("watch.zig");

pub const EventCallback = watch_common.EventCallback;

// ── CoreServices / GCD declarations ──────────────────────────────────
// Manual declarations to avoid pulling in the entire CoreServices header.

const CFAllocatorRef = ?*anyopaque;
const CFStringRef = *anyopaque;
const CFArrayRef = *anyopaque;
const CFTypeRef = *anyopaque;
const CFIndex = isize;
const CFStringEncoding = u32;
const CFArrayCallBacks = extern struct {
    version: CFIndex = 0,
    retain: ?*const anyopaque = null,
    release: ?*const anyopaque = null,
    copyDescription: ?*const anyopaque = null,
    equal: ?*const anyopaque = null,
};
const Boolean = u8;

const kCFStringEncodingUTF8: CFStringEncoding = 0x08000100;

extern "CoreServices" fn CFStringCreateWithBytes(alloc: CFAllocatorRef, bytes: [*]const u8, numBytes: CFIndex, encoding: CFStringEncoding, isExternalRepresentation: Boolean) ?CFStringRef;
extern "CoreServices" fn CFArrayCreate(alloc: CFAllocatorRef, values: [*]const CFTypeRef, numValues: CFIndex, callBacks: ?*const CFArrayCallBacks) ?CFArrayRef;
extern "CoreServices" fn CFRelease(cf: CFTypeRef) void;

const FSEventStreamRef = *anyopaque;
const ConstFSEventStreamRef = *const anyopaque;
const FSEventStreamEventFlags = u32;
const FSEventStreamEventId = u64;
const FSEventStreamContext = extern struct {
    version: CFIndex = 0,
    info: ?*anyopaque = null,
    retain: ?*const anyopaque = null,
    release: ?*const anyopaque = null,
    copyDescription: ?*const anyopaque = null,
};

const FSEventStreamCallback = *const fn (
    stream: ConstFSEventStreamRef,
    info: ?*anyopaque,
    numEvents: usize,
    eventPaths: ?*anyopaque,
    eventFlags: [*]const FSEventStreamEventFlags,
    eventIds: [*]const FSEventStreamEventId,
) callconv(.c) void;

const kFSEventStreamCreateFlagFileEvents: u32 = 0x00000010;
const kFSEventStreamCreateFlagNoDefer: u32 = 0x00000002;
const kFSEventStreamEventIdSinceNow: u64 = 0xFFFFFFFFFFFFFFFF;

const kFSEventStreamEventFlagItemCreated: u32 = 0x00000100;
const kFSEventStreamEventFlagItemRemoved: u32 = 0x00000200;
const kFSEventStreamEventFlagItemInodeMetaMod: u32 = 0x00000400;
const kFSEventStreamEventFlagItemRenamed: u32 = 0x00000800;
const kFSEventStreamEventFlagItemModified: u32 = 0x00001000;
const kFSEventStreamEventFlagItemChangeOwner: u32 = 0x00004000;
const kFSEventStreamEventFlagItemXattrMod: u32 = 0x00008000;

extern "CoreServices" fn FSEventStreamCreate(
    allocator: CFAllocatorRef,
    callback: FSEventStreamCallback,
    context: ?*FSEventStreamContext,
    pathsToWatch: CFArrayRef,
    sinceWhen: FSEventStreamEventId,
    latency: f64,
    flags: u32,
) ?FSEventStreamRef;
extern "CoreServices" fn FSEventStreamStart(streamRef: FSEventStreamRef) Boolean;
extern "CoreServices" fn FSEventStreamStop(streamRef: FSEventStreamRef) void;
extern "CoreServices" fn FSEventStreamInvalidate(streamRef: FSEventStreamRef) void;
extern "CoreServices" fn FSEventStreamRelease(streamRef: FSEventStreamRef) void;

const dispatch_queue_t = *anyopaque;
extern "System" fn dispatch_queue_create(label: [*:0]const u8, attr: ?*anyopaque) ?dispatch_queue_t;
extern "CoreServices" fn FSEventStreamSetDispatchQueue(streamRef: FSEventStreamRef, queue: dispatch_queue_t) void;

// ── CFArrayCallBacks (simplified: retain/release not needed for local use) ─

var g_array_callbacks = CFArrayCallBacks{};

// ── FSEvents Watcher ─────────────────────────────────────────────────

const WatchEntry = struct {
    id: []u8,
    path: []u8, // with trailing '/'
    stream: FSEventStreamRef,
};

pub const FSEventsWatcher = struct {
    watches: std.ArrayList(WatchEntry),
    allocator: Allocator,
    queue: dispatch_queue_t,
    callback: ?EventCallback = null,
    mutex: std.Thread.Mutex = .{},

    pub fn init(allocator: Allocator) !FSEventsWatcher {
        const q = dispatch_queue_create("dev.faraday.fsevents", null) orelse
            return error.SystemResources;
        return .{
            .watches = .empty,
            .allocator = allocator,
            .queue = q,
        };
    }

    pub fn deinit(self: *FSEventsWatcher) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.watches.items) |entry| {
            releaseStream(entry.stream);
            self.allocator.free(entry.id);
            self.allocator.free(entry.path);
        }
        self.watches.deinit(self.allocator);
    }

    pub fn addWatch(self: *FSEventsWatcher, id: []const u8, dir_path: []const u8) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.removeWatchLocked(id);

        // Ensure path with trailing '/' for prefix matching
        const path_slash = if (dir_path.len > 0 and dir_path[dir_path.len - 1] != '/')
            std.fmt.allocPrint(self.allocator, "{s}/", .{dir_path}) catch return false
        else
            self.allocator.dupe(u8, dir_path) catch return false;

        // Create CFString path
        const cf_path = CFStringCreateWithBytes(
            null,
            dir_path.ptr,
            @intCast(dir_path.len),
            kCFStringEncodingUTF8,
            0,
        ) orelse {
            self.allocator.free(path_slash);
            return false;
        };

        // Create CFArray
        var cf_path_ref: CFTypeRef = @ptrCast(cf_path);
        const paths = CFArrayCreate(null, @ptrCast(&cf_path_ref), 1, &g_array_callbacks) orelse {
            CFRelease(cf_path);
            self.allocator.free(path_slash);
            return false;
        };

        // Context
        var ctx = FSEventStreamContext{ .info = @ptrCast(self) };

        // Create stream
        const stream = FSEventStreamCreate(
            null,
            fsEventsCallback,
            &ctx,
            paths,
            kFSEventStreamEventIdSinceNow,
            0.1, // 100ms latency
            kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer,
        );

        CFRelease(paths);
        CFRelease(cf_path);

        const s = stream orelse {
            self.allocator.free(path_slash);
            return false;
        };

        FSEventStreamSetDispatchQueue(s, self.queue);
        if (FSEventStreamStart(s) == 0) {
            releaseStream(s);
            self.allocator.free(path_slash);
            return false;
        }

        const id_dup = self.allocator.dupe(u8, id) catch {
            releaseStream(s);
            self.allocator.free(path_slash);
            return false;
        };

        self.watches.append(self.allocator, .{
            .id = id_dup,
            .path = path_slash,
            .stream = s,
        }) catch {
            self.allocator.free(id_dup);
            releaseStream(s);
            self.allocator.free(path_slash);
            return false;
        };

        return true;
    }

    pub fn removeWatch(self: *FSEventsWatcher, id: []const u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.removeWatchLocked(id);
    }

    fn removeWatchLocked(self: *FSEventsWatcher, id: []const u8) void {
        var i: usize = 0;
        while (i < self.watches.items.len) {
            if (std.mem.eql(u8, self.watches.items[i].id, id)) {
                const entry = self.watches.orderedRemove(i);
                releaseStream(entry.stream);
                self.allocator.free(entry.id);
                self.allocator.free(entry.path);
                return;
            }
            i += 1;
        }
    }

    fn releaseStream(stream: FSEventStreamRef) void {
        FSEventStreamStop(stream);
        FSEventStreamInvalidate(stream);
        FSEventStreamRelease(stream);
    }

    fn fsEventsCallback(
        stream: ConstFSEventStreamRef,
        info: ?*anyopaque,
        num_events: usize,
        event_paths: ?*anyopaque,
        event_flags: [*]const FSEventStreamEventFlags,
        _: [*]const FSEventStreamEventId,
    ) callconv(.c) void {
        const self: *FSEventsWatcher = @ptrCast(@alignCast(info orelse return));
        self.mutex.lock();
        defer self.mutex.unlock();

        const cb = self.callback orelse return;
        const paths: [*]const [*:0]const u8 = @ptrCast(@alignCast(event_paths orelse return));

        // Find which watch entry this stream belongs to
        var watch_id: ?[]const u8 = null;
        var watch_path: ?[]const u8 = null;
        for (self.watches.items) |entry| {
            if (@intFromPtr(entry.stream) == @intFromPtr(stream)) {
                watch_id = entry.id;
                watch_path = entry.path;
                break;
            }
        }
        const wid = watch_id orelse return;
        const wpath = watch_path orelse return;

        for (0..num_events) |i| {
            const full_path = std.mem.span(paths[i]);
            const flags = event_flags[i];

            // Must be under the watched directory
            if (full_path.len <= wpath.len) continue;
            if (!std.mem.startsWith(u8, full_path, wpath)) continue;
            const relative = full_path[wpath.len..];

            // Only direct children (no '/' in relative path)
            if (std.mem.indexOfScalar(u8, relative, '/') != null) continue;

            const kind: []const u8 = if (flags & kFSEventStreamEventFlagItemRemoved != 0)
                "disappeared"
            else if (flags & kFSEventStreamEventFlagItemCreated != 0)
                "appeared"
            else if (flags & kFSEventStreamEventFlagItemRenamed != 0)
                "appeared" // treat rename-in as appear
            else if (flags & (kFSEventStreamEventFlagItemModified |
                kFSEventStreamEventFlagItemInodeMetaMod |
                kFSEventStreamEventFlagItemChangeOwner |
                kFSEventStreamEventFlagItemXattrMod) != 0)
                "modified"
            else
                "unknown";

            cb(wid, kind, relative);
        }
    }
};
