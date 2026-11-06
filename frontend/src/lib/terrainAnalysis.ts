import type { RestationingLeg, SiteGeometry, StationingPolicyValues, TerrainAssessment } from '../api/types';
import { distanceM, type LatLng } from './geo';
import { centre, LABELS } from './requestMap';

/**
 * What the 3D view and the terrain panel show about a request's geometries (owner brief «TRUE OFFLINE 3D TERRAIN»,
 * §9–§19, §25, §28): the three connectors in their one order, and the deployment rule of a leg.
 *
 * The connectors are never all-to-all: current site → re-stationing site (information only: no minimum, no maximum,
 * no verdict), re-stationing site → primary deployment area, primary → alternative deployment area. A deployment leg is
 * measured centre to centre against the range of the server's terrain analysis of the area it reaches.
 */
export type ConnectorKind = 'move' | 'primary' | 'alternative';
export type Connector = { kind: ConnectorKind; from: LatLng; to: LatLng; fromLabel: string; toLabel: string; distanceM: number };

export const CONNECTOR_TITLE: Record<ConnectorKind, string> = {
  move: `${LABELS.CURRENT} ← ${LABELS.SITE}`,
  primary: `${LABELS.SITE} ← ${LABELS.PRIMARY}`,
  alternative: `${LABELS.PRIMARY} ← ${LABELS.ALTERNATIVE}`,
};

export function connectors(g: { current: SiteGeometry | null; site: SiteGeometry | null; primary: SiteGeometry | null; alternative: SiteGeometry | null }): Connector[] {
  const out: Connector[] = [];
  const add = (kind: ConnectorKind, a: SiteGeometry | null, b: SiteGeometry | null, fromLabel: string, toLabel: string) => {
    if (!a || !b) return;
    const [from, to] = [centre(a), centre(b)];
    const d = distanceM(from, to);
    if (d >= 1) out.push({ kind, from, to, fromLabel, toLabel, distanceM: d });
  };
  add('move', g.current, g.site, LABELS.CURRENT, LABELS.SITE);
  add('primary', g.site, g.primary, LABELS.SITE, LABELS.PRIMARY);
  add('alternative', g.primary, g.alternative, LABELS.PRIMARY, LABELS.ALTERNATIVE);
  return out;
}

/**
 * A deployment leg as the server would judge it now, from its terrain analysis of the area and the centre-to-centre
 * distance on the page — the same rule as DeploymentRules.leg (range raised by the allowance at the maximum only;
 * exception band when the policy allows one; an unresolved terrain tie blocks). A PREVIEW: the server's check on save
 * decides, and where both exist for the same geometry the server's wins.
 */
export function previewLeg(kind: 'primary' | 'alternative', distance: number | null, a: TerrainAssessment | null, policy: Pick<StationingPolicyValues, 'exception'> | null): RestationingLeg | undefined {
  if (!a) return undefined;
  const r = a[kind];
  const exceptionMaxM = policy?.exception?.allowed ? r.effectiveMaxM + policy.exception.maxExtraM : null;
  const status: RestationingLeg['status'] =
    distance == null ? 'NOT_PLACED'
      : r.terrainApplies && a.tie && !a.resolved ? 'TERRAIN_TIE_UNRESOLVED'
        : distance >= r.effectiveMinM && distance <= r.effectiveMaxM ? 'OK'
          : exceptionMaxM != null && distance > r.effectiveMaxM && distance <= exceptionMaxM ? 'NEEDS_EXCEPTION'
            : 'OUT_OF_RANGE';
  return {
    leg: kind,
    label: kind === 'primary' ? LABELS.PRIMARY : LABELS.ALTERNATIVE,
    status,
    distanceM: distance,
    baseMinM: r.baseMinM,
    baseMaxM: r.baseMaxM,
    effectiveMinM: r.effectiveMinM,
    effectiveMaxM: r.effectiveMaxM,
    exceptionMaxM,
    method: a.method,
    conflicts: [],
    terrain: {
      controllingClass: a.controllingClass,
      controllingLabel: a.controllingLabel,
      shares: a.shares,
      tie: a.tie,
      tied: a.tied,
      resolved: a.resolved,
      priority: [],
      allowanceM: r.terrainApplies ? a.allowanceM : 0,
      dataset: a.datasetCode + ' ' + a.datasetVersion,
      surfaceModel: a.surfaceModel,
    },
  };
}

const km = (m: number) => (m / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 2 });

export const VERDICT: Record<RestationingLeg['status'], { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' }> = {
  OK: { text: 'ضمن النطاق', tone: 'ok' },
  NEEDS_EXCEPTION: { text: 'يحتاج استثناء', tone: 'warn' },
  OUT_OF_RANGE: { text: 'خارج النطاق', tone: 'bad' },
  TERRAIN_TIE_UNRESOLVED: { text: 'تعادل في طبيعة الأرض', tone: 'bad' },
  NOT_PLACED: { text: 'لم تُحدَّد بعد', tone: 'none' },
};

/** The rule of a leg in words: «الأساسي: 5–8 كم», «طبيعة الأرض (جبلي): +2 كم», «الحد الفعال: حتى 10 كم». */
export function ruleLines(l: RestationingLeg): { base: string; terrain: string; effective: string; exception: string | null } {
  const add = l.terrain?.allowanceM ?? Math.max(0, l.effectiveMaxM - l.baseMaxM);
  return {
    base: `${km(l.baseMinM)}–${km(l.baseMaxM)} كم`,
    terrain: (add >= 0 ? '+' : '−') + km(Math.abs(add)) + ' كم' + (l.terrain?.controllingLabel ? ` (${l.terrain.controllingLabel})` : ''),
    effective: `${km(l.effectiveMinM)}–${km(l.effectiveMaxM)} كم`,
    exception: l.exceptionMaxM != null ? `حتى ${km(l.exceptionMaxM)} كم باستثناء معتمد` : null,
  };
}

/** The leg the server checked, when it was checked for exactly the geometry now on the page; otherwise null. */
export function serverLegFor(kind: 'primary' | 'alternative', checked: { legs?: RestationingLeg[] } | null, savedKey: string | null, nowKey: string): RestationingLeg | null {
  if (!checked?.legs || savedKey !== nowKey) return null;
  return checked.legs.find((l) => l.leg === kind && l.status !== 'NOT_PLACED') ?? null;
}

/** Where a preview and the server's check disagree for the same geometry (a defect to show, never hidden). */
export function discrepancy(preview: RestationingLeg | undefined, server: RestationingLeg | null): string | null {
  if (!preview || !server) return null;
  const diff = (a: number, b: number) => Math.abs(a - b) > 0.5;
  if (diff(preview.effectiveMinM, server.effectiveMinM) || diff(preview.effectiveMaxM, server.effectiveMaxM)) return 'النطاق الفعّال يختلف عن فحص الخادم';
  if ((preview.terrain?.controllingClass ?? null) !== (server.terrain?.controllingClass ?? preview.terrain?.controllingClass ?? null)) return 'فئة الأرض تختلف عن فحص الخادم';
  return null;
}
