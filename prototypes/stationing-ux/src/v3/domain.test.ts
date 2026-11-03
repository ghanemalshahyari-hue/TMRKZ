import { describe, expect, it } from 'vitest';
import { areaM2, centroid } from '../../../../frontend/src/lib/footprint';
import { distanceM } from '../../../../frontend/src/lib/geo';
import {
  DAY,
  HIERARCHY_CHANGED,
  affectedSites,
  ancestors,
  changedFacts,
  check,
  conflictRings,
  deriveRoute,
  descendants,
  effectiveOf,
  legCheck,
  linkedTo,
  occupantsOf,
  otherBranchOccupants,
  perform,
  permanentOf,
  policyAt,
  presetScope,
  responsibleOf,
  siteOfOrg,
  terrainClassOf,
  terrainShares,
  validate,
  type Action,
  type World,
} from './domain';
import { BASE_POLICY, NOW, baseWorld } from './fixtures';
import { bandOutline, circleRing, measure, nearestPair, pointToRing, ringToRing } from './measure';
import { P, POLICIES, SCENARIOS, content, copyTo, run, scenarioOf } from './scenarios';

/** Runs a scenario and asserts that EVERY step passed its guard (nothing is skipped silently). */
function play(code: string): World {
  let w = baseWorld();
  for (const [who, a] of scenarioOf(code)!.actions) {
    expect(check(w, who, a), code + ' ' + a.t + ' by ' + who).toEqual({ ok: true });
    w = perform(w, who, a);
  }
  return w;
}
const req = (w: World, id: string) => w.requests.find((r) => r.id === id)!;
const act = (w: World, who: string, a: Action) => {
  expect(check(w, who, a)).toEqual({ ok: true });
  return perform(w, who, a);
};
const pub = (w: World, values: typeof BASE_POLICY, at = w.now) => act(w, 'p-admin', { t: 'PUBLISH_POLICY', values, effectiveFrom: at, reason: 'اختبار', reference: 'POL-T' });
const CO = ['u800', 'u901', 'u1001'];

describe('the four separate concepts: Oracle hierarchy, site links, stationing, responsibility (A, B, C, X)', () => {
  it('A — the tree comes from Oracle parent links, levels are Oracle values', () => {
    const w = play('A');
    expect(ancestors(w, 'u1000').map((o) => o.id)).toEqual(['u900', 'u800', 'u700', 'u600']);
    expect(new Set(w.orgs.map((o) => o.level))).toEqual(new Set([6, 7, 8, 9, 10]));
  });
  it('B — parent and children are stationed at different sites', () => {
    const w = play('B');
    expect([siteOfOrg(w, 'u800')?.id, siteOfOrg(w, 'u900')?.id, siteOfOrg(w, 'u1000')?.id]).toEqual(['SITE-0101', 'SITE-0102', 'SITE-0103']);
  });
  it('C — one site: stationed parent, children and an unrelated unit; linked units are a separate list', () => {
    const w = play('C');
    expect(occupantsOf(w, 'SITE-0101').sort()).toEqual(['u1001', 'u800', 'u802', 'u901'].sort());
    expect(descendants(w, 'u800')).not.toContain('u802');
    expect(linkedTo(w, 'SITE-0101').sort()).toEqual(['u700', 'u902']);
    // a link is NOT stationing: the linked unit is stationed elsewhere and is not an occupant
    expect(siteOfOrg(w, 'u902')?.id).toBe('SITE-0104');
    expect(occupantsOf(w, 'SITE-0101')).not.toContain('u902');
  });
  it('X — linking, responsibility and an Oracle parent change each leave the other concepts untouched', () => {
    const before = baseWorld();
    const w = play('X');
    expect(linkedTo(w, 'SITE-0101')).toContain('u903');
    expect(siteOfOrg(w, 'u903')?.id).toBe(siteOfOrg(before, 'u903')?.id);
    expect(responsibleOf(w, 'SITE-0103')?.org).toBe('u1000');
    expect(w.orgs.find((o) => o.id === 'u902')?.parentId).toBe('u801');
    expect(siteOfOrg(w, 'u902')?.id).toBe('SITE-0104');
    expect(linkedTo(w, 'SITE-0101')).toContain('u902');
    expect(w.events.map((e) => e.type)).toEqual(['SITE_LINKED', 'FACILITY_RESPONSIBILITY_SET', 'ORACLE_SYNC_APPLIED']);
    expect(check(before, 'p-req', { t: 'LINK_SITE', org: 'u901', site: 'SITE-0102', reason: 'x' }).ok).toBe(false);
  });
  it('stationing is corrected only by its own audited action; one site may hold one or several units', () => {
    let w = baseWorld();
    expect(occupantsOf(w, 'SITE-0103')).toEqual(['u1000']);
    expect(occupantsOf(w, 'SITE-0106').length).toBe(3);
    expect(w.sites.find((s) => s.id === 'SITE-0104')!.source).toMatchObject({ externalId: 'FMS-117' });
    w = act(w, 'p-admin', { t: 'CORRECT_STATIONING', org: 'u903', site: 'SITE-0101', reason: 'تصحيح' });
    expect(siteOfOrg(w, 'u903')?.id).toBe('SITE-0101');
    expect(w.stationings.find((s) => s.org === 'u903' && s.state === 'ENDED')?.endReason).toBe('STATIONING_CORRECTION');
  });
});

