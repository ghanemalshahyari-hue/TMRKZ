import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type PostureUnit, type PosturePending } from '../api/client';
import type { GeoPolygon, RestationingRequest, SiteGeometry } from '../api/types';
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { PITCH_3D, addOverlayLayer, installedTerrain3d, type MapView } from '../components/map/maplibre';
import { MAP_COLOURS } from '../components/workspace/RequestMap';
import type { BasemapMode, Terrain3dSource } from '../components/map/maplibre/offlineStyle';
import { flatSource } from '../components/tree/tree';
import { UnitTree } from '../components/tree/UnitTree';
import { Icon } from '../components/ui';
import { MapModeSwitcher, ViewSwitcher } from '../components/workspace/MapFrame';
import { EmptyCentre } from '../components/workspace/EmptyCentre';
import { RequestMap } from '../components/workspace/RequestMap';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { PURPOSE_TITLE, UNIT_STATE, isPurpose } from '../lib/requestPurpose';
import {
  COMPLETENESS_LABEL,
  COMPLETENESS_TONE,
  MISSING_LABEL,
  TIMING_LABEL,
  TIMING_TONE,
  completenessOf,
  matchesFilter,
  missingOf,
  postureCounts,
  timingOf,
  type PostureFilter,
} from '../lib/operationalPostureStatus';
import {
  hubAttention,
  hubsForFilter,
  operationalSiteHubs,
  type SiteHub,
} from '../lib/operationalSiteHubs';

type GeomLike = { type?: string; coordinates?: unknown } | null | undefined;

/** The selected unit's posture as the map's request shape — used for the stronger emphasis layer on top of the overall posture. */
function asMapRequest(u: PostureUnit): RestationingRequest {
  return {
    id: 'posture', number: '', state: 'ACTIVATED_PERMANENT', requestingUnit: { id: u.id, name: u.name }, requester: { id: '', name: '' }, units: [],
    currentSites: u.site ? [{ unit: u.name, site: { id: u.site.id, name: u.site.name }, geometry: u.site.geometry as RestationingRequest['currentSites'][number]['geometry'] }] : [],
    purpose: 'DEPLOYMENT_AREAS',
    content: { kind: u.kind === 'TEMPORARY' ? 'TEMPORARY' : 'PERMANENT', scope: [], site: u.site?.geometry && u.site.geometry.type !== 'Point' ? { geometry: u.site.geometry, copiedFrom: u.site.id, shape: 'COPY' } : null, primary: (u.primary as GeoPolygon | null) ?? null, alternative: (u.alternative as GeoPolygon | null) ?? null, reason: '', exceptions: {}, occupants: {} },
    policyVersion: null, routeNo: 0, route: [], previousRoutes: [], revisions: [], returned: null, paused: null, finalApprover: null,
    can: { edit: false, submit: false, decide: false, activate: false },
  } as unknown as RestationingRequest;
}

/**
 * Operational-posture meaning-layer brief (owner, 21 Nov 2026 — PROGRESSIVE DISCLOSURE revision).
 *   - Overview (nothing selected): map draws ONLY current authorised sites + status-coloured unit markers + small
 *     «قيد الاعتماد» rings for sites with a pending proposal. No PRIMARY, no SUB, no proposed geometry, no connectors.
 *   - Select a unit:     show THAT unit's site boundary + PRIMARY + SUB. Other markers subdued; other polygons stay
 *                        hidden. Legend and the «مناطق الانتشار» layer toggles become active for this unit only.
 *   - Select a request:  show THAT request's current posture + proposed geometry + connector arrows. Nothing else.
 *   - Filters answer «WHICH units?» — they narrow the list and the status markers; they NEVER reveal polygons.
 *   - Status model, area ownership and the backend `pending[]` payload are unchanged (owner, §34): only the rendering
 *     moves from «all at once» to progressive disclosure.
 */
/**
 * Six operational filters (owner, 21 Nov 2026 «REDESIGN» §13). The map stays aggregated by site — the filter narrows
 * which hubs appear and what their centre label counts (brief §14), not which polygons draw.
 */
const FILTER_TABS: readonly { key: PostureFilter; label: string }[] = [
  { key: 'ALL', label: 'الكل' },
  { key: 'INCOMPLETE', label: 'مناطق غير مكتملة' },
  { key: 'NO_STATIONING', label: 'بلا تمركز' },
  { key: 'TEMPORARY', label: 'مؤقت' },
  { key: 'EXPIRING', label: 'ينتهي قريبًا' },
  { key: 'REQUESTS', label: 'طلبات' },
];

type LayerState = {
  sites: boolean; units: boolean; primary: boolean; sub: boolean;
  boundaries: boolean; terrain: boolean; satellite: boolean;
};

/**
 * One selection at a time (brief §22). Each variant decides what the map draws:
 *   none         → clean overview: sites + status markers + pending indicators only.
 *   unit         → the unit's current site + PRIMARY + SUB. Other polygons hidden.
 *   area         → as unit, plus the «area card» for the clicked PRIMARY/SUB.
 *   site         → reference-site card (no deployment areas).
 *   request      → current posture for that request's unit + proposed geometry + connector arrows. Everything else
 *                  on the map stays as overview (sites + status markers + indicators).
 *   pending-area → as request, plus the «pending card» for the clicked proposed element.
 */
type Selection =
  | null
  | { kind: 'unit'; unitId: string }
  | { kind: 'site'; siteId: string }
  | { kind: 'area'; unitId: string; role: 'PRIMARY' | 'SUB' }
  | { kind: 'request'; requestId: string; unitId: string }
  | { kind: 'pending-area'; requestId: string; unitId: string; element: 'SITE' | 'PRIMARY' | 'SUB' };

type AreaChoice = { unitIds: string[]; role: 'PRIMARY' | 'SUB' };

const PENDING_STAGE_AR: Record<string, string> = {
  UNDER_REVIEW: 'قيد الاعتماد',
  RETURNED_FOR_CHANGES: 'مُعاد للتعديل',
  PAUSED_HIERARCHY_CHANGED: 'متوقف بسبب تغير الهيكل',
  APPROVED_NOT_ACTIVATED: 'معتمد — بانتظار التفعيل',
  CANCELLATION_PENDING: 'إلغاء قيد الاعتماد',
  START_HELD_PENDING_CANCELLATION: 'بدء موقوف — إلغاء قيد الاعتماد',
};

/** Rough centroid of a GeoJSON polygon/multipolygon/point — enough to anchor a connector endpoint. */
function centreOf(g: GeomLike): [number, number] | null {
  if (!g || !g.type) return null;
  if (g.type === 'Point') return g.coordinates as [number, number];
  const ring = g.type === 'Polygon' ? (g.coordinates as [number, number][][])[0] : ((g.coordinates as [number, number][][][])[0] ?? [])[0];
  if (!ring?.length) return null;
  let lng = 0, lat = 0;
  for (const [x, y] of ring) { lng += x; lat += y; }
  return [lng / ring.length, lat / ring.length];
}

/** Initial bearing (degrees from north) for the line between two lng/lat points. */
function bearing(from: [number, number], to: [number, number]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [x1, y1] = from; const [x2, y2] = to;
  const y = Math.sin(toRad(x2 - x1)) * Math.cos(toRad(y2));
  const x = Math.cos(toRad(y1)) * Math.sin(toRad(y2)) - Math.sin(toRad(y1)) * Math.cos(toRad(y2)) * Math.cos(toRad(x2 - x1));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Rough polygon area in km² (shoelace on lng/lat with an equirectangular flat-earth correction at the centroid). */
function areaKm2Of(g: GeomLike): number | null {
  if (!g || !g.type) return null;
  const rings = g.type === 'Polygon' ? [((g.coordinates as number[][][]) ?? [])[0]]
    : g.type === 'MultiPolygon' ? ((g.coordinates as number[][][][]) ?? []).map((p) => p[0])
    : null;
  if (!rings) return null;
  let total = 0;
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    const centreLat = ring.reduce((s, [, la]) => s + la, 0) / ring.length;
    const R = 6_378_137;
    const toM = (lng: number, lat: number): [number, number] => [
      ((lng * Math.PI) / 180) * R * Math.cos((centreLat * Math.PI) / 180),
      ((lat * Math.PI) / 180) * R,
    ];
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = toM(ring[i][0], ring[i][1]);
      const [x2, y2] = toM(ring[i + 1][0], ring[i + 1][1]);
      s += x1 * y2 - x2 * y1;
    }
    total += Math.abs(s) / 2;
  }
  return total / 1_000_000;
}

/**
 * «الموقف العملياتي» — the clean overview is the default. Polygons appear only when a specific unit or request is
 * selected; filters narrow the population but never reveal the detail layers.
 */
