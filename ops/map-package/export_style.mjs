// Writes the Stationing V3 map style exactly as the application builds it (frontend/src/components/map/maplibre/
// offlineStyle.ts with the served package paths of mapPackage.ts), as canonical JSON for the map package's styles/
// component. The application builds the same style in code at run time; this copy records, with its checksum in the
// package manifest, which style a package was made for. Deterministic: the same source gives the same bytes.
//   node ops/map-package/export_style.mjs <out.json>
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const maplibre = path.join(repo, 'frontend/src/components/map/maplibre');
const out = process.argv[2];
if (!out) {
  console.error('usage: node ops/map-package/export_style.mjs <out.json>');
  process.exit(2);
}
const esbuild = createRequire(path.join(repo, 'frontend/package.json'))('esbuild');
const tmp = mkdtempSync(path.join(tmpdir(), 'tmrkz-style-'));
try {
  const bundle = path.join(tmp, 'style.mjs');
  esbuild.buildSync({
    stdin: {
      contents: `export { buildOfflineStyle } from './offlineStyle.ts'; export * from './mapPackage.ts';`,
      resolveDir: maplibre,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    logLevel: 'error',
  });
  const m = await import(pathToFileURL(bundle).href);
  const style = m.buildOfflineStyle({ basemapUrl: m.BASEMAP_URL, fontUrl: m.MAP_FONT_URL, hillshade: m.HILLSHADE, mode: 'street', labels: 'ar' });
  writeFileSync(out, JSON.stringify(style, null, 2) + '\n', 'utf8');
  console.log(`[style] ${style.layers.length} layers, sources ${Object.keys(style.sources).join(', ')} → ${out}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
