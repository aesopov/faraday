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
    kind: []const u8, // "directory" or "file"
    size: f64,
    mtimeMs: f64,
    mode: u32,
    isSymbolicLink: bool,
};

pub const StatResult = struct {
    size: f64,
    mtimeMs: f64,
};

// ── File-descriptor table ────────────────────────────────────────────

pub const FdTable = struct {
    const Entry = struct { id: []u8, file: std.fs.File };

    entries: std.ArrayList(Entry) = .empty,
    next_id: u32 = 0,
    allocator: Allocator,

    pub fn init(allocator: Allocator) FdTable {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *FdTable) void {
        for (self.entries.items) |*e| {
            e.file.close();
            self.allocator.free(e.id);
        }
        self.entries.deinit(self.allocator);
    }

    pub fn add(self: *FdTable, file: std.fs.File) ![]const u8 {
        var buf: [32]u8 = undefined;
        const id = std.fmt.bufPrint(&buf, "fd-{d}", .{self.next_id}) catch unreachable;
        self.next_id += 1;
        const owned = try self.allocator.dupe(u8, id);
        try self.entries.append(self.allocator, .{ .id = owned, .file = file });
        return owned;
    }

    pub fn get(self: *const FdTable, id: []const u8) ?std.fs.File {
        for (self.entries.items) |e| {
            if (std.mem.eql(u8, e.id, id)) return e.file;
        }
        return null;
    }

    pub fn remove(self: *FdTable, id: []const u8) void {
        for (self.entries.items, 0..) |e, i| {
            if (std.mem.eql(u8, e.id, id)) {
                e.file.close();
                self.allocator.free(e.id);
                _ = self.entries.orderedRemove(i);
                return;
            }
        }
    }
};

// ── Operations ───────────────────────────────────────────────────────

pub fn entries(dir_path: []const u8, allocator: Allocator) !std.ArrayList(EntryInfo) {
    var dir = try std.fs.openDirAbsolute(dir_path, .{ .iterate = true });
    defer dir.close();

    var list = std.ArrayList(EntryInfo).empty;
    var iter = dir.iterate();
    while (try iter.next()) |entry| {
        var size: f64 = 0;
        var mtime_ms: f64 = 0;
        var mode: u32 = 0;

        if (dir.statFile(entry.name)) |st| {
            size = @floatFromInt(st.size);
            mtime_ms = @as(f64, @floatFromInt(st.mtime)) / 1_000_000.0;
            mode = if (comptime builtin.os.tag == .windows) 0 else @intCast(st.mode);
        } else |_| {}

        try list.append(allocator, .{
            .name = try allocator.dupe(u8, entry.name),
            .kind = if (entry.kind == .directory) "directory" else "file",
            .size = size,
            .mtimeMs = mtime_ms,
            .mode = mode,
            .isSymbolicLink = entry.kind == .sym_link,
        });
    }
    return list;
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

pub fn open(file_path: []const u8, fdt: *FdTable) ![]const u8 {
    const f = try std.fs.openFileAbsolute(file_path, .{});
    const id = fdt.add(f) catch |err| {
        f.close();
        return err;
    };
    return id;
}

pub fn read(fd_id: []const u8, offset: i64, length: usize, fdt: *const FdTable, allocator: Allocator) ![]u8 {
    const f = fdt.get(fd_id) orelse return error.InvalidHandle;
    const buf = try allocator.alloc(u8, length);
    const n = f.pread(buf, @intCast(offset)) catch |err| {
        allocator.free(buf);
        return err;
    };
    return buf[0..n];
}

pub fn close(fd_id: []const u8, fdt: *FdTable) void {
    fdt.remove(fd_id);
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
