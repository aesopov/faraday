const std = @import("std");

pub fn getImports(b: *std.Build, args: anytype) []const std.Build.Module.Import {

    // Link CoreServices framework on macOS for FSEventsWatcher.
    if (args.target.result.os.tag == .macos) {
        args.library.linkFramework("CoreServices");
        // When cross-compiling (node-zigar always specifies -target), the SDK
        // sysroot isn't set automatically. Detect via xcrun at build time.
        const sdk_path = std.zig.system.darwin.getSdk(b.allocator, &args.target.result) orelse return &.{};
        args.library.addFrameworkPath(.{ .cwd_relative = std.fs.path.join(b.allocator, &.{ sdk_path, "System/Library/Frameworks" }) catch return &.{} });
        args.library.addLibraryPath(.{ .cwd_relative = std.fs.path.join(b.allocator, &.{ sdk_path, "usr/lib" }) catch return &.{} });
    }

    return &.{};
}

pub fn getCSourceFiles(b: *std.Build, args: anytype) []const []const u8 {
    _ = b;
    _ = args;
    return &.{};
}

pub fn getIncludePaths(b: *std.Build, args: anytype) []const []const u8 {
    _ = b;
    _ = args;
    return &.{};
}