describe('who moves (D, E, F, G, H)', () => {
  it('presets only propose; the scope is explicit', () => {
    const w = baseWorld();
    expect(presetScope(w, 'u800', 'UNIT_ONLY')).toEqual(['u800']);
    expect(presetScope(w, 'u800', 'WITH_COLOCATED').sort()).toEqual(['u1001', 'u800', 'u901']);
    expect(presetScope(w, 'u800', 'WITH_ELSEWHERE').sort()).toEqual(['u1000', 'u800', 'u900', 'u902']);
    expect(presetScope(w, 'u800', 'WHOLE_BRANCH').length).toBe(6);
  });
  it('D — a unit of another branch is never moved silently: submission waits for a decision', () => {
    const w = play('D');
    const r = req(w, 'rD');
    expect(otherBranchOccupants(w, r.requestingUnit, r.content.scope)).toEqual(['u802']);
    expect(validate(w, r).problems.join()).toContain('قسم الشبكات');
    const w2 = act(w, 'p-req', { t: 'EDIT', req: 'rD', content: { ...r.content, occupants: { u802: 'EXCLUDED' } } });
    expect(validate(w2, req(w2, 'rD')).ok).toBe(true);
  });
  it('E — co-located units move together with one dragged site', () => {
    let w = play('E');
    expect(affectedSites(w, req(w, 'rE').content.scope).map((a) => [a.site.id, a.moving.length, a.staying])).toEqual([['SITE-0101', 3, ['u802']]]);
    w = run([['p-req', { t: 'SUBMIT', req: 'rE' }], ...['p-a8', 'p-a7', 'p-a6'].map((p) => [p, { t: 'APPROVE', req: 'rE' }] as [string, Action]), ['p-act', { t: 'ACTIVATE', req: 'rE' }]], w);
    const s = req(w, 'rE').activation!.site;
    expect(CO.map((o) => siteOfOrg(w, o)?.id)).toEqual([s, s, s]);
    expect(siteOfOrg(w, 'u802')?.id).toBe('SITE-0101');
  });
  it('F — a child unit requests; units at three sites consolidate into one', () => {
    const w = play('F');
    const r = req(w, 'rF');
    expect(r.requestingUnit).toBe('u900');
    expect(affectedSites(w, r.content.scope).map((a) => a.site.id).sort()).toEqual(['SITE-0101', 'SITE-0102', 'SITE-0103']);
    expect(validate(w, r)).toMatchObject({ ok: true });
  });
  it('G — an excluded child stays where it is', () => {
    const w = play('G');
    expect(req(w, 'rG').content.scope).not.toContain('u902');
    expect(affectedSites(w, req(w, 'rG').content.scope).find((a) => a.site.id === 'SITE-0104')).toBeUndefined();
  });
  it('H — including a unit of another branch: refused unless configured; then the configured authorities are added', () => {
    const base = baseWorld();
    const c = content(base, [...CO, 'u802'], { occupants: { u802: 'INCLUDED' } });
    const w0 = act(base, 'p-req', { t: 'CREATE', id: 'x', content: c });
    expect(validate(w0, req(w0, 'x')).problems.join()).toContain('غير مسموح');
    const w = play('H');
    const route = deriveRoute(w, req(w, 'rH'), policyAt(w, w.now).values);
    expect(route.map((s) => s.unit)).toEqual(['u800', 'u700', 'u802', 'u701', 'u600']);
    expect(route.filter((s) => s.kind === 'CROSS_BRANCH').map((s) => s.label.split(' — ')[0])).toEqual(['موافقة الوحدة من الفرع الآخر', 'موافقة أب الوحدة من الفرع الآخر']);
    // one authority only, as another configuration
    const one = { ...BASE_POLICY, crossBranch: { allowed: true, authorities: ['OTHER_UNIT' as const], independent: false } };
    expect(deriveRoute(w, req(w, 'rH'), one).filter((s) => s.kind === 'CROSS_BRANCH').length).toBe(1);
    // the inclusion is recorded in the content and the audit event of the submission
    expect(req(w, 'rH').content.occupants.u802).toBe('INCLUDED');
  });
});

