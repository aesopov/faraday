const std = @import("std");

pub fn getImports(b: *std.Build, args: anytype) []const std.Build.Module.Import {
    _ = b;

    // Link CoreServices framework on macOS for FSEventsWatcher.
    if (args.target.result.os.tag == .macos) {
        args.library.linkFramework("CoreServices");
        // When cross-compiling (node-zigar always specifies -target), the SDK
        // sysroot isn't set automatically. Point at the macOS SDK so the
        // linker can resolve framework and library paths.
        const sdk_path: []const u8 = "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk";
        args.library.addFrameworkPath(.{ .cwd_relative = sdk_path ++ "/System/Library/Frameworks" });
        args.library.addLibraryPath(.{ .cwd_relative = sdk_path ++ "/usr/lib" });
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
