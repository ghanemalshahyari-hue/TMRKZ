// Stationing model V3 — FINAL OWNER MODEL (owner briefs of 3 Nov 2026) as a pure, simulated state machine for the
// isolated prototype. A re-stationing request has ONE proposed site; «رئيسية / بديلة» names the two DEPLOYMENT areas of
// a stationing context. Four concepts stay separate: the Oracle hierarchy, site ↔ unit links, authoritative stationing
// and facility responsibility. Every value a rule uses comes from a versioned policy (`Policy`), never from code. The
// owner's answers (O-02–O-10, O-10b, O-13, O-14; O-04 = centre to centre) are the policy defaults; the points still
// open are listed in docs/STATIONING_MODEL_V3_AR.md §13.2.
// Nothing is persisted; no server is called.
import { areaM2, centroid, kinks, pointInRing, ringsIntersect, type Ring } from '../../../../frontend/src/lib/footprint';
import type { LatLng } from '../../../../frontend/src/lib/geo';
import { measure, type Method } from './measure';

export const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------------
// The four separate concepts (§1–§4 of the final brief)

/** 1. Organisational units: Oracle is their source. The tree comes from parent links; the level is Oracle's value. */
export type Org = { id: string; oracleId: string; parentId: string | null; level: number; name: string; code: string };

/** Sites are TMRKZ records, or records another site system supplies; their ids never derive from Oracle ids. */
export type SiteSource = { system: 'TMRKZ' } | { system: string; externalId: string; readOnlyGeometry: boolean };
export type Site = { id: string; name: string; ring: Ring; source: SiteSource; state: 'REGISTERED' | 'PROPOSED'; createdBy?: string };

/** 2. A site ↔ unit association. It is NOT stationing and never becomes stationing by itself (O-02). */
export type SiteLink = { id: string; site: string; org: string; from: number; to?: number; source: string; reason: string };

/** 3. Authoritative stationing, recorded explicitly. A temporary record sits over the preserved permanent one. */
export type Stationing = {
  id: string;
  org: string;
  site: string;
  kind: 'PERMANENT' | 'TEMPORARY';
  state: 'CURRENT' | 'ENDED' | 'SCHEDULED' | 'ACTIVE' | 'CANCELLED_BEFORE_START';
  from: number;
  to?: number;
  plannedEnd?: number;
  endReason?: 'REPLACED_BY_ACTIVATION' | 'EXPIRED_RETURNED' | 'EARLY_RETURN' | 'STATIONING_CORRECTION' | 'SUPERSEDED_BY_PERMANENT';
  requestId?: string;
  baseId?: string;
};

/** 4. Facility responsibility: its own audited record; stationing never changes it. */
export type Responsibility = { id: string; site: string; org: string; from: number; to?: number; reason: string };

/** The two deployment areas of a stationing context: both valid at once, neither is a fallback. */
export type DeploymentArea = { id: string; site: string; role: 'PRIMARY' | 'ALTERNATIVE'; ring: Ring; requestId: string; state: 'ACTIVE' | 'RETIRED'; from: number; to?: number };

/** Unavailable geography that is not a registered site (a reserved works area, for example) — fictional. */
export type Zone = { id: string; name: string; ring: Ring };

/** Terrain classes of a terrain dataset (fictional here: no approved dataset yet). Outside every zone: `defaultCode`. */
export type TerrainZone = { id: string; code: string; ring: Ring };
export type TerrainDataset = { name: string; provenance: string; defaultCode: string; zones: TerrainZone[] };

export type Perm =
  | 'CREATE_RESTATIONING'
  | 'APPROVE'
  | 'ACTIVATE_STATIONING'
  | 'ACTIVATE_TEMPORARY_EXTENSION'
  | 'DECIDE_EARLY_RETURN'
  | 'DECIDE_TEMPORARY_BEFORE_START_CANCELLATION'
  | 'APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION'
  | 'MANAGE_SITE_LINKS'
  | 'CORRECT_STATIONING'
  | 'MANAGE_FACILITY_RESPONSIBILITY'
  | 'ADMIN_POLICY';

/**
 * A sign-in. `human` is the stable identity (two accounts of one person share it). `scope` lists units; CREATE and the
 * activation/decision permissions cover each unit's branch, APPROVE is the approver seat of exactly those units.
 */
export type Person = { id: string; name: string; title: string; human: string; perms: Perm[]; scope: string[] };

// ---------------------------------------------------------------------------------------------------------------------
// Policy (System Properties / Studio): every business value, versioned, effective-dated, reasoned and audited

export type Leg = { minM: number; maxM: number; method: Method; terrain: boolean };
export type TerrainClass = { code: string; label: string; allowanceM: number };
export type RoutingLevel = { level: number; approve: boolean; label: string; final?: boolean; dependsOn: Fact[] };
/** Who must authorise including a unit of another branch (O-03): one or several, as configured. */
export type CrossAuthority = 'OTHER_UNIT' | 'OTHER_UNIT_PARENT' | 'SITE_RESPONSIBLE';

export type PolicyValues = {
  maxFootprintAreaM2: number;
  /** `stationing_areas_requirement` */
  deployment: 'REQUIRED' | 'OPTIONAL';
  primary: Leg;
  alternative: Leg;
  terrainClasses: TerrainClass[];
  /** O-05 owner rule: the class covering the LARGEST AREA; another method only if the administrator changes it. */
  terrainResolution: 'LARGEST_AREA' | 'AREA_CENTRE' | 'MOST_DEMANDING_TOUCHED';
  /**
   * O-05b owner rule (`terrain_class_priority`): when two or more classes tie for the largest share, the tied class
   * listed first here governs. A tie between classes missing from this list BLOCKS submission. Codes come from the
   * approved terrain dataset; the order is the administrator's.
   */
  terrainPriority: string[];
  /** O-06 owner rule: the allowance extends the MAXIMUM only; configurable. */
  terrainAppliesTo: 'MAX_ONLY' | 'MIN_AND_MAX';
  exception: { allowed: boolean; maxExtraM: number };
  /** O-03 owner rule: never automatic; whether allowed and which authorities, configured. */
  /**
   * O-03: never automatic; whether allowed and which authorities. O-03b: by default one stage already on the route
   * satisfies a cross-branch requirement of the same authority; `independent` requires a SEPARATE stage decided by a
   * DIFFERENT human (stable identity), even when the authority is the same.
   */
  crossBranch: { allowed: boolean; authorities: CrossAuthority[]; independent: boolean };
  routing: {
    /** O-09 owner rule: default the requesting unit's own approver; configurable. */
    startAt: 'SELF' | 'PARENT';
    levels: RoutingLevel[];
    /** O-10b owner rule: after a hierarchy change and reconfirmation every stage is decided again (RESTART_ALL). */
    afterHierarchyChange: 'RESTART_ALL' | 'CARRY_SAME_UNIT_STAGES';
  };
};
export type PolicyVersion = { version: number; effectiveFrom: number; author: string; reason: string; reference: string; values: PolicyValues };

// ---------------------------------------------------------------------------------------------------------------------
// Requests

/** What a stage's decision rests on (V2 D18 kept; CANDIDATE became SITE, DEPLOYMENT is new). */
export type Fact = 'SCOPE' | 'CLASSIFICATION' | 'DURATION' | 'SITE' | 'DEPLOYMENT' | 'AVAILABILITY';
export const ALL_FACTS: Fact[] = ['SCOPE', 'CLASSIFICATION', 'DURATION', 'SITE', 'DEPLOYMENT', 'AVAILABILITY'];

export type Stage = {
  key: string;
  label: string;
  /** The unit whose approver seat decides it (from the Oracle hierarchy), or null for a permission-based stage. */
  unit: string | null;
  perm: Perm;
  dependsOn: Fact[];
  final?: boolean;
  kind: 'HIERARCHY' | 'EXCEPTION' | 'CROSS_BRANCH';
  /** Every approval condition this ONE decision satisfies (O-03b), shown in the route and written to the history. */
  satisfies: string[];
  mark?: 'APPROVED' | 'CARRIED';
  by?: string;
  at?: number;
};