describe('the one proposed site', () => {
  it('no distance rule on re-stationing: a far site is valid (distance is information only)', () => {
    let w = pub(baseWorld(), { ...BASE_POLICY, deployment: 'OPTIONAL' });
    const c = content(w, CO, { occupants: { u802: 'EXCLUDED' }, deploy: null, at: { lat: 25.3, lng: 55.25 } });
    w = act(w, 'p-req', { t: 'CREATE', id: 'r', content: c });
    expect(distanceM(centroid(c.site!.ring), centroid(w.sites[0].ring))).toBeGreaterThan(10_000);
    expect(validate(w, req(w, 'r')).ok).toBe(true);
  });
  it('occupied geography blocks; a site everyone leaves is not a conflict', () => {
    const w = act(baseWorld(), 'p-req', { t: 'CREATE', id: 'r', content: content(baseWorld(), CO, { occupants: { u802: 'EXCLUDED' }, at: P.intoH }) });
    expect(validate(w, req(w, 'r')).conflicts).toContain('الموقع H — مبنى الموارد البشرية');
    expect(conflictRings(w, ['u1000']).some((x) => x.name.startsWith('الموقع C'))).toBe(false);
  });
  it('the maximum area is a policy value; exceeding it blocks, nothing is resized', () => {
    let w = play('E');
    const ring = req(w, 'rE').content.site!.ring;
    expect(areaM2(ring)).toBeLessThan(BASE_POLICY.maxFootprintAreaM2);
    w = pub(w, { ...BASE_POLICY, maxFootprintAreaM2: 50_000 });
    expect(validate(w, req(w, 'rE')).problems.join()).toContain('مساحة الموقع');
    expect(req(w, 'rE').content.site!.ring).toEqual(ring);
  });
});

describe('lifecycles (I, J, K, L, M)', () => {
  it('I — permanent: new site current after independent activation; old one history; links and responsibility untouched', () => {
    const w = play('I');
    const r = req(w, 'rI');
    expect(r.state).toBe('ACTIVATED_PERMANENT');
    expect(w.stationings.filter((s) => s.org === 'u800' && s.state === 'ENDED').map((s) => [s.site, s.endReason])).toEqual([['SITE-0101', 'REPLACED_BY_ACTIVATION']]);
    expect(permanentOf(w, 'u800')?.site).toBe(r.activation!.site);
    expect(check(w, 'p-req', { t: 'EDIT', req: 'rI', content: r.content }).ok).toBe(false);
    expect(responsibleOf(w, 'SITE-0101')?.org).toBe('u800');
    expect(linkedTo(w, 'SITE-0101').sort()).toEqual(['u700', 'u902']);
    expect(w.areas.filter((a) => a.site === r.activation!.site).map((a) => a.role)).toEqual(['PRIMARY', 'ALTERNATIVE']);
  });
  it('the final approver cannot activate; the activation authority can', () => {
    const w = run([['p-req', { t: 'SUBMIT', req: 'rE' }], ['p-a8', { t: 'APPROVE', req: 'rE' }], ['p-a7', { t: 'APPROVE', req: 'rE' }], ['p-a6', { t: 'APPROVE', req: 'rE' }]], play('E'));
    expect(req(w, 'rE').state).toBe('APPROVED_NOT_ACTIVATED');
    expect(permanentOf(w, 'u800')?.site).toBe('SITE-0101');
    expect(check(w, 'p-a6', { t: 'ACTIVATE', req: 'rE' }).ok).toBe(false);
    expect(check(w, 'p-act', { t: 'ACTIVATE', req: 'rE' }).ok).toBe(true);
  });
  it('J — temporary active over the preserved permanent record', () => {
    const w = play('J');
    expect(req(w, 'rJ').state).toBe('ACTIVE_TEMPORARY');
    expect(effectiveOf(w, 'u800')?.site).toBe(req(w, 'rJ').activation!.site);
    expect(permanentOf(w, 'u800')).toMatchObject({ site: 'SITE-0101', state: 'CURRENT' });
  });
  it('K — at the approved end the units return to the preserved stationing', () => {
    const w = play('K');
    expect(req(w, 'rK').state).toBe('TEMPORARY_RETURNED');
    expect(effectiveOf(w, 'u800')?.site).toBe('SITE-0101');
    expect(w.areas.filter((a) => a.requestId === 'rK').every((a) => a.state === 'RETIRED')).toBe(true);
  });
  it('L — extension reviewed by the stages resting on DURATION, activated independently; unactivated it lapses', () => {
    const w = play('L');
    expect(req(w, 'rL').extensions[0].stages.map((s) => s.label.split(' — ')[0])).toEqual(['معتمد القسم', 'المعتمد النهائي']);
    expect(req(w, 'rL').state).toBe('ACTIVE_TEMPORARY');
    const lapse = act(run(scenarioOf('L')!.actions.slice(0, -2)), 'p-req', { t: 'TICK', ms: 30 * DAY });
    expect(req(lapse, 'rL').extensions[0].state).toBe('LAPSED_NOT_ACTIVATED');
  });
  it('M — returned: the SAME request is edited; only stages resting on a changed fact are reconsidered', () => {
    let w = play('M');
    const r0 = req(w, 'rM');
    w = act(w, 'p-req', { t: 'EDIT', req: 'rM', content: { ...r0.content, site: { ...r0.content.site!, ring: copyTo(w, 'SITE-0101', { lat: 25.231, lng: 55.296 }) } } });
    expect(check(w, 'p-req', { t: 'SUBMIT', req: 'rM' }).ok).toBe(false);
    w = act(w, 'p-req', { t: 'SUBMIT', req: 'rM', reason: 'نقل الموقع قرب الطريق' });
    const r = req(w, 'rM');
    expect(w.requests.length).toBe(1);
    expect(r.revisions[1].changed).toEqual(['SITE', 'AVAILABILITY']);
    expect(r.stages.map((s) => s.mark ?? '-')).toEqual(['APPROVED', '-', '-']);
    expect(r.revisions[0].content.site!.ring).not.toEqual(r.revisions[1].content.site!.ring);
  });
  it('M — a scope change reopens every stage', () => {
    let w = play('M');
    const r0 = req(w, 'rM');
    w = act(w, 'p-req', { t: 'EDIT', req: 'rM', content: { ...r0.content, scope: ['u800', 'u901'] } });
    w = act(w, 'p-req', { t: 'SUBMIT', req: 'rM', reason: 'استبعاد وحدة' });
    expect(changedFacts(r0.content, req(w, 'rM').content)).toEqual(['SCOPE', 'AVAILABILITY']);
    expect(req(w, 'rM').stages.every((s) => !s.mark)).toBe(true);
  });
  it('cancellation before start is decided independently (A4)', () => {
    let w = run(scenarioOf('K')!.actions.slice(0, -2));
    w = act(w, 'p-req', { t: 'REQUEST_START_CANCELLATION', req: 'rK', reason: 'لم تعد الحاجة قائمة' });
    expect(check(w, 'p-req', { t: 'DECIDE_START_CANCELLATION', req: 'rK', approve: true, reason: 'x' }).ok).toBe(false);
    w = act(w, 'p-act', { t: 'DECIDE_START_CANCELLATION', req: 'rK', approve: true, reason: 'موافقة' });
    expect(req(w, 'rK').state).toBe('TEMPORARY_CANCELLED_BEFORE_START');
  });
});

