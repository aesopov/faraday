#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

let targets = [{ platform: process.platform, arch: process.arch }];

const config = {
  optimize: 'ReleaseSmall',
  modules: {
    'lib/fs.zigar': {
      source: 'zig/src/fs_zigar.zig',
    },
  },
  targets,
};

writeFileSync('node-zigar.config.json', JSON.stringify(config, null, 2) + '\n');
console.log('Generated node-zigar.config.json with targets:', targets.map((t) => `${t.platform}/${t.arch}`).join(', '));