export type OccupantDecision = 'EXCLUDED' | 'INCLUDED' | 'SEPARATE';

/** The editable content of a request — what a revision snapshots and what return-for-edit changes. */
export type Content = {
  kind: 'PERMANENT' | 'TEMPORARY';
  start: number;
  end?: number;
  /** The units that move (explicit; never inferred from the tree or the site). */
  scope: string[];
  /** Units of another branch at affected sites: never moved without an explicit, audited decision (O-03). */
  occupants: Record<string, OccupantDecision>;
  /** The ONE proposed site: copied from `copiedFrom` and dragged, edited or drawn. */
  site: { ring: Ring; copiedFrom: string; shape: 'COPY' | 'EDITED' | 'DRAWN' } | null;
  primary: Ring | null;
  alternative: Ring | null;
  exceptions: Partial<Record<'primary' | 'alternative', string>>;
  reason: string;
};

export type ReqState =
  | 'DRAFT'
  | 'UNDER_REVIEW'
  | 'RETURNED_FOR_CHANGES'
  | 'PAUSED_HIERARCHY_CHANGED'
  | 'REJECTED'
  | 'APPROVED_NOT_ACTIVATED'
  | 'ACTIVATED_PERMANENT'
  | 'TEMPORARY_SCHEDULED'
  | 'ACTIVE_TEMPORARY'
  | 'TEMPORARY_RETURNED'
  | 'TEMPORARY_CANCELLED_BEFORE_START';

export type Revision = { n: number; at: number; by: string; content: Content; changed: Fact[]; reason?: string; invalidated: string[]; carried: string[] };
export type Extension = { id: string; newEnd: number; state: 'UNDER_REVIEW' | 'APPROVED_NOT_ACTIVATED' | 'ACTIVATED' | 'LAPSED_NOT_ACTIVATED'; by: string; stages: Stage[]; reason: string };
/** A route that was replaced (hierarchy change): kept with its decisions, never deleted (O-10). */
export type RouteRecord = { at: number; reason: string; stages: Stage[]; path: string[] };

export type Request = {
  id: string;
  number: string;
  requester: string;
  /** The requesting organisational unit: the route starts here and belongs to it, not to a person (O-07). */
  requestingUnit: string;
  content: Content;
  state: ReqState;
  policyVersion: number | null;
  stages: Stage[];
  /** The Oracle path (requesting unit → top) the current route was derived from. */
  routePath: string[];
  routeHistory: RouteRecord[];
  revisions: Revision[];
  returned?: { by: string; stage: string; reason: string; at: number };
  paused?: { at: number; reason: string; from: ReqState };
  finalApprover?: string;
  activation?: { by: string; at: number; site: string };
  extensions: Extension[];
  earlyReturn?: { by: string; reason: string; state: 'REQUESTED' | 'APPROVED' | 'REJECTED'; decidedBy?: string };
  startCancellation?: { by: string; reason: string; state: 'REQUESTED' | 'APPROVED' | 'REJECTED'; decidedBy?: string };
};

export type Event = { at: number; by: string; type: string; ref: string; detail: string };

/**
 * Authoritative occupancy other than stationing (O-15): an approved use or a reservation. Together with stationing it
 * is what occupies geography; a site link alone never does.
 */
export type Occupancy = { id: string; site: string; org: string; kind: 'APPROVED_USE' | 'RESERVATION'; from: number; to?: number; reference: string };

/**
 * The outbound integration contract (O-01): an outbox of authoritative changes other systems may consume (read API or
 * event feed). Written in the same transaction as the change; delivery is asynchronous, so stationing never depends on
 * Oracle or any consumer being available. TMRKZ never writes Oracle's hierarchy.
 */
export type OutboxEvent = {
  seq: number;
  id: string;
  type: 'STATIONING_ACTIVATED' | 'TEMPORARY_STATIONING_SCHEDULED' | 'TEMPORARY_STATIONING_STARTED' | 'TEMPORARY_STATIONING_ENDED' | 'TEMPORARY_STATIONING_CANCELLED' | 'STATIONING_CORRECTED' | 'SITE_LINK_CREATED' | 'SITE_LINK_ENDED';
  orgExternalId: string;
  orgCode: string;
  siteId: string;
  siteExternalId: string | null;
  effectiveAt: number;
  recordedAt: number;
  source: 'TMRKZ';
  schema: 'tmrkz.stationing.v1';
  sourceVersion: string;
  auditRef: string;
};

export type World = {
  now: number;
  orgs: Org[];
  sites: Site[];
  links: SiteLink[];
  stationings: Stationing[];
  responsibilities: Responsibility[];
  areas: DeploymentArea[];
  zones: Zone[];
  terrain: TerrainDataset;
  people: Person[];
  policies: PolicyVersion[];
  requests: Request[];
  events: Event[];
  occupancies: Occupancy[];
  outbox: OutboxEvent[];
  oracle: { extractAt: number; rows: number; source: string };
};

export const HIERARCHY_CHANGED = 'تغير الهيكل التنظيمي بعد تقديم الطلب';

// ---------------------------------------------------------------------------------------------------------------------
// Queries

export const orgOf = (w: World, id: string) => w.orgs.find((o) => o.id === id);
export const siteOf = (w: World, id: string) => w.sites.find((s) => s.id === id);
export const personOf = (w: World, id: string) => w.people.find((p) => p.id === id)!;
export const children = (w: World, id: string) => w.orgs.filter((o) => o.parentId === id);
export function descendants(w: World, id: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => children(w, p).forEach((c) => (out.push(c.id), walk(c.id)));
  walk(id);
  return out;
}
export function ancestors(w: World, id: string): Org[] {
  const out: Org[] = [];
  for (let o = orgOf(w, orgOf(w, id)?.parentId ?? ''); o; o = orgOf(w, o.parentId ?? '')) out.push(o);
  return out;
}
export const isUnder = (w: World, id: string, root: string) => id === root || ancestors(w, id).some((a) => a.id === root);
export const pathOf = (w: World, id: string) => [id, ...ancestors(w, id).map((a) => a.id)];

export function policyAt(w: World, t: number): PolicyVersion {
  return [...w.policies].filter((p) => p.effectiveFrom <= t).sort((a, b) => b.version - a.version)[0] ?? w.policies[0];
}
export const policyOfRequest = (w: World, r: Request) => (r.policyVersion != null ? w.policies.find((p) => p.version === r.policyVersion)! : policyAt(w, w.now));

export const permanentOf = (w: World, org: string) => w.stationings.find((s) => s.org === org && s.kind === 'PERMANENT' && s.state === 'CURRENT');
export const effectiveOf = (w: World, org: string) => w.stationings.find((s) => s.org === org && s.kind === 'TEMPORARY' && s.state === 'ACTIVE') ?? permanentOf(w, org);
export const siteOfOrg = (w: World, org: string) => siteOf(w, effectiveOf(w, org)?.site ?? '');
/** Units STATIONED at a site now (one site object on the map; listed inside its card). */
export const occupantsOf = (w: World, site: string) => w.orgs.filter((o) => effectiveOf(w, o.id)?.site === site).map((o) => o.id);
/** Units LINKED to a site (association only, not stationing). */
export const linkedTo = (w: World, site: string) => w.links.filter((l) => l.site === site && l.to == null).map((l) => l.org);
export const linksOf = (w: World, org: string) => w.links.filter((l) => l.org === org && l.to == null);
export const responsibleOf = (w: World, site: string) => w.responsibilities.find((r) => r.site === site && r.to == null);
export const activeAreas = (w: World, site: string) => w.areas.filter((a) => a.site === site && a.state === 'ACTIVE');

