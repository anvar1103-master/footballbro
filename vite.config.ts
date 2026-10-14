import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base './' so the built game works from any sub-path (GitHub Pages, artifact hosting, file server).
// Pages: index.html = Golazo (current game), party.html = Footballbro, classic.html = Soccerbro.
// VITE_ENTRY=index|party|classic builds a single page (used by scripts/build-single.py).
const entry = process.env.VITE_ENTRY;
const input = entry ? { [entry]: resolve(__dirname, `${entry}.html`) } : { index: resolve(__dirname, 'index.html'), party: resolve(__dirname, 'party.html'), classic: resolve(__dirname, 'classic.html') };

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, rollupOptions: { input } },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
