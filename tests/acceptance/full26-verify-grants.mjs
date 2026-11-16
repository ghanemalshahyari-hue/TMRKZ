// FULL acceptance §21 — the saved grants equal what /me says, what the database holds and what OpenFGA decides.
// For each persona: the grants in the database (membership), the grants /me returns to that person's own real session, and
// the published decision against OpenFGA's own answer (GET /access/explain, which asks OpenFGA) at a unit inside the scope and
// one outside it. Read-only. Writes ops/acceptance-main/.generated/evidence/grants.json and docs/.../grants-summary.json.
//   node tests/acceptance/full26-verify-grants.mjs
import { writeFileSync } from 'node:fs';
import { DOCS, PRIVATE, recorder, session, sql, unitId } from './lib/full26-ui.mjs';

const ok = recorder('grants');
const B = 'وحدة إضافية 1';
const U = (n) => `${B} · ${n}`;
const OTHER = 'وحدة إضافية 3';
// persona, action, unit inside, unit outside
const CHECKS = [
  [1, 'CREATE_INITIAL_STATIONING', U('م10-1'), U('م10-2')],
  [1, 'CREATE_INITIAL_STATIONING', U('م10-3'), U('م9-1')],
  [2, 'APPROVE_HIERARCHY', U('م9-3'), U('م8-5')],
  [2, 'APPROVE_HIERARCHY', U('م9-1'), U('م9-4')],
  [3, 'DECIDE_UNIT_OPERATIONS', U('م10-1'), OTHER],
  [4, 'FINAL_APPROVE_STATIONING', U('م10-1'), U('م9-4')],
  [5, 'FINAL_APPROVE_STATIONING', U('م9-4'), U('م10-1')],
  [6, 'MANAGE_FYI_DISTRIBUTION', U('م10-1'), OTHER],
  [7, 'VIEW_SUMMARY', U('م8-6'), U('م8-2')],
  [8, 'VIEW_SUMMARY', U('م8-2'), U('م8-6')],
  [9, 'ACTIVATE_STATIONING', U('م10-1'), OTHER],
  [10, 'VIEW_OPERATIONAL_POSTURE', U('م10-1'), OTHER],
  [11, 'CORRECT_STATIONING', OTHER, null],
  [11, 'MANAGE_FACILITIES', U('م10-1'), null],
  [12, 'REQUEST_SITE_REGISTRATION', U('م9-4'), U('م9-3')],
  [13, 'VIEW_OPERATIONAL_POSTURE', OTHER, B],
  [14, 'MANAGE_ACCESS', U('م10-1'), OTHER],
];
const login = (n) => 'full26.u' + String(n).padStart(2, '0');
const admin = await session('admin');
const out = { at: new Date().toISOString(), people: {} };
for (let n = 1; n <= 14; n++) {
  const db = sql(`select m.role_code || ' @ ' || o.name || ' · ' || m.scope_mode || case when m.scope_all then ' ALL' else '' end || coalesce(' · ' || (select string_agg(coalesce(t2.name, t.target_id::text) || case when t.levels is not null and cardinality(t.levels) > 0 then ' L' || array_to_string(t.levels, ',') when t.include_descendants then ' +فروع' else ' وحدها' end, '، ') from membership_scope_target t left join organization t2 on t2.id = t.target_id where t.membership_id = m.id), '') from membership m join person p on p.id = m.person_id join organization o on o.id = m.organization_id where p.username = '${login(n)}' and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()) order by 1`).split('\n').filter(Boolean);
  const s = await session(login(n));
  const me = await s.api('GET', '/me');
  const mine = (me.body?.grants ?? []).map((g) => `${g.roleCode} @ ${g.organization?.name}`).sort();
  const dbRoles = db.map((l) => l.replace(/ · (ROLE|CUSTOM)( ALL)?( · .*)?$/, '')).sort();
  ok(JSON.stringify(mine) === JSON.stringify(dbRoles), `GRANT-ME-${String(n).padStart(2, '0')}`, `${login(n)}: /me = قاعدة البيانات`, db.join(' | '));
  out.people[login(n)] = { db, me: mine };
}
for (const [n, action, inside, outside] of CHECKS) {
  const pid = sql(`select id from person where username = '${login(n)}'`);
  for (const [unit, expect] of [[inside, true], [outside, false]]) {
    if (!unit) continue;
    const ex = await admin.api('GET', `/access/explain?personId=${pid}&organizationId=${unitId(unit)}`);
    const a = (ex.body?.actions ?? []).find((x) => x.action === action);
    const pub = a?.published?.allowed;
    const fga = a?.openfga;
    ok(pub === expect && fga === expect, `GRANT-FGA-${String(n).padStart(2, '0')}-${expect ? 'IN' : 'OUT'}`, `${login(n)} ${action} في «${unit}»: ${expect ? 'مسموح' : 'مرفوض'} في القرار المنشور وفي OpenFGA`, `published=${pub} openfga=${fga} openfgaAvailable=${ex.body?.openfgaAvailable}`);
    (out.people[login(n)].fga ??= []).push({ action, unit, published: pub, openfga: fga });
  }
}
writeFileSync(PRIVATE + 'grants.json', JSON.stringify(out, null, 1));
writeFileSync(DOCS + 'grants-summary.json', JSON.stringify(out, null, 1));
process.exit(0);