export function can(p: Person, perm: Perm, w: World, unit?: string): boolean {
  if (!p.perms.includes(perm)) return false;
  if (unit == null) return true;
  if (perm === 'APPROVE') return p.scope.includes(unit);
  return p.scope.some((s) => isUnder(w, unit, s));
}
export const inRequesterScope = (w: World, p: Person, org: string) => can(p, 'CREATE_RESTATIONING', w, org);
/** The requesting unit for a requester and an anchor: the requester's own unit whose branch holds the anchor. */
export const requestingUnitFor = (w: World, p: Person, anchor: string) => p.scope.find((s) => isUnder(w, anchor, s)) ?? p.scope[0];

// ---------------------------------------------------------------------------------------------------------------------
// Scope helpers — one-click PROPOSALS; the user confirms each unit.

export type ScopePreset = 'UNIT_ONLY' | 'WITH_COLOCATED' | 'WITH_ELSEWHERE' | 'WHOLE_BRANCH';
export function presetScope(w: World, anchor: string, preset: ScopePreset): string[] {
  const here = siteOfOrg(w, anchor)?.id;
  const desc = descendants(w, anchor);
  if (preset === 'UNIT_ONLY') return [anchor];
  if (preset === 'WITH_COLOCATED') return [anchor, ...desc.filter((d) => siteOfOrg(w, d)?.id === here)];
  if (preset === 'WITH_ELSEWHERE') return [anchor, ...desc.filter((d) => siteOfOrg(w, d)?.id !== here)];
  return [anchor, ...desc];
}

export function affectedSites(w: World, scope: string[]) {
  const ids = [...new Set(scope.map((o) => siteOfOrg(w, o)?.id).filter((x): x is string => !!x))];
  return ids.map((id) => ({ site: siteOf(w, id)!, moving: occupantsOf(w, id).filter((o) => scope.includes(o)), staying: occupantsOf(w, id).filter((o) => !scope.includes(o)) }));
}

/** Units of ANOTHER branch (outside the requesting unit) stationed at an affected site: shown, decided explicitly. */
export function otherBranchOccupants(w: World, requestingUnit: string, scope: string[]): string[] {
  return [...new Set(affectedSites(w, scope).flatMap((a) => occupantsOf(w, a.site.id)))].filter((o) => !isUnder(w, o, requestingUnit));
}

// ---------------------------------------------------------------------------------------------------------------------
// Geography checks — validation against administrator policy, never a recommendation

/** Active authoritative occupancy records (approved use, reservation) at a site. */
export const occupancyAt = (w: World, site: string) => w.occupancies.filter((o) => o.site === site && o.from <= w.now && (o.to == null || o.to > w.now));
/**
 * Occupied geography (O-15): sites occupied by AUTHORITATIVE records only — stationing that stays, or an active
 * approved use or reservation — and unavailable zones. A site link alone never blocks geography.
 */
export function conflictRings(w: World, scope: string[]): { name: string; ring: Ring; kind: 'SITE' | 'ZONE' }[] {
  const vacated = new Set(affectedSites(w, scope).filter((a) => a.staying.length === 0).map((a) => a.site.id));
  const occupied = (s: Site) => (occupantsOf(w, s.id).length > 0 && !vacated.has(s.id)) || occupancyAt(w, s.id).length > 0;
  return [
    ...w.sites.filter((s) => s.state === 'REGISTERED' && occupied(s)).map((s) => ({ name: s.name, ring: s.ring, kind: 'SITE' as const })),
    ...w.zones.map((z) => ({ name: z.name, ring: z.ring, kind: 'ZONE' as const })),
  ];
}

export type TerrainShare = { code: string; label: string; pct: number };
/**
 * `tie`: two or more classes share the largest area. `tieResolved`: the configured priority chose `cls` among
 * `tied`; false → no valid priority for the tied classes → submission is blocked.
 */
export type TerrainResult = { cls: TerrainClass; shares: TerrainShare[]; tie: boolean; tied: string[]; tieResolved: boolean; priority: string[] };

/**
 * Share of the area by terrain class, by sampling a fine grid over the geometry (prototype; production: PostGIS
 * ST_Area(ST_Intersection)). The controlling class follows the policy: largest area (owner rule O-05) by default.
 */
export function terrainShares(w: World, ring: Ring, n = 48): TerrainShare[] {
  const lat0 = Math.min(...ring.map((p) => p.lat)), lat1 = Math.max(...ring.map((p) => p.lat));
  const lng0 = Math.min(...ring.map((p) => p.lng)), lng1 = Math.max(...ring.map((p) => p.lng));
  const count = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const p: LatLng = { lat: lat0 + ((i + 0.5) / n) * (lat1 - lat0), lng: lng0 + ((j + 0.5) / n) * (lng1 - lng0) };
      if (!pointInRing(p, ring)) continue;
      const code = w.terrain.zones.find((z) => pointInRing(p, z.ring))?.code ?? w.terrain.defaultCode;
      count.set(code, (count.get(code) ?? 0) + 1);
      total++;
    }
  return [...count.entries()].map(([code, c]) => ({ code, label: code, pct: Math.round((c / Math.max(1, total)) * 1000) / 10 })).sort((a, b) => b.pct - a.pct);
}

export function terrainClassOf(w: World, pol: PolicyValues, ring: Ring): TerrainResult {
  const byCode = (code: string): TerrainClass => pol.terrainClasses.find((c) => c.code === code) ?? { code, label: 'فئة غير مهيأة (' + code + ')', allowanceM: 0 };
  const shares = terrainShares(w, ring).map((s) => ({ ...s, label: byCode(s.code).label }));
  const none = { tie: false, tied: [] as string[], tieResolved: true, priority: pol.terrainPriority };
  if (pol.terrainResolution === 'AREA_CENTRE') {
    const z = w.terrain.zones.find((t) => pointInRing(centroid(ring), t.ring));
    return { cls: byCode(z?.code ?? w.terrain.defaultCode), shares, ...none };
  }
  if (pol.terrainResolution === 'MOST_DEMANDING_TOUCHED')
    return { cls: shares.map((s) => byCode(s.code)).sort((a, b) => b.allowanceM - a.allowanceM)[0] ?? byCode(w.terrain.defaultCode), shares, ...none };
  // LARGEST_AREA (O-05): the class with the largest share; a tie (equal shares — here within the 48×48 sampling
  // tolerance, in production exact areas) goes to the tied class highest in `terrain_class_priority` (O-05b). Never
  // random, never "most restrictive" or "largest allowance" by itself; no valid priority → blocked.
  const top = shares[0]?.pct ?? 0;
  const tied = shares.filter((s) => top - s.pct < 0.5).map((s) => s.code);
  if (tied.length < 2) return { cls: byCode(shares[0]?.code ?? w.terrain.defaultCode), shares, ...none };
  const ranked = tied.filter((c) => pol.terrainPriority.includes(c)).sort((a, b) => pol.terrainPriority.indexOf(a) - pol.terrainPriority.indexOf(b));
  const resolved = ranked.length === tied.length;
  return { cls: byCode(resolved ? ranked[0] : tied[0]), shares, tie: true, tied, tieResolved: resolved, priority: pol.terrainPriority };
}

export type LegCheck = {
  leg: 'primary' | 'alternative';
  base: { min: number; max: number };
  terrain: TerrainResult | null;
  effective: { min: number; max: number };
  exceptionMax: number | null;
  distance: number | null;
  method: Method;
  status: 'NOT_PLACED' | 'OK' | 'NEEDS_EXCEPTION' | 'OUT_OF_RANGE' | 'TERRAIN_TIE';
};

export function legCheck(w: World, pol: PolicyValues, leg: 'primary' | 'alternative', from: Ring | null, to: Ring | null): LegCheck {
  const L = pol[leg];
  const t = L.terrain && to ? terrainClassOf(w, pol, to) : null;
  const add = t?.cls.allowanceM ?? 0;
  const effective = { min: L.minM + (pol.terrainAppliesTo === 'MIN_AND_MAX' ? add : 0), max: L.maxM + add };
  const exceptionMax = pol.exception.allowed ? effective.max + pol.exception.maxExtraM : null;
  const base = { leg, base: { min: L.minM, max: L.maxM }, terrain: t, effective, exceptionMax, method: L.method };
  if (!from || !to) return { ...base, distance: null, status: 'NOT_PLACED' };
  const d = measure(L.method, from, to);
  if (t?.tie && !t.tieResolved) return { ...base, distance: d, status: 'TERRAIN_TIE' };
  const status = d >= effective.min && d <= effective.max ? 'OK' : exceptionMax != null && d > effective.max && d <= exceptionMax ? 'NEEDS_EXCEPTION' : 'OUT_OF_RANGE';
  return { ...base, distance: d, status };
}

