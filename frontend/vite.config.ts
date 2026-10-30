import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'], leaflet: ['leaflet'] } } },
  },
  server: {
    port: 5173,
    // MOVER_API=http://localhost:8088 runs the dev server against the test environment's web container
    proxy: {
      '/api': {
        target: (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.MOVER_API ?? 'http://localhost:8080',
        changeOrigin: false,
      },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
