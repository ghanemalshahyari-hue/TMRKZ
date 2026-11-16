// FULL acceptance §19 / §27 (owner's specification, 16 Nov 2026) — the one-save setup is all or nothing, checked first, on the
// occupied ground of the camp. As U11 (site setup administrator), through the same endpoints the wizard calls: a refused setup
// writes no site, no stationing and no area. ACCEPTANCE ONLY. Nothing here is kept.
//   node tests/acceptance/full26-setup-atomic.mjs
import { recorder, session, sql, unitId } from './lib/full26-ui.mjs';

const ok = recorder('setup-atomic');
const s = await session('full26.u11');
const sq = (lng, lat, half) => { const dlat = half / 110900, dlng = half / (111320 * Math.cos(lat * Math.PI / 180)); return { type: 'Polygon', coordinates: [[[lng - dlng, lat - dlat], [lng + dlng, lat - dlat], [lng + dlng, lat + dlat], [lng - dlng, lat + dlat], [lng - dlng, lat - dlat]]] }; };
const B = 'وحدة إضافية 1';
const counts = () => [sql(`select count(*) from site`), sql(`select count(*) from org_stationing`), sql(`select count(*) from deployment_area`), sql(`select count(*) from audit_event where action = 'SITE_SETUP_BOOTSTRAPPED'`)].join('/');
const before = counts();
const base = (name, centre, units) => ({
  site: { name, kind: 'معسكر', location: { lat: centre[1], lng: centre[0] }, responsibleOrgId: unitId(B), reason: 'ACCEPTANCE ONLY — فحص الذرية' },
  boundary: { geometry: sq(centre[0], centre[1], 250), crs: 'EPSG:4326', reason: 'ACCEPTANCE ONLY — فحص الذرية', method: 'DRAWN' },
  units, reason: 'ACCEPTANCE ONLY — فحص الذرية: يجب ألا يُحفظ شيء',
});
// 1. a new site on open ground, with a unit whose primary area lies on the camp (occupied ground: م8-2 and م10-1 are stationed there)
const C2 = [55.90, 24.97];
const occupied = base('محاولة ذرية 1', C2, [{ organizationId: unitId(B + ' · م8-1'), primary: sq(55.965, 24.935, 150), alternative: sq(55.965, 24.97, 150) }]);
const chk = await s.api('POST', '/site-setup/check', occupied);
ok(chk.status === 200 && chk.body.ok === false && JSON.stringify(chk.body).includes('أرض مشغولة'), 'ATOMIC-01', 'الفحص قبل الحفظ: منطقة على أرض مشغولة مرفوضة بسببها', JSON.stringify(chk.body.problems ?? chk.body).slice(0, 300));
const save1 = await s.api('POST', '/site-setup', occupied);
ok(save1.status === 400 && counts() === before && sql(`select count(*) from site where name = 'محاولة ذرية 1'`) === '0', 'ATOMIC-02', 'الحفظ مرفوض كله: لا موقع ولا تمركز ولا مناطق (لا حالة نصفية)', `${save1.status} ${(save1.body?.message ?? '').slice(0, 160)} · ${counts()}`);
// 2. a unit already stationed (م8-2 at the camp) → nothing written, not even the site
const stationed = base('محاولة ذرية 2', C2, [{ organizationId: unitId(B + ' · م8-2'), primary: sq(55.965, 24.97, 150), alternative: sq(55.93, 24.99, 150) }]);
const save2 = await s.api('POST', '/site-setup', stationed);
ok(save2.status === 400 && counts() === before, 'ATOMIC-03', 'وحدة متمركزة أصلاً: يُرفض كل شيء', `${save2.status} ${(save2.body?.message ?? '').slice(0, 160)}`);
// 3. a site over the registered camp
const overlap = base('محاولة ذرية 3', [55.965, 24.935], []);
const save3 = await s.api('POST', '/site-setup', overlap);
ok(save3.status >= 400 && counts() === before, 'ATOMIC-04', 'موقع فوق المعسكر المسجل: مرفوض، لا تكرار', `${save3.status} ${(save3.body?.message ?? '').slice(0, 160)}`);
process.exit(0);