export type Check = { ok: boolean; problems: string[]; area: number | null; conflicts: string[]; deployConflicts: Record<'primary' | 'alternative', string[]>; legs: LegCheck[] };

/** Everything submission requires, against the request's policy (locked version once submitted). */
export function validate(w: World, r: Request): Check {
  const pol = policyOfRequest(w, r).values;
  const c = r.content;
  const problems: string[] = [];
  if (!c.scope.length) problems.push('لم تُحدد أي وحدة تنتقل.');
  const outside = c.scope.filter((o) => !isUnder(w, o, r.requestingUnit) && c.occupants[o] !== 'INCLUDED');
  if (outside.length) problems.push('وحدات خارج فرع الوحدة الطالبة: ' + outside.map((o) => orgOf(w, o)?.name).join('، '));
  const included = c.scope.filter((o) => !isUnder(w, o, r.requestingUnit));
  if (included.length && !pol.crossBranch.allowed) problems.push('ضم وحدة من فرع آخر غير مسموح في السياسة السارية.');
  if (c.kind === 'TEMPORARY' && (c.end == null || c.end <= c.start)) problems.push('التمركز المؤقت يحتاج نهاية بعد بدايته.');
  let area: number | null = null;
  let conflicts: string[] = [];
  const occupied = conflictRings(w, c.scope);
  if (!c.site) problems.push('لم يُحدد موقع إعادة التمركز.');
  else {
    area = areaM2(c.site.ring);
    if (kinks(c.site.ring)) problems.push('حدود الموقع المقترح متقاطعة.');
    if (area > pol.maxFootprintAreaM2) problems.push('مساحة الموقع المقترح تتجاوز الحد الأقصى المعتمد.');
    conflicts = occupied.filter((x) => ringsIntersect(c.site!.ring, x.ring)).map((x) => x.name);
    if (conflicts.length) problems.push('الموقع المقترح يتداخل مع: ' + conflicts.join('، '));
  }
  const has = { p: !!c.primary, a: !!c.alternative };
  if (pol.deployment === 'REQUIRED' && !(has.p && has.a)) problems.push('منطقتا الانتشار الرئيسية والبديلة مطلوبتان في السياسة السارية.');
  if (pol.deployment === 'OPTIONAL' && has.p !== has.a) problems.push('الانتشار زوج كامل: الرئيسية والبديلة معاً، أو لا شيء.');
  const legs = [legCheck(w, pol, 'primary', c.site?.ring ?? null, c.primary), legCheck(w, pol, 'alternative', c.primary, c.alternative)];
  const deployConflicts = { primary: [] as string[], alternative: [] as string[] };
  for (const l of legs) {
    const name = l.leg === 'primary' ? 'منطقة الانتشار الرئيسية' : 'منطقة الانتشار البديلة';
    const ring = c[l.leg];
    if (l.status === 'OUT_OF_RANGE') problems.push(name + ' خارج النطاق المسموح.');
    if (l.status === 'NEEDS_EXCEPTION' && !c.exceptions[l.leg]?.trim()) problems.push(name + ' تحتاج استثناءً بسبب مكتوب.');
    if (l.status === 'TERRAIN_TIE') problems.push(name + ': تعادل بين فئات أرض (' + l.terrain!.tied.join('، ') + ') دون ترتيب أولوية صالح لها في السياسة — يُمنع الإرسال (O-05b).');
    if (!ring) continue;
    if (kinks(ring)) problems.push(name + ': حدود متقاطعة.');
    // O-08 owner rule: occupied or unavailable geography is a HARD block for deployment areas
    deployConflicts[l.leg] = occupied.filter((x) => ringsIntersect(ring, x.ring) || pointInRing(x.ring[0], ring)).map((x) => x.name);
    if (deployConflicts[l.leg].length) problems.push(name + ' تتداخل مع أرض مشغولة: ' + deployConflicts[l.leg].join('، '));
  }
  const req = personOf(w, r.requester);
  for (const o of otherBranchOccupants(w, r.requestingUnit, c.scope.filter((x) => c.occupants[x] !== 'INCLUDED')))
    if (!c.occupants[o] && responsibleIn(w, req, siteOfOrg(w, o)?.id)) problems.push('حدّد معالجة الوحدة من فرع آخر: ' + orgOf(w, o)?.name);
  if (!c.reason.trim()) problems.push('سبب الطلب مطلوب.');
  return { ok: problems.length === 0, problems, area, conflicts, deployConflicts, legs };
}

/** Whether the requester's branch holds facility responsibility for a site (then other-branch occupants need a decision). */
export const responsibleIn = (w: World, p: Person, site: string | undefined) => {
  const r = site ? responsibleOf(w, site) : undefined;
  return !!r && inRequesterScope(w, p, r.org);
};

// ---------------------------------------------------------------------------------------------------------------------
// Routing — from the REQUESTING UNIT upward through the Oracle hierarchy and the configured levels (O-07, O-09)

export function deriveRoute(w: World, r: Request, pol: PolicyValues): Stage[] {
  const path = pathOf(w, r.requestingUnit).map((id) => orgOf(w, id)!);
  const walk = pol.routing.startAt === 'PARENT' ? path.slice(1) : path;
  const stages: Stage[] = [];
  for (const u of walk) {
    const cfg = pol.routing.levels.find((l) => l.level === u.level);
    if (cfg?.approve) stages.push({ key: 'H:' + u.id, label: cfg.label + ' — ' + u.name, unit: u.id, perm: 'APPROVE', dependsOn: cfg.final ? ALL_FACTS : cfg.dependsOn, final: cfg.final, kind: 'HIERARCHY', satisfies: ['اعتماد هرمي'] });
    if (cfg?.final) break;
  }
  const c = r.content;
  const extra: Stage[] = [];
  // O-03: each included unit of another branch adds the configured authorities (one or several)
  for (const o of c.scope.filter((x) => !isUnder(w, x, r.requestingUnit) && c.occupants[x] === 'INCLUDED')) {
    const units: [CrossAuthority, string | undefined][] = pol.crossBranch.authorities.map((a) => [a, a === 'OTHER_UNIT' ? o : a === 'OTHER_UNIT_PARENT' ? orgOf(w, o)?.parentId ?? undefined : responsibleOf(w, siteOfOrg(w, o)?.id ?? '')?.org]);
    for (const [a, unit] of units) {
      if (!unit) continue;
      const what = a === 'OTHER_UNIT' ? 'موافقة الوحدة من الفرع الآخر' : a === 'OTHER_UNIT_PARENT' ? 'موافقة أب الوحدة من الفرع الآخر' : 'موافقة المسؤول عن موقعها';
      const condition = what + ' (ضم ' + orgOf(w, o)?.name + ')';
      // O-03b: the same authority already on the route satisfies this condition too — unless independence is required
      const existing = pol.crossBranch.independent ? undefined : [...stages, ...extra].find((s) => s.unit === unit && s.perm === 'APPROVE');
      if (existing) existing.satisfies.push(condition);
      else extra.push({ key: 'C:' + a + ':' + unit + ':' + o, label: what + ' — ' + orgOf(w, unit)?.name, unit, perm: 'APPROVE', dependsOn: ['SCOPE', 'SITE'], kind: 'CROSS_BRANCH', satisfies: [condition] });
    }
  }
  const legs = [legCheck(w, pol, 'primary', c.site?.ring ?? null, c.primary), legCheck(w, pol, 'alternative', c.primary, c.alternative)];
  if (legs.some((l) => l.status === 'NEEDS_EXCEPTION')) extra.push({ key: 'X:distance', label: 'اعتماد استثناء مسافة الانتشار', unit: null, perm: 'APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION', dependsOn: ['DEPLOYMENT'], kind: 'EXCEPTION', satisfies: ['استثناء المسافة'] });
  stages.splice(Math.max(0, stages.length - 1), 0, ...extra);
  return stages;
}

