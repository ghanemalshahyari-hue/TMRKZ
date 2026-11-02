// Stationing UX prototype (owner brief of 2 Nov 2026, stage 2). Runs with the frontend's own installed packages — no new
// dependency is added — and imports the real polygon engine, symbol renderer, fonts and design-system stylesheet from
// frontend/src without changing them. Fictional data only; no server.
// Usage (from the repository root): node frontend/node_modules/vite/bin/vite.js --config prototypes/stationing-ux/vite.config.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const fe = path.join(repo, 'frontend');
const nm = (p) => path.join(fe, 'node_modules', p);
const { default: react } = await import(pathToFileURL(nm('@vitejs/plugin-react/dist/index.js')).href);

export default {
  root: here,
  publicDir: path.join(fe, 'public'),
  plugins: [react()],
  resolve: {
    // one copy of each library, shared with the imported frontend modules
    alias: [
      { find: /^react-dom(\/.*)?$/, replacement: nm('react-dom') + '$1' },
      { find: /^react(\/.*)?$/, replacement: nm('react') + '$1' },
      { find: /^leaflet(\/.*)?$/, replacement: nm('leaflet') + '$1' },
      { find: /^milsymbol(\/.*)?$/, replacement: nm('milsymbol') + '$1' },
    ],
  },
  server: { host: '127.0.0.1', port: 5194, strictPort: true, fs: { allow: [repo] } },
  build: { target: 'es2022', outDir: path.join(here, 'dist'), emptyOutDir: true },
  test: { root: here, include: ['src/**/*.test.ts'] },
};
