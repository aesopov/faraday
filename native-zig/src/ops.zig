/// Filesystem operations — uses std.fs for cross-platform support.
const std = @import("std");
const proto = @import("proto.zig");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;

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

    fn add(self: *FdTable, file: std.fs.File) ![]const u8 {
        var buf: [32]u8 = undefined;
        const id = std.fmt.bufPrint(&buf, "fd-{d}", .{self.next_id}) catch unreachable;
        self.next_id += 1;
        const owned = try self.allocator.dupe(u8, id);
        try self.entries.append(self.allocator, .{ .id = owned, .file = file });
        return owned;
    }

    fn get(self: *const FdTable, id: []const u8) ?std.fs.File {
        for (self.entries.items) |e| {
            if (std.mem.eql(u8, e.id, id)) return e.file;
        }
        return null;
    }

    fn remove(self: *FdTable, id: []const u8) void {
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

pub fn entries(dir_path: []const u8, out: *proto.Writer) !void {
    var dir = try std.fs.openDirAbsolute(dir_path, .{ .iterate = true });
    defer dir.close();

    const count_pos = out.buf.items.len;
    try out.u32_(0); // placeholder

    var count: u32 = 0;
    var iter = dir.iterate();
    while (try iter.next()) |entry| {
        const is_dir: u8 = if (entry.kind == .directory) 1 else 0;
        const is_link: u8 = if (entry.kind == .sym_link) 1 else 0;

        var size: f64 = 0;
        var mtime_ms: f64 = 0;
        var mode: u32 = 0;

        if (dir.statFile(entry.name)) |st| {
            size = @floatFromInt(st.size);
            mtime_ms = @as(f64, @floatFromInt(st.mtime)) / 1_000_000.0;
            mode = if (comptime builtin.os.tag == .windows) 0 else @intCast(st.mode);
        } else |_| {}

        try out.str_(entry.name);
        try out.u8_(is_dir);
        try out.f64_(size);
        try out.f64_(mtime_ms);
        try out.u32_(mode);
        try out.u8_(is_link);
        count += 1;
    }

    out.patchU32(count_pos, count);
}

pub fn stat(file_path: []const u8, out: *proto.Writer) !void {
    var f = try std.fs.openFileAbsolute(file_path, .{});
    defer f.close();
    const st = try f.stat();
    try out.f64_(@floatFromInt(st.size));
    try out.f64_(@as(f64, @floatFromInt(st.mtime)) / 1_000_000.0);
}

pub fn exists(file_path: []const u8, out: *proto.Writer) !void {
    std.fs.accessAbsolute(file_path, .{}) catch {
        try out.u8_(0);
        return;
    };
    try out.u8_(1);
}

pub fn open(file_path: []const u8, out: *proto.Writer, fdt: *FdTable) !void {
    const f = try std.fs.openFileAbsolute(file_path, .{});
    const id = fdt.add(f) catch |err| {
        f.close();
        return err;
    };
    try out.str_(id);
}

pub fn read(fd_id: []const u8, offset: i64, length: usize, out: *proto.Writer, fdt: *const FdTable, allocator: Allocator) !void {
    const f = fdt.get(fd_id) orelse return error.InvalidHandle;
    const buf = try allocator.alloc(u8, length);
    defer allocator.free(buf);
    const n = try f.pread(buf, @intCast(offset));
    try out.bytes(buf[0..n]);
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
