import { describe, expect, it } from 'vitest';
import type { Permission, RestationingChecks, RestationingRequest, RestationingStage } from '../api/types';
import { moreNav, primaryNav, restriction } from './navigation';
import { deploymentRows, movementInfo, pathOf, routeStrip, treeRows } from './workspace';

const stage = (key: string, label: string, unit: string, extra: Partial<RestationingStage> = {}): RestationingStage => ({
  key, kind: 'HIERARCHY', label, unit: { id: unit, name: unit }, satisfies: [], final: false, mark: null, current: false, decidedBy: null, decidedAt: null, ...extra,
});
const base = {
  id: 'r1', number: 'RS-1', state: 'UNDER_REVIEW', requestingUnit: { id: 'u7', name: 'وحدة الطلب' }, requester: { id: 'p', name: 'مقدم' },
  content: { kind: 'PERMANENT', scope: [], site: null, primary: null, alternative: null, reason: '' }, units: [], currentSites: [], policyVersion: 1,
  routeNo: 1, previousRoutes: [], revisions: [{ n: 1, submittedAt: '2026-11-05T08:00:00Z', submittedBy: 'مقدم', changed: [], reason: null, invalidated: [], carried: [], routeNo: 1, policyVersion: 1 }],
  returned: null, paused: null, finalApprover: null, can: { edit: false, submit: false, decide: false, activate: false },
} as unknown as RestationingRequest;
const req = (patch: Partial<RestationingRequest>) => ({ ...base, ...patch }) as RestationingRequest;

describe('approval strip = the request route (UI rebuild brief, §15)', () => {
  it('lists the requester, exactly the stages of the route in order, then the independent activation', () => {
    const route = [
      stage('L9', 'اعتماد المستوى L9', 'قسم', { mark: 'APPROVED', decidedBy: { id: 'a', name: 'أحمد' }, decidedAt: '2026-11-05T09:00:00Z' }),
      stage('L8', 'اعتماد المستوى L8', 'إدارة', { mark: 'CARRIED', decidedBy: { id: 'b', name: 'باسل' } }),
      stage('L7', 'اعتماد المستوى L7', 'قطاع', { current: true }),
      stage('L6', 'اعتماد المستوى L6', 'الجهة', { final: true }),
    ];
    const { nodes, expected } = routeStrip(req({ route }), null);
    expect(expected).toBe(false);
    expect(nodes.map((n) => n.label)).toEqual(['مقدم الطلب', 'اعتماد المستوى L9', 'اعتماد المستوى L8', 'اعتماد المستوى L7', 'اعتماد المستوى L6', 'التفعيل']);
    expect(nodes.map((n) => n.status)).toEqual(['done', 'done', 'carried', 'current', 'upcoming', 'upcoming']);
    expect(nodes[1].person).toBe('أحمد');
    expect(nodes[4].final).toBe(true);
  });

  it('assumes no level: a two-stage route gives two stages', () => {
    const { nodes } = routeStrip(req({ route: [stage('L7', 'اعتماد المستوى L7', 'الخدمات', { current: true }), stage('L6', 'اعتماد المستوى L6', 'المؤسسة', { final: true })] }), null);
    expect(nodes.filter((n) => n.key.startsWith('L'))).toHaveLength(2);
  });

  it('marks a rejection, a return and a pending activation from the state', () => {
    const route = [stage('L7', 'اعتماد المستوى L7', 'x', { mark: 'APPROVED' }), stage('L6', 'اعتماد المستوى L6', 'y', { final: true })];
    expect(routeStrip(req({ route, state: 'REJECTED' }), null).nodes[2].status).toBe('rejected');
    const ret = routeStrip(req({ route, state: 'RETURNED_FOR_CHANGES', returned: { byName: 'م', stageLabel: 'اعتماد المستوى L6', reason: 'ع', at: '' } }), null).nodes;
    expect(ret[0].status).toBe('current');
    expect(ret[2].status).toBe('returned');
    const approved = routeStrip(req({ route: route.map((s) => ({ ...s, mark: 'APPROVED' as const })), state: 'APPROVED_NOT_ACTIVATED' }), null).nodes;
    expect(approved.at(-1)!.status).toBe('current');
  });

  it('shows the route the server expects before the first submission', () => {
    const checks = { ok: true, problems: [], policyVersion: 1, route: [{ key: 'L7', kind: 'HIERARCHY', label: 'اعتماد المستوى L7', unit: { id: 'x', name: 'x' }, satisfies: [], final: true }] } as unknown as RestationingChecks;
    const { nodes, expected } = routeStrip(req({ state: 'DRAFT', revisions: [], route: [] }), checks);
    expect(expected).toBe(true);
    expect(nodes.map((n) => [n.label, n.status])).toEqual([['مقدم الطلب', 'current'], ['اعتماد المستوى L7', 'upcoming'], ['التفعيل', 'upcoming']]);
  });
});