describe('routing from the requesting unit (N, O) and separation of duties', () => {
  it('N — the route starts at the requesting unit and follows the Oracle hierarchy upward', () => {
    const w = play('N');
    const r = req(w, 'rN');
    expect(deriveRoute(w, r, policyAt(w, w.now).values).map((s) => s.unit)).toEqual(['u900', 'u800', 'u700', 'u600']);
    const skip7 = { ...BASE_POLICY, routing: { ...BASE_POLICY.routing, levels: BASE_POLICY.routing.levels.map((l) => (l.level === 7 ? { ...l, approve: false } : l)) } };
    expect(deriveRoute(w, r, skip7).map((s) => s.unit)).toEqual(['u900', 'u800', 'u600']);
    const parent = { ...BASE_POLICY, routing: { ...BASE_POLICY.routing, startAt: 'PARENT' as const } };
    expect(deriveRoute(w, r, parent)[0].unit).toBe('u800');
  });
  it('the route belongs to the requesting unit, not to the selected units', () => {
    const w = play('E');
    // u1001 sits deeper (L10 under u900), yet the route still starts at the requesting unit u800
    expect(deriveRoute(w, req(w, 'rE'), BASE_POLICY)[0].unit).toBe('u800');
  });
  it('O — a hierarchy change of the requesting unit pauses the request; reconfirmation rebuilds the route; history kept', () => {
    let w = play('O');
    const r = req(w, 'rO');
    expect(r.state).toBe('PAUSED_HIERARCHY_CHANGED');
    expect(r.paused?.reason).toBe(HIERARCHY_CHANGED);
    expect(r.routeHistory[0].stages.map((s) => [s.unit, s.mark ?? '-'])).toEqual([
      ['u800', 'APPROVED'],
      ['u700', '-'],
      ['u600', '-'],
    ]);
    expect(check(w, 'p-a7', { t: 'APPROVE', req: 'rO' }).ok).toBe(false);
    expect(check(w, 'p-req', { t: 'SUBMIT', req: 'rO' }).ok).toBe(false); // a reason is required
    w = act(w, 'p-req', { t: 'SUBMIT', req: 'rO', reason: 'تأكيد بعد تغيّر الهيكل' });
    expect(req(w, 'rO').stages.map((s) => [s.unit, s.mark ?? '-'])).toEqual([
      ['u800', '-'],
      ['u701', '-'],
      ['u600', '-'],
    ]);
    expect(w.events.map((e) => e.type)).toEqual(expect.arrayContaining(['REQUEST_PAUSED_HIERARCHY_CHANGED', 'RECONFIRMED_ROUTE_REBUILT']));
  });
  it('O — the alternative (not decided, O-10b): carry decisions of stages whose unit stays on the route', () => {
    let w = pub(baseWorld(), { ...BASE_POLICY, routing: { ...BASE_POLICY.routing, afterHierarchyChange: 'CARRY_SAME_UNIT_STAGES' } });
    w = run(scenarioOf('O')!.actions, w);
    w = act(w, 'p-req', { t: 'SUBMIT', req: 'rO', reason: 'تأكيد' });
    expect(req(w, 'rO').stages.map((s) => s.mark ?? '-')).toEqual(['APPROVED', '-', '-']);
  });
  it('a hierarchy change elsewhere does not pause the request', () => {
    let w = run(scenarioOf('O')!.actions.slice(0, -1));
    w = act(w, 'oracle', { t: 'ORACLE_SYNC', rows: [{ oracleId: '902', parentOracleId: '801', level: 9, name: 'شعبة المستودعات' }] });
    expect(req(w, 'rO').state).toBe('UNDER_REVIEW');
  });
  it('the same human cannot approve their own request through a second account', () => {
    let w = play('M');
    w = act(w, 'p-req', { t: 'SUBMIT', req: 'rM', reason: 'بلا تغيير' });
    expect(check(w, 'p-req-alt', { t: 'APPROVE', req: 'rM' }).ok).toBe(false);
    expect(check(w, 'p-a7', { t: 'APPROVE', req: 'rM' }).ok).toBe(true);
  });
});

