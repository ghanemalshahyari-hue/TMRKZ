import { defineConfig } from 'vite';

// Served over a local static server (dev/preview) — air-gap is proven by blocking non-localhost requests,
// not by file:// opening. Default base keeps MapLibre's bundled web worker URL resolvable.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5190 },
  preview: { host: '127.0.0.1', port: 5191 },
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
});
