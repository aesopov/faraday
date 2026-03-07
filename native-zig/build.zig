const std = @import("std");
const napigen = @import("napigen");

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
    b.installArtifact(exe);

    // N-API shared library (loaded by Node.js)
    const lib = b.addLibrary(.{
        .name = "faraday_napi",
        .linkage = .dynamic,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/napi.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    napigen.setup(lib);
    if (target.result.os.tag == .macos) {
        lib.root_module.linkFramework("CoreServices", .{});
    }
    b.installArtifact(lib);

    // Copy to .node extension so require() can find it
    const copy_node = b.addInstallLibFile(lib.getEmittedBin(), "faraday_napi.node");
    b.getInstallStep().dependOn(&copy_node.step);
}