/** Who may decide a stage now, with separation of duties by the stable human identity. */
export function stageDeciders(w: World, r: Request, s: Stage): Person[] {
  const decided = new Set(r.stages.filter((x) => x.by && x.key !== s.key).map((x) => personOf(w, x.by!).human));
  const requester = personOf(w, r.requester).human;
  return w.people.filter((p) => (s.unit ? can(p, s.perm, w, s.unit) : p.perms.includes(s.perm)) && p.human !== requester && !decided.has(p.human));
}

// ---------------------------------------------------------------------------------------------------------------------
// Revisions and selective invalidation (V2 D18 kept)

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function changedFacts(a: Content, b: Content): Fact[] {
  const f = new Set<Fact>();
  if (!same([...a.scope].sort(), [...b.scope].sort()) || !same(a.occupants, b.occupants)) f.add('SCOPE').add('AVAILABILITY');
  if (a.kind !== b.kind) f.add('CLASSIFICATION').add('DURATION').add('AVAILABILITY');
  if (a.start !== b.start || a.end !== b.end) f.add('DURATION').add('AVAILABILITY');
  if (!same(a.site?.ring, b.site?.ring)) f.add('SITE').add('AVAILABILITY');
  if (!same(a.primary, b.primary) || !same(a.alternative, b.alternative) || !same(a.exceptions, b.exceptions)) f.add('DEPLOYMENT');
  return ALL_FACTS.filter((x) => f.has(x));
}

export function reconcile(old: Stage[], fresh: Stage[], changed: Fact[]) {
  const prev = new Map(old.map((s) => [s.key, s]));
  const hits = (s: Stage) => s.dependsOn.some((f) => changed.includes(f));
  const reopen = fresh.findIndex((s) => hits(s) || !prev.get(s.key)?.mark);
  const invalidated: string[] = [];
  const carried: string[] = [];
  const stages = fresh.map((s, i) => {
    const p = prev.get(s.key);
    if (!p?.mark) return s;
    if (hits(s)) {
      invalidated.push(s.key);
      return s;
    }
    if (reopen >= 0 && i > reopen) carried.push(s.key);
    return { ...s, mark: reopen >= 0 && i > reopen ? ('CARRIED' as const) : p.mark, by: p.by, at: p.at };
  });
  return { stages, invalidated, carried };
}

// ---------------------------------------------------------------------------------------------------------------------
// Actions

export type Action =
  | { t: 'CREATE'; id: string; content: Content; requestingUnit?: string }
  | { t: 'EDIT'; req: string; content: Content }
  | { t: 'SUBMIT'; req: string; reason?: string }
  | { t: 'APPROVE'; req: string }
  | { t: 'RETURN'; req: string; reason: string }
  | { t: 'REJECT'; req: string; reason: string }
  | { t: 'ACTIVATE'; req: string }
  | { t: 'REQUEST_EXTENSION'; req: string; newEnd: number; reason: string }
  | { t: 'APPROVE_EXTENSION'; req: string }
  | { t: 'ACTIVATE_EXTENSION'; req: string }
  | { t: 'REQUEST_EARLY_RETURN'; req: string; reason: string }
  | { t: 'DECIDE_EARLY_RETURN'; req: string; approve: boolean; reason: string }
  | { t: 'REQUEST_START_CANCELLATION'; req: string; reason: string }
  | { t: 'DECIDE_START_CANCELLATION'; req: string; approve: boolean; reason: string }
  | { t: 'PUBLISH_POLICY'; values: PolicyValues; effectiveFrom: number; reason: string; reference: string }
  | { t: 'LINK_SITE'; org: string; site: string; reason: string }
  | { t: 'UNLINK_SITE'; org: string; site: string; reason: string }
  | { t: 'CORRECT_STATIONING'; org: string; site: string; reason: string }
  | { t: 'SET_RESPONSIBILITY'; site: string; org: string; reason: string }
  | { t: 'ORACLE_SYNC'; rows: { oracleId: string; parentOracleId: string | null; level: number; name: string }[] }
  | { t: 'TICK'; ms: number };

export type Verdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Verdict => ({ ok: false, reason });
const yes: Verdict = { ok: true };
const reqOf = (w: World, id: string) => w.requests.find((r) => r.id === id);
export const currentStage = (r: Request) => r.stages.find((s) => !s.mark);
const pendingExt = (r: Request) => r.extensions.find((e) => e.state === 'UNDER_REVIEW' || e.state === 'APPROVED_NOT_ACTIVATED');
const editable = (s: ReqState) => s === 'DRAFT' || s === 'RETURNED_FOR_CHANGES' || s === 'PAUSED_HIERARCHY_CHANGED';

