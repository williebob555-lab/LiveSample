import { defineConfig } from 'vite';

// base './' so the built bundle loads from file:// inside Electron.
export default defineConfig({
  base: './',
  server: { port: 5210, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
