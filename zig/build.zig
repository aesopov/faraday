const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Elevated helper executable (standalone binary)
    const exe = b.addExecutable(.{
        .name = "frdye",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    // Link CoreServices on macOS for FSEventsWatcher
    if (target.result.os.tag == .macos) {
        exe.linkFramework("CoreServices");
    }

    b.installArtifact(exe);
}
