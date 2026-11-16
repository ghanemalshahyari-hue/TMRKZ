// FULL END-TO-END ACCEPTANCE (owner, 16 Nov 2026) — ACCEPTANCE ONLY. Adds the 14 fictional accounts full26.u01…u14 (created in
// the stand-in directory by ops/acceptance-main/full26-ldap.sh) to their units with «إضافة مستخدم» ← «بدون ربط الموارد», and
// gives their roles, through the same server calls «إدارة الصلاحيات والوحدات» makes, as the signed-in administrator (the
// owner's browser session borrowed read-only through CDP). Idempotent: a person already added or a role already held is kept.
//   node tests/acceptance/full26-users.mjs <repo root>
import { pathToFileURL } from 'node:url';

const [root] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(`${root}/tests/acceptance/node_modules/playwright-core/index.mjs`).href);
const b = await chromium.connectOverCDP('http://127.0.0.1:9345');
const page = b.contexts()[0].pages().find((x) => x.url().includes('8088'));
if (!page) throw new Error('no :8088 page in the signed-in browser');
const call = (method, url, body) => page.evaluate(async ([m, u, x]) => {
  const r = await fetch('/api/v1' + u, { method: m, headers: { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' }, body: x === undefined ? undefined : JSON.stringify(x) });
  const t = await r.text();
  let body = null;
  try { body = t ? JSON.parse(t) : null; } catch { body = t; }
  return { status: r.status, body };
}, [method, url, body]);

const orgs = (await call('GET', '/organizations/tree')).body ?? [];
const flat = [];
const walk = (n) => { flat.push(n); (n.children ?? []).forEach(walk); };
(Array.isArray(orgs) ? orgs : [orgs]).forEach(walk);
const unit = (name) => {
  const u = flat.find((o) => o.name === name);
  if (!u) throw new Error('unit not found: ' + name);
  return u.id;
};
const B = 'وحدة إضافية 1';
const one = (n) => ({ kind: 'ORGANIZATION', id: unit(n), includeDescendants: false });
const branch = (n) => ({ kind: 'ORGANIZATION', id: unit(n), includeDescendants: true });
const levels = (n, ls) => ({ kind: 'ORGANIZATION', id: unit(n), includeDescendants: true, levels: ls });
const ALL = { mode: 'CUSTOM', all: true, targets: [] };
const custom = (...targets) => ({ mode: 'CUSTOM', targets });

// who sits where and holds what (the acceptance recipe); every value ACCEPTANCE ONLY — OWNER DECISION PENDING
const USERS = [
  ['01', 'وحدة إضافية 1', [['SITE_SETUP_ADMIN', ALL], ['ACCESS_FINAL_APPROVER', ALL]]],
  ['02', `${B} · م10-1`, [['STATIONING_REQUESTER', custom(one(`${B} · م10-1`))]]],
  ['03', `${B} · م9-3`, [['CHAIN_APPROVER', custom(one(`${B} · م9-3`))]]],
  ['04', `${B} · م8-3`, [['CHAIN_APPROVER', custom(branch(`${B} · م8-3`))]]],
  ['05', `${B} · م10-3`, [['STATIONING_REQUESTER', custom(one(`${B} · م10-3`))]]],
  ['06', `${B} · م9-4`, [['STATIONING_REQUESTER', custom(one(`${B} · م9-4`))]]],
  ['07', B, [['UNIT_OPERATIONS_APPROVER', custom(branch(B))]]],
  ['08', B, [['FINAL_APPROVER', custom(levels(B, [10]))]]],
  ['09', B, [['FINAL_APPROVER', custom(levels(B, [9]))]]],
  ['10', B, [['FYI_DISTRIBUTOR', custom(branch(B))]]],
  ['11', `${B} · م8-6`, [['FYI_RECEIVER', custom(one(`${B} · م8-6`))]]],
  ['12', B, [['STATIONING_ACTIVATOR', custom(branch(B))]]],
  ['13', B, [['POSTURE_VIEWER', custom(branch(B))]]],
  ['14', `${B} · م10-2`, []],
];

const report = [];
for (const [n, unitName, roles] of USERS) {
  const login = `full26.u${n}`;
  const orgId = unit(unitName);
  const added = await call('POST', '/access/unit-members', { organizationId: orgId, userId: login, displayName: `مستخدم قبول ${n}` });
  if (added.status !== 200) throw new Error(`${login} add: ${added.status} ${JSON.stringify(added.body).slice(0, 300)}`);
  const personId = added.body.personId;
  const line = [login, unitName, added.body.created ? 'added' : 'already there'];
  for (const [role, scope] of roles) {
    const g = await call('POST', '/memberships', { personId, organizationId: orgId, roleCode: role, scope });
    line.push(`${role}: ${g.status === 200 ? 'granted' : g.status + ' ' + JSON.stringify(g.body).slice(0, 160)}`);
  }
  report.push(line.join(' · '));
}
console.log(report.join('\n'));
process.exit(0);
