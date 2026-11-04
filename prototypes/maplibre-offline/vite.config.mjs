// Offline MapLibre harness (owner decision 5 of 4 Nov 2026): runs the not-yet-wired frontend module
// frontend/src/components/map/maplibre with the frontend's installed packages, the local font and the local map data in
// map-data/ (git-ignored). Nothing is fetched from the internet.
// Usage (from the repository root): node frontend/node_modules/vite/bin/vite.js --config prototypes/maplibre-offline/vite.config.mjs
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const fe = path.join(repo, 'frontend');
const data = path.join(repo, 'map-data');
const nm = (p) => path.join(fe, 'node_modules', p);
const { default: react } = await import(pathToFileURL(nm('@vitejs/plugin-react/dist/index.js')).href);

/** Serves map-data/ with HTTP range requests (what the PMTiles protocol reads), the way the production web server will. */
function mapData() {
  return {
    name: 'tmrkz-map-data',
    configureServer(server) {
      server.middlewares.use('/map-data', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const file = path.join(data, rel);
        if (!file.startsWith(data + path.sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        const size = statSync(file).size;
        const type = file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'no-store');
        if (!m) {
          res.setHeader('Content-Length', size);
          return createReadStream(file).pipe(res);
        }
        const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
        const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${size}`);
          return res.end();
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}

export default {
  root: here,
  publicDir: path.join(fe, 'public'),
  plugins: [react(), mapData()],
  resolve: {
    // one copy of each library, shared with the imported frontend module
    alias: [
      { find: /^react-dom(\/.*)?$/, replacement: nm('react-dom') + '$1' },
      { find: /^react(\/.*)?$/, replacement: nm('react') + '$1' },
      { find: /^maplibre-gl(\/.*)?$/, replacement: nm('maplibre-gl') + '$1' },
      { find: /^pmtiles(\/.*)?$/, replacement: nm('pmtiles') + '$1' },
    ],
  },
  // MapLibre 6 is one self-contained ES module plus its worker file; served as is, the worker URL imported with `?url`
  // stays the packaged file. The rest is pre-bundled at start-up so the dev server never reloads a page mid-test.
  optimizeDeps: { exclude: ['maplibre-gl'], include: ['pmtiles', 'react', 'react-dom/client', 'react/jsx-dev-runtime'] },
  server: { host: '127.0.0.1', port: 5197, strictPort: true, fs: { allow: [repo] } },
  build: { target: 'es2022', outDir: path.join(here, 'dist'), emptyOutDir: true },
};