describe('deployment (P, Q, R, S, T)', () => {
  it('P — REQUIRED: no submission without both areas', () => {
    const w = play('P');
    expect(validate(w, req(w, 'rP')).problems.join()).toContain('مطلوبتان');
    expect(check(w, 'p-req', { t: 'SUBMIT', req: 'rP' }).ok).toBe(false);
  });
  it('Q — OPTIONAL: none is valid, both is valid, one alone is refused', () => {
    const w = play('Q');
    expect(validate(w, req(w, 'rQ')).ok).toBe(true);
    const both = act(w, 'p-req', { t: 'EDIT', req: 'rQ', content: { ...req(w, 'rQ').content, primary: circleRing(P.primary, 600), alternative: circleRing(P.alternative, 500) } });
    expect(validate(both, req(both, 'rQ')).ok).toBe(true);
    const half = act(w, 'p-req', { t: 'EDIT', req: 'rQ', content: { ...req(w, 'rQ').content, primary: circleRing(P.primary, 600) } });
    expect(validate(half, req(half, 'rQ')).problems.join()).toContain('زوج كامل');
  });
  it('R — a deployment area over occupied geography is a HARD block', () => {
    const w = play('R');
    const v = validate(w, req(w, 'rR'));
    expect(v.legs[0].status).toBe('OK'); // the distance is fine — the overlap alone blocks
    expect(v.deployConflicts.primary).toEqual(['الموقع F — مركز الأنظمة']);
    expect(v.ok).toBe(false);
    expect(check(w, 'p-req', { t: 'SUBMIT', req: 'rR' }).ok).toBe(false);
  });
  it('S — the terrain class is the one covering the LARGEST AREA, with the shares shown', () => {
    const w = play('S');
    const ring = req(w, 'rS').content.primary!;
    const t = terrainClassOf(w, BASE_POLICY, ring);
    expect(t.shares.map((s) => s.code)).toEqual(['RUGGED', 'FLAT']);
    expect(t.shares[0].pct).toBeGreaterThan(50);
    expect(t.cls.code).toBe('RUGGED');
    expect(Math.round(t.shares.reduce((a, s) => a + s.pct, 0))).toBe(100);
    // it really straddles both classes, and the area under the minority class is not ignored in the shares
    expect(t.shares[1].pct).toBeGreaterThan(10);
    expect(t.tie).toBe(false);
  });
  it('T — base 5–8 km with a configured +2 km becomes 5–10 km (the minimum stays)', () => {
    const w = play('T');
    const l = validate(w, req(w, 'rT')).legs[0];
    expect(l).toMatchObject({ status: 'OK', base: { min: 5000, max: 8000 }, effective: { min: 5000, max: 10000 } });
    expect(l.terrain?.cls).toMatchObject({ code: 'RUGGED', allowanceM: 2000 });
    expect(l.distance!).toBeGreaterThan(9000);
    // MIN_AND_MAX is an explicit alternative configuration, not the owner's default
    expect(legCheck(w, { ...BASE_POLICY, terrainAppliesTo: 'MIN_AND_MAX' }, 'primary', req(w, 'rT').content.site!.ring, req(w, 'rT').content.primary).effective).toEqual({ min: 7000, max: 10000 });
    // without the terrain allowance the same placement needs an exception, without the exception it is out of range
    const flat = { ...BASE_POLICY, primary: { ...BASE_POLICY.primary, terrain: false } };
    expect(legCheck(w, flat, 'primary', req(w, 'rT').content.site!.ring, req(w, 'rT').content.primary).status).toBe('OUT_OF_RANGE');
  });
  it('the policy version is locked at submission and versions are effective-dated, reasoned and referenced', () => {
    let w = play('Q');
    w = act(w, 'p-req', { t: 'SUBMIT', req: 'rQ' });
    expect(req(w, 'rQ').policyVersion).toBe(2);
    w = pub(w, { ...BASE_POLICY, maxFootprintAreaM2: 1000 });
    expect(validate(w, req(w, 'rQ')).ok).toBe(true);
    const later = pub(baseWorld(), { ...BASE_POLICY, deployment: 'OPTIONAL' }, NOW + 10 * DAY);
    expect(policyAt(later, NOW).values.deployment).toBe('REQUIRED');
    expect(policyAt(later, NOW + 10 * DAY).values.deployment).toBe('OPTIONAL');
    expect(check(baseWorld(), 'p-admin', { t: 'PUBLISH_POLICY', values: BASE_POLICY, effectiveFrom: NOW, reason: 'x', reference: '' }).ok).toBe(false);
    expect(check(baseWorld(), 'p-req', { t: 'PUBLISH_POLICY', values: BASE_POLICY, effectiveFrom: NOW, reason: 'x', reference: 'y' }).ok).toBe(false);
  });
  it('an exception is explicit, reasoned, and adds a permission-controlled stage', () => {
    let w = pub(baseWorld(), { ...BASE_POLICY, primary: { ...BASE_POLICY.primary, terrain: false } });
    w = act(w, 'p-req', { t: 'CREATE', id: 'r', content: content(w, CO, { occupants: { u802: 'EXCLUDED' }, deploy: [{ lat: 25.255, lng: 55.37 }, { lat: 25.288, lng: 55.39 }] }) });
    expect(validate(w, req(w, 'r')).problems.join()).toContain('استثناء');
    w = act(w, 'p-req', { t: 'EDIT', req: 'r', content: { ...req(w, 'r').content, exceptions: { primary: 'طريق الوصول الوحيد (توضيحي)' } } });
    w = act(w, 'p-req', { t: 'SUBMIT', req: 'r' });
    expect(req(w, 'r').stages.map((s) => s.kind)).toEqual(['HIERARCHY', 'HIERARCHY', 'EXCEPTION', 'HIERARCHY']);
  });
});