export function check(w: World, actor: string, a: Action): Verdict {
  const p = personOf(w, actor);
  if (a.t === 'TICK' || a.t === 'ORACLE_SYNC') return yes;
  if (a.t === 'PUBLISH_POLICY') return !p.perms.includes('ADMIN_POLICY') ? no('تغيير السياسة لمسؤول النظام فقط.') : !a.reason.trim() || !a.reference.trim() ? no('السبب ومرجع السياسة مطلوبان.') : yes;
  if (a.t === 'LINK_SITE' || a.t === 'UNLINK_SITE') return !can(p, 'MANAGE_SITE_LINKS', w, a.org) ? no('ربط المواقع يحتاج صلاحية «إدارة ربط المواقع».') : !a.reason.trim() ? no('السبب مطلوب.') : a.t === 'UNLINK_SITE' && !w.links.some((l) => l.org === a.org && l.site === a.site && l.to == null) ? no('لا يوجد ربط قائم.') : yes;
  if (a.t === 'CORRECT_STATIONING') return !can(p, 'CORRECT_STATIONING', w, a.org) ? no('تصحيح التمركز إجراء بيانات بصلاحيته الخاصة.') : !a.reason.trim() ? no('السبب مطلوب.') : yes;
  if (a.t === 'SET_RESPONSIBILITY') return !p.perms.includes('MANAGE_FACILITY_RESPONSIBILITY') ? no('المسؤولية عن المرفق إجراء مستقل بصلاحيته.') : !a.reason.trim() ? no('السبب مطلوب.') : yes;
  if (a.t === 'CREATE') {
    const unit = a.requestingUnit ?? requestingUnitFor(w, p, a.content.scope[0] ?? '');
    if (!p.scope.includes(unit) || !p.perms.includes('CREATE_RESTATIONING')) return no('الوحدة الطالبة خارج نطاق مقدم الطلب.');
    return a.content.scope.every((o) => isUnder(w, o, unit) || a.content.occupants[o] === 'INCLUDED') ? yes : no('خارج فرع الوحدة الطالبة.');
  }
  const r = reqOf(w, a.req);
  if (!r) return no('لا يوجد طلب.');
  const own = r.requester === actor;
  switch (a.t) {
    case 'EDIT':
      if (!own) return no('يعدّل الطلبَ مقدمُه فقط.');
      return editable(r.state) ? yes : no('لا يُعدّل الطلب في حالته الحالية؛ الحركة اللاحقة تحتاج طلباً جديداً.');
    case 'SUBMIT': {
      if (!own) return no('يرسل الطلبَ مقدمُه فقط.');
      if (!editable(r.state)) return no('أُرسل الطلب.');
      const v = validate(w, r);
      if (!v.ok) return no(v.problems[0]);
      if (r.state !== 'DRAFT' && !(a.reason ?? '').trim()) return no(r.state === 'PAUSED_HIERARCHY_CHANGED' ? 'أكّد الطلب بسبب مكتوب لإعادة بناء المسار.' : 'اذكر ما عدّلته عند إعادة الإرسال.');
      return deriveRoute(w, r, policyOfRequest(w, r).values).length ? yes : no('لم يُشتق مسار اعتماد من الهيكل والإعداد.');
    }
    case 'APPROVE':
    case 'RETURN':
    case 'REJECT': {
      if (r.state !== 'UNDER_REVIEW') return no(r.state === 'PAUSED_HIERARCHY_CHANGED' ? 'الطلب موقوف: ' + HIERARCHY_CHANGED + '.' : 'الطلب ليس قيد المراجعة.');
      const s = currentStage(r)!;
      if (!stageDeciders(w, r, s).some((x) => x.id === actor)) return no('ليس صاحب قرار المرحلة الحالية («' + s.label + '»)، أو قرر مرحلة أخرى في الطلب، أو هو مقدم الطلب.');
      if (a.t !== 'APPROVE' && !a.reason.trim()) return no('السبب مطلوب.');
      return yes;
    }
    case 'ACTIVATE':
      if (r.state !== 'APPROVED_NOT_ACTIVATED') return no(r.state === 'PAUSED_HIERARCHY_CHANGED' ? 'الطلب موقوف: ' + HIERARCHY_CHANGED + '.' : 'التفعيل بعد الاعتماد النهائي فقط.');
      // O-16: never activate on an obsolete hierarchy, even if the drift has not been processed yet
      if (!same(r.routePath, pathOf(w, r.requestingUnit))) return no(HIERARCHY_CHANGED + ' — التفعيل ممنوع حتى إعادة التأكيد وإعادة الاعتماد.');
      if (!r.content.scope.every((o) => can(p, 'ACTIVATE_STATIONING', w, o))) return no('يحتاج صلاحية «تفعيل التمركز» على كل الوحدات.');
      if (r.finalApprover && personOf(w, r.finalApprover).human === p.human) return no('صاحب الاعتماد النهائي لا يفعّل (D1).');
      if (personOf(w, r.requester).human === p.human) return no('مقدم الطلب لا يفعّل طلبه.');
      return yes;
    case 'REQUEST_EXTENSION':
      if (!own) return no('يطلب التمديدَ مقدمُ الطلب.');
      if (r.content.kind !== 'TEMPORARY' || !['TEMPORARY_SCHEDULED', 'ACTIVE_TEMPORARY'].includes(r.state)) return no('التمديد لتمركز مؤقت مفعّل فقط.');
      if (pendingExt(r)) return no('يوجد تمديد قيد المعالجة.');
      return a.newEnd > (r.content.end ?? 0) && a.reason.trim() ? yes : no('النهاية الجديدة بعد الحالية، والسبب مطلوب.');
    case 'APPROVE_EXTENSION': {
      const e = r.extensions.find((x) => x.state === 'UNDER_REVIEW');
      if (!e) return no('لا تمديد قيد المراجعة.');
      const s = e.stages.find((x) => !x.mark)!;
      return stageDeciders(w, { ...r, stages: e.stages }, s).some((x) => x.id === actor) ? yes : no('ليس صاحب قرار مرحلة التمديد («' + s.label + '»).');
    }
    case 'ACTIVATE_EXTENSION': {
      const e = r.extensions.find((x) => x.state === 'APPROVED_NOT_ACTIVATED');
      if (!e) return no('لا تمديد معتمد بانتظار التفعيل.');
      if (!r.content.scope.every((o) => can(p, 'ACTIVATE_TEMPORARY_EXTENSION', w, o))) return no('يحتاج صلاحية «تفعيل التمديد».');
      const last = e.stages[e.stages.length - 1]?.by;
      if ((last && personOf(w, last).human === p.human) || personOf(w, e.by).human === p.human) return no('لا يفعّل التمديدَ مقدمُه ولا صاحب اعتماده النهائي (D10).');
      return yes;
    }
    case 'REQUEST_EARLY_RETURN':
      return own && r.state === 'ACTIVE_TEMPORARY' && !r.earlyReturn ? (a.reason.trim() ? yes : no('السبب مطلوب.')) : no('العودة المبكرة لتمركز مؤقت نافذ، يطلبها مقدم الطلب.');
    case 'DECIDE_EARLY_RETURN':
      if (r.earlyReturn?.state !== 'REQUESTED') return no('لا طلب عودة مبكرة معلق.');
      if (!r.content.scope.every((o) => can(p, 'DECIDE_EARLY_RETURN', w, o)) || personOf(w, r.earlyReturn.by).human === p.human) return no('يقرره طرف مستقل بصلاحية «قرار العودة المبكرة».');
      return a.reason.trim() ? yes : no('السبب مطلوب.');
    case 'REQUEST_START_CANCELLATION':
      return own && r.state === 'TEMPORARY_SCHEDULED' && !r.startCancellation ? (a.reason.trim() ? yes : no('السبب مطلوب.')) : no('الإلغاء قبل البدء لتمركز مؤقت مجدول، يطلبه مقدم الطلب.');
    case 'DECIDE_START_CANCELLATION':
      if (r.startCancellation?.state !== 'REQUESTED') return no('لا طلب إلغاء معلق.');
      if (!r.content.scope.every((o) => can(p, 'DECIDE_TEMPORARY_BEFORE_START_CANCELLATION', w, o)) || personOf(w, r.startCancellation.by).human === p.human) return no('يقرره طرف مستقل بصلاحيته (A4).');
      return a.reason.trim() ? yes : no('السبب مطلوب.');
  }
}

const log = (w: World, by: string, type: string, ref: string, detail: string) => w.events.push({ at: w.now, by, type, ref, detail });

