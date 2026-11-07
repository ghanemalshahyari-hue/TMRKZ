// Prints the number of a draft request with a proposed site, for geometry-two-methods.mjs on a loaded acceptance run (reused if present).
import { apiSession } from './browser.mjs';
import { execFileSync } from 'node:child_process';
const sql = (q) => execFileSync('docker', ['exec', process.env.DB_CONTAINER, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-c', q], { encoding: 'utf8' }).trim();
const unit = sql(`select md5('${process.env.ACC_NS}:org:${process.argv[2] ?? 'N-A116'}')::uuid`);
const api = await apiSession(process.env.ACC_USER);
const had = sql(`select number from restationing_request where requesting_unit_id = '${unit}' and state = 'DRAFT' limit 1`);
const square = (lng, lat, d = 0.0015) => ({ type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] });
if (had) {
  const id = sql(`select id from restationing_request where number = '${had}'`);
  const full = (await api.get('/restationing-requests/' + id)).body;
  const [x, y] = (full.content.site.geometry.type === 'Polygon' ? full.content.site.geometry.coordinates[0][0] : full.content.site.geometry.coordinates[0][0][0]);
  const put = await api.put(`/restationing-requests/${id}/content`, { ...full.content, primary: square(x + 0.06, y), alternative: square(x + 0.06, y + 0.036) });
  if (put.status !== 200) throw new Error(JSON.stringify(put.body).slice(0, 300));
  console.log(had);
  process.exit(0);
}
const cur = (await api.get('/stationing/current')).body.find((c) => c.organizationId === unit || c.orgId === unit);
const moved = JSON.parse(JSON.stringify(cur.siteGeometry));
const shift = (r) => r.map((ring) => ring.map(([x, y]) => [x + 0.004, y + 0.004]));
moved.coordinates = moved.type === 'MultiPolygon' ? moved.coordinates.map(shift) : shift(moved.coordinates);
const r = await api.post('/restationing-requests', { requestingUnitId: unit, content: { kind: 'PERMANENT', scope: [unit], reason: 'مسودة لاختبار القبول — وهمي', site: { geometry: moved } } });
if (r.status !== 200) throw new Error(JSON.stringify(r.body).slice(0, 300));
console.log(r.body.number);
