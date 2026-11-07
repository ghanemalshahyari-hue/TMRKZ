// Fictional setup of the owner-review environment through the server's own API (FICTIONAL / ACCEPTANCE values, never defaults):
// the policy with the configured stages, and the permission request's type and path. Idempotent.
import { readFileSync } from 'node:fs';
import { BASE, apiSession } from './lib/browser.mjs';

const admin = await apiSession('p14.admin');
const inForce = (await admin.get('/stationing/policy')).body?.inForce;
if (!inForce?.values?.approvalStages) {
  const t = JSON.parse(readFileSync(new URL('../../ops/test-env/acceptance-v3-policy-template.json', import.meta.url), 'utf8'));
  const values = { ...(t.values ?? t) };
  for (const k of ['_note', 'reason', 'reference']) delete values[k];
  values.terrainSlopeClassification.datasetVersion = process.env.TERRAIN_VERSION ?? '2026.11-dev-unverified';
  values.maxFootprintAreaM2 = 200000;
  values.deploymentRequirement = 'REQUIRED';
  values.primary = { ...values.primary, minM: 5000, maxM: 8000, terrainApplies: true };
  values.alternative = { ...values.alternative, minM: 3000, maxM: 5000, terrainApplies: true };
  values.routing = { startAt: 'SELF', levels: [
    { level: 9, approves: false, label: 'الشعبة', finalStage: false, dependsOn: [] },
    { level: 8, approves: true, label: 'اعتماد المستوى L8', finalStage: false, dependsOn: ['SCOPE', 'SITE', 'DEPLOYMENT'] },
    { level: 7, approves: true, label: 'اعتماد المستوى L7', finalStage: true, dependsOn: [] },
  ] };
  values.deploymentAreaDefault = { shape: 'SQUARE', areaM2: 90000 };
  values.approvalStages = { unitOperations: true, finalByPermission: true, fyiBeforeActivation: true };
  const r = await admin.post('/stationing/policy/versions', { values, reason: 'سياسة قبول وهمية لمراجعة المالك', reference: 'FICTIONAL / ACCEPTANCE' });
  if (r.status !== 200) throw new Error('policy: ' + JSON.stringify(r.body).slice(0, 600));
  console.log('policy version', r.body.version?.version);
}
const list = async () => (await admin.get('/workflows')).body;
let access = (await list()).find((w) => w.requestType.kind === 'ACCESS');
if (!access) {
  const made = await admin.post('/request-types', { name: 'طلب صلاحيات', kind: 'ACCESS' });
  if (made.status !== 200) throw new Error('type: ' + JSON.stringify(made.body).slice(0, 400));
  access = (await list()).find((w) => w.requestType.kind === 'ACCESS');
}
if (!access.published) {
  const step = (id, name, role, x) => ({ id, type: 'approval', name, x: 300, y: x, mode: 'ANY', slaDays: 3, assignees: [{ role, orgFrom: 'BY_SCOPE' }], final: id === 'fin', requiresSignature: false });
  const graph = {
    nodes: [{ id: 'st', type: 'start', name: 'بداية الطلب', x: 300, y: 0 }, step('rev', 'مراجعة مدير صلاحيات الوحدة', 'UNIT_ACCESS_MANAGER', 150), step('fin', 'اعتماد طلبات الصلاحية', 'ACCESS_FINAL_APPROVER', 320), { id: 'ok', type: 'end_approved', name: 'معتمد', x: 300, y: 480 }],
    edges: [{ from: 'st', to: 'rev' }, { from: 'rev', to: 'fin', when: 'approved' }, { from: 'fin', to: 'ok', when: 'approved' }],
  };
  const draft = await admin.post(`/workflows/${access.id}/drafts`, { definition: { name: 'طلب صلاحيات', stages: [], execution: [], graph } });
  if (draft.status !== 200) throw new Error('draft: ' + JSON.stringify(draft.body).slice(0, 400));
  const live = await admin.post(`/workflow-versions/${draft.body.id}/publish`, {});
  if (live.status !== 200) throw new Error('publish: ' + JSON.stringify(live.body).slice(0, 400));
  console.log('access path published');
}
console.log('owner review set up on', BASE);