describe('deployment check card (§3, §18)', () => {
  const legs = [
    { leg: 'primary', label: 'p', status: 'OK', distanceM: 6300, baseMinM: 5000, baseMaxM: 8000, effectiveMinM: 5000, effectiveMaxM: 9500, exceptionMaxM: null, method: 'm', conflicts: [],
      terrain: { controllingClass: 'HILLY', controllingLabel: 'HILLY', shares: [], tie: false, tied: [], resolved: true, priority: [], allowanceM: 1500, dataset: 'd', surfaceModel: 'DSM' } },
    { leg: 'alternative', label: 'a', status: 'NEEDS_EXCEPTION', distanceM: 5600, baseMinM: 3000, baseMaxM: 5000, effectiveMinM: 3000, effectiveMaxM: 5000, exceptionMaxM: 7000, method: 'm', conflicts: [] },
  ];
  const rows = deploymentRows({ ok: false, problems: [], policyVersion: 1, legs } as unknown as RestationingChecks);

  it('shows each leg with the server\'s distance, the policy range, the terrain allowance and the effective maximum', () => {
    expect(rows.map((r) => r.leg)).toEqual(['primary', 'alternative']);
    expect(rows[0].distance).toBe('6.3 كم');
    expect(rows[0].verdict).toBe('ضمن 5–8 كم (حتى 9.5 كم مع الأرض)');
    expect(rows[0].terrain).toBe('HILLY +1.5 كم');
    expect(rows[0].effectiveMax).toBe('9.5 كم');
    expect(rows[1].range).toBe('3–5 كم');
    expect(rows[1].verdict).toBe('تحتاج استثناء مسافة الانتشار');
    expect(rows[1].exception).toBe(true);
    const out = deploymentRows({ ok: false, problems: [], policyVersion: 1, legs: [{ ...legs[1], status: 'OUT_OF_RANGE', distanceM: 2000 }] } as unknown as RestationingChecks);
    expect(out[0].verdict).toBe('خارج 3–5 كم');
    expect(out[0].tone).toBe('bad');
  });

  it('never words an exception as a re-stationing distance and has no row for the re-stationing move', () => {
    expect(JSON.stringify(rows)).not.toContain('إعادة التمركز');
    expect(deploymentRows({ ok: true, problems: [], policyVersion: 1, legs: [] } as unknown as RestationingChecks)).toEqual([]);
  });

  it('gives the re-stationing move a distance only: no range, no verdict', () => {
    const sq = (lng: number) => ({ type: 'Polygon', coordinates: [[[lng, 25], [lng + 0.01, 25], [lng + 0.01, 25.01], [lng, 25.01], [lng, 25]]] });
    const info = movementInfo(req({ currentSites: [{ unit: 'u', site: { id: 's', name: 'الحالي' }, geometry: sq(55) }], content: { ...base.content, site: { geometry: sq(55.5) as never } } }));
    expect(info).toHaveLength(1);
    expect(Object.keys(info[0]).sort()).toEqual(['from', 'km']);
    expect(info[0].km).toMatch(/كم$/);
  });
});

describe('organisation tree from the server data (§12)', () => {
  const units = [
    { id: 'root', name: 'الجهة الرئيسية', parentId: null },
    { id: 's1', name: 'قطاع العمليات', parentId: 'root' },
    { id: 'd1', name: 'إدارة التمركز', parentId: 's1' },
    { id: 'u1', name: 'وحدة (أ)', parentId: 'd1' },
    { id: 'u2', name: 'وحدة (ب)', parentId: 'd1' },
    { id: 's2', name: 'قطاع الدعم', parentId: 'root' },
    { id: 'x1', name: 'قسم الدعم', parentId: 's2' },
  ];

  it('keeps the server order and parents, opens the branch to the requesting unit and highlights it', () => {
    const rows = treeRows(units, { requesting: 'd1', moving: ['u1'] });
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ['الجهة الرئيسية', 0], ['قطاع العمليات', 1], ['إدارة التمركز', 2], ['قطاع الدعم', 1],
    ]);
    expect(rows.find((r) => r.id === 'd1')!.highlight).toBe('requesting');
    expect(rows.find((r) => r.id === 's2')!.open).toBe(false);
  });

  it('expands and collapses on demand', () => {
    const open = treeRows(units, { requesting: 'd1', moving: ['u1'], toggled: new Set(['d1', 's2']) });
    expect(open.map((r) => r.id)).toEqual(['root', 's1', 'd1', 'u1', 'u2', 's2', 'x1']);
    expect(open.find((r) => r.id === 'u1')!.highlight).toBe('moving');
    expect(pathOf(units, 'u2').map((p) => p.name)).toEqual(['الجهة الرئيسية', 'قطاع العمليات', 'إدارة التمركز', 'وحدة (ب)']);
  });
});

describe('permission-hidden navigation (§4, §14)', () => {
  const can = (...p: Permission[]) => (x: Permission) => p.includes(x);

  it('offers a requester only what their rights open', () => {
    const rq = can('VIEW', 'CREATE', 'EDIT', 'EXECUTE', 'CREATE_RESTATIONING');
    const views = [...primaryNav(rq, false), ...moreNav(rq, false)].map((l) => l.view);
    expect(views).not.toContain('permissions');
    expect(views).not.toContain('audit');
    expect(views).not.toContain('stationingPolicy');
    expect(views).not.toContain('settings');
    expect(views[0]).toBe('home');
  });

  it('shows the audit report and the permissions centre only with their rights', () => {
    const auditor = can('VIEW', 'AUDIT');
    expect(primaryNav(auditor, false).find((l) => l.label === 'التقارير')!.view).toBe('audit');
    expect(restriction('permissions', auditor, false)).toBe(true);
    const admin = can('MANAGE_ACCESS', 'CONFIGURE');
    expect(moreNav(admin, false).map((l) => l.view)).toContain('permissions');
    // a single-action holder sees no list page it cannot open
    const activator = can('ACTIVATE_STATIONING');
    expect(primaryNav(activator, false).map((l) => l.view)).toEqual(['home']);
  });
});
