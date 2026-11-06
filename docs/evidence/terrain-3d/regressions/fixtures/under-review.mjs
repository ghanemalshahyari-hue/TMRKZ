// Creates (and, with SUBMIT=1, submits) ONE fictional re-stationing request for the ui-rebuild regression's
// «under review» fixture: t.requester moves the fictional section DEV-SS-1 (requesting unit HR-T-SS). Fictional data only.
import { signIn, square, towards, M_LAT } from './api.mjs';
const rq = await signIn('t.requester');
const cur = (await rq.get('/stationing/current')).body;
const unit = cur.find((c) => c.orgName === 'قسم الخدمات العامة (وهمي)');
const ss = cur.find((c) => c.orgName === 'الخدمات المشتركة');
const shiftN = 1500 / M_LAT;
const site = { type: 'MultiPolygon', coordinates: unit.siteGeometry.coordinates.map((p) => p.map((r) => r.map(([x, y]) => [x, y + shiftN]))) };
const anchor = { lat: 25.10135 + shiftN, lng: 56.0020 };
const pc = towards(anchor, 100, 6300);
const ac = towards(pc, 20, 4000);
const content = {
  kind: 'PERMANENT', scope: [unit.orgId], site: { geometry: site, shape: 'DRAWN' },
  primary: square(pc.lat, pc.lng, 150), alternative: square(ac.lat, ac.lng, 150),
  reason: 'طلب اختبار انحدار قيد المراجعة — بيانات تطوير وهمية، ليس طلب عمل (DEV-REGRESSION)',
};
let id = process.env.ID;
if (!id) {
  const r = await rq.post('/restationing-requests', { requestingUnitId: ss.orgId, content });
  console.log('create', r.status, r.body.number, r.body.id, r.body.state);
  id = r.body.id;
}
const c = (await rq.get(`/restationing-requests/${id}/checks`)).body;
console.log('checks ok', c.ok, c.problems, (c.legs ?? []).map((l) => `${l.leg} ${l.distanceM} ${l.status} ${l.effectiveMinM}-${l.effectiveMaxM} ${l.terrain?.controllingClass}+${l.terrain?.allowanceM}`), 'route', (c.route ?? []).map((s) => s.label + '/' + s.unit?.code));
if (process.env.SUBMIT === '1' && c.ok) {
  const s = await rq.post(`/restationing-requests/${id}/submit`, {});
  console.log('submit', s.status, s.body.number, s.body.state, (s.body.route ?? []).map((x) => x.label + '/' + x.unit?.code).join(' <- '));
}
