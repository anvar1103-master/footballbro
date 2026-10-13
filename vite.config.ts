import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base './' so the built game works from any sub-path (GitHub Pages, artifact hosting, file server).
// Two pages: index.html = footballbro (party edition), classic.html = the older FIFA-style game.
// VITE_ENTRY=index|classic builds a single page (used by scripts/build-single.py).
const entry = process.env.VITE_ENTRY;
const input = entry ? { [entry]: resolve(__dirname, `${entry}.html`) } : { index: resolve(__dirname, 'index.html'), classic: resolve(__dirname, 'classic.html') };

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, rollupOptions: { input } },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
