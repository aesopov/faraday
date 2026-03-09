import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // ws has optional native deps (bufferutil, utf-8-validate) that
      // can't be bundled — keep it as a Node.js require at runtime.
      external: ['ws'],
    },
  },
});