describe('measurement methods (O-04, still open) and guidance bands', () => {
  const a = circleRing({ lat: 25.2, lng: 55.3 }, 300);
  const b = circleRing({ lat: 25.2, lng: 55.36 }, 500);
  const cc = distanceM(centroid(a), centroid(b));
  it('the methods differ by the radii', () => {
    expect(measure('CENTROID_TO_CENTROID', a, b)).toBeCloseTo(cc, 3);
    expect(Math.abs(measure('CENTROID_TO_NEAREST_EDGE', a, b) - (cc - 500))).toBeLessThan(15);
    expect(Math.abs(measure('EDGE_TO_EDGE', a, b) - (cc - 800))).toBeLessThan(20);
    expect(Math.abs(nearestPair(a, b).d - measure('EDGE_TO_EDGE', a, b))).toBeLessThan(1);
    expect(pointToRing(centroid(b), b)).toBe(0);
    expect(ringToRing(a, a)).toBe(0);
  });
  it('the guidance band outline sits at the configured distance', () => {
    for (const p of bandOutline('CENTROID_TO_CENTROID', a, 5000)) expect(Math.abs(distanceM(centroid(a), p) - 5000)).toBeLessThan(1);
    for (const p of bandOutline('EDGE_TO_EDGE', a, 5000)) expect(pointToRing(p, a)).toBeGreaterThan(4900);
  });
});

