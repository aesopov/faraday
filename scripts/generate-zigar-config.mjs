#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const PLATFORM_TARGETS = {
  darwin: [
    { platform: "darwin", arch: "x64" },
    { platform: "darwin", arch: "arm64" },
  ],
  linux: [
    { platform: "linux", arch: "x64" },
    { platform: "linux", arch: "arm64" },
  ],
  win32: [{ platform: "win32", arch: "x64" }],
};

const { values } = parseArgs({
  options: {
    platform: { type: "string" },
  },
});

let targets;

if (values.platform) {
  // CI mode: generate targets for specified platform(s)
  const platforms = values.platform.split(",");
  targets = platforms.flatMap((p) => {
    const t = PLATFORM_TARGETS[p];
    if (!t) throw new Error(`Unknown platform: ${p}`);
    return t;
  });
} else {
  // Local mode: current platform + arch only
  targets = [{ platform: process.platform, arch: process.arch }];
}

const config = {
  optimize: "ReleaseSmall",
  modules: {
    "lib/fs.zigar": {
      source: "zig/src/fs_zigar.zig",
    },
  },
  targets,
};

writeFileSync("node-zigar.config.json", JSON.stringify(config, null, 2) + "\n");
console.log(
  "Generated node-zigar.config.json with targets:",
  targets.map((t) => `${t.platform}/${t.arch}`).join(", "),
);
