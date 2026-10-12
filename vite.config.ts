import { defineConfig } from 'vite';

// base './' so the built game works from any sub-path (GitHub Pages, artifact hosting, file server)
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
