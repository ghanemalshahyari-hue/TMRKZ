// DEVELOPMENT SERVER ONLY (never a build): the production configuration plus the repository's git-ignored map-data/
// (offline basemap and terrain PMTiles) served with HTTP range requests, as the production web server will once the
// map package is released. Usage (Stationing V3 development environment, ops/test-env/README.md):
//   MOVER_API=http://localhost:8097 VITE_STATIONING_V3=true npx vite --config vite.dev.config.mjs --host 127.0.0.1
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from './vite.config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'map-data');

function mapData() {
  return {
    name: 'tmrkz-dev-map-data',
    configureServer(server) {
      server.middlewares.use('/map-data', (req, res, next) => {
        const file = path.join(root, decodeURIComponent((req.url ?? '/').split('?')[0]));
        if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        const size = statSync(file).size;
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'application/octet-stream');
        if (!m) {
          res.setHeader('Content-Length', size);
          createReadStream(file).pipe(res);
          return;
        }
        const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
        const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}

export default { ...base, plugins: [...(base.plugins ?? []), mapData()] };