describe('closing decisions of 3 Nov 2026 (O-03b, O-15, O-16, O-01, O-05b)', () => {
  it('O-03b — one stage already on the route satisfies the extra requirement of the same authority, and says so', () => {
    const w = play('Z');
    const route = deriveRoute(w, req(w, 'rZ'), policyAt(w, w.now).values);
    // OTHER_UNIT adds a stage for u802; SITE_RESPONSIBLE (site A → u800) is satisfied by the existing u800 stage
    expect(route.map((s) => s.unit)).toEqual(['u800', 'u700', 'u802', 'u600']);
    const u800 = route.find((s) => s.unit === 'u800')!;
    expect(u800.satisfies).toEqual(['اعتماد هرمي', 'موافقة المسؤول عن موقعها (ضم قسم الشبكات)']);
    // the history records which conditions the one decision satisfied
    let w2 = act(w, 'p-req', { t: 'SUBMIT', req: 'rZ' });
    w2 = act(w2, 'p-a8', { t: 'APPROVE', req: 'rZ' });
    expect(w2.events.find((e) => e.type === 'STAGE_APPROVED')!.detail).toContain('موافقة المسؤول عن موقعها');
  });
  it('O-03b — when the policy requires independence: a separate stage, decided by a DIFFERENT human', () => {
    let w = run([POLICIES.crossIndependent, ['p-req', { t: 'CREATE', id: 'r', content: content(baseWorld(), [...CO, 'u802'], { occupants: { u802: 'INCLUDED' } }) }]]);
    const route = deriveRoute(w, req(w, 'r'), policyAt(w, w.now).values);
    expect(route.filter((s) => s.unit === 'u800').map((s) => s.kind)).toEqual(['HIERARCHY', 'CROSS_BRANCH']);
    w = act(w, 'p-req', { t: 'SUBMIT', req: 'r' });
    w = act(w, 'p-a8', { t: 'APPROVE', req: 'r' });
    w = act(w, 'p-a7', { t: 'APPROVE', req: 'r' });
    // next: u802's own approver, then the independent site-responsibility stage of u800
    w = act(w, 'p-ait', { t: 'APPROVE', req: 'r' });
    expect(req(w, 'r').stages.find((s) => !s.mark)?.key).toContain('SITE_RESPONSIBLE');
    expect(check(w, 'p-a8', { t: 'APPROVE', req: 'r' }).ok).toBe(false); // same human cannot satisfy both
    expect(check(w, 'p-a8b', { t: 'APPROVE', req: 'r' }).ok).toBe(true); // an independent human of the same seat can
  });
  it('O-15 — a linked-only site does not occupy geography; an approved reservation does; stationing does', () => {
    const w = baseWorld();
    expect(linkedTo(w, 'SITE-0110')).toEqual(['u903']);
    expect(occupantsOf(w, 'SITE-0110')).toEqual([]);
    const names = conflictRings(w, CO).map((x) => x.name);
    expect(names).not.toContain('الموقع J — قاعة متعددة الاستخدام');
    expect(names).toContain('الموقع K — ساحة محجوزة');
    const onJ = act(w, 'p-req', { t: 'CREATE', id: 'j', content: content(w, CO, { occupants: { u802: 'EXCLUDED' }, at: { lat: 25.2335, lng: 55.2985 } }) });
    expect(validate(onJ, req(onJ, 'j')).conflicts).toEqual([]);
    const onK = act(w, 'p-req', { t: 'CREATE', id: 'k', content: content(w, CO, { occupants: { u802: 'EXCLUDED' }, at: { lat: 25.2245, lng: 55.2855 } }) });
    expect(validate(onK, req(onK, 'k')).conflicts).toEqual(['الموقع K — ساحة محجوزة']);
  });
  it('O-16 — a hierarchy change after final approval blocks activation, pauses, and every approval runs again on the new route', () => {
    let w = play('Y');
    const r = req(w, 'rY');
    expect(r.state).toBe('PAUSED_HIERARCHY_CHANGED');
    expect(r.paused).toMatchObject({ reason: HIERARCHY_CHANGED, from: 'APPROVED_NOT_ACTIVATED' });
    expect(check(w, 'p-act', { t: 'ACTIVATE', req: 'rY' }).ok).toBe(false);
    expect(r.routeHistory[0].stages.every((s) => s.mark === 'APPROVED')).toBe(true);
    w = act(w, 'p-req', { t: 'SUBMIT', req: 'rY', reason: 'تأكيد الوحدة بعد تغيّر الهيكل' });
    expect(req(w, 'rY').stages.map((s) => [s.unit, s.mark ?? '-'])).toEqual([
      ['u800', '-'],
      ['u701', '-'],
      ['u600', '-'],
    ]);
    w = run([['p-a8', { t: 'APPROVE', req: 'rY' }], ['p-a7it', { t: 'APPROVE', req: 'rY' }], ['p-a6', { t: 'APPROVE', req: 'rY' }]], w);
    expect(req(w, 'rY').state).toBe('APPROVED_NOT_ACTIVATED');
    w = act(w, 'p-act', { t: 'ACTIVATE', req: 'rY' });
    expect(req(w, 'rY').state).toBe('ACTIVATED_PERMANENT');
  });
  it('O-16 — activation is refused on drift even before the pause is processed (defensive check)', () => {
    const w = run(scenarioOf('Y')!.actions.slice(0, -1));
    const drifted = structuredClone(w);
    drifted.orgs.find((o) => o.id === 'u800')!.parentId = 'u701';
    expect(check(drifted, 'p-act', { t: 'ACTIVATE', req: 'rY' })).toMatchObject({ ok: false });
    expect(check(w, 'p-act', { t: 'ACTIVATE', req: 'rY' }).ok).toBe(true);
  });
  it('O-01 — the outbox carries authoritative changes with the contract fields; nothing is written to Oracle', () => {
    const w = play('K');
    const types = w.outbox.map((e) => e.type);
    expect(types).toEqual(['TEMPORARY_STATIONING_SCHEDULED', 'TEMPORARY_STATIONING_SCHEDULED', 'TEMPORARY_STATIONING_SCHEDULED', 'TEMPORARY_STATIONING_STARTED', 'TEMPORARY_STATIONING_STARTED', 'TEMPORARY_STATIONING_STARTED', 'TEMPORARY_STATIONING_ENDED', 'TEMPORARY_STATIONING_ENDED', 'TEMPORARY_STATIONING_ENDED']);
    for (const e of w.outbox) {
      expect(e).toMatchObject({ source: 'TMRKZ', schema: 'tmrkz.stationing.v1', auditRef: 'rK' });
      expect(e.orgExternalId).toMatch(/^\d+$/);
      expect(e.siteId).toMatch(/^SITE-/);
      expect(e.sourceVersion).toBeTruthy();
    }
    const perm = play('I');
    expect(perm.outbox.map((e) => [e.type, e.orgExternalId])).toEqual([
      ['STATIONING_ACTIVATED', '800'],
      ['STATIONING_ACTIVATED', '1001'],
      ['STATIONING_ACTIVATED', '901'],
    ]);
    // a site link change is published; an external site carries its external id
    const ln = act(baseWorld(), 'p-admin', { t: 'LINK_SITE', org: 'u903', site: 'SITE-0104', reason: 'ربط' });
    expect(ln.outbox[0]).toMatchObject({ type: 'SITE_LINK_CREATED', orgExternalId: '903', siteId: 'SITE-0104', siteExternalId: 'FMS-117' });
    // the Oracle mirror is only ever read: a sync emits nothing outbound and changes no unit identity
    const sync = act(baseWorld(), 'oracle', { t: 'ORACLE_SYNC', rows: [{ oracleId: '902', parentOracleId: '801', level: 9, name: 'شعبة المستودعات' }] });
    expect(sync.outbox).toEqual([]);
  });
  it('O-05b — a tie for the largest share is decided by the configured terrain_class_priority', () => {
    const w = play('T2');
    const r = req(w, 'rT2');
    const t = terrainClassOf(w, BASE_POLICY, r.content.primary!);
    expect(terrainShares(w, r.content.primary!).map((x) => [x.code, x.pct]).sort()).toEqual([
      ['FLAT', 50],
      ['RUGGED', 50],
    ]);
    // priority ROLLING > FLAT > RUGGED: FLAT wins although RUGGED has the larger allowance (not "largest allowance")
    expect(t).toMatchObject({ tie: true, tieResolved: true, cls: { code: 'FLAT', allowanceM: 0 } });
    expect(t.tied.sort()).toEqual(['FLAT', 'RUGGED']);
    const v = validate(w, r);
    expect(v.legs[0]).toMatchObject({ status: 'OK', effective: { min: 5000, max: 8000 } });
    // reversing the administrator's order changes the winner: the rule is the configured priority
    const rev = { ...BASE_POLICY, terrainPriority: ['RUGGED', 'FLAT', 'ROLLING'] };
    expect(terrainClassOf(w, rev, r.content.primary!).cls.code).toBe('RUGGED');
    expect(legCheck(w, rev, 'primary', r.content.site!.ring, r.content.primary).effective.max).toBe(10000);
  });
  it('O-05b — tied classes without a valid priority BLOCK submission (no random, no automatic choice)', () => {
    const w = play('T2');
    const r = req(w, 'rT2');
    const partial = { ...BASE_POLICY, terrainPriority: ['ROLLING', 'FLAT'] }; // RUGGED missing
    expect(terrainClassOf(w, partial, r.content.primary!)).toMatchObject({ tie: true, tieResolved: false });
    expect(legCheck(w, partial, 'primary', r.content.site!.ring, r.content.primary).status).toBe('TERRAIN_TIE');
    const blocked = run([['p-admin', { t: 'PUBLISH_POLICY', values: partial, effectiveFrom: w.now, reason: 'ترتيب ناقص (اختبار)', reference: 'POL-T' }]], w);
    expect(validate(blocked, req(blocked, 'rT2')).problems.join()).toContain('دون ترتيب أولوية صالح');
    expect(check(blocked, 'p-req', { t: 'SUBMIT', req: 'rT2' }).ok).toBe(false);
  });
  it('O-05b — the applied terrain decision and policy version are written to the audit record', () => {
    let w = play('T2');
    w = act(w, 'p-req', { t: 'SUBMIT', req: 'rT2' });
    const e = w.events.find((x) => x.type === 'SUBMITTED' && x.ref === 'rT2')!;
    expect(e.detail).toContain('السياسة 1 POL-STN-DEMO-1');
    expect(e.detail).toContain('بتعادل');
    expect(e.detail).toContain('ROLLING > FLAT > RUGGED');
  });
});

describe('every scenario runs with every step allowed', () => {
  for (const s of SCENARIOS) it(s.code + ' — ' + s.title, () => void play(s.code));
});
