#!/usr/bin/env node
/**
 * Build Rust native modules (faraday-napi + frdye).
 *
 * Usage:
 *   node scripts/build-rust.mjs [--release]
 *
 * Outputs:
 *   native/faraday_napi.node   — N-API addon
 *   native/frdye               — elevated helper binary
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const RUST_DIR = join(ROOT, 'rust');
const NATIVE_DIR = join(ROOT, 'native');

const release = process.argv.includes('--release');
const profile = release ? '--release' : '';
const targetDir = join(RUST_DIR, 'target', release ? 'release' : 'debug');

// Platform-specific library names
const platform = process.platform;
const libPrefix = platform === 'win32' ? '' : 'lib';
const libExt = platform === 'darwin' ? '.dylib' : platform === 'win32' ? '.dll' : '.so';
const binExt = platform === 'win32' ? '.exe' : '';

console.log(`Building Rust workspace (${release ? 'release' : 'debug'})…`);
execSync(`cargo build -p faraday-napi -p frdye ${profile}`, {
  cwd: RUST_DIR,
  stdio: 'inherit',
});

mkdirSync(NATIVE_DIR, { recursive: true });

// Copy the N-API addon (.dylib/.so/.dll → .node)
const libSrc = join(targetDir, `${libPrefix}faraday_napi${libExt}`);
const libDst = join(NATIVE_DIR, 'faraday_napi.node');
console.log(`Copying ${basename(libSrc)} → native/faraday_napi.node`);
cpSync(libSrc, libDst);

// Copy the frdye binary
const binSrc = join(targetDir, `frdye${binExt}`);
const binDst = join(NATIVE_DIR, `frdye${binExt}`);
console.log(`Copying frdye → native/frdye${binExt}`);
cpSync(binSrc, binDst);

console.log('Done.');
