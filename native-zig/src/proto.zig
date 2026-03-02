/// Binary IPC protocol — must stay in sync with src/protocol.ts.
///
/// Wire format: [4: payload_len (u32 LE)][payload...]
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const Allocator = std.mem.Allocator;

// ── Message types ────────────────────────────────────────────────────

pub const MsgType = enum(u8) {
    auth = 0x01,
    request = 0x02,
    response = 0x82,
    err = 0x83,
    event = 0x84,
};

pub const Method = enum(u8) {
    entries = 0x01,
    stat = 0x02,
    exists = 0x03,
    read_file = 0x04,
    open = 0x05,
    read = 0x06,
    close = 0x07,
    watch = 0x08,
    unwatch = 0x09,
    ping = 0x0a,
    _,
};

pub const EventType = enum(u8) {
    appeared = 0x00,
    disappeared = 0x01,
    modified = 0x02,
    errored = 0x03,
    unknown = 0x04,
};

// ── Reader — zero-copy decode from a message payload ─────────────────

pub const Reader = struct {
    data: []const u8,
    pos: usize = 0,

    pub fn u8_(self: *Reader) !u8 {
        if (self.pos >= self.data.len) return error.EndOfBuffer;
        defer self.pos += 1;
        return self.data[self.pos];
    }

    pub fn u32_(self: *Reader) !u32 {
        if (self.pos + 4 > self.data.len) return error.EndOfBuffer;
        const v = std.mem.readInt(u32, self.data[self.pos..][0..4], .little);
        self.pos += 4;
        return v;
    }

    pub fn f64_(self: *Reader) !f64 {
        if (self.pos + 8 > self.data.len) return error.EndOfBuffer;
        const bits = std.mem.readInt(u64, self.data[self.pos..][0..8], .little);
        self.pos += 8;
        return @bitCast(bits);
    }

    pub fn str(self: *Reader) ![]const u8 {
        const len: usize = try self.u16_();
        if (self.pos + len > self.data.len) return error.EndOfBuffer;
        const s = self.data[self.pos..][0..len];
        self.pos += len;
        return s;
    }

    fn u16_(self: *Reader) !u16 {
        if (self.pos + 2 > self.data.len) return error.EndOfBuffer;
        const v = std.mem.readInt(u16, self.data[self.pos..][0..2], .little);
        self.pos += 2;
        return v;
    }
};

// ── Writer — build a message payload ─────────────────────────────────

pub const Writer = struct {
    buf: std.ArrayList(u8) = .empty,
    allocator: Allocator,

    pub fn init(allocator: Allocator) Writer {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Writer) void {
        self.buf.deinit(self.allocator);
    }

    pub fn reset(self: *Writer) void {
        self.buf.clearRetainingCapacity();
    }

    pub fn slice(self: *const Writer) []const u8 {
        return self.buf.items;
    }

    pub fn u8_(self: *Writer, v: u8) !void {
        try self.buf.append(self.allocator, v);
    }

    pub fn u16_(self: *Writer, v: u16) !void {
        try self.buf.appendSlice(self.allocator, &std.mem.toBytes(std.mem.nativeToLittle(u16, v)));
    }

    pub fn u32_(self: *Writer, v: u32) !void {
        try self.buf.appendSlice(self.allocator, &std.mem.toBytes(std.mem.nativeToLittle(u32, v)));
    }

    pub fn f64_(self: *Writer, v: f64) !void {
        const bits: u64 = @bitCast(v);
        try self.buf.appendSlice(self.allocator, &std.mem.toBytes(std.mem.nativeToLittle(u64, bits)));
    }

    pub fn str_(self: *Writer, s: []const u8) !void {
        try self.u16_(@intCast(s.len));
        try self.buf.appendSlice(self.allocator, s);
    }

    pub fn bytes(self: *Writer, data: []const u8) !void {
        try self.u32_(@intCast(data.len));
        try self.buf.appendSlice(self.allocator, data);
    }

    pub fn raw(self: *Writer, data: []const u8) !void {
        try self.buf.appendSlice(self.allocator, data);
    }

    /// Overwrite a u32 at a previously-known offset (for patching counts).
    pub fn patchU32(self: *Writer, offset: usize, v: u32) void {
        std.mem.writeInt(u32, self.buf.items[offset..][0..4], v, .little);
    }
};

// ── MsgReader — accumulates socket data and yields complete messages ──

pub const MsgReader = struct {
    buf: std.ArrayList(u8) = .empty,
    allocator: Allocator,

    pub fn init(allocator: Allocator) MsgReader {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *MsgReader) void {
        self.buf.deinit(self.allocator);
    }

    /// Read available data from `fd`. Returns bytes read (0 = EOF).
    pub fn fill(self: *MsgReader, fd: posix.fd_t) !usize {
        try self.buf.ensureTotalCapacity(self.allocator, self.buf.items.len + 4096);
        const space = self.buf.allocatedSlice()[self.buf.items.len..];
        const n = try posix.read(fd, space);
        self.buf.items.len += n;
        return n;
    }

    /// Append externally-read data (used on Windows with overlapped I/O).
    pub fn feed(self: *MsgReader, data: []const u8) !void {
        try self.buf.appendSlice(self.allocator, data);
    }

    /// Extract the next complete message. Caller owns the returned slice.
    pub fn nextMsg(self: *MsgReader, allocator: Allocator) !?[]u8 {
        if (self.buf.items.len < 4) return null;
        const plen: usize = std.mem.readInt(u32, self.buf.items[0..4], .little);
        const total = 4 + plen;
        if (self.buf.items.len < total) return null;

        const msg = try allocator.dupe(u8, self.buf.items[4..total]);
        const remaining = self.buf.items.len - total;
        if (remaining > 0)
            std.mem.copyForwards(u8, self.buf.items[0..remaining], self.buf.items[total..][0..remaining]);
        self.buf.items.len = remaining;
        return msg;
    }
};

// ── Wire I/O ─────────────────────────────────────────────────────────

/// Write a length-prefixed message to `fd`.
pub fn writeMsg(fd: posix.fd_t, data: []const u8) !void {
    var header: [4]u8 = undefined;
    std.mem.writeInt(u32, &header, @intCast(data.len), .little);
    try writeAll(fd, &header);
    if (data.len > 0) try writeAll(fd, data);
}

fn writeAll(fd: posix.fd_t, data: []const u8) !void {
    var off: usize = 0;
    while (off < data.len) {
        off += try posix.write(fd, data[off..]);
    }
}