export function PosturePage() {
  const app = useApp();
  const [units, setUnits] = useState<PostureUnit[] | null>(null);
  const [pendingAll, setPendingAll] = useState<PosturePending[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<PostureFilter>('ALL');
  const [openCamp, setOpenCamp] = useState<Set<string>>(new Set());
  const [openOrg, setOpenOrg] = useState<Set<string>>(new Set());
  const toggleCamp = (id: string) => setOpenCamp((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleOrg = (id: string) => setOpenOrg((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mode, setMode] = useState<BasemapMode>('terrain');
  const [view, setView] = useState<MapView>('2d');
  const [terrain3d, setTerrain3d] = useState<Terrain3dSource | null | undefined>(undefined);
  const [fit, setFit] = useState(0);
  const [map, setMap] = useState<MlMap | null>(null);
  const [layers, setLayers] = useState<LayerState>({ sites: true, units: true, primary: true, sub: true, boundaries: true, terrain: true, satellite: false });
  const [areaOpacity, setAreaOpacity] = useState(60);
  const [chooser, setChooser] = useState<{ siteId: string; siteName: string; unitIds: string[] } | null>(null);
  const [areaChooser, setAreaChooser] = useState<AreaChoice | null>(null);
  // Full fetched request for the selected proposal — carries the stage label and revision history for the detail
  // card. Map layers never read this; they read the scoped `pendingAll` returned by the posture endpoint.
  const [pendingReq, setPendingReq] = useState<RestationingRequest | null>(null);
  const [legendOpen, setLegendOpen] = useState(() => (typeof window !== 'undefined' ? window.innerWidth > 1180 : true));

  // Which single unit's current geometry is visible? Both `unit` and `area` selections reveal a unit's polygons;
  // a `request` selection reveals the request's unit for comparison with the proposed geometry.
  const revealedUnitId =
    selection?.kind === 'unit' || selection?.kind === 'area' ? selection.unitId
    : selection?.kind === 'request' || selection?.kind === 'pending-area' ? selection.unitId
    : null;
  const selectedRequestId =
    selection?.kind === 'request' || selection?.kind === 'pending-area' ? selection.requestId : null;
  const siteInfoId = selection?.kind === 'site' ? selection.siteId : null;
  const pendingAreaSel = selection?.kind === 'pending-area' ? selection : null;
  const areaSel = selection?.kind === 'area' ? selection : null;

  useEffect(() => {
    map?.easeTo({ pitch: view === '3d' ? PITCH_3D : 0, duration: 500 });
  }, [map, view]);
  useEffect(() => {
    installedTerrain3d().then(setTerrain3d);
    api.operationalPosture().then((p) => { setUnits(p.units); setPendingAll(p.pending ?? []); })
      .catch((e: Error) => (setUnits([]), setPendingAll([]), app.toast(e.message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);

  const tree = useMemo(() => flatSource(units ?? []), [units]);
  const unit = units?.find((u) => u.id === revealedUnitId) ?? null;

  // When a request row is picked (or a unit with a pending request), fetch the full request so the connector arrows
  // can chain current → proposed site → primary → sub. The scoped `pendingAll` already carries the overview fields;
  // this call fills in the stage label and any revision history for the detail card.
  useEffect(() => {
    if (!selectedRequestId) { setPendingReq(null); return; }
    let live = true;
    api.restationingRequest(selectedRequestId).then((r) => { if (live) setPendingReq(r); }).catch(() => { if (live) setPendingReq(null); });
    return () => { live = false; };
  }, [selectedRequestId]);

  /** Per-request pending data as the SELECTED proposal — overview mode leaves this empty so no geometry draws. */
  const selectedPending = useMemo<PosturePending | null>(() => {
    if (!selectedRequestId) return null;
    return pendingAll.find((p) => p.requestId === selectedRequestId) ?? null;
  }, [selectedRequestId, pendingAll]);

  /**
   * Current posture polygons — drawn ONLY for the revealed unit (brief §4/§5). Overview mode returns an empty
   * FeatureCollection, so no PRIMARY/SUB appears until the operator picks a unit or a request.
   */
  const postureFC = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];
    if (unit) {
      const primary = unit.primary as GeomLike;
      if (primary && (primary.type === 'Polygon' || primary.type === 'MultiPolygon')) {
        features.push({ type: 'Feature', geometry: primary as GeoJSON.Geometry, properties: { role: 'PRIMARY', unitId: unit.id, unitCode: unit.code, unitName: unit.name } });
      }
      const alt = unit.alternative as GeomLike;
      if (alt && (alt.type === 'Polygon' || alt.type === 'MultiPolygon')) {
        features.push({ type: 'Feature', geometry: alt as GeoJSON.Geometry, properties: { role: 'SUB', unitId: unit.id, unitCode: unit.code, unitName: unit.name } });
      }
    }
    return { type: 'FeatureCollection', features };
  }, [unit]);

  /**
   * Site-hub projection (owner, 21 Nov 2026 «REDESIGN»): one feature per PHYSICAL SITE — the strategic overview
   * draws site hubs, not individual unit markers. `filteredCount` is the number of units at the site matching the
   * active filter so the hub label stays legible (brief §14). Attention (incomplete / pending / temporary /
   * expiring) is carried as separate properties so a single bad unit does not repaint a healthy site (brief §30).
   */
  const siteHubs = useMemo<SiteHub[]>(() => operationalSiteHubs(units ?? [], pendingAll, filter), [units, pendingAll, filter]);
  const visibleHubs = useMemo<SiteHub[]>(() => hubsForFilter(siteHubs, filter), [siteHubs, filter]);
  const siteHubsFC = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];
    for (const h of visibleHubs) {
      if (!h.centroid) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: h.centroid },
        properties: {
          siteId: h.siteId,
          siteName: h.siteName,
          unitsTotal: h.unitsTotal,
          filteredCount: h.filteredCount,
          completeCount: h.completeCount,
          incompleteCount: h.incompleteCount,
          temporaryCount: h.temporaryCount,
          expiringCount: h.expiringCount,
          pendingCount: h.pendingCount,
          attention: hubAttention(h),
          selected: (siteInfoId === h.siteId || unit?.site?.id === h.siteId) ? 1 : 0,
          label: String((filter === 'ALL' || filter === 'REQUESTS') ? h.unitsTotal : h.filteredCount),
        },
      });
    }
    return { type: 'FeatureCollection', features };
  }, [visibleHubs, filter, siteInfoId, unit]);

  /**
   * The SELECTED request's proposal polygons + connector arrows (user mid-turn, 21 Nov 2026): each hop endpoint must
   * be labelled and coloured distinctly so the operator can tell «الحالي → موقع مقترح → رئيسية → فرعية» apart; each
   * arrow line shows the great-circle distance in km at its midpoint.
   *
   * Hop step → kind → colour:
   *   step 0 = current site                          (slate blue — the anchor; not a proposal)
   *   step 1 = proposed site (RS only)               (orange)
   *   step 2 = proposed PRIMARY                      (amber)
   *   step 3 = proposed SUB                          (purple)
   */
  const selectedPendingFC = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];
    if (selectedPending) {
      const unitId = selectedPending.unitId;
      const number = selectedPending.requestNumber;
      if (selectedPending.proposedSite) features.push({ type: 'Feature', geometry: selectedPending.proposedSite as unknown as GeoJSON.Geometry, properties: { role: 'SITE', requestId: selectedPending.requestId, unitId, requestNumber: number } });
      if (selectedPending.proposedPrimary) features.push({ type: 'Feature', geometry: selectedPending.proposedPrimary as unknown as GeoJSON.Geometry, properties: { role: 'PRIMARY', requestId: selectedPending.requestId, unitId, requestNumber: number } });
      if (selectedPending.proposedSub) features.push({ type: 'Feature', geometry: selectedPending.proposedSub as unknown as GeoJSON.Geometry, properties: { role: 'SUB', requestId: selectedPending.requestId, unitId, requestNumber: number } });

      const anchorUnit = units?.find((u) => u.id === unitId);
      const currentCentre = centreOf((anchorUnit?.site?.geometry) as GeomLike);
      const proposedSiteCentre = selectedPending.proposedSite ? centreOf(selectedPending.proposedSite as GeomLike) : null;
      const primaryCentre = selectedPending.proposedPrimary ? centreOf(selectedPending.proposedPrimary as GeomLike) : null;
      const subCentre = selectedPending.proposedSub ? centreOf(selectedPending.proposedSub as GeomLike) : null;
      const chain: Array<{ point: [number, number]; kind: 'CURRENT' | 'PROPOSED_SITE' | 'PROPOSED_PRIMARY' | 'PROPOSED_SUB'; label: string }> = [];
      if (currentCentre) chain.push({ point: currentCentre, kind: 'CURRENT', label: anchorUnit?.site?.name ? 'الحالي · ' + anchorUnit.site.name : 'الموقع الحالي' });
      if (selectedPending.purpose === 'RESTATIONING' && proposedSiteCentre && selectedPending.proposedSite) chain.push({ point: proposedSiteCentre, kind: 'PROPOSED_SITE', label: 'موقع مقترح' });
      if (primaryCentre) chain.push({ point: primaryCentre, kind: 'PROPOSED_PRIMARY', label: 'منطقة انتشار رئيسية مقترحة' });
      if (subCentre) chain.push({ point: subCentre, kind: 'PROPOSED_SUB', label: 'منطقة انتشار فرعية مقترحة' });
      // One Point per endpoint (labelled with its name, coloured by kind).
      for (let i = 0; i < chain.length; i++) {
        const { point, kind, label } = chain[i];
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: { role: 'ENDPOINT', kind, step: i, label, unitId, requestNumber: number } });
      }
      for (let i = 1; i < chain.length; i++) {
        const from = chain[i - 1].point; const to = chain[i].point;
        // Great-circle (haversine) distance in km, rounded to one decimal for operator legibility.
        const toRad = (d: number) => (d * Math.PI) / 180;
        const R = 6371.0;
        const dLat = toRad(to[1] - from[1]);
        const dLng = toRad(to[0] - from[0]);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(from[1])) * Math.cos(toRad(to[1])) * Math.sin(dLng / 2) ** 2;
        const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
        const kmLabel = (km >= 10 ? km.toFixed(0) : km.toFixed(1)) + ' كم';
        const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [from, to] }, properties: { role: 'HOP', step: i, kind: chain[i].kind, unitId, requestNumber: number, distanceLabel: kmLabel } });
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: mid }, properties: { role: 'HOP_LABEL', step: i, kind: chain[i].kind, distanceLabel: kmLabel, requestNumber: number } });
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: to }, properties: { role: 'HOP_HEAD', step: i, kind: chain[i].kind, unitId, rotate: bearing(from, to), requestNumber: number } });
      }
    }
    return { type: 'FeatureCollection', features };
  }, [selectedPending, units]);

  const req = useMemo(() => (unit ? asMapRequest(unit) : null), [unit]);
  // Any right-rail or map click that changes what is selected must zoom the camera to it (user, mid-turn 21 Nov 2026).
  useEffect(() => setFit((k) => k + 1), [revealedUnitId]);
  useEffect(() => setFit((k) => k + 1), [siteInfoId]);
  useEffect(() => setFit((k) => k + 1), [selectedRequestId]);
  useEffect(() => setFit((k) => k + 1), [filter]);
  useEffect(() => { if (units && units.length > 0) setFit((k) => k + 1); }, [units]);

  /**
   * Geometry-driven camera fit (owner, 21 Nov 2026: «A fixed zoom cannot represent a site/deployment area that may be
   * LARGE»). We compute the real bounds of the selection's geometry (site + PRIMARY + SUB for a unit; current geometry
   * set + proposed geometry set for a request) and let MapLibre decide the zoom level, clamped by a sensible ceiling.
   */
  useEffect(() => {
    if (!map) return;
    const canvas = map.getCanvas();
    const w = canvas.clientWidth || 1600;
    const h = canvas.clientHeight || 900;
    // Allow room for the left layers panel, the right rail and the floating detail card.
    const safePadding = { top: 120, bottom: 160, left: Math.round(w * 0.15), right: Math.round(w * 0.24) };
    const outerPadding = 80;

    const pts: [number, number][] = [];
    const pushPoints = (g: GeomLike): void => {
      if (!g || !g.type) return;
      if (g.type === 'Point') { pts.push(g.coordinates as [number, number]); return; }
      if (g.type === 'Polygon') {
        for (const ring of (g.coordinates as number[][][])) for (const p of ring) pts.push([p[0], p[1]]);
        return;
      }
      if (g.type === 'MultiPolygon') {
        for (const poly of (g.coordinates as number[][][][])) for (const ring of poly) for (const p of ring) pts.push([p[0], p[1]]);
      }
    };
    const fitFromPts = (padding: number | { top: number; bottom: number; left: number; right: number }, maxZoom: number) => {
      if (pts.length === 0) return false;
      let minLng = pts[0][0], minLat = pts[0][1], maxLng = minLng, maxLat = minLat;
      for (const [lng, lat] of pts) { if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng; if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat; }
      // One-point fallback (site is a bare marker): pad by a small delta so fitBounds has non-zero area.
      if (minLng === maxLng && minLat === maxLat) { minLng -= 0.001; maxLng += 0.001; minLat -= 0.001; maxLat += 0.001; }
      map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding, duration: 650, maxZoom });
      return true;
    };

    // Selected REQUEST: fit to the UNION of current + proposed geometries (owner §3): the operator must see the
    // spatial relationship, not just the centroids.
    if (selectedRequestId) {
      const anchorUnit = units?.find((u) => u.id === selectedPending?.unitId);
      if (anchorUnit) {
        pushPoints(anchorUnit.site?.geometry as GeomLike);
        pushPoints(anchorUnit.primary as GeomLike);
        pushPoints(anchorUnit.alternative as GeomLike);
      }
      if (selectedPending) {
        pushPoints(selectedPending.proposedSite as GeomLike);
        pushPoints(selectedPending.proposedPrimary as GeomLike);
        pushPoints(selectedPending.proposedSub as GeomLike);
      }
      if (fitFromPts(safePadding, 17)) return;
    }
    // Selected UNIT: fit to the combined extent of site boundary + PRIMARY + SUB (owner §2).
    if (unit) {
      pushPoints(unit.site?.geometry as GeomLike);
      pushPoints(unit.primary as GeomLike);
      pushPoints(unit.alternative as GeomLike);
      if (fitFromPts(safePadding, 17)) return;
    }
    // Selected SITE: fit to the site's own polygon (owner §1). If the site is point-only, fall back to point focus.
    if (siteInfoId) {
      const hub = siteHubs.find((h) => h.siteId === siteInfoId);
      const anyAtSite = units?.find((u) => u.site?.id === siteInfoId);
      if (anyAtSite) pushPoints(anyAtSite.site?.geometry as GeomLike);
      if (pts.length === 0 && hub?.centroid) {
        map.easeTo({ center: hub.centroid, zoom: 15, duration: 650 });
        return;
      }
      if (fitFromPts(safePadding, 16)) return;
    }
    // Overview: fit to every visible site-hub centroid.
    for (const f of siteHubsFC.features) {
      const c = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      if (c) pts.push(c);
    }
    if (pts.length === 0) return;
    let minLng = pts[0][0], minLat = pts[0][1], maxLng = minLng, maxLat = minLat;
    for (const [lng, lat] of pts) { if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng; if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat; }
    const d = 0.05;
    map.fitBounds([[minLng - d, minLat - d], [maxLng + d, maxLat + d]], { padding: outerPadding, duration: 650, maxZoom: 11 });
    // Silence unused-var lint for the header-height closure variable.
    void h;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fit, unit, siteInfoId, selectedRequestId]);

  const siteToUnits = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const u of units ?? []) if (u.site) {
      const bucket = m.get(u.site.id);
      if (bucket) bucket.push(u.id);
      else m.set(u.site.id, [u.id]);
    }
    return m;
  }, [units]);
  const sitesById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of units ?? []) if (u.site) m.set(u.site.id, u.site.name);
    return m;
  }, [units]);

  const unitsById = useMemo(() => {
    const m = new Map<string, PostureUnit>();
    for (const u of units ?? []) m.set(u.id, u);
    return m;
  }, [units]);

  const selectUnit = (id: string) => setSelection({ kind: 'unit', unitId: id });
  const selectSite = (id: string) => setSelection({ kind: 'site', siteId: id });
  const selectArea = (unitId: string, role: 'PRIMARY' | 'SUB') => setSelection({ kind: 'area', unitId, role });
  const selectRequest = (requestId: string, unitId: string) => setSelection({ kind: 'request', requestId, unitId });
  const selectPendingArea = (requestId: string, unitId: string, element: 'SITE' | 'PRIMARY' | 'SUB') => setSelection({ kind: 'pending-area', requestId, unitId, element });
  const clearSelection = () => setSelection(null);

  /**
   * Click resolver (brief §8–§10): one authorised stationed unit → select that unit (reveals its areas); several →
   * unit chooser; reference site with no posture unit → site info card. No deployment area is drawn until a unit is
   * actually selected.
   */
  const clickSite = (siteId: string | null): boolean => {
    if (!siteId) return true;
    const unitIds = siteToUnits.get(siteId) ?? [];
    if (unitIds.length === 1) { selectUnit(unitIds[0]); return true; }
    if (unitIds.length > 1) { setChooser({ siteId, siteName: sitesById.get(siteId) ?? siteId, unitIds }); return true; }
    selectSite(siteId);
    return true;
  };

  const clickSiteRef = useRef(clickSite);
  clickSiteRef.current = clickSite;

  // --- Map overlay sources + layers --------------------------------------------------------------------------------
  // Three sources, each updated separately:
  //   posture-sel       → only the revealed unit's current PRIMARY/SUB (empty in overview)
  //   pending-overview  → amber indicator rings at affected sites (always on when there are pending proposals)
  //   pending-sel       → only the selected request's proposal polygons + connector arrows (empty otherwise)
  //   status-markers    → status-coloured rings per unit, placed on the site centroid (always on)
  useEffect(() => {
    if (!map) return;
    if (map.getSource('posture-sel')) return;
    map.addSource('posture-sel', { type: 'geojson', data: postureFC });
    addOverlayLayer(map, {
      id: 'posture-primary-fill', type: 'fill', source: 'posture-sel',
      filter: ['==', ['get', 'role'], 'PRIMARY'],
      paint: { 'fill-color': MAP_COLOURS.PRIMARY, 'fill-opacity': 0.25 },
    });
    addOverlayLayer(map, {
      id: 'posture-primary-line', type: 'line', source: 'posture-sel',
      filter: ['==', ['get', 'role'], 'PRIMARY'],
      paint: { 'line-color': MAP_COLOURS.PRIMARY, 'line-width': 2.0 },
    });
    addOverlayLayer(map, {
      id: 'posture-sub-fill', type: 'fill', source: 'posture-sel',
      filter: ['==', ['get', 'role'], 'SUB'],
      paint: { 'fill-color': MAP_COLOURS.ALTERNATIVE, 'fill-opacity': 0.22 },
    });
    addOverlayLayer(map, {
      id: 'posture-sub-line', type: 'line', source: 'posture-sel',
      filter: ['==', ['get', 'role'], 'SUB'],
      paint: { 'line-color': MAP_COLOURS.ALTERNATIVE, 'line-width': 1.8, 'line-dasharray': [3, 2] },
    });
    // Area polygon clicks: the revealed unit's current PRIMARY/SUB open the area context card (brief §23); several
    // polygons stacked at the click open the overlap chooser (brief §21) — never a silent top pick.
    const onAreaClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      const feats = e.features ?? [];
      const picks = feats
        .map((f) => ({ unitId: f.properties?.unitId as string | undefined, role: (f.properties?.role === 'SUB' ? 'SUB' : 'PRIMARY') as 'PRIMARY' | 'SUB' }))
        .filter((p): p is { unitId: string; role: 'PRIMARY' | 'SUB' } => !!p.unitId);
      const unique = new Map<string, 'PRIMARY' | 'SUB'>();
      for (const p of picks) unique.set(p.unitId + ':' + p.role, p.role);
      if (unique.size === 1) {
        const [key] = [...unique.keys()];
        const [uid, role] = key.split(':') as [string, 'PRIMARY' | 'SUB'];
        selectArea(uid, role);
      } else if (unique.size > 1) {
        setAreaChooser({ unitIds: [...unique.keys()].map((k) => k.split(':')[0]), role: 'PRIMARY' });
      }
    };
    const onEnter = () => (map.getCanvas().style.cursor = 'pointer');
    const onLeave = () => (map.getCanvas().style.cursor = '');
    for (const id of ['posture-primary-fill', 'posture-sub-fill']) {
      map.on('click', id, onAreaClick);
      map.on('mouseenter', id, onEnter);
      map.on('mouseleave', id, onLeave);
    }

    // Site hubs (owner, 21 Nov 2026 «SITE-HUB REDESIGN»): ONE object per physical site AND MapLibre clustering on the
    // source so a dense region shows one «N مواقع · M وحدة» bubble at far zoom; the cluster breaks into per-site
    // hubs as the operator zooms in (brief §4/§5/§8). Attention counts travel in the feature properties so clusters
    // can aggregate them with `cluster_properties` sums.
    map.addSource('site-hubs', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      clusterRadius: 60,
      clusterMaxZoom: 12,
      clusterProperties: {
        unitsTotal: ['+', ['get', 'unitsTotal']],
        incompleteCount: ['+', ['get', 'incompleteCount']],
        pendingCount: ['+', ['get', 'pendingCount']],
        temporaryCount: ['+', ['get', 'temporaryCount']],
        expiringCount: ['+', ['get', 'expiringCount']],
      },
    });
    // Cluster bubble — one object per cluster; a click zooms until the cluster expands (brief §7).
    addOverlayLayer(map, {
      id: 'site-cluster', type: 'circle', source: 'site-hubs',
      filter: ['has', 'point_count'],
      paint: {
        'circle-radius': ['step', ['get', 'point_count'], 22, 5, 26, 20, 32],
        'circle-color': '#2b3b4e',
        'circle-opacity': 0.9,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
      },
    }, 'top');
    addOverlayLayer(map, {
      id: 'site-cluster-count', type: 'symbol', source: 'site-hubs',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['concat', ['to-string', ['get', 'point_count']], ' مواقع\n', ['to-string', ['get', 'unitsTotal']], ' وحدة'],
        'text-font': ['noto-sans-arabic-bold', 'noto-sans-bold'],
        'text-size': 11.5,
        'text-line-height': 1.1,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff' },
    }, 'top');
    // Small attention badge on the cluster — one amber ring when the cluster aggregates any pending or incomplete.
    addOverlayLayer(map, {
      id: 'site-cluster-attention', type: 'circle', source: 'site-hubs',
      filter: ['all', ['has', 'point_count'], ['>', ['get', 'incompleteCount'], 0]],
      paint: {
        'circle-radius': ['step', ['get', 'point_count'], 28, 5, 32, 20, 38],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#d9822b',
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': 0.9,
      },
    }, 'top');
    addOverlayLayer(map, {
      id: 'site-cluster-pending', type: 'circle', source: 'site-hubs',
      filter: ['all', ['has', 'point_count'], ['>', ['get', 'pendingCount'], 0]],
      paint: {
        'circle-radius': ['step', ['get', 'point_count'], 34, 5, 38, 20, 44],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#f59e0b',
        'circle-stroke-width': 1.3,
        'circle-stroke-opacity': 0.9,
      },
    }, 'top');
    // Cluster click — zoom into the cluster until it breaks (MapLibre's own cluster-expansion zoom helper).
    const onClusterClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      const f = e.features?.[0];
      if (!f) return;
      const srcAny = map.getSource('site-hubs') as unknown as {
        getClusterExpansionZoom(id: number): Promise<number> | number;
      };
      const clusterId = f.properties?.cluster_id as number | undefined;
      if (clusterId == null) return;
      const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      const zoomOrPromise = srcAny.getClusterExpansionZoom(clusterId);
      const easeTo = (z: number) => map.easeTo({ center: coords, zoom: z + 0.5, duration: 650 });
      if (typeof zoomOrPromise === 'number') easeTo(zoomOrPromise);
      else Promise.resolve(zoomOrPromise).then(easeTo);
    };
    map.on('click', 'site-cluster', onClusterClick);
    map.on('mouseenter', 'site-cluster', onEnter);
    map.on('mouseleave', 'site-cluster', onLeave);
    addOverlayLayer(map, {
      id: 'site-hub-bg', type: 'circle', source: 'site-hubs',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['get', 'unitsTotal'],
          1, 14, 4, 18, 10, 24, 30, 30,
        ],
        // Selected hub: amber-accent fill so the operator sees exactly which site answers the current context card.
        'circle-color': ['case', ['==', ['get', 'selected'], 1], '#c98a1a', '#2b3b4e'],
        'circle-opacity': ['case', ['==', ['get', 'selected'], 1], 1, 0.82],
        'circle-stroke-color': ['case',
          ['==', ['get', 'selected'], 1], '#ffffff',
          ['match', ['get', 'attention'],
            'OK', '#2f7a40',
            'TEMPORARY', '#3b82f6',
            'EXPIRING', '#ea580c',
            'PENDING', '#f59e0b',
            'INCOMPLETE', '#d9822b',
            'MIXED', '#d9822b',
            '#2b3b4e',
          ],
        ],
        'circle-stroke-width': ['case', ['==', ['get', 'selected'], 1], 5, 2.2],
      },
    }, 'top');
    addOverlayLayer(map, {
      id: 'site-hub-pending-ring', type: 'circle', source: 'site-hubs',
      filter: ['all', ['!', ['has', 'point_count']], ['>', ['get', 'pendingCount'], 0]],
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['get', 'unitsTotal'],
          1, 20, 4, 24, 10, 30, 30, 36,
        ],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#f59e0b',
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0.85,
      },
    }, 'top');
    addOverlayLayer(map, {
      id: 'site-hub-count', type: 'symbol', source: 'site-hubs',
      filter: ['!', ['has', 'point_count']],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['noto-sans-arabic-bold', 'noto-sans-bold'],
        'text-size': ['interpolate', ['linear'], ['get', 'unitsTotal'], 1, 12, 10, 14, 30, 16],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff' },
    }, 'top');
    addOverlayLayer(map, {
      id: 'site-hub-pending-badge', type: 'symbol', source: 'site-hubs',
      filter: ['all', ['!', ['has', 'point_count']], ['>', ['get', 'pendingCount'], 0]],
      layout: {
        'text-field': ['concat', ['to-string', ['get', 'pendingCount']], ' ⏳'],
        'text-font': ['noto-sans-arabic-bold', 'noto-sans-bold'],
        'text-size': 11,
        'text-offset': [0, -2.2],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#f59e0b',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    }, 'top');
    addOverlayLayer(map, {
      id: 'site-hub-incomplete-badge', type: 'symbol', source: 'site-hubs',
      filter: ['all', ['!', ['has', 'point_count']], ['>', ['get', 'incompleteCount'], 0]],
      layout: {
        'text-field': ['concat', '!', ['to-string', ['get', 'incompleteCount']]],
        'text-font': ['noto-sans-arabic-bold', 'noto-sans-bold'],
        'text-size': 11,
        'text-offset': [1.8, 1.6],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#d9822b',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    }, 'top');
    const onHubClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      const sid = e.features?.[0]?.properties?.siteId as string | undefined;
      if (sid) selectSite(sid);
    };
    map.on('click', 'site-hub-bg', onHubClick);
    map.on('mouseenter', 'site-hub-bg', onEnter);
    map.on('mouseleave', 'site-hub-bg', onLeave);

    // Selected-request proposal layers — amber/dashed; a click on one of them opens the pending-area context card
    // (brief §24) while keeping the request selected.
    map.addSource('pending-sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(map, {
      id: 'pending-sel-site-fill', type: 'fill', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'SITE'],
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.12 },
    });
    addOverlayLayer(map, {
      id: 'pending-sel-site-line', type: 'line', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'SITE'],
      paint: { 'line-color': '#f59e0b', 'line-width': 2.0, 'line-dasharray': [2, 2] },
    });
    addOverlayLayer(map, {
      id: 'pending-sel-primary-fill', type: 'fill', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'PRIMARY'],
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.18 },
    });
    addOverlayLayer(map, {
      id: 'pending-sel-primary-line', type: 'line', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'PRIMARY'],
      paint: { 'line-color': '#f59e0b', 'line-width': 2.4, 'line-dasharray': [3, 2] },
    });
    addOverlayLayer(map, {
      id: 'pending-sel-sub-fill', type: 'fill', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'SUB'],
      paint: { 'fill-color': '#d97706', 'fill-opacity': 0.16 },
    });
    addOverlayLayer(map, {
      id: 'pending-sel-sub-line', type: 'line', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'SUB'],
      paint: { 'line-color': '#d97706', 'line-width': 2.0, 'line-dasharray': [1.5, 2] },
    });
    // Hop line coloured by its destination kind so the operator can tell each hop apart (user mid-turn, 21 Nov 2026).
    addOverlayLayer(map, {
      id: 'pending-sel-hop', type: 'line', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'HOP'],
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': ['match', ['get', 'kind'],
          'PROPOSED_SITE', '#ea580c',
          'PROPOSED_PRIMARY', '#d9822b',
          'PROPOSED_SUB', '#7b4fc0',
          '#f59e0b',
        ],
        'line-width': 3.0,
        'line-dasharray': [2.5, 2],
      },
    });
    // The arrowhead colour follows the hop line, so «where did this arrow point?» is unambiguous.
    addOverlayLayer(map, {
      id: 'pending-sel-hop-head', type: 'symbol', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'HOP_HEAD'],
      layout: {
        'icon-image': ['match', ['get', 'kind'],
          'PROPOSED_SITE', 'tz-arrow',
          'PROPOSED_SUB', 'tz-arrow-alternative',
          'tz-arrow-primary',
        ],
        'icon-rotate': ['get', 'rotate'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': 2.4,
      },
    }, 'top');
    // Kilometre label at the midpoint of each hop.
    addOverlayLayer(map, {
      id: 'pending-sel-hop-dist', type: 'symbol', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'HOP_LABEL'],
      layout: {
        'text-field': ['get', 'distanceLabel'],
        'text-font': ['noto-sans-arabic-bold', 'noto-sans-bold'],
        'text-size': 12,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': ['match', ['get', 'kind'],
          'PROPOSED_SITE', '#ea580c',
          'PROPOSED_PRIMARY', '#8a4b10',
          'PROPOSED_SUB', '#5a3a93',
          '#8a4b10',
        ],
        'text-halo-color': '#ffffff',
        'text-halo-width': 2.4,
      },
    }, 'top');
    // Endpoint marker — a small dot the kind's colour paints, so the operator can tell «current / proposed site /
    // primary / sub» apart at a glance.
    addOverlayLayer(map, {
      id: 'pending-sel-endpoint', type: 'circle', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'ENDPOINT'],
      paint: {
        'circle-radius': 7,
        'circle-color': ['match', ['get', 'kind'],
          'CURRENT', '#2b3b4e',
          'PROPOSED_SITE', '#ea580c',
          'PROPOSED_PRIMARY', '#d9822b',
          'PROPOSED_SUB', '#7b4fc0',
          '#f59e0b',
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.4,
      },
    }, 'top');
    // Endpoint LABEL — «الحالي · <site>», «موقع مقترح», «منطقة انتشار رئيسية مقترحة», «منطقة انتشار فرعية مقترحة».
    addOverlayLayer(map, {
      id: 'pending-sel-endpoint-label', type: 'symbol', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'ENDPOINT'],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['noto-sans-arabic-bold', 'noto-sans-bold'],
        'text-size': 11.5,
        'text-anchor': 'top',
        'text-offset': [0, 1.0],
        'text-allow-overlap': false,
        'text-optional': true,
        'text-max-width': 14,
      },
      paint: {
        'text-color': ['match', ['get', 'kind'],
          'CURRENT', '#1f2937',
          'PROPOSED_SITE', '#c2410c',
          'PROPOSED_PRIMARY', '#8a4b10',
          'PROPOSED_SUB', '#5a3a93',
          '#333333',
        ],
        'text-halo-color': '#ffffff',
        'text-halo-width': 2.0,
      },
    }, 'top');
    const onPendingSelClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      const f = e.features?.[0];
      const rid = f?.properties?.requestId as string | undefined;
      const uid = f?.properties?.unitId as string | undefined;
      const role = f?.properties?.role as string | undefined;
      if (!rid || !uid || !role) return;
      selectPendingArea(rid, uid, role === 'SITE' ? 'SITE' : role === 'SUB' ? 'SUB' : 'PRIMARY');
    };
    for (const id of ['pending-sel-site-fill', 'pending-sel-primary-fill', 'pending-sel-sub-fill']) {
      map.on('click', id, onPendingSelClick);
      map.on('mouseenter', id, onEnter);
      map.on('mouseleave', id, onLeave);
    }
    void clickSiteRef;
  }, [map]);

  // Push data into each source whenever its memoised FeatureCollection changes.
  useEffect(() => {
    const src = map?.getSource('posture-sel') as GeoJSONSource | undefined;
    if (src) src.setData(postureFC);
  }, [map, postureFC]);
  useEffect(() => {
    const src = map?.getSource('site-hubs') as GeoJSONSource | undefined;
    if (src) src.setData(siteHubsFC);
  }, [map, siteHubsFC]);
  useEffect(() => {
    const src = map?.getSource('pending-sel') as GeoJSONSource | undefined;
    if (src) src.setData(selectedPendingFC);
  }, [map, selectedPendingFC]);

  // Progressive-disclosure layer visibility (brief §4/§14/§26):
  //   - PRIMARY/SUB polygon layers follow the Primary/Sub toggles; with no unit selected, the source is empty anyway.
  //   - «قيد الاعتماد» overview rings are suppressed only when the operator has turned the toggle off.
  //   - Status markers are always on so the overview answers brief §3's six questions at a glance.
  //   - Labels on every reference site are hidden at overview zoom to cut label clutter (brief §29/§30); they return
  //     only for the revealed unit's own site, kept emphasised by the status ring.
  useEffect(() => {
    if (!map) return;
    const show = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    show('posture-primary-fill', layers.primary && !!unit);
    show('posture-primary-line', layers.primary && !!unit);
    show('posture-sub-fill', layers.sub && !!unit);
    show('posture-sub-line', layers.sub && !!unit);
    show('site-hub-bg', layers.units);
    show('site-hub-pending-ring', layers.units);
    show('site-hub-count', layers.units);
    show('site-hub-pending-badge', layers.units);
    show('site-hub-incomplete-badge', layers.units);
    const op = (areaOpacity / 100);
    if (map.getLayer('posture-primary-fill')) map.setPaintProperty('posture-primary-fill', 'fill-opacity', op * 0.35 as never);
    if (map.getLayer('posture-sub-fill')) map.setPaintProperty('posture-sub-fill', 'fill-opacity', op * 0.28 as never);
  }, [map, layers, areaOpacity, unit]);

  const counts = useMemo(() => postureCounts(units ?? []), [units]);
  /**
   * Pending union — `pendingAll` from the server (full projection, clickable to reveal proposal geometry) plus one
   * row per unit whose `.request` summary is NOT already in `pendingAll` (the operator lacks that request's read
   * right but still sees the fact that «a change is pending here»). Site hubs show the aggregate, SiteGroup rail
   * lists the per-request rows.
   */
  const pendingWithSummaries = useMemo<PosturePending[]>(() => {
    const byUnit = new Map<string, PosturePending>();
    for (const p of pendingAll) byUnit.set(p.unitId, p);
    const summaryRows: PosturePending[] = [];
    for (const u of units ?? []) {
      if (!u.request || byUnit.has(u.id)) continue;
      summaryRows.push({
        requestId: 'summary:' + u.id,
        requestNumber: '—',
        purpose: u.request.purpose,
        state: u.request.state,
        currentStage: null,
        unitId: u.id,
        unitCode: u.code,
        unitName: u.name,
        currentSiteId: u.site?.id ?? null,
        proposedSite: null,
        proposedPrimary: null,
        proposedSub: null,
      });
    }
    return [...pendingAll, ...summaryRows];
  }, [pendingAll, units]);

  const matches = useMemo(() => {
    const low = q.trim().toLowerCase();
    const base = (units ?? []).filter((u) => matchesFilter(u, filter));
    return base.filter((u) => !low || u.code.toLowerCase().includes(low) || u.name.toLowerCase().includes(low) || (u.site?.name ?? '').toLowerCase().includes(low));
  }, [units, q, filter]);

  /**
   * «المواقع (N)» (brief §9/§10/§11): the right rail default is a list of sites, each collapsible. Collapsed rows
   * show aggregate counts; expanded rows reveal the units inside. The visible sites follow the active filter via
   * `hubsForFilter` so the rail and the map always agree on «WHICH sites?».
   */
  const visibleSiteHubs = useMemo(() => {
    const low = q.trim().toLowerCase();
    const hubs = visibleHubs.filter((h) => !low || h.siteName.toLowerCase().includes(low) || h.unitIds.some((id) => {
      const u = unitsById.get(id);
      if (!u) return false;
      return u.code.toLowerCase().includes(low) || u.name.toLowerCase().includes(low);
    }));
    return hubs;
  }, [visibleHubs, q, unitsById]);

  type OrgNode = { unit: PostureUnit; children: OrgNode[] };
  const noStationingTree = useMemo<OrgNode[]>(() => {
    const noSite = matches.filter((u) => !u.site);
    const inPool = new Set(noSite.map((u) => u.id));
    const byId = new Map(noSite.map((u) => [u.id, { unit: u, children: [] as OrgNode[] }]));
    const roots: OrgNode[] = [];
    for (const n of byId.values()) {
      const parentId = n.unit.parentId;
      if (parentId && inPool.has(parentId) && byId.get(parentId)) byId.get(parentId)!.children.push(n);
      else roots.push(n);
    }
    const sortTree = (list: OrgNode[]) => { list.sort((a, b) => a.unit.name.localeCompare(b.unit.name, 'ar')); for (const n of list) sortTree(n.children); };
    sortTree(roots);
    return roots;
  }, [matches]);

  const siteHubById = useMemo(() => {
    const m = new Map<string, SiteHub>();
    for (const h of siteHubs) m.set(h.siteId, h);
    return m;
  }, [siteHubs]);
  const siteInfoCard = useMemo(() => {
    if (!siteInfoId) return null;
    const hub = siteHubById.get(siteInfoId) ?? null;
    return {
      siteId: siteInfoId,
      siteName: hub?.siteName ?? sitesById.get(siteInfoId) ?? siteInfoId,
      hub,
    };
  }, [siteInfoId, siteHubById, sitesById]);

  if (app.state?.empty) {
    return (
      <div className="tz-posture3 tz-posture3-empty" data-testid="posture-empty">
        <EmptyCentre title="لا توجد بيانات تمركز ضمن نطاقك" hint="تظهر الخريطة بعد استيراد الوحدات وتسجيل المواقع." />
      </div>
    );
  }

  const tabCount = (f: PostureFilter): number => {
    if (f === 'INCOMPLETE') return counts.incomplete;
    if (f === 'NO_STATIONING') return counts.noStationing;
    if (f === 'REQUESTS') return counts.requests;
    if (f === 'TEMPORARY') return counts.temporary;
    if (f === 'EXPIRING') return counts.expiring;
    if (f === 'COMPLETE') return counts.complete;
    return counts.sites;
  };

  const selectedRequestRow = selectedRequestId ? pendingAll.find((p) => p.requestId === selectedRequestId) ?? null : null;
  const pendingForRevealedUnit = unit ? pendingAll.find((p) => p.unitId === unit.id) ?? null : null;
  const unitCardOpen = !!unit && (selection?.kind === 'unit' || selection?.kind === 'area' || selection?.kind === 'request' || selection?.kind === 'pending-area');

  return (
    <div className="tz-posture3" data-testid="stationing-posture" data-selection={selection?.kind ?? 'none'}>
      <header className="tz-posture3-title">
        <div className="tz-posture3-titles">
          <Icon name="map" />
          <div>
            <h1>الموقف العملياتي</h1>
            <p>مواقع الوحدات وتمركزها ومناطق الانتشار</p>
          </div>
        </div>
      </header>

      <div className="tz-posture3-workspace">
        <div className="tz-posture3-mapbody">
          {terrain3d !== undefined && (
            <RequestMap
              view={view}
              terrain3d={terrain3d}
              request={req ?? asMapRequest({ id: '-', code: '', name: '', parentId: null, depth: 0, state: '' } as PostureUnit)}
              checks={null}
              mode={mode}
              fitMaxZoom={13}
              hideSite
              fit
              fitKey={fit}
              referenceInteractive
              onMap={setMap}
              highlight={unit?.site?.id ?? (siteInfoId ?? null)}
              fitSites
              pick={{ selectedId: unit?.site?.id ?? null, onPick: (siteId) => clickSite(siteId) }}
              referenceBoundaries="SELECTED"
              referenceLabels="POSTURE"
            />
          )}
        </div>

        {/* Left floating Layers panel — progressive: PRIMARY/SUB toggles are disabled until a unit is selected. */}
        <aside className="tz-posture3-layers" aria-label="طبقات الخريطة" data-testid="posture-layers">
          <header><Icon name="layers" /> <b>الطبقات</b></header>
          <ul>
            <li><label><input type="checkbox" checked={layers.sites} onChange={(e) => setLayers((l) => ({ ...l, sites: e.target.checked }))} /> <span><Icon name="pin" /> مواقع التمركز</span></label></li>
            <li><label><input type="checkbox" checked={layers.units} onChange={(e) => setLayers((l) => ({ ...l, units: e.target.checked }))} /> <span><Icon name="units" /> الوحدات والمؤشرات</span></label></li>
            <li>
              <label className={unit ? '' : 'is-disabled'} title={unit ? '' : 'اختر وحدة لعرض مناطق الانتشار'}>
                <input type="checkbox" checked={layers.primary} disabled={!unit} onChange={(e) => setLayers((l) => ({ ...l, primary: e.target.checked }))} />
                <span><i className="tz-sw tz-sw-primary" /> منطقة الانتشار الرئيسية</span>
              </label>
            </li>
            <li>
              <label className={unit ? '' : 'is-disabled'} title={unit ? '' : 'اختر وحدة لعرض مناطق الانتشار'}>
                <input type="checkbox" checked={layers.sub} disabled={!unit} onChange={(e) => setLayers((l) => ({ ...l, sub: e.target.checked }))} />
                <span><i className="tz-sw tz-sw-sub" /> منطقة الانتشار الفرعية</span>
              </label>
            </li>
            <li><label><input type="checkbox" checked={layers.boundaries} onChange={(e) => setLayers((l) => ({ ...l, boundaries: e.target.checked }))} /> <span><Icon name="boundary" /> حدود المواقع</span></label></li>
            <li><label><input type="checkbox" checked={mode === 'terrain'} onChange={(e) => { const on = e.target.checked; setMode(on ? 'terrain' : 'street'); setLayers((l) => ({ ...l, terrain: on })); }} /> <span><Icon name="chart" /> التضاريس (الانحدار)</span></label></li>
            <li><label className="is-disabled" title="غير مثبتة في حزمة الخرائط الحالية"><input type="checkbox" checked={layers.satellite} disabled /> <span><Icon name="eye" /> الصور الفضائية</span></label></li>
          </ul>
          {!unit && <p className="tz-posture3-layers-hint">اختر وحدة لعرض مناطق الانتشار</p>}
          <div className="tz-posture3-opacity">
            <label><span>شفافية المناطق</span><span className="tz-posture3-opacity-value">{areaOpacity}%</span></label>
            <input type="range" min={0} max={100} step={5} value={areaOpacity} onChange={(e) => setAreaOpacity(Number(e.target.value))} aria-label="شفافية المناطق" disabled={!unit} />
          </div>
        </aside>

        {/* Right docked Units panel — four tabs; selecting a row still reveals geometry for that single unit. */}
        <aside className="tz-posture3-units" aria-label="الوحدات" data-testid="posture-units-panel">
          <header>
            <span className="tz-posture3-units-title"><Icon name="units" /> <b>الوحدات</b> <em>({counts.all.toLocaleString('ar-AE')})</em></span>
          </header>
          <div className="tz-posture3-units-search">
            <Icon name="search" />
            <input type="search" aria-label="بحث عن وحدة" placeholder="بحث عن وحدة…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="tz-posture3-units-tabs" role="tablist">
            {FILTER_TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                data-testid={'cohort-' + key.toLowerCase()}
                className={'tz-posture3-tab' + (filter === key ? ' is-active' : '')}
                onClick={() => setFilter(key)}
              >
                {label} <span>({tabCount(key).toLocaleString('ar-AE')})</span>
              </button>
            ))}
            <button type="button" className="tz-posture3-browse" onClick={() => setDrawerOpen(true)} data-testid="posture-browse" title="استعراض الوحدات حسب الهيكل الكامل">
              <Icon name="tree" />
            </button>
          </div>
          <div className="tz-posture3-camps" role="listbox" aria-label={(FILTER_TABS.find((t) => t.key === filter) ?? { label: 'المواقع' }).label}>
            {!units && <div className="tz-posture3-empty-row">جارٍ التحميل…</div>}

            {/* «بلا تمركز» stays organisational — there is no site to cluster around (brief §12). */}
            {units && filter === 'NO_STATIONING' && noStationingTree.length === 0 && <div className="tz-posture3-empty-row">لا توجد وحدات غير متمركزة.</div>}
            {units && filter === 'NO_STATIONING' && noStationingTree.map((n) => (
              <OrgBranch key={n.unit.id} node={n} open={openOrg} onToggle={toggleOrg} selected={revealedUnitId} onPick={(uid) => selectUnit(uid)} />
            ))}

            {/* Every other filter aggregates by physical site (brief §9/§10/§11). The hub carries the counts; the
                units list lives one level deeper so no view is flooded by rows. */}
            {units && filter !== 'NO_STATIONING' && visibleSiteHubs.length === 0 && (
              <div className="tz-posture3-empty-row">لا توجد مواقع مطابقة للمرشّح الحالي.</div>
            )}
            {units && filter !== 'NO_STATIONING' && visibleSiteHubs.map((h) => (
              <SiteGroup
                key={h.siteId}
                hub={h}
                filter={filter}
                units={unitsById}
                pending={pendingWithSummaries}
                open={openCamp.has(h.siteId)}
                onToggleOpen={() => toggleCamp(h.siteId)}
                onPickSite={() => selectSite(h.siteId)}
                onPickUnit={(uid) => selectUnit(uid)}
                onPickRequest={(rid, uid) => selectRequest(rid, uid)}
                selectedSiteId={siteInfoId}
                revealedUnitId={revealedUnitId}
                selectedRequestId={selectedRequestId}
              />
            ))}
          </div>
        </aside>

        {/* Unit / area / request context card — one at a time (brief §22). */}
        {unitCardOpen && unit && (
          <aside className="tz-posture3-detail" aria-label="تفاصيل الوحدة المختارة" data-testid="posture-details">
            <header>
              <span className="tz-posture3-detail-icon"><Icon name="building" /></span>
              <div>
                <b>الوحدة {unit.code || unit.name}</b>
                <small>{unit.name}</small>
              </div>
              <button type="button" className="tz-posture3-detail-close" aria-label="إغلاق البطاقة" onClick={clearSelection}>×</button>
            </header>
            <div className="tz-posture3-badges" data-testid="posture-badges">
              <span className={'tz-posture3-badge tone-' + COMPLETENESS_TONE[completenessOf(unit)]}>{COMPLETENESS_LABEL[completenessOf(unit)]}</span>
              {TIMING_TONE[timingOf(unit)] && (
                <span className={'tz-posture3-badge tz-posture3-badge-timing tone-' + TIMING_TONE[timingOf(unit)]} data-testid="posture-timing-badge">{TIMING_LABEL[timingOf(unit)]}</span>
              )}
              {missingOf(unit) && <span className="tz-posture3-badge tone-warn" data-testid="posture-missing-badge">{MISSING_LABEL[missingOf(unit)!]}</span>}
            </div>
            {areaSel && (
              <div className="tz-posture3-area" data-testid="posture-area-card">
                <header>
                  <i className={'tz-sw ' + (areaSel.role === 'PRIMARY' ? 'tz-sw-primary' : 'tz-sw-sub')} aria-hidden />
                  <b>{areaSel.role === 'PRIMARY' ? 'منطقة الانتشار الرئيسية' : 'منطقة الانتشار الفرعية'}</b>
                </header>
                <dl>
                  <div><dt>الوحدة</dt><dd>{unit.code || '—'} · {unit.name}</dd></div>
                  <div><dt>الموقع</dt><dd>{unit.site?.name ?? '—'}</dd></div>
                  <div><dt>نوع التمركز</dt><dd>{unit.kind === 'TEMPORARY' ? 'مؤقت' : unit.kind ? 'دائم' : '—'}{unit.plannedEnd ? ' · حتى ' + fullDate(unit.plannedEnd) : ''}</dd></div>
                  {(() => { const g = (areaSel.role === 'PRIMARY' ? unit.primary : unit.alternative) as GeomLike; const km = areaKm2Of(g); return km == null ? null : (<div><dt>المساحة التقريبية</dt><dd>{km.toFixed(2)} كم²</dd></div>); })()}
                  <div><dt>حالة الاعتماد</dt><dd>معتمدة وسارية</dd></div>
                </dl>
              </div>
            )}
            <dl className="tz-posture3-detail-body">
              <div><dt><Icon name="pin" /> الموقع الحالي</dt><dd data-testid="posture-site">{unit.site?.name ?? 'بلا تمركز معتمد'}</dd></div>
              <div><dt><Icon name="layers" /> نوع التمركز</dt><dd data-testid="posture-kind">{unit.kind === 'TEMPORARY' ? 'مؤقت' : unit.kind ? 'دائم' : '—'}{unit.plannedEnd ? ' · حتى ' + fullDate(unit.plannedEnd) : ''}</dd></div>
              <div><dt><i className="tz-sw tz-sw-primary" /> منطقة الانتشار الرئيسية</dt><dd data-testid="posture-primary">{unit.primary ? 'معتمدة' : 'لا توجد'}</dd></div>
              <div><dt><i className="tz-sw tz-sw-sub" /> منطقة الانتشار الفرعية</dt><dd data-testid="posture-alternative">{unit.alternative ? 'معتمدة' : 'لا توجد'}</dd></div>
              <div><dt><Icon name="check" /> الحالة</dt><dd>{UNIT_STATE[unit.state] ?? unit.state}</dd></div>
              {!!unit.otherUnitsAtSite && <div><dt><Icon name="units" /> وحدات أخرى في الموقع</dt><dd data-testid="posture-others">{unit.otherUnitsAtSite}</dd></div>}
              {unit.request && <div><dt><Icon name="file" /> طلب جارٍ</dt><dd data-testid="posture-request">{(isPurpose(unit.request.purpose) ? PURPOSE_TITLE[unit.request.purpose] : unit.request.purpose) + ' · ' + unit.request.state}</dd></div>}
            </dl>
            {selectedRequestRow && (
              <div className="tz-posture3-pending" data-testid="posture-pending-detail">
                <header><i className="tz-posture3-pending-swatch" aria-hidden /> <b>المقترح قيد الاعتماد</b> <small>{selectedRequestRow.requestNumber}</small></header>
                <ul>
                  {selectedRequestRow.proposedSite && <li><i className="tz-posture3-pending-swatch is-site" aria-hidden /> موقع مقترح</li>}
                  {selectedRequestRow.proposedPrimary && <li><i className="tz-posture3-pending-swatch is-primary" aria-hidden /> منطقة انتشار رئيسية مقترحة</li>}
                  {selectedRequestRow.proposedSub && <li><i className="tz-posture3-pending-swatch is-sub" aria-hidden /> منطقة انتشار فرعية مقترحة</li>}
                </ul>
                <p>المرحلة الحالية: {selectedRequestRow.currentStage ?? (PENDING_STAGE_AR[selectedRequestRow.state] ?? selectedRequestRow.state)}{pendingReq?.revisions?.length ? ' · التعديلات: ' + pendingReq.revisions.length : ''}</p>
              </div>
            )}
            {!selectedRequestRow && pendingForRevealedUnit && (
              <div className="tz-posture3-pending-hint" data-testid="posture-pending-hint">
                <i className="tz-posture3-legend-dot tone-pending" aria-hidden />
                <span>هذه الوحدة لديها طلب <b>{pendingForRevealedUnit.purpose === 'RESTATIONING' ? 'إعادة تمركز' : 'مناطق انتشار'}</b> قيد الاعتماد.</span>
                <button type="button" className="tz-posture3-pending-link" onClick={() => selectRequest(pendingForRevealedUnit.requestId, pendingForRevealedUnit.unitId)}>عرض المقترح</button>
              </div>
            )}
          </aside>
        )}

        {/* Standalone pending-area card (clicking an amber polygon of the selected proposal). */}
        {pendingAreaSel && selectedRequestRow && (
          <aside className="tz-posture3-detail tz-posture3-detail-pending" aria-label="تفاصيل الطلب المقترح" data-testid="posture-pending-card">
            <header>
              <span className="tz-posture3-detail-icon"><Icon name="file" /></span>
              <div>
                <b>{selectedRequestRow.requestNumber}</b>
                <small>{selectedRequestRow.purpose === 'RESTATIONING' ? 'طلب إعادة تمركز' : 'طلب مناطق انتشار'}</small>
              </div>
              <button type="button" className="tz-posture3-detail-close" aria-label="إغلاق البطاقة" onClick={() => setSelection({ kind: 'request', requestId: selectedRequestRow.requestId, unitId: selectedRequestRow.unitId })}>×</button>
            </header>
            <dl className="tz-posture3-detail-body">
              <div><dt>الوحدة</dt><dd>{selectedRequestRow.unitCode ?? '—'} · {selectedRequestRow.unitName ?? '—'}</dd></div>
              <div><dt>العنصر</dt><dd>{pendingAreaSel.element === 'SITE' ? 'موقع مقترح' : pendingAreaSel.element === 'PRIMARY' ? 'منطقة انتشار رئيسية مقترحة' : 'منطقة انتشار فرعية مقترحة'}</dd></div>
              <div><dt>المرحلة الحالية</dt><dd>{selectedRequestRow.currentStage ?? (PENDING_STAGE_AR[selectedRequestRow.state] ?? selectedRequestRow.state)}</dd></div>
              <div><dt>الحالة</dt><dd>{PENDING_STAGE_AR[selectedRequestRow.state] ?? selectedRequestRow.state}</dd></div>
            </dl>
            <p className="tz-posture3-detail-note">لا يمكن تعديل الطلب من صفحة الموقف العملياتي.</p>
          </aside>
        )}

        {siteInfoCard && (
          <aside className="tz-posture3-detail tz-posture3-detail-site" aria-label="تفاصيل الموقع" data-testid="posture-site-info">
            <header>
              <span className="tz-posture3-detail-icon"><Icon name="pin" /></span>
              <div>
                <b>{siteInfoCard.siteName}</b>
                <small>{siteInfoCard.hub ? `${siteInfoCard.hub.unitsTotal.toLocaleString('ar-AE')} وحدة` : 'موقع مرجعي — لا توجد وحدات لك فيه'}</small>
              </div>
              <button type="button" className="tz-posture3-detail-close" aria-label="إغلاق البطاقة" onClick={clearSelection}>×</button>
            </header>
            {siteInfoCard.hub ? (
              <>
                <dl className="tz-posture3-detail-body">
                  {siteInfoCard.hub.completeCount > 0 && <div><dt><Icon name="check" /> موقف مكتمل</dt><dd>{siteInfoCard.hub.completeCount.toLocaleString('ar-AE')}</dd></div>}
                  {siteInfoCard.hub.incompleteCount > 0 && <div><dt><Icon name="alert" /> مناطق غير مكتملة</dt><dd>{siteInfoCard.hub.incompleteCount.toLocaleString('ar-AE')}</dd></div>}
                  {siteInfoCard.hub.temporaryCount > 0 && <div><dt><Icon name="clock" /> تمركز مؤقت</dt><dd>{siteInfoCard.hub.temporaryCount.toLocaleString('ar-AE')}</dd></div>}
                  {siteInfoCard.hub.expiringCount > 0 && <div><dt><Icon name="clock" /> ينتهي قريبًا</dt><dd>{siteInfoCard.hub.expiringCount.toLocaleString('ar-AE')}</dd></div>}
                  {siteInfoCard.hub.pendingCount > 0 && <div><dt><Icon name="file" /> طلبات جارية</dt><dd>{siteInfoCard.hub.pendingCount.toLocaleString('ar-AE')}</dd></div>}
                  {siteInfoCard.hub.hasOutsideReach && <div><dt><Icon name="units" /> وحدات أخرى خارج نطاقك</dt><dd>موجودة — لا تُسمّى</dd></div>}
                </dl>
                <ul className="tz-posture3-camp-units tz-posture3-site-units" data-testid="posture-site-units">
                  {siteInfoCard.hub.unitIds.map((uid) => {
                    const u = unitsById.get(uid);
                    if (!u) return null;
                    return (
                      <li key={uid}>
                        <UnitRow u={u} selected={revealedUnitId === u.id} onPick={() => selectUnit(u.id)} />
                      </li>
                    );
                  })}
                </ul>
                {pendingWithSummaries.filter((p) => siteInfoCard.hub!.unitIds.includes(p.unitId)).length > 0 && (
                  <ul className="tz-posture3-camp-units" data-testid="posture-site-requests">
                    {pendingWithSummaries
                      .filter((p) => siteInfoCard.hub!.unitIds.includes(p.unitId))
                      .map((p) => (
                        <PendingRow
                          key={p.requestId + ':' + p.unitId}
                          pending={p}
                          units={unitsById}
                          selectedRequestId={selectedRequestId}
                          onPickRequest={() => selectRequest(p.requestId, p.unitId)}
                        />
                      ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="tz-posture3-detail-note">يُعرض هذا الموقع للمرجع فقط. لا يُكشف عن الوحدات غير المرئية ضمن صلاحيتك.</p>
            )}
          </aside>
        )}

        <div className="tz-posture3-mapctl" aria-label="أدوات الخريطة">
          <MapModeSwitcher mode={mode} setMode={setMode} />
          <ViewSwitcher view={view} setView={setView} available={!!terrain3d} />
          <button type="button" className="tz-posture3-mapctl-btn" onClick={() => setFit((k) => k + 1)} title="الحدود والمناطق">
            <Icon name="target" />
          </button>
        </div>

        {/* Progressive legend (brief §27): overview tokens only; PRIMARY/SUB and «الحالي/المقترح» appear contextually. */}
        <div className={'tz-posture3-legend' + (legendOpen ? '' : ' is-closed')} data-testid="posture-legend">
          <button type="button" className="tz-posture3-legend-toggle" aria-expanded={legendOpen} onClick={() => setLegendOpen((o) => !o)}>
            <Icon name="layers" /> مفتاح الموقف
          </button>
          <ul hidden={!legendOpen}>
            <li><i className="tz-posture3-legend-dot tone-ok" aria-hidden /> موقف مكتمل</li>
            <li><i className="tz-posture3-legend-dot tone-warn" aria-hidden /> مناطق غير مكتملة</li>
            <li><i className="tz-posture3-legend-dot tone-off" aria-hidden /> بلا تمركز</li>
            {counts.temporary > 0 && <li><i className="tz-posture3-legend-dot tone-temp" aria-hidden /> تمركز مؤقت</li>}
            {counts.expiring > 0 && <li><i className="tz-posture3-legend-dot tone-expiring" aria-hidden /> ينتهي قريبًا</li>}
            {pendingAll.length > 0 && <li><i className="tz-posture3-legend-dot tone-pending" aria-hidden /> قيد الاعتماد</li>}
            {unit && <li><i className="tz-sw tz-sw-primary" aria-hidden /> منطقة الانتشار الرئيسية</li>}
            {unit && <li><i className="tz-sw tz-sw-sub" aria-hidden /> منطقة الانتشار الفرعية</li>}
            {selectedRequestId && <li><i className="tz-posture3-legend-dot tone-pending" aria-hidden /> المقترح قيد الاعتماد</li>}
            {selectedRequestId && <li><i className="tz-posture3-legend-dot tone-ok" aria-hidden /> الموقف الحالي للوحدة</li>}
          </ul>
        </div>
      </div>

      <footer className="tz-posture3-dock" aria-label="موجز الموقف">
        <DockChip icon="units" value={counts.all} label="إجمالي الوحدات" active={filter === 'ALL'} onClick={() => setFilter('ALL')} testId="dock-all" />
        <DockChip icon="check" value={counts.complete} label="موقف مكتمل" active={filter === 'COMPLETE'} onClick={() => setFilter('COMPLETE')} testId="dock-complete" />
        <DockChip icon="alert" value={counts.incomplete} label="مناطق غير مكتملة" active={filter === 'INCOMPLETE'} onClick={() => setFilter('INCOMPLETE')} testId="dock-incomplete" />
        <DockChip icon="target" value={counts.noStationing} label="بلا تمركز" active={filter === 'NO_STATIONING'} onClick={() => setFilter('NO_STATIONING')} testId="dock-no-stationing" />
        <DockChip icon="clock" value={counts.temporary} label="تمركز مؤقت" active={filter === 'TEMPORARY'} onClick={() => setFilter('TEMPORARY')} testId="dock-temporary" />
        <DockChip icon="clock" value={counts.expiring} label="ينتهي قريبًا" active={filter === 'EXPIRING'} onClick={() => setFilter('EXPIRING')} testId="dock-expiring" />
        <DockChip icon="file" value={counts.requests} label="طلبات جارية" active={filter === 'REQUESTS'} onClick={() => setFilter('REQUESTS')} testId="dock-requests" />
        <span className="tz-posture3-dock-sites"><Icon name="pin" /> <b>{counts.sites.toLocaleString('ar-AE')}</b> <small>المواقع المستخدمة</small></span>
      </footer>

      {drawerOpen && units && (
        <div className="tz-posture3-drawer" role="dialog" aria-modal="true" aria-label="استعراض الوحدات" data-testid="posture-drawer">
          <div className="tz-posture3-drawer-shade" onClick={() => setDrawerOpen(false)} aria-hidden />
          <div className="tz-posture3-drawer-panel">
            <header>
              <b>استعراض الوحدات</b>
              <button type="button" className="tz-pbtn" aria-label="إغلاق" onClick={() => setDrawerOpen(false)}>×</button>
            </header>
            <div className="tz-posture3-drawer-body">
              <UnitTree
                source={tree}
                label="الوحدات"
                searchLabel="بحث في الوحدات"
                testId="posture-tree"
                selected={revealedUnitId}
                trail={tree.trail(revealedUnitId)}
                initialOpen={units.length <= 80 ? units.map((u) => u.id) : []}
                openSingleRoot
                onSelect={(u) => (selectUnit(u.id), setDrawerOpen(false))}
                meta={(u) => u.site?.name ?? 'بلا تمركز معتمد'}
                empty="لا وحدات ضمن صلاحيتك."
              />
            </div>
          </div>
        </div>
      )}

      {chooser && (
        <div className="tz-posture3-chooser" role="dialog" aria-modal="true" aria-label={'وحدات في ' + chooser.siteName} data-testid="posture-site-chooser">
          <div className="tz-posture3-chooser-shade" onClick={() => setChooser(null)} aria-hidden />
          <div className="tz-posture3-chooser-panel">
            <header>
              <b>{chooser.siteName}</b>
              <small>{chooser.unitIds.length.toLocaleString('ar-AE')} وحدات ضمن صلاحيتك</small>
              <button type="button" className="tz-pbtn" aria-label="إغلاق" onClick={() => setChooser(null)}>×</button>
            </header>
            <ul>
              {chooser.unitIds.map((uid) => {
                const u = units?.find((x) => x.id === uid);
                if (!u) return null;
                return (
                  <li key={uid}>
                    <button type="button" data-testid="posture-site-chooser-item" onClick={() => (selectUnit(uid), setChooser(null))}>
                      <Icon name="building" />
                      <span><b>{u.code || u.name}</b><small>{u.name}</small></span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {areaChooser && (
        <div className="tz-posture3-chooser" role="dialog" aria-modal="true" aria-label="مناطق متداخلة" data-testid="posture-area-chooser">
          <div className="tz-posture3-chooser-shade" onClick={() => setAreaChooser(null)} aria-hidden />
          <div className="tz-posture3-chooser-panel">
            <header>
              <b>{areaChooser.unitIds.length.toLocaleString('ar-AE')} مناطق في هذا الموضع</b>
              <small>اختر الوحدة</small>
              <button type="button" className="tz-pbtn" aria-label="إغلاق" onClick={() => setAreaChooser(null)}>×</button>
            </header>
            <ul>
              {areaChooser.unitIds.map((uid) => {
                const u = unitsById.get(uid);
                if (!u) return null;
                return (
                  <li key={uid}>
                    <button type="button" data-testid="posture-area-chooser-item" onClick={() => (selectArea(uid, areaChooser.role), setAreaChooser(null))}>
                      <Icon name="building" />
                      <span><b>{u.code || u.name}</b><small>{u.name}</small></span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Rail sub-components. Row colouring reads the shared helper — one source of truth.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One row per physical SITE HUB (owner, 21 Nov 2026 «REDESIGN» §9–§11). Collapsed shows aggregate counts; expanded
 * reveals the units at the site. Each site/unit/request click selects — the map zooms to it and the hub turns amber.
 */
function SiteGroup({
  hub, filter, units, pending, open, onToggleOpen, onPickSite, onPickUnit, onPickRequest,
  selectedSiteId, revealedUnitId, selectedRequestId,
}: {
  hub: SiteHub;
  filter: PostureFilter;
  units: Map<string, PostureUnit>;
  pending: readonly PosturePending[];
  open: boolean;
  onToggleOpen: () => void;
  onPickSite: () => void;
  onPickUnit: (unitId: string) => void;
  onPickRequest: (requestId: string, unitId: string) => void;
  selectedSiteId: string | null;
  revealedUnitId: string | null;
  selectedRequestId: string | null;
}) {
  const siteSelected = selectedSiteId === hub.siteId || (!!revealedUnitId && units.get(revealedUnitId)?.site?.id === hub.siteId);
  const bulletByFilter = (): PostureUnit[] => {
    const all = hub.unitIds.map((id) => units.get(id)).filter((u): u is PostureUnit => !!u);
    if (filter === 'INCOMPLETE') return all.filter((u) => completenessOf(u) === 'INCOMPLETE_DEPLOYMENT');
    if (filter === 'TEMPORARY' || filter === 'EXPIRING') {
      return all.filter((u) => {
        const t = timingOf(u);
        return filter === 'EXPIRING' ? t === 'TEMPORARY_EXPIRING' : (t === 'TEMPORARY' || t === 'TEMPORARY_EXPIRING');
      });
    }
    if (filter === 'COMPLETE') return all.filter((u) => completenessOf(u) === 'COMPLETE');
    if (filter === 'REQUESTS') return all.filter((u) => !!u.request);
    return all;
  };
  const visibleUnits = bulletByFilter();
  const requestsAtSite = pending.filter((p) => hub.unitIds.includes(p.unitId));
  const summaries: Array<{ label: string; tone: 'ok' | 'warn' | 'off' | 'temp' | 'expiring' | 'pending' }> = [];
  if (hub.completeCount > 0) summaries.push({ label: hub.completeCount.toLocaleString('ar-AE') + ' مكتمل', tone: 'ok' });
  if (hub.incompleteCount > 0) summaries.push({ label: hub.incompleteCount.toLocaleString('ar-AE') + ' ناقص', tone: 'warn' });
  if (hub.temporaryCount > 0) summaries.push({ label: hub.temporaryCount.toLocaleString('ar-AE') + ' مؤقت', tone: 'temp' });
  if (hub.expiringCount > 0) summaries.push({ label: hub.expiringCount.toLocaleString('ar-AE') + ' ينتهي قريبًا', tone: 'expiring' });
  if (hub.pendingCount > 0) summaries.push({ label: hub.pendingCount.toLocaleString('ar-AE') + ' طلب', tone: 'pending' });

  return (
    <section className={'tz-posture3-camp' + (open ? ' is-open' : '') + (siteSelected ? ' is-selected' : '')} data-testid="posture-site-group" data-site={hub.siteId}>
      <button
        type="button"
        className="tz-posture3-camp-head"
        aria-expanded={open}
        onClick={() => { onPickSite(); if (!open) onToggleOpen(); }}
      >
        <span className="tz-posture3-camp-twist" aria-hidden onClick={(e) => { e.stopPropagation(); onToggleOpen(); }}>{open ? '▾' : '◂'}</span>
        <span className="tz-posture3-camp-icon"><Icon name="pin" /></span>
        <span className="tz-posture3-camp-meta">
          <b>{hub.siteName}</b>
          <small>
            {hub.unitsTotal.toLocaleString('ar-AE')} {hub.unitsTotal === 1 ? 'وحدة' : 'وحدات'}
            {summaries.length > 0 ? ' · ' + summaries.map((s) => s.label).join(' · ') : ''}
          </small>
        </span>
      </button>
      {open && (
        <>
          {visibleUnits.length > 0 && (
            <ul className="tz-posture3-camp-units">
              {visibleUnits.map((u) => (
                <li key={u.id}>
                  <UnitRow u={u} selected={revealedUnitId === u.id} onPick={() => onPickUnit(u.id)} />
                </li>
              ))}
            </ul>
          )}
          {requestsAtSite.length > 0 && (
            <ul className="tz-posture3-camp-units" data-testid="posture-site-pending">
              {requestsAtSite.map((p) => (
                <PendingRow
                  key={p.requestId + ':' + p.unitId}
                  pending={p}
                  units={units}
                  selectedRequestId={selectedRequestId}
                  onPickRequest={() => onPickRequest(p.requestId, p.unitId)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function UnitRow({ u, selected, onPick }: { u: PostureUnit; selected: boolean; onPick: () => void }) {
  const comp = completenessOf(u);
  const tim = timingOf(u);
  const miss = missingOf(u);
  return (
    <button
      type="button"
      data-testid="posture-unit"
      data-unit={u.id}
      data-completeness={comp}
      data-timing={tim}
      className={'tz-posture3-unit-row' + (selected ? ' is-selected' : '')}
      onClick={onPick}
      title={u.site?.name ?? ''}
    >
      <span className="tz-posture3-unit-icon"><Icon name="building" /></span>
      <span className="tz-posture3-unit-meta">
        <b>{u.code || u.name}</b>
        <small>
          {u.name}
          {miss ? ' · ' + MISSING_LABEL[miss] : ''}
        </small>
      </span>
      <span className={'tz-posture3-unit-state tone-' + COMPLETENESS_TONE[comp]} aria-hidden>●</span>
      {TIMING_TONE[tim] && <span className={'tz-posture3-unit-clock tone-' + TIMING_TONE[tim]} aria-hidden>◷</span>}
    </button>
  );
}

function OrgBranch({ node, open, onToggle, selected, onPick, depth = 0 }: { node: { unit: PostureUnit; children: { unit: PostureUnit; children: unknown[] }[] }; open: Set<string>; onToggle: (id: string) => void; selected: string | null; onPick: (unitId: string) => void; depth?: number }) {
  const has = node.children.length > 0;
  const isOpen = has && open.has(node.unit.id);
  return (
    <div className="tz-posture3-org-node" style={{ ['--d' as never]: depth }}>
      <button
        type="button"
        data-testid="posture-unit"
        data-unit={node.unit.id}
        data-completeness="NO_STATIONING"
        className={'tz-posture3-unit-row' + (selected === node.unit.id ? ' is-selected' : '')}
        onClick={() => onPick(node.unit.id)}
      >
        {has ? (
          <span className="tz-posture3-camp-twist" aria-hidden onClick={(e) => { e.stopPropagation(); onToggle(node.unit.id); }}>{isOpen ? '▾' : '◂'}</span>
        ) : (
          <span className="tz-posture3-camp-twist" aria-hidden>·</span>
        )}
        <span className="tz-posture3-unit-icon"><Icon name="tree" /></span>
        <span className="tz-posture3-unit-meta">
          <b>{node.unit.code || node.unit.name}</b>
          <small>{node.unit.name}</small>
        </span>
        <span className="tz-posture3-unit-state tone-off" aria-hidden>●</span>
      </button>
      {isOpen && (
        <div className="tz-posture3-org-kids">
          {node.children.map((c) => (
            <OrgBranch key={c.unit.id} node={c as never} open={open} onToggle={onToggle} selected={selected} onPick={onPick} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pending-request row. Clicking it SELECTS the request (brief §17): current posture + that one proposal are revealed
 * on the map; nothing else. Row colour uses the pending tone so it never looks like a completeness verdict.
 */
function PendingRow({ pending, units, selectedRequestId, onPickRequest }: { pending: PosturePending; units: Map<string, PostureUnit>; selectedRequestId: string | null; onPickRequest: () => void }) {
  const u = units.get(pending.unitId);
  const stage = pending.currentStage ?? PENDING_STAGE_AR[pending.state] ?? pending.state;
  const selected = selectedRequestId === pending.requestId;
  return (
    <li>
      <button
        type="button"
        data-testid="posture-request-row"
        data-unit={pending.unitId}
        data-request={pending.requestId}
        data-state={pending.state}
        className={'tz-posture3-unit-row' + (selected ? ' is-selected' : '')}
        onClick={onPickRequest}
        title={stage}
      >
        <span className="tz-posture3-unit-icon"><Icon name="file" /></span>
        <span className="tz-posture3-unit-meta">
          <b>{pending.unitCode ?? u?.code ?? '—'} · {pending.requestNumber}</b>
          <small>
            {u?.name ?? pending.unitName ?? '—'}
            {pending.purpose === 'RESTATIONING' && u?.site ? ' · ' + u.site.name + ' → موقع مقترح' : ''}
            {pending.purpose === 'DEPLOYMENT_AREAS' ? (pending.proposedPrimary ? ' · رئيسية مقترحة' : '') + (pending.proposedSub ? ' · فرعية مقترحة' : '') : ''}
            {' · ' + stage}
          </small>
        </span>
        <span className="tz-posture3-unit-state tone-pending" aria-hidden>●</span>
      </button>
    </li>
  );
}

/** Dock chip — clickable; sets the shared filter. */
function DockChip({ icon, value, label, active, onClick, testId }: { icon: 'units' | 'check' | 'alert' | 'target' | 'clock' | 'file'; value: number; label: string; active: boolean; onClick: () => void; testId: string }) {
  return (
    <button type="button" className={'tz-posture3-dock-chip' + (active ? ' is-active' : '')} onClick={onClick} data-testid={testId} aria-pressed={active}>
      <Icon name={icon} />
      <b>{value.toLocaleString('ar-AE')}</b>
      <small>{label}</small>
    </button>
  );
}

export type { SiteGeometry };

export default PosturePage;
