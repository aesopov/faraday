import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // ws has optional native deps that Vite tries (and fails) to bundle.
      // Mark them as external so ws itself is still inlined.
      external: ['bufferutil', 'utf-8-validate'],
    },
  },
});
