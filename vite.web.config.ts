import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      src: path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
      },
    },
  },
});