export function perform(w0: World, actor: string, a: Action): World {
  if (!check(w0, actor, a).ok) return w0;
  const w: World = structuredClone(w0);
  const r = 'req' in a ? reqOf(w, a.req)! : undefined;
  switch (a.t) {
    case 'TICK':
      tick(w, w.now + a.ms);
      break;
    case 'CREATE': {
      const p = personOf(w, actor);
      const unit = a.requestingUnit ?? requestingUnitFor(w, p, a.content.scope[0] ?? '');
      w.requests.push({ id: a.id, number: 'RS-2026-' + String(100 + w.requests.length + 1).padStart(4, '0'), requester: actor, requestingUnit: unit, content: a.content, state: 'DRAFT', policyVersion: null, stages: [], routePath: [], routeHistory: [], revisions: [], extensions: [] });
      log(w, actor, 'REQUEST_CREATED', a.id, 'مسودة · الوحدة الطالبة: ' + orgOf(w, unit)?.name);
      break;
    }
    case 'EDIT':
      r!.content = structuredClone(a.content);
      break;
    case 'SUBMIT': {
      const first = r!.state === 'DRAFT';
      const wasPaused = r!.state === 'PAUSED_HIERARCHY_CHANGED';
      if (first) r!.policyVersion = policyAt(w, w.now).version;
      const pol = policyOfRequest(w, r!).values;
      const fresh = deriveRoute(w, r!, pol);
      const prev = r!.revisions[r!.revisions.length - 1];
      const changed = prev ? changedFacts(prev.content, r!.content) : ALL_FACTS;
      let result = prev ? reconcile(r!.stages, fresh, changed) : { stages: fresh, invalidated: [] as string[], carried: [] as string[] };
      if (wasPaused && pol.routing.afterHierarchyChange === 'RESTART_ALL') result = { stages: fresh, invalidated: r!.stages.filter((s) => s.mark).map((s) => s.key), carried: [] };
      r!.stages = result.stages;
      r!.routePath = pathOf(w, r!.requestingUnit);
      r!.revisions.push({ n: r!.revisions.length + 1, at: w.now, by: actor, content: structuredClone(r!.content), changed, reason: a.reason, invalidated: result.invalidated, carried: result.carried });
      r!.state = 'UNDER_REVIEW';
      r!.returned = undefined;
      r!.paused = undefined;
      log(w, actor, first ? 'SUBMITTED' : wasPaused ? 'RECONFIRMED_ROUTE_REBUILT' : 'RESUBMITTED', r!.id, (first ? 'نسخة السياسة ' + r!.policyVersion : 'تغيّر: ' + (changed.join('، ') || '—') + ' · أُعيد: ' + result.invalidated.length + ' · حُمل: ' + result.carried.length) + terrainAudit(w, r!));
      settle(w, r!);
      break;
    }
    case 'APPROVE': {
      const s = currentStage(r!)!;
      Object.assign(s, { mark: 'APPROVED', by: actor, at: w.now });
      log(w, actor, 'STAGE_APPROVED', r!.id, s.label + ' · يستوفي: ' + s.satisfies.join('، '));
      settle(w, r!);
      break;
    }
    case 'RETURN': {
      const s = currentStage(r!)!;
      r!.state = 'RETURNED_FOR_CHANGES';
      r!.returned = { by: actor, stage: s.key, reason: a.reason, at: w.now };
      log(w, actor, 'RETURNED_FOR_CHANGES', r!.id, s.label + ': ' + a.reason);
      break;
    }
    case 'REJECT':
      r!.state = 'REJECTED';
      log(w, actor, 'REJECTED', r!.id, a.reason);
      break;
    case 'ACTIVATE':
      activate(w, r!, actor);
      break;
    case 'REQUEST_EXTENSION': {
      const st = r!.stages.filter((s) => s.kind === 'HIERARCHY' && (s.final || s.dependsOn.includes('DURATION'))).map((s) => ({ ...s, key: 'E' + s.key, mark: undefined, by: undefined, at: undefined }));
      r!.extensions.push({ id: r!.id + '-x' + (r!.extensions.length + 1), newEnd: a.newEnd, state: 'UNDER_REVIEW', by: actor, stages: st, reason: a.reason });
      log(w, actor, 'EXTENSION_REQUESTED', r!.id, a.reason);
      break;
    }
    case 'APPROVE_EXTENSION': {
      const e = r!.extensions.find((x) => x.state === 'UNDER_REVIEW')!;
      Object.assign(e.stages.find((x) => !x.mark)!, { mark: 'APPROVED', by: actor, at: w.now });
      if (e.stages.every((x) => x.mark)) e.state = 'APPROVED_NOT_ACTIVATED';
      log(w, actor, 'EXTENSION_STAGE_APPROVED', r!.id, e.id);
      break;
    }
    case 'ACTIVATE_EXTENSION': {
      const e = r!.extensions.find((x) => x.state === 'APPROVED_NOT_ACTIVATED')!;
      e.state = 'ACTIVATED';
      r!.content.end = e.newEnd;
      for (const s of w.stationings.filter((s) => s.requestId === r!.id && s.kind === 'TEMPORARY')) s.plannedEnd = e.newEnd;
      for (const ar of w.areas.filter((x) => x.requestId === r!.id && x.state === 'ACTIVE')) ar.to = e.newEnd;
      log(w, actor, 'EXTENSION_ACTIVATED', r!.id, 'النهاية الجديدة ' + new Date(e.newEnd).toISOString().slice(0, 10));
      break;
    }
    case 'REQUEST_EARLY_RETURN':
      r!.earlyReturn = { by: actor, reason: a.reason, state: 'REQUESTED' };
      log(w, actor, 'EARLY_RETURN_REQUESTED', r!.id, a.reason);
      break;
    case 'DECIDE_EARLY_RETURN':
      r!.earlyReturn = { ...r!.earlyReturn!, state: a.approve ? 'APPROVED' : 'REJECTED', decidedBy: actor };
      if (a.approve) endTemporary(w, r!, 'EARLY_RETURN');
      log(w, actor, a.approve ? 'EARLY_RETURN_APPROVED' : 'EARLY_RETURN_REJECTED', r!.id, a.reason);
      break;
    case 'REQUEST_START_CANCELLATION':
      r!.startCancellation = { by: actor, reason: a.reason, state: 'REQUESTED' };
      log(w, actor, 'START_CANCELLATION_REQUESTED', r!.id, a.reason);
      break;
    case 'DECIDE_START_CANCELLATION':
      r!.startCancellation = { ...r!.startCancellation!, state: a.approve ? 'APPROVED' : 'REJECTED', decidedBy: actor };
      if (a.approve) {
        r!.state = 'TEMPORARY_CANCELLED_BEFORE_START';
        for (const s of w.stationings.filter((s) => s.requestId === r!.id && s.state === 'SCHEDULED')) {
          s.state = 'CANCELLED_BEFORE_START';
          emit(w, 'TEMPORARY_STATIONING_CANCELLED', s.org, s.site, w.now, 'cancellation', r!.id);
        }
        for (const ar of w.areas.filter((x) => x.requestId === r!.id)) ar.state = 'RETIRED';
      }
      log(w, actor, a.approve ? 'START_CANCELLATION_APPROVED' : 'START_CANCELLATION_REJECTED', r!.id, a.reason);
      break;
    case 'PUBLISH_POLICY': {
      const v = Math.max(...w.policies.map((p) => p.version)) + 1;
      w.policies.push({ version: v, effectiveFrom: a.effectiveFrom, author: actor, reason: a.reason, reference: a.reference, values: structuredClone(a.values) });
      log(w, actor, 'POLICY_PUBLISHED', 'policy-' + v, a.reference + ': ' + a.reason);
      break;
    }
    case 'LINK_SITE':
      w.links.push({ id: 'ln-' + w.links.length, site: a.site, org: a.org, from: w.now, source: 'TMRKZ', reason: a.reason });
      log(w, actor, 'SITE_LINKED', a.org, siteOf(w, a.site)?.name + ': ' + a.reason);
      emit(w, 'SITE_LINK_CREATED', a.org, a.site, w.now, 'link', 'ln-' + (w.links.length - 1));
      break;
    case 'UNLINK_SITE': {
      const l = w.links.find((x) => x.org === a.org && x.site === a.site && x.to == null)!;
      l.to = w.now;
      log(w, actor, 'SITE_UNLINKED', a.org, siteOf(w, a.site)?.name + ': ' + a.reason);
      emit(w, 'SITE_LINK_ENDED', a.org, a.site, w.now, 'link', l.id);
      break;
    }
    case 'CORRECT_STATIONING': {
      const cur = permanentOf(w, a.org);
      if (cur) Object.assign(cur, { state: 'ENDED', to: w.now, endReason: 'STATIONING_CORRECTION' });
      w.stationings.push({ id: 'st-' + w.stationings.length + '-fix', org: a.org, site: a.site, kind: 'PERMANENT', state: 'CURRENT', from: w.now });
      log(w, actor, 'STATIONING_CORRECTED', a.org, (cur ? siteOf(w, cur.site)?.name : '—') + ' ← ' + siteOf(w, a.site)?.name + ': ' + a.reason);
      emit(w, 'STATIONING_CORRECTED', a.org, a.site, w.now, 'correction', 'evt-log-' + (w.events.length - 1));
      break;
    }
    case 'SET_RESPONSIBILITY': {
      const cur = responsibleOf(w, a.site);
      if (cur) cur.to = w.now;
      w.responsibilities.push({ id: 'rs-' + w.responsibilities.length, site: a.site, org: a.org, from: w.now, reason: a.reason });
      log(w, actor, 'FACILITY_RESPONSIBILITY_SET', a.site, orgOf(w, a.org)?.name + ': ' + a.reason);
      break;
    }
    case 'ORACLE_SYNC': {
      // read-only mirror: names, parents and levels change; site links and stationing are never rewritten
      const byOracle = new Map(w.orgs.map((o) => [o.oracleId, o]));
      const moved: string[] = [];
      for (const row of a.rows) {
        const o = byOracle.get(row.oracleId);
        if (!o) continue;
        const parent = row.parentOracleId ? byOracle.get(row.parentOracleId)?.id ?? null : null;
        if (parent !== o.parentId) moved.push(o.id);
        Object.assign(o, { parentId: parent, level: row.level, name: row.name });
      }
      // O-10 owner rule: a request whose requesting unit's hierarchy changed is paused and returned for reconfirmation
      for (const q of w.requests.filter((q) => (q.state === 'UNDER_REVIEW' || q.state === 'APPROVED_NOT_ACTIVATED') && !same(q.routePath, pathOf(w, q.requestingUnit)))) {
        q.routeHistory.push({ at: w.now, reason: HIERARCHY_CHANGED, stages: structuredClone(q.stages), path: q.routePath });
        q.paused = { at: w.now, reason: HIERARCHY_CHANGED, from: q.state };
        q.state = 'PAUSED_HIERARCHY_CHANGED';
        log(w, 'oracle-sync', 'REQUEST_PAUSED_HIERARCHY_CHANGED', q.id, HIERARCHY_CHANGED + ' · المسار السابق محفوظ: ' + q.routePath.map((id) => orgOf(w0, id)?.code).join(' ← '));
      }
      w.oracle = { ...w.oracle, extractAt: w.now, rows: a.rows.length };
      log(w, 'oracle-sync', 'ORACLE_SYNC_APPLIED', 'hr', 'تغيّر الأب لـ ' + moved.length + ' وحدة؛ روابط المواقع والتمركز لم تتغير');
      break;
    }
  }
  return w;
}

