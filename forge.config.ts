import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerMSIX } from '@electron-forge/maker-msix';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { cpSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: ['assets'],
    afterCopyExtraResources: [
      (buildPath, _electronVersion, platform, arch, callback) => {
        let resources = join(buildPath, 'resources');
        if (platform === 'darwin') {
          resources = join(buildPath, 'faraday.app', 'Contents', 'Resources');
        }

        cpSync(join('zig', 'zig-out', 'bin'), join(resources), { recursive: true });

        cpSync('lib', join(resources, 'lib'), {
          recursive: true,
          filter: (src) => {
            // if src is a directory, return true to copy it and its contents
            if (lstatSync(src).isDirectory()) return true;

            // only copy files with names {platform}.{arch}.*
            const base = basename(src);
            return base.startsWith(`${platform}.${arch}.`);
          },
        });

        const nodeModules = 'node_modules';
        const libs = ['node-zigar', 'node-zigar-addon', 'zigar-compiler'];
        for (const lib of libs) {
          cpSync(join(nodeModules, lib), join(resources, nodeModules, lib), { recursive: true });
        }
        callback();
      },
    ],
  },
  rebuildConfig: {},
  // makers: [new MakerMSIX({}), new MakerZIP({}, ['darwin', 'linux', 'win32']), new MakerRpm({}), new MakerDeb({})],
  makers: [new MakerZIP({}, ['darwin', 'linux', 'win32'])],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
