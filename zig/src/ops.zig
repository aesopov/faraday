/// Filesystem operations — uses std.fs for cross-platform support.
///
/// All operations return data structures. Serialization to proto.Writer
/// (for the elevated helper) or to JS values (for the N-API addon) is
/// handled by the respective callers.
const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;

// ── Result types ─────────────────────────────────────────────────────

pub const EntryInfo = struct {
    name: []const u8,
    /// One of: "file" "directory" "symlink" "block_device" "char_device"
    ///         "named_pipe" "socket" "whiteout" "unknown"
    kind: []const u8,
    size: f64,
    mtimeMs: f64,
    mode: u32,
    nlink: u32,
    hidden: bool,
    /// Non-null only when kind == "symlink".
    linkTarget: ?[]const u8,
};

pub const StatResult = struct {
    size: f64,
    mtimeMs: f64,
};

// ── File-descriptor table ────────────────────────────────────────────

pub const FdTable = struct {
    map: std.AutoHashMapUnmanaged(std.fs.File.Handle, void) = .empty,
    allocator: Allocator,

    pub fn init(allocator: Allocator) FdTable {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *FdTable) void {
        var it = self.map.keyIterator();
        while (it.next()) |handle| {
            (std.fs.File{ .handle = handle.* }).close();
        }
        self.map.deinit(self.allocator);
    }

    pub fn track(self: *FdTable, file: std.fs.File) !void {
        try self.map.put(self.allocator, file.handle, {});
    }

    pub fn contains(self: *const FdTable, handle: std.fs.File.Handle) bool {
        return self.map.contains(handle);
    }

    pub fn remove(self: *FdTable, handle: std.fs.File.Handle) void {
        if (self.map.fetchRemove(handle)) |_| {
            (std.fs.File{ .handle = handle }).close();
        }
    }
};

// ── Handle ↔ i32 conversion ─────────────────────────────────────────
// On POSIX, File.Handle is fd_t (i32) — identity conversion.
// On Windows, File.Handle is HANDLE (*anyopaque) — cast via @intFromPtr.

pub fn handleToI32(handle: std.fs.File.Handle) i32 {
    if (comptime builtin.os.tag == .windows) {
        return @intCast(@intFromPtr(handle));
    } else {
        return handle;
    }
}

pub fn i32ToHandle(id: i32) std.fs.File.Handle {
    if (comptime builtin.os.tag == .windows) {
        return @ptrFromInt(@as(usize, @intCast(@as(u32, @bitCast(id)))));
    } else {
        return id;
    }
}

// ── Operations ───────────────────────────────────────────────────────

/// Map a Zig Dir.Entry.Kind to the canonical kind string.
fn entryKindStr(k: std.fs.Dir.Entry.Kind) []const u8 {
    return switch (k) {
        .file => "file",
        .directory => "directory",
        .sym_link => "symlink",
        .block_device => "block_device",
        .character_device => "char_device",
        .named_pipe => "named_pipe",
        .unix_domain_socket => "socket",
        .whiteout => "whiteout",
        else => "unknown",
    };
}

/// Return the hard-link count for an entry without following symlinks.
/// Uses fstatatZ on POSIX; returns 1 on Windows (Windows hard links are rare
/// and require opening the file, which we avoid for performance).
fn entryNlink(dir: std.fs.Dir, name: []const u8) u32 {
    if (comptime builtin.os.tag == .windows) return 1;
    const name_z = std.posix.toPosixPath(name) catch return 1;
    const st = std.posix.fstatatZ(dir.fd, &name_z, std.posix.AT.SYMLINK_NOFOLLOW) catch return 1;
    return @intCast(st.nlink);
}