/** The applied terrain decision of each leg, with the policy version, for the audit record (O-05, O-05b). */
function terrainAudit(w: World, r: Request): string {
  const pv = policyOfRequest(w, r);
  const legs = validate(w, r).legs.filter((l) => l.terrain);
  if (!legs.length) return '';
  return (
    ' · الأرض (السياسة ' + pv.version + ' ' + pv.reference + '): ' +
    legs
      .map((l) => (l.leg === 'primary' ? 'الرئيسية ' : 'البديلة ') + l.terrain!.cls.code + (l.terrain!.tie ? ' بتعادل ' + l.terrain!.tied.join('/') + ' حسمته الأولوية ' + l.terrain!.priority.join(' > ') : '') + ' +' + l.terrain!.cls.allowanceM + 'م')
      .join('؛ ')
  );
}

/** Appends to the outbox in the same (simulated) transaction as the change it describes. */
function emit(w: World, type: OutboxEvent['type'], org: string, site: string, effectiveAt: number, sourceVersion: string, auditRef: string) {
  const o = orgOf(w, org)!;
  const s = siteOf(w, site);
  const seq = w.outbox.length + 1;
  w.outbox.push({
    seq,
    id: 'evt-' + String(seq).padStart(5, '0'),
    type,
    orgExternalId: o.oracleId,
    orgCode: o.code,
    siteId: site,
    siteExternalId: s && s.source.system !== 'TMRKZ' ? (s.source as { externalId: string }).externalId : null,
    effectiveAt,
    recordedAt: w.now,
    source: 'TMRKZ',
    schema: 'tmrkz.stationing.v1',
    sourceVersion,
    auditRef,
  });
}

function settle(w: World, r: Request) {
  if (currentStage(r)) return;
  r.state = 'APPROVED_NOT_ACTIVATED';
  r.finalApprover = [...r.stages].reverse().find((s) => s.mark === 'APPROVED')?.by;
  log(w, 'system', 'FINAL_APPROVAL', r.id, 'بانتظار التفعيل المستقل');
}

function activate(w: World, r: Request, actor: string) {
  const c = r.content;
  const site: Site = { id: 'SITE-' + String(9000 + w.sites.length), name: 'موقع ' + r.number, ring: c.site!.ring, source: { system: 'TMRKZ' }, state: 'REGISTERED', createdBy: r.id };
  w.sites.push(site);
  r.activation = { by: actor, at: w.now, site: site.id };
  const temp = c.kind === 'TEMPORARY';
  for (const org of c.scope) {
    const base = permanentOf(w, org)!;
    if (!temp) {
      Object.assign(base, { state: 'ENDED', to: w.now, endReason: 'REPLACED_BY_ACTIVATION' });
      for (const t of w.stationings.filter((s) => s.org === org && s.kind === 'TEMPORARY' && (s.state === 'ACTIVE' || s.state === 'SCHEDULED'))) Object.assign(t, { state: 'ENDED', to: w.now, endReason: 'SUPERSEDED_BY_PERMANENT' });
      w.stationings.push({ id: 'st-' + w.stationings.length, org, site: site.id, kind: 'PERMANENT', state: 'CURRENT', from: w.now, requestId: r.id });
      emit(w, 'STATIONING_ACTIVATED', org, site.id, w.now, 'policy-' + r.policyVersion + '/rev-' + r.revisions.length, r.id);
    } else {
      const live = c.start <= w.now;
      w.stationings.push({ id: 'st-' + w.stationings.length, org, site: site.id, kind: 'TEMPORARY', state: live ? 'ACTIVE' : 'SCHEDULED', from: c.start, plannedEnd: c.end, requestId: r.id, baseId: base.id });
      emit(w, live ? 'TEMPORARY_STATIONING_STARTED' : 'TEMPORARY_STATIONING_SCHEDULED', org, site.id, c.start, 'policy-' + r.policyVersion + '/rev-' + r.revisions.length, r.id);
    }
  }
  for (const [role, ring] of [
    ['PRIMARY', c.primary],
    ['ALTERNATIVE', c.alternative],
  ] as const)
    if (ring) w.areas.push({ id: 'da-' + w.areas.length, site: site.id, role, ring, requestId: r.id, state: 'ACTIVE', from: temp ? c.start : w.now, to: temp ? c.end : undefined });
  r.state = temp ? (c.start <= w.now ? 'ACTIVE_TEMPORARY' : 'TEMPORARY_SCHEDULED') : 'ACTIVATED_PERMANENT';
  log(w, actor, 'ACTIVATED', r.id, (temp ? 'مؤقت' : 'دائم') + ' · ' + site.id + ' · ' + c.scope.length + ' وحدة · روابط المواقع والمسؤولية لم تتغير');
}

function endTemporary(w: World, r: Request, why: 'EXPIRED_RETURNED' | 'EARLY_RETURN') {
  for (const s of w.stationings.filter((s) => s.requestId === r.id && s.kind === 'TEMPORARY' && s.state === 'ACTIVE')) {
    Object.assign(s, { state: 'ENDED', to: w.now, endReason: why });
    emit(w, 'TEMPORARY_STATIONING_ENDED', s.org, s.site, w.now, why, r.id);
  }
  for (const a of w.areas.filter((x) => x.requestId === r.id && x.state === 'ACTIVE')) Object.assign(a, { state: 'RETIRED', to: w.now });
  r.state = 'TEMPORARY_RETURNED';
  log(w, 'system', why === 'EARLY_RETURN' ? 'EARLY_RETURN_EFFECTIVE' : 'TEMPORARY_ENDED_RETURNED', r.id, 'عادت الوحدات إلى تمركزها الأصلي المحفوظ');
}

function tick(w: World, to: number) {
  w.now = to;
  for (const r of w.requests) {
    if (r.state === 'TEMPORARY_SCHEDULED' && r.content.start <= to && r.startCancellation?.state !== 'REQUESTED') {
      for (const s of w.stationings.filter((s) => s.requestId === r.id && s.state === 'SCHEDULED')) {
        s.state = 'ACTIVE';
        emit(w, 'TEMPORARY_STATIONING_STARTED', s.org, s.site, s.from, 'start', r.id);
      }
      r.state = 'ACTIVE_TEMPORARY';
      log(w, 'system', 'TEMPORARY_STARTED', r.id, 'بدأ النفاذ');
    }
    if (r.state === 'ACTIVE_TEMPORARY' && (r.content.end ?? Infinity) <= to) {
      for (const e of r.extensions.filter((e) => e.state === 'UNDER_REVIEW' || e.state === 'APPROVED_NOT_ACTIVATED')) e.state = 'LAPSED_NOT_ACTIVATED';
      endTemporary(w, r, 'EXPIRED_RETURNED');
    }
  }
}
