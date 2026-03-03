/// N-API addon — exposes Zig filesystem operations to Node.js via napigen.
const std = @import("std");
const napigen = @import("napigen");
const ops = @import("ops.zig");

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

// ── Exported operations ──────────────────────────────────────────────

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
    return exports;
}