pub fn entries(dir_path: []const u8, allocator: Allocator) !std.ArrayList(EntryInfo) {
    var dir = try std.fs.openDirAbsolute(dir_path, .{ .iterate = true });
    defer dir.close();

    var list = std.ArrayList(EntryInfo).empty;
    var iter = dir.iterate();
    while (try iter.next()) |entry| {
        // stat() follows symlinks → gives us target size/mtime/mode.
        var size: f64 = 0;
        var mtime_ms: f64 = 0;
        var mode: u32 = 0;
        if (dir.statFile(entry.name)) |st| {
            size = @floatFromInt(st.size);
            mtime_ms = @as(f64, @floatFromInt(st.mtime)) / 1_000_000.0;
            mode = if (comptime builtin.os.tag == .windows) 0 else @intCast(st.mode);
        } else |_| {}

        var link_target: ?[]const u8 = null;
        if (entry.kind == .sym_link) {
            var link_buf: [4096]u8 = undefined;
            if (dir.readLink(entry.name, &link_buf)) |target| {
                link_target = try allocator.dupe(u8, target);
            } else |_| {}
        }

        try list.append(allocator, .{
            .name = try allocator.dupe(u8, entry.name),
            .kind = entryKindStr(entry.kind),
            .size = size,
            .mtimeMs = mtime_ms,
            .mode = mode,
            .nlink = entryNlink(dir, entry.name),
            .hidden = isHidden(dir_path, entry.name),
            .linkTarget = link_target,
        });
    }
    return list;
}

/// Determines whether a filesystem entry should be considered hidden.
/// On Windows: queries FILE_ATTRIBUTE_HIDDEN via GetFileAttributesW.
/// On all other platforms: dot-file convention (name starts with '.').
fn isHidden(dir_path: []const u8, name: []const u8) bool {
    if (comptime builtin.os.tag == .windows) {
        var path_buf: [4096]u8 = undefined;
        var fba = std.heap.FixedBufferAllocator.init(&path_buf);
        const full = std.fs.path.join(fba.allocator(), &.{ dir_path, name }) catch return false;
        const attrs = std.os.windows.GetFileAttributes(full) catch return false;
        return (attrs & std.os.windows.FILE_ATTRIBUTE_HIDDEN) != 0;
    } else {
        return name.len > 0 and name[0] == '.';
    }
}

pub fn stat(file_path: []const u8) !StatResult {
    var f = try std.fs.openFileAbsolute(file_path, .{});
    defer f.close();
    const st = try f.stat();
    return .{
        .size = @floatFromInt(st.size),
        .mtimeMs = @as(f64, @floatFromInt(st.mtime)) / 1_000_000.0,
    };
}

pub fn exists(file_path: []const u8) bool {
    std.fs.accessAbsolute(file_path, .{}) catch return false;
    return true;
}

pub fn open(file_path: []const u8, fdt: *FdTable) !std.fs.File.Handle {
    const f = try std.fs.openFileAbsolute(file_path, .{});
    fdt.track(f) catch |err| {
        f.close();
        return err;
    };
    return f.handle;
}

pub fn read(handle: std.fs.File.Handle, offset: i64, length: usize, fdt: *const FdTable, allocator: Allocator) ![]u8 {
    if (!fdt.contains(handle)) return error.InvalidHandle;
    const f = std.fs.File{ .handle = handle };
    const buf = try allocator.alloc(u8, length);
    const n = f.pread(buf, @intCast(offset)) catch |err| {
        allocator.free(buf);
        return err;
    };
    return buf[0..n];
}

pub fn close(handle: std.fs.File.Handle, fdt: *FdTable) void {
    fdt.remove(handle);
}

/// Map a Zig error to an errno-style code string.
pub fn errorCode(err: anyerror) []const u8 {
    return switch (err) {
        error.FileNotFound, error.NoDevice => "ENOENT",
        error.AccessDenied => "EACCES",
        error.NotDir => "ENOTDIR",
        error.IsDir => "EISDIR",
        error.OutOfMemory => "ENOMEM",
        error.PathAlreadyExists => "EEXIST",
        error.InvalidHandle => "EBADF",
        error.EndOfBuffer => "EINVAL",
        else => "EIO",
    };
}
