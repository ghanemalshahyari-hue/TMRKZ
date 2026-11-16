// FULL END-TO-END ACCEPTANCE (owner, 16 Nov 2026) on http://localhost:8088, as the signed-in administrator (the owner's
// browser session is borrowed read-only through CDP; nothing is typed into it). Idempotent. Everything set here is
// «ACCEPTANCE ONLY — OWNER DECISION PENDING»: the owner's acceptance values of 4 Nov 2026 (primary 5–8 km, alternative 3–5 km,
// terrain allowances 0/500/1000/1500/2000 m with the mountainous class first, footprint 0.5 km², deployment areas required),
// a routing of levels for the demo branch, the stages after the climb, and the permission request's path.
//   node tests/acceptance/full26-setup.mjs <repo root> [--dry]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [root, flag] = process.argv.slice(2);
const dry = flag === '--dry';
const { chromium } = await import(pathToFileURL(`${root}/tests/acceptance/node_modules/playwright-core/index.mjs`).href);
const b = await chromium.connectOverCDP('http://127.0.0.1:9345');
const page = b.contexts()[0].pages().find((x) => x.url().includes('8088'));
if (!page) throw new Error('no :8088 page in the signed-in browser');
const call = (method, url, body) => page.evaluate(async ([m, u, x]) => {
  const r = await fetch('/api/v1' + u, { method: m, headers: { 'X-Requested-With': 'mover', 'Content-Type': 'application/json' }, body: x === undefined ? undefined : JSON.stringify(x) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}, [method, url, body]);
const LABEL = 'ACCEPTANCE ONLY — OWNER DECISION PENDING';

// 1. the stationing policy
const inForce = (await call('GET', '/stationing/policy')).body?.inForce;
if (inForce?.values?.approvalStages && String(inForce.reference ?? '').includes('FULL26')) {
  console.log('policy: acceptance version already in force:', inForce.version);
} else {
  const t = JSON.parse(readFileSync(`${root}/ops/test-env/acceptance-v3-policy-template.json`, 'utf8'));
  const values = { ...t };
  for (const k of ['_note', 'reason', 'reference']) delete values[k];
  values.terrainSlopeClassification.datasetVersion = '2026.11';
  values.maxFootprintAreaM2 = 500000;
  values.deploymentRequirement = 'REQUIRED';
  values.primary = { ...values.primary, minM: 5000, maxM: 8000, terrainApplies: true };
  values.alternative = { ...values.alternative, minM: 3000, maxM: 5000, terrainApplies: true };
  values.routing = { startAt: 'SELF', levels: [
    { level: 10, approves: false, label: '', finalStage: false, dependsOn: [] },
    { level: 9, approves: true, label: 'اعتماد المستوى L9', finalStage: false, dependsOn: ['SCOPE', 'SITE', 'DEPLOYMENT'] },
    { level: 8, approves: true, label: 'اعتماد المستوى L8', finalStage: false, dependsOn: ['SCOPE', 'SITE', 'DEPLOYMENT'] },
    { level: 7, approves: true, label: 'اعتماد المستوى L7', finalStage: true, dependsOn: [] },
  ] };
  values.deploymentAreaDefault = { shape: 'SQUARE', areaM2: 90000 };
  values.approvalStages = { unitOperations: true, finalByPermission: true, fyiBeforeActivation: true };
  values.exception = { allowed: false, maxExtraM: 0 };
  const check = await call('POST', '/stationing/policy/validate', { values });
  console.log('policy check:', check.status, JSON.stringify(check.body).slice(0, 300));
  if (!dry) {
    const r = await call('POST', '/stationing/policy/versions', { values, reason: `${LABEL}: قيم قبول المالك في 4 نوفمبر 2026 لاختبار القبول الشامل`, reference: 'FULL26-ACCEPTANCE' });
    if (r.status !== 200) throw new Error('policy: ' + JSON.stringify(r.body).slice(0, 600));
    console.log('policy published, version', r.body.version?.version ?? r.body.version);
  }
}

// 2. the permission request's type and path (review by the unit's access manager, then the final approval)
const list = async () => (await call('GET', '/workflows')).body;
let access = (await list()).find((w) => w.requestType.kind === 'ACCESS');
if (!access && !dry) {
  const made = await call('POST', '/request-types', { name: 'طلب صلاحيات', kind: 'ACCESS' });
  if (made.status !== 200) throw new Error('type: ' + JSON.stringify(made.body).slice(0, 400));
  access = (await list()).find((w) => w.requestType.kind === 'ACCESS');
}
if (access && !access.published && !dry) {
  const step = (id, name, role, y) => ({ id, type: 'approval', name, x: 300, y, mode: 'ANY', slaDays: 3, assignees: [{ role, orgFrom: 'BY_SCOPE' }], final: id === 'fin', requiresSignature: false });
  const graph = {
    nodes: [{ id: 'st', type: 'start', name: 'بداية الطلب', x: 300, y: 0 }, step('rev', 'مراجعة مدير صلاحيات الوحدة', 'UNIT_ACCESS_MANAGER', 150),
      step('fin', 'اعتماد طلبات الصلاحية', 'ACCESS_FINAL_APPROVER', 320), { id: 'ok', type: 'end_approved', name: 'معتمد', x: 300, y: 480 }],
    edges: [{ from: 'st', to: 'rev' }, { from: 'rev', to: 'fin', when: 'approved' }, { from: 'fin', to: 'ok', when: 'approved' }],
  };
  const draft = await call('POST', `/workflows/${access.id}/drafts`, { definition: { name: 'طلب صلاحيات', stages: [], execution: [], graph } });
  if (draft.status !== 200) throw new Error('draft: ' + JSON.stringify(draft.body).slice(0, 400));
  const live = await call('POST', `/workflow-versions/${draft.body.id}/publish`, {});
  if (live.status !== 200) throw new Error('publish: ' + JSON.stringify(live.body).slice(0, 400));
  console.log('access path published');
} else {
  console.log('access path:', access ? (access.published ? 'already published' : 'not published (dry run)') : 'no type yet (dry run)');
}
// the owner's browser stays as it was: only this connection ends
process.exit(0);
