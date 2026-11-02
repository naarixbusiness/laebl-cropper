import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the app works when hosted under a sub-folder too.
  base: './',
  // pdf.js is big; this is a local tool, so one large bundle is fine.
  build: { chunkSizeWarningLimit: 1500 },
});
