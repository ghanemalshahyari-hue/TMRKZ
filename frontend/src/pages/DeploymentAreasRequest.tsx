import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { api, type HubUnit } from '../api/client';
import type { GeoPolygon, RestationingChecks, RestationingRequest, SiteGeometry, StationingPolicyValues } from '../api/types';
import { DemSampler, SITE_LOOK, SiteEditor, SlopeInside, addOverlayLayer, installedTerrain3d, type MapView, type SiteLive } from '../components/map/maplibre';
import type { BasemapMode, Terrain3dSource } from '../components/map/maplibre/offlineStyle';
import { AREA_LOOK } from '../components/stationing/AreaControls';
import { Icon } from '../components/ui';
import { MapFrame } from '../components/workspace/MapFrame';
import { OperationalWorkspace } from '../components/workspace/OperationalWorkspace';
import { MAP_COLOURS, RequestMap } from '../components/workspace/RequestMap';
import { useRegisteredSites } from '../components/workspace/useRegisteredSites';
import { SlopeControl } from '../components/workspace/TerrainPanel';
import { INITIAL_SLOPE_LIMITS } from '../lib/terrainRgb';
import { resolveAreaDefault, type AreaDefault } from '../lib/deploymentDefault';
import { readyShape, type ShapeKind } from '../lib/shapeTransform';
import { ToolGlyph } from '../components/stationing/ToolGlyph';
import {
  AREA_NAME, FLOW_STAGES, FLOW_STEPS, areaChip, areaVerdict, campTree, flowStepProblem, kmChip, measuredFrom, overReason, rangeText, requestingUnitOf,
  restationingChoices, siteShapeKind, startStep, unitChoices, unitForest, verdictOf,
  type AreaRole, type CampNode, type FlowPurpose, type UnitNode,
  requestIntoFlow, type FlowKind, reachFor, reachText, BEYOND_MAX, STOPS_AT_REACH,
} from '../lib/deploymentAreasFlow';
import { distanceM, withinM, type LatLng } from '../lib/geo';
import { PURPOSE_WRITES } from '../lib/requestPurpose';
import { ReturnedParts } from '../components/workspace/PartReviewPanel';
import { anchorOf, partsOf, siteArea } from '../lib/siteGeometry';

type PlaceShape = ShapeKind | 'COPY';
type Tool = 'select' | 'move' | 'vertices';
type Target = 'site' | AreaRole;

/** A site that is only a marker, as a footprint of about a metre (as the request editor draws it). */
const tinySquare = (lat: number, lng: number) => {
  const d = 0.000005;
  return { type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] } as unknown as SiteGeometry;
};
const isShape = (g: unknown): g is SiteGeometry => !!g && ['Polygon', 'MultiPolygon'].includes((g as { type?: string }).type ?? '');
const centreOf = (g: SiteGeometry) => anchorOf(partsOf(g));
const areaOf = (g: unknown) => siteArea(partsOf(g as SiteGeometry));
const geometryOf = (u: HubUnit | null | undefined): SiteGeometry | null =>
  u?.site ? (isShape(u.site.geometry) ? (u.site.geometry as unknown as SiteGeometry) : u.site.lat != null && u.site.lng != null ? tinySquare(u.site.lat, u.site.lng) : null) : null;
const SITE_NAME = 'موقع التمركز الجديد';

/**
 * Two requests on one map-first screen (owner brief «إعادة تنظيم التمركز والمواقع ومناطق الانتشار»):
 *
 * «طلب مناطق انتشار» (§4, phase 3): one unit with an approved stationing; the request starts from its current site by
 * itself (no starting point to choose), places «منطقة الانتشار الرئيسية» then «منطقة الانتشار الفرعية», and is reviewed and
 * sent. The unit's site does not change.
 *
 * «طلب إعادة تمركز» (§5, phase 4): the unit or units that move, chosen by camp; their current site shows by itself; then
 * «موقع التمركز الجديد», the new main and sub-areas, the review and the sending — one progress strip, no stacked cards.
 *
 * Distances and ranges follow the stationing policy in force; the server checks again, with the terrain, before sending.
 * Each shape is placed ready-made by one click (circle, ellipse, square, rectangle, or a copy) or drawn (a double click
 * finishes), then handled like a shape in Word (§7). Its numbers are small chips with «ⓘ» for the details (§8).
 */
/** A date input's day of an ISO instant, and the instant a chosen day starts at (the application's time zone, as before). */
const isoDay = (s?: string | null) => (s ? s.slice(0, 10) : '');
const dayStart = (d: string) => (d ? new Date(d + 'T00:00:00+04:00').toISOString() : null);

/**
 * The one map-first editor of «طلب مناطق انتشار» and «طلب إعادة تمركز» (owner brief §4–§5; release closure, 20 Nov 2026):
 * a new request, a new one opened from a site (the site preselected, nothing saved), a saved draft or a returned request
 * (`requestId`: loaded as saved, nothing changed by opening it; content this screen has no control for is carried back
 * unchanged and named). A temporary move keeps the same lifecycle: its dates are asked here when the kind is TEMPORARY.
 */
export function DeploymentAreasRequest({ onClose, purpose = 'DEPLOYMENT_AREAS', preselectUnit = null, preselectSite = null, requestId = null }: {
  onClose: () => void; purpose?: FlowPurpose; preselectUnit?: string | null; preselectSite?: string | null; requestId?: string | null;
}) {
  const isRS = purpose === 'RESTATIONING';
  const stages = FLOW_STAGES[purpose];
  const steps = FLOW_STEPS[purpose];
  const last = stages.length;
  const [units, setUnits] = useState<HubUnit[] | null>(null);
  const [policy, setPolicy] = useState<{ version: number; values: StationingPolicyValues } | null | undefined>(undefined);
  const [step, setStep] = useState(1);
  // «طلب مناطق انتشار»: the one unit; «طلب إعادة تمركز»: the units that move (the unit asking is the one over them all)
  const [unitId, setUnitId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [areas, setAreas] = useState<Record<AreaRole, GeoPolygon | null>>({ primary: null, alternative: null });
  const [newSite, setNewSite] = useState<SiteGeometry | null>(null);
  // the current site the new one was copied from (its id and area): the server records COPY, EDITED or DRAWN
  const [copied, setCopied] = useState<{ id: string; area: number } | null>(null);
  const [err, setErr] = useState('');
  // how the next click places the shape (owner, 17 Nov 2026): a ready shape of the right size, or a copy (the sub-area as
  // the main area, the new site as the current site), moved to the click; free drawing is the editor's own mode
  const [placeShape, setPlaceShape] = useState<PlaceShape | null>(null);
  const placing = !!placeShape;
  const setPlacing = (_off: false) => setPlaceShape(null);
  const [drawing, setDrawing] = useState(false);
  // «تحديد» shows the Word-like frame and handles, «تحريك» drags the whole shape, «الرؤوس» edits its vertices
  const [tool, setTool] = useState<Tool>('select');
  const [info, setInfo] = useState<AreaRole | null>(null);
  const [reason, setReason] = useState('');
  // permanent, or temporary with its start and planned end (the lifecycle of ADR-034 is the server's, unchanged)
  const [kind, setKind] = useState<FlowKind>('PERMANENT');
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  // the saved request this screen edits (a draft or a returned request), as the server holds it; null for a new one
  const [loaded, setLoaded] = useState<RestationingRequest | null | undefined>(requestId ? undefined : null);
  const [legacy, setLegacy] = useState<string[]>([]);
  // the request on the server: a draft, then sent through its route
  const [draft, setDraft] = useState<{ id: string; number: string; sent: boolean; requester: string } | null>(null);
  // «حُفظت المسودة» is said for a save made here, not for a saved request merely opened
  const [savedHere, setSavedHere] = useState(false);
  const [sendErr, setSendErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<BasemapMode>('street');
  const [view, setView] = useState<MapView>('2d');
  const [terrain3d, setTerrain3d] = useState<Terrain3dSource | null | undefined>(undefined);
  const [mapReady, setMapReady] = useState(false);
  const slopeRef = useRef<SlopeInside | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const editor = useRef<SiteEditor | null>(null);
  const clickRef = useRef<(e: MapMouseEvent) => void>(() => undefined);
  // the distance under the pointer while a shape is placed or drawn, with its verdict (owner, 17 Nov 2026)
  const moveRef = useRef<(e: MapMouseEvent) => void>(() => undefined);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const roleRef = useRef<AreaRole | null>(null);
  const targetRef = useRef<Target | null>(null);
  // the units by camp (owner, 17 Nov 2026): the camps and units folded at first, an arrow opens one. The camp chosen is
  // highlighted in the list and on the map; «التالي» moves on, never the click itself
  const registered = useRegisteredSites();
  const [openCamps, setOpenCamps] = useState<Set<string>>(new Set());
  const [openUnits, setOpenUnits] = useState<Set<string>>(new Set());
  const [campId, setCampId] = useState<string | null>(null);
  // the map moves only when a camp is chosen from the list (owner): never when a step changes
  const [focusReq, setFocusReq] = useState<{ siteId: string; key: number } | null>(null);
  const [fitAll, setFitAll] = useState(false);

  useEffect(() => {
    installedTerrain3d().then(setTerrain3d);
    api.requestHub().then((h) => setUnits(h.units), () => setUnits([]));
    api.stationingPolicy().then((p) => setPolicy(p.inForce ? { version: p.inForce.version, values: p.inForce.values } : null), () => setPolicy(null));
  }, []);
  // a saved request: read as saved; opening it writes nothing (only «حفظ كمسودة» and «إرسال للاعتماد» do)
  useEffect(() => {
    if (!requestId) return;
    api.restationingRequest(requestId).then((r) => {
      const f = requestIntoFlow(r);
      setLoaded(r);
      setLegacy(f.legacy);
      setKind(f.kind);
      setStart(f.start);
      setEnd(f.end);
      setReason(f.reason);
      setAreas({ primary: f.primary as GeoPolygon | null, alternative: f.alternative as GeoPolygon | null });
      setNewSite(isRS && f.site && isShape(f.site as SiteGeometry) ? (f.site as SiteGeometry) : null);
      setCopied(f.copiedFrom ? { id: f.copiedFrom, area: r.currentSites.find((c) => c.site.id === f.copiedFrom)?.geometry && isShape(r.currentSites.find((c) => c.site.id === f.copiedFrom)!.geometry as SiteGeometry) ? areaOf(r.currentSites.find((c) => c.site.id === f.copiedFrom)!.geometry as SiteGeometry) : 0 } : null);
      setDraft({ id: r.id, number: r.number, sent: false, requester: r.requestingUnit.id });
    }, (e: Error) => setErr(e.message));
  }, [requestId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => editor.current?.destroy(), []);

  const choices = useMemo(() => (isRS ? restationingChoices(units ?? []) : unitChoices(units ?? [])), [units, isRS]);
  // a new request opens at its first step with nothing chosen (owner, 25 Nov 2026): only a unit or site the person opened it for
  // is preselected, and even then «التالي» moves on — the page never chooses the location or moves to the next step by itself
  const started = useRef(false);
  useEffect(() => {
    if (started.current || units === null || loaded === undefined) return;
    started.current = true;
    if (loaded) {
      // a saved request: its units as saved, opened at its first open step, the map on its current site
      const f = requestIntoFlow(loaded);
      if (isRS) setPicked(f.picked);
      else setUnitId(f.picked[0] ?? null);
      setStep(f.step);
      const site = loaded.currentSites[0]?.site.id ?? choices.find((c) => c.unit.id === f.picked[0])?.unit.site?.id ?? null;
      setCampId(site);
      if (site) setFocusReq({ siteId: site, key: 1 });
      else setFitAll(true);
      return;
    }
    // opened from a site (the Sites page): that site is the choice; its one eligible unit is chosen with it, nothing saved
    const atSite = preselectSite ? choices.filter((c) => c.eligible && c.unit.site?.id === preselectSite) : [];
    const pre = preselectUnit ? choices.find((c) => c.unit.id === preselectUnit && c.eligible) : atSite.length === 1 ? atSite[0] : undefined;
    const s = pre ? { step: 1, unitId: pre.unit.id } : startStep(choices);
    if (isRS) setPicked(s.unitId ? [s.unitId] : []);
    else setUnitId(s.unitId);
    setStep(1);
    const site = choices.find((c) => c.unit.id === s.unitId)?.unit.site?.id ?? preselectSite ?? null;
    setCampId(site);
    // the camps stay folded at first (owner); only the site the request was opened from is unfolded
    if (site && preselectSite) setOpenCamps((c) => new Set(c).add(site));
    if (site) setFocusReq({ siteId: site, key: 1 });
    else setFitAll(true);
  }, [units, choices, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const siteRefs = useMemo(() => registered.sites.filter((x) => x.view !== 'CONTEXT').map((x) => ({ siteId: x.siteId, name: x.name, code: x.code, parentId: x.parentId ?? null })), [registered.sites]);
  const tree = useMemo(() => campTree(choices, siteRefs), [choices, siteRefs]);
  const byId = (id: string | null) => choices.find((c) => c.unit.id === id)?.unit ?? null;
  // the units of the request: the one unit, or the units that move with the unit asking for them
  const scopeIds = isRS ? picked : unitId ? [unitId] : [];
  const scopeUnits = scopeIds.map(byId).filter((u): u is HubUnit => !!u);
  const sameAsSaved = !!loaded && scopeIds.length === loaded.content.scope.length && scopeIds.every((id) => loaded.content.scope.includes(id));
  // a saved request keeps its requesting unit while its units are as saved (the server checks again on every save)
  const requester = isRS ? requestingUnitOf(picked, units ?? []) ?? (sameAsSaved && loaded ? ({ id: loaded.requestingUnit.id, name: loaded.requestingUnit.name } as HubUnit) : null) : byId(unitId) ?? (sameAsSaved && loaded ? ({ id: loaded.requestingUnit.id, name: loaded.requestingUnit.name } as HubUnit) : null);
  const savedName = (id: string) => loaded?.units.find((u) => u.id === id)?.name ?? id;
  const scopeNames = scopeIds.map((id) => byId(id)?.name ?? savedName(id));
  // «the current site shows by itself» (brief §5): the first unit's site is where distances start; every one is drawn
  const unit = scopeUnits[0] ?? null;
  const siteGeom = geometryOf(unit);
  const currentArea = siteGeom && isShape(unit?.site?.geometry) ? areaOf(siteGeom) : null;
  const stage = stages[step - 1];
  const role: AreaRole | null = stage === 'primary' || stage === 'alternative' ? stage : null;
  const target: Target | null = stage === 'site' ? 'site' : role;
  roleRef.current = role;
  targetRef.current = target;
  const legOf = (r: AreaRole) => (policy ? policy.values[r] : null);
  const maxSite = policy?.values.maxFootprintAreaM2 ?? null;
  const originOf = (t: Target): LatLng | null =>
    t === 'site' || (t === 'primary' && !isRS) ? (siteGeom ? centreOf(siteGeom) : null)
      : t === 'primary' ? (newSite ? centreOf(newSite) : null)
        : areas.primary ? centreOf(areas.primary as unknown as SiteGeometry) : null;
  const areaDefault: AreaDefault | null = resolveAreaDefault(policy?.values.deploymentAreaDefault ?? null).value;
  const measure = (r: AreaRole) => {
    const g = areas[r];
    const o = originOf(r);
    if (!g || !o) return null;
    const d = distanceM(o, centreOf(g as unknown as SiteGeometry));
    // beyond the base maximum but within what the ground under it adds (the server's assessment): within the policy
    const leg = legOf(r);
    const ground = assessedOf(r);
    // a main area past its maximum (the ground's under it once assessed, else the most any ground allows) is kept, with
    // the warning; the final approver decides it with the request (owner, 28 Nov 2026)
    const limit = r === 'primary' && leg && policy ? (ground?.maxM ?? reachFor(r, leg, policy.values).maxM) : null;
    if (limit != null && d > limit + 1) {
      return { distance: d, area: areaOf(g), verdict: BEYOND_MAX, over: `أبعد بـ${kmChip(d - limit)} من الحد الأقصى (${kmChip(limit)}): تُرسل مع تنبيه، ويقررها المعتمد النهائي مع الطلب.` };
    }
    const byGround = !!leg && !!ground && d > leg.maxM && d <= ground.maxM;
    return { distance: d, area: areaOf(g), verdict: byGround ? { text: '✓ ضمن المسموح بطبيعة الأرض', tone: 'ok' as const } : verdictOf(d, leg), over: byGround ? '' : overReason(d, leg) };
  };
  const siteMeasure = newSite ? { distance: siteGeom ? distanceM(centreOf(siteGeom), centreOf(newSite)) : null, area: areaOf(newSite) } : null;
  const siteOver = !!siteMeasure && maxSite != null && siteMeasure.area > maxSite + 0.5;
  // the farthest the area of this step may be (owner, 25 Nov 2026): while it moves, the base maximum with the most any ground
  // can add (and the exception margin when the policy gives one); once it is placed, the ground under it decides. Only the
  // sub-area is stopped there; the main area may go farther, with the warning (owner, 28 Nov 2026)
  const liveReach = role && policy ? reachFor(role, policy.values[role], policy.values) : null;
  const stopsAtReach = !!role && STOPS_AT_REACH[role];
  const openingRef = useRef(false);
  const openedShape = useRef<GeoPolygon | null>(null);
  const assessedRole = useRef<AreaRole | null>(null);
  const autoMoves = useRef(0);
  // what the ground under each placed area allows (the shape it was assessed for: a later change makes it stale)
  const [assessed, setAssessed] = useState<Partial<Record<AreaRole, { shape: GeoPolygon; maxM: number; text: string; label: string; moved: boolean }>>>({});
  const assessedOf = (r: AreaRole) => (assessed[r] && assessed[r].shape === areas[r] ? assessed[r] : null);

  // ---- the map: the current site, the shape being placed in the editor, the others as the request map draws them --------
  const onMap = (m: MlMap) => {
    mapRef.current = m;
    m.on('click', (e) => clickRef.current(e));
    const tip = document.createElement('div');
    tip.className = 'da-hover';
    tip.hidden = true;
    tip.dataset.testid = 'pointer-distance';
    m.getContainer().appendChild(tip);
    tipRef.current = tip;
    m.on('mousemove', (e) => moveRef.current(e));
    // the arrow from where the shape is measured to the pointer, in the verdict's colour (owner, 17 Nov 2026)
    m.addSource('da-pointer', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(m, {
      id: 'da-pointer', type: 'line', source: 'da-pointer', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['match', ['get', 'tone'], 'ok', '#2f9e6e', 'warn', '#c98a1b', 'bad', '#c0392b', '#334155'], 'line-width': ['match', ['get', 'part'], 'shaft', 2.4, 3], 'line-dasharray': ['match', ['get', 'part'], 'shaft', ['literal', [2.4, 1.6]], ['literal', [1, 0]]] },
    }, 'top');
    m.getCanvasContainer().addEventListener('mouseleave', () => { tip.hidden = true; clearArrow(); });
    editor.current = new SiteEditor(m, {
      // an oversized new site stays valid: the final approver decides or returns it (ADR-087)
      maxAreaM2: () => null,
      flyOnFinish: false,
      // the slope colours follow the area being drawn
      // Owner, 20 Nov 2026: the slope colour follows the shape being drawn live, whether it is a new site, a primary area
      // or an alternative — the SlopeInside class carries all three shapes.
      onDrawShape: (shape) => targetRef.current && slopeRef.current?.update(targetRef.current, shape ? [[shape]] : null, true),
      onChange: (live: SiteLive, final: boolean) => {
        setDrawing(live.mode === 'draw');
        if (live.mode !== 'draw' && targetRef.current) slopeRef.current?.update(targetRef.current, live.geometry ? partsOf(live.geometry) : null, !final);
        if (!final) return;
        const t = targetRef.current;
        if (t === 'site') {
          setNewSite(live.geometry && isShape(live.geometry) ? (live.geometry as SiteGeometry) : null);
          return;
        }
        if (!t) return;
        const g = live.geometry && live.geometry.type === 'Polygon' ? (live.geometry as unknown as GeoPolygon) : null;
        // the shape as the step opened it (a saved draft): not brought back by the reach until it is changed
        if (openingRef.current) openedShape.current = g;
        setAreas((a) => ({ ...a, [t]: g }));
      },
    });
    setMapReady(true);
  };
  const clearArrow = () => (mapRef.current?.getSource('da-pointer') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
  moveRef.current = (e: MapMouseEvent) => {
    const tip = tipRef.current;
    const m = mapRef.current;
    if (!tip || !m) return;
    const o = target ? originOf(target) : null;
    if (!target || !o || !(placing || drawing)) {
      tip.hidden = true;
      clearArrow();
      return;
    }
    // a sub-area's arrow stops at the farthest it may be (owner, 25 Nov 2026): the base maximum with the most the ground can
    // add; a main area's goes on, past its maximum with the warning (owner, 28 Nov 2026)
    const pointer = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    const r = role ? liveReach : null;
    const head = r && stopsAtReach ? withinM(o, pointer, r.maxM) : pointer;
    const atLimit = head !== pointer;
    const d = distanceM(o, head);
    const beyond = !!r && !stopsAtReach && d > r.maxM + 1;
    // the new site has no range (for information); an area has the policy's
    const v = role ? (beyond ? BEYOND_MAX : verdictOf(d, legOf(role))) : null;
    // the shaft from the origin to the head and the head itself, drawn in screen space so the head keeps its size
    const a = m.project([o.lng, o.lat]);
    const b = atLimit ? m.project([head.lng, head.lat]) : e.point;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const at = (x: number, y: number) => m.unproject([x, y]).toArray();
    const wing = (side: 1 | -1) => at(b.x - 13 * ux + side * 7 * uy, b.y - 13 * uy - side * 7 * ux);
    const tone = v?.tone ?? 'none';
    (m.getSource('da-pointer') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { part: 'shaft', tone }, geometry: { type: 'LineString', coordinates: [[o.lng, o.lat], [head.lng, head.lat]] } },
        { type: 'Feature', properties: { part: 'head', tone }, geometry: { type: 'LineString', coordinates: [wing(1), [head.lng, head.lat], wing(-1)] } },
      ],
    });
    // Owner, 20 Nov 2026: a bare «5.3 كم» with no verdict was too wordy («من الموقع الحالي» repeated what the line already
    // shows). Keep the short form when informational, add the verdict on its own when the area is in/out of policy range.
    // At the limit the words say so: the area is placed there, never beyond.
    tip.textContent = atLimit && r ? reachText(r) + ' · تُوضع هنا' : v ? kmChip(d) + ' · ' + v.text : kmChip(d);
    tip.className = 'da-hover is-' + (atLimit ? 'warn' : v?.tone ?? 'none');
    tip.dataset.limit = atLimit ? 'max' : beyond ? 'beyond' : '';
    tip.style.transform = `translate(${Math.round(b.x + 16)}px, ${Math.round(b.y + 18)}px)`;
    tip.hidden = false;
  };
  useEffect(() => {
    if (!(placing || drawing) && tipRef.current) {
      tipRef.current.hidden = true;
      clearArrow();
    }
  }, [placing, drawing]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * The size a ready shape is placed at: the new site as the current site's, within the policy's maximum; the sub-area as
   * the main area's; the main area as the policy's initial area.
   */
  const sizeFor = (t: Target) =>
    // (a ready shape's area on the ground is within about 0.3 % of the one asked: kept just under the maximum)
    t === 'site' ? Math.min(currentArea ?? 250_000, maxSite != null ? maxSite * 0.99 : Number.POSITIVE_INFINITY)
      : t === 'alternative' && areas.primary ? areaOf(areas.primary) : areaDefault?.areaM2 ?? 90000;
  clickRef.current = (e: MapMouseEvent) => {
    const shape = placeShape;
    if (!shape || !target) return;
    setPlaceShape(null);
    const at = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    if (shape === 'COPY') {
      const from = target === 'site' ? (isShape(unit?.site?.geometry) ? siteGeom : null) : (areas.primary as unknown as SiteGeometry | null);
      if (!from) return;
      editor.current?.load(JSON.parse(JSON.stringify(from)) as SiteGeometry, false);
      editor.current?.moveTo(at);
      if (target === 'site' && unit?.site) setCopied({ id: unit.site.id, area: areaOf(from) });
      setTool('select');
      return;
    }
    if (target === 'site') setCopied(null);
    // a ready sub-area is placed no farther than its reach, on the bearing of the click (the copy is moved by the editor's
    // own); a main area where it is clicked
    const o = role ? originOf(role) : null;
    const ring = readyShape(o && liveReach && stopsAtReach ? withinM(o, at, liveReach.maxM) : at, shape, sizeFor(target));
    editor.current?.load({ type: 'Polygon', coordinates: [[...ring, ring[0]].map((q) => [q.lng, q.lat])] } as unknown as SiteGeometry, false);
    setTool('select');
  };
  // the edited shape follows the step: its look (the new site's, the sub-area dashed), where it is measured from; the view stays
  useEffect(() => {
    const ed = editor.current;
    const m = mapRef.current;
    if (!ed || !m || !mapReady) return;
    ed.cancelDrawing();
    setPlacing(false);
    setTool('select');
    setInfo(null);
    if (!target) {
      ed.load(null, false);
      ed.setOrigin(null);
      ed.setDistanceLabel(null);
      return;
    }
    ed.setLook(target === 'site' ? SITE_LOOK : AREA_LOOK[target]);
    ed.setMode('move');
    openingRef.current = true;
    openedShape.current = null;
    ed.load(target === 'site' ? newSite : (areas[target] as unknown as SiteGeometry) ?? null, false);
    openingRef.current = false;
    const o = originOf(target);
    ed.setOrigin(o ? { at: o, label: null } : null);
    const leg = target === 'site' ? null : legOf(target);
    ed.setDistanceLabel((d: number) => {
      // Owner, 20 Nov 2026: the chip on the measured line shows the number only. The line's two endpoints already show
      // where the measurement is from and to; the verdict (in/out of range) is appended when a policy leg applies.
      const v = leg ? verdictOf(d, leg) : null;
      return { text: v ? kmChip(d) + ' · ' + v.text : kmChip(d), tone: v?.tone ?? 'none' };
    });
  }, [target, mapReady, unitId, picked.join(','), policy?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // the editor stops the sub-area at its reach: a move, a placement or a drawn corner goes no farther (owner, 25 Nov 2026);
  // the main area is not stopped (owner, 28 Nov 2026)
  const reachFrom = role ? originOf(role) : null;
  useEffect(() => {
    editor.current?.setReach(reachFrom && liveReach && stopsAtReach ? { at: reachFrom, maxM: liveReach.maxM } : null);
  }, [mapReady, role, reachFrom?.lat, reachFrom?.lng, liveReach?.maxM, stopsAtReach]); // eslint-disable-line react-hooks/exhaustive-deps
  // once the area is placed or changed, the ground under it decides its own maximum (the server's terrain assessment, read
  // only): an area beyond that is brought back along its bearing to it. A saved area as opened is left as it is.
  const roleShape = role ? areas[role] : null;
  useEffect(() => {
    // the run of a step change sees the shape before the editor opened it: the opened one follows, and is left as it is
    if (assessedRole.current !== role) {
      assessedRole.current = role;
      return;
    }
    if (!role || !policy || !roleShape) return;
    const leg = policy.values[role];
    const o = originOf(role);
    if (!o || roleShape === openedShape.current) return;
    const ours = autoMoves.current > 0;
    let live = true;
    const settle = (effectiveMaxM: number | null, label: string) => {
      if (!live) return;
      const r = reachFor(role, leg, policy.values, effectiveMaxM);
      const c = centreOf(roleShape as unknown as SiteGeometry);
      // a sub-area beyond the limit (with the same margin the editor keeps from it): brought back to it, at most a few
      // times in a row; a main area stays where it is put, with the warning (owner, 28 Nov 2026)
      if (STOPS_AT_REACH[role] && distanceM(o, c) > r.maxM - Math.max(10, r.maxM * 0.005) + 1 && autoMoves.current < 4) {
        autoMoves.current += 1;
        editor.current?.moveTo(withinM(o, c, r.maxM));
        return;
      }
      autoMoves.current = 0;
      setAssessed((a) => ({ ...a, [role]: { shape: roleShape, maxM: r.maxM, text: reachText(r), label, moved: ours } }));
    };
    if (!leg.terrainApplies) settle(null, '');
    // without a terrain answer the most any ground allows stays the limit; the server checks again on every save
    else api.terrainAssess(roleShape as unknown as SiteGeometry, policy.version).then((t) => settle(t[role].effectiveMaxM, t.controllingLabel), () => undefined);
    return () => {
      live = false;
    };
  }, [role, roleShape, policy?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // the slope inside each area (green, caution, high; display only, the policy's limits), with the map's «الانحدار» switch
  const sampler = useMemo(() => (terrain3d ? new DemSampler(terrain3d.url) : null), [terrain3d]);
  const [slopeOn, setSlopeOn] = useState(true);
  const slopeLimits = policy?.values.slopeDisplay ?? INITIAL_SLOPE_LIMITS;
  const [slopeInside, setSlopeInside] = useState<SlopeInside | null>(null);
  slopeRef.current = slopeInside;
  // Owner, 20 Nov 2026: the slope colouring is live for EVERY area being drawn — site (restationing), primary and
  // alternative — not only once primary is reached. The class carries all three shapes, so the previous one stays visible.
  const areasOn = target !== null || !!newSite || !!areas.primary || !!areas.alternative;
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !mapReady || !sampler || !slopeOn || !areasOn) return;
    const x = new SlopeInside(m, sampler, slopeLimits);
    setSlopeInside(x);
    return () => {
      x.destroy();
      setSlopeInside(null);
    };
  }, [mapReady, sampler, JSON.stringify(slopeLimits), slopeOn, areasOn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Owner, 20 Nov 2026: the «active» shape (whose stats the legend speaks about) tracks the step — site, primary or alternative.
    if (target) slopeInside?.setActive(target);
  }, [slopeInside, target]);
  useEffect(() => {
    // Every area's slope is maintained in parallel; a shape's class keeps the previous one visible while another is being drawn.
    slopeInside?.update('site', newSite ? partsOf(newSite as unknown as SiteGeometry) : null, false);
    slopeInside?.update('primary', areas.primary ? partsOf(areas.primary as unknown as SiteGeometry) : null, false);
    slopeInside?.update('alternative', areas.alternative ? partsOf(areas.alternative as unknown as SiteGeometry) : null, false);
  }, [slopeInside, areas, newSite]);

  const legChecks = useMemo(() => (policy ? ({
    legs: (['primary', 'alternative'] as const).map((leg) => ({ leg, effectiveMinM: policy.values[leg].minM, baseMaxM: policy.values[leg].maxM, effectiveMaxM: policy.values[leg].maxM, exceptionMaxM: null })),
  } as unknown as RestationingChecks) : null), [policy]);
  useEffect(() => {
    const ed = editor.current;
    if (!ed || !mapReady) return;
    ed.setMode(tool === 'vertices' ? 'vertices' : 'move');
    ed.setShapeHandles(!!target && tool === 'select');
    // a closed drawing comes back here too: the editor leaves its vertices on, the tool decides
  }, [tool, target, mapReady, drawing]);
  // a finished drawing is selected, with its frame, as a placed shape
  const wasDrawing = useRef(false);
  useEffect(() => {
    if (wasDrawing.current && !drawing) setTool('select');
    wasDrawing.current = drawing;
  }, [drawing]);

  // the request as the map draws it: the current sites, the new site (unless it is being edited), the other areas
  const currentSites = isRS ? scopeUnits.filter((u, i, l) => u.site && l.findIndex((x) => x.site?.id === u.site?.id) === i) : unit ? [unit] : [];
  // the current sites as the map draws them: from the hub, or, for a saved request whose units are beyond the hub, as saved
  const currentSiteDraws = currentSites.length > 0 || !loaded
    ? currentSites.flatMap((u) => (u.site && geometryOf(u) ? [{ unit: u.name, site: { id: u.site.id, name: u.site.name }, geometry: geometryOf(u)! }] : []))
    : loaded.currentSites.flatMap((c) => (c.geometry ? [{ unit: c.unit, site: c.site, geometry: c.geometry }] : []));
  const currentSiteNames = currentSites.length > 0 || !loaded ? currentSites.map((u) => u.site?.name) : loaded.currentSites.map((c) => c.site.name);
  const preview = useMemo<RestationingRequest>(() => ({
    id: loaded?.id ?? 'new', number: loaded?.number ?? 'جديد', state: loaded?.state ?? 'DRAFT', purpose, requestingUnit: requester ? { id: requester.id, name: requester.name } : { id: '', name: '' }, requester: { id: '', name: '' }, units: [],
    currentSites: currentSiteDraws,
    policyVersion: policy?.version ?? null, routeNo: 0, route: [], previousRoutes: [], revisions: [], returned: null, paused: null, finalApprover: null,
    can: { edit: true, submit: true, decide: false, activate: false },
    // the shape being edited is drawn by the editor; the others by the request map (the main area's leg starts at content.site)
    content: {
      kind, scope: [],
      site: isRS ? (newSite && target !== 'site' ? { geometry: newSite, copiedFrom: null, shape: 'DRAWN' } : null) : siteGeom ? { geometry: siteGeom, copiedFrom: null, shape: 'DRAWN' } : null,
      primary: role === 'primary' ? null : areas.primary, alternative: role === 'alternative' ? null : areas.alternative, reason: '', exceptions: {}, occupants: {},
    },
    targetSite: null,
  }) as unknown as RestationingRequest, [scopeIds.join(','), requester?.id, siteGeom, newSite, areas, target, policy?.version, kind, loaded?.id, currentSiteDraws.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * A unit chosen. «طلب مناطق انتشار»: it and its camp are the choice (its areas start again when the unit changes).
   * «طلب إعادة تمركز»: it joins or leaves the units that move. «التالي» moves on, never the click.
   */
  const selectUnit = (id: string) => {
    const c = choices.find((x) => x.unit.id === id);
    if (!c?.eligible) return;
    setErr('');
    setCampId(c.unit.site?.id ?? null);
    if (isRS) {
      setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
      return;
    }
    if (id !== unitId) setAreas({ primary: null, alternative: null });
    setUnitId(id);
  };
  const isPicked = (id: string) => (isRS ? picked.includes(id) : id === unitId);
  const findCamp = (id: string, l: CampNode<HubUnit>[] = tree.camps): CampNode<HubUnit> | null => {
    for (const n of l) {
      if (n.site.siteId === id) return n;
      const k = findCamp(id, n.children);
      if (k) return k;
    }
    return null;
  };
  /**
   * A camp chosen in the list or on the map: it is the choice, highlighted in both; its one unit is chosen with it, with
   * several it opens to choose. Chosen from the list, the map flies to it; chosen on the map, the view stays.
   */
  const pickCamp = (id: string, fromMap = false) => {
    const n = findCamp(id);
    if (!n) return;
    setCampId(id);
    setErr('');
    setOpenCamps((c) => new Set(c).add(id));
    const ok = n.units.filter((c) => c.eligible);
    if (isRS) {
      if (ok.length === 1 && picked.length === 0) setPicked([ok[0].unit.id]);
    } else if (ok.length === 1) selectUnit(ok[0].unit.id);
    else if (!ok.some((c) => c.unit.id === unitId)) {
      setUnitId(null);
      setAreas({ primary: null, alternative: null });
    }
    if (!fromMap) setFocusReq({ siteId: id, key: Date.now() });
    else requestAnimationFrame(() => document.querySelector(`[data-camp="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
  };
  /** A camp clicked on the map: the choice everywhere; after step 1 the request goes back to the first step to show it. */
  const chooseOnMap = (id: string) => {
    if (step > 1 && id === campId) return;
    editor.current?.cancelDrawing();
    setPlacing(false);
    pickCamp(id, true);
    if (step > 1) setStep(1);
  };
  const pickShape = (k: PlaceShape) => {
    editor.current?.cancelDrawing();
    setPlaceShape(placeShape === k ? null : k);
  };
  const toggleCamp = (id: string) => setOpenCamps((c) => { const x = new Set(c); if (!x.delete(id)) x.add(id); return x; });
  const toggleUnit = (id: string) => setOpenUnits((c) => { const x = new Set(c); if (!x.delete(id)) x.add(id); return x; });

  // what is saved: the content as saved (so occupants, exceptions and a site registration are carried unchanged) under
  // what this screen controls; a permanent move carries no dates
  const contentOf = () => ({
    ...(loaded?.content ?? {}),
    kind,
    start: kind === 'TEMPORARY' ? start : null,
    end: kind === 'TEMPORARY' ? end : null,
    scope: scopeIds,
    // the new site as saved when it was not touched (its copiedFrom and shape stay as recorded), else as placed here
    site: isRS && newSite
      ? (loaded?.content.site && JSON.stringify(loaded.content.site.geometry) === JSON.stringify(newSite) ? loaded.content.site
        : { geometry: newSite, copiedFrom: copied?.id ?? null, shape: siteShapeKind(copied?.area ?? null, areaOf(newSite)) })
      : loaded?.content.site && !isRS ? loaded.content.site : null,
    primary: areas.primary, alternative: areas.alternative, reason: reason.trim(),
    exceptions: loaded?.content.exceptions ?? {}, occupants: loaded?.content.occupants ?? {},
  });
  /** «حفظ كمسودة» and «إرسال للاعتماد»: the draft is made once and its content kept current; sending submits it (the server checks again). */
  const save = async (send: boolean) => {
    if (!requester) return;
    if (send && reason.trim().length < 5) return setSendErr('اكتب سبب الطلب (5 أحرف على الأقل).');
    if (draft && draft.requester !== requester.id) return setSendErr('تغيّرت الوحدة الطالبة بعد حفظ المسودة: افتح المسودة من «الطلبات» أو ابدأ طلباً جديداً.');
    setSendErr('');
    setBusy(true);
    try {
      const content = contentOf() as unknown as Parameters<typeof api.createRestationing>[1];
      const r = draft ? await api.editRestationing(draft.id, content) : await api.createRestationing(requester.id, content, purpose);
      const sent = send ? await api.submitRestationing(r.id) : r;
      setDraft({ id: r.id, number: sent.number ?? r.number, sent: send, requester: requester.id });
      setSavedHere(true);
    } catch (e) {
      setSendErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const problemFor = (to: number) => flowStepProblem(purpose, { units: scopeIds.length, requester: !!requester, site: newSite, primary: areas.primary, alternative: areas.alternative, kind, start, end }, to);
  const goStep = (to: number) => {
    const p = problemFor(to);
    if (p && to > step) return setErr(p);
    setErr('');
    editor.current?.cancelDrawing();
    setStep(to);
  };

  // ---- the panel -------------------------------------------------------------------------------------------------------
  const contextLine = (unit || (loaded && scopeIds.length > 0)) && (
    <div className="da-from" data-testid="request-from">
      <Icon name="tent" />
      {isRS ? (
        <div><b>{currentSiteNames.join('، ')}</b><small>{scopeIds.length === 1 ? scopeNames[0] : scopeIds.length + ' وحدات'} — الموقع الحالي، يظهر تلقائياً.</small></div>
      ) : (
        <div><b>{unit?.site?.name ?? currentSiteNames[0]}</b><small>{unit?.name ?? scopeNames[0]} — يبدأ الطلب من هذا الموقع، ولا يتغير.</small></div>
      )}
      {step > 1 && (isRS || choices.filter((c) => c.eligible).length > 1) && <button type="button" className="sw-link" onClick={() => goStep(1)}>تغيير</button>}
    </div>
  );

  /** A unit and the units under it (folded at first): a chosen one is in the request, the others say why not. */
  const unitRow = (n: UnitNode<HubUnit>, selectable: boolean): React.ReactNode => {
    const c = n.choice;
    const id = c.unit.id;
    const kids = n.children.length > 0;
    const open = openUnits.has(id);
    const on = isPicked(id);
    return (
      <li key={id}>
        <div className="da-camprow">
          {kids ? (
            <button type="button" className={'rs-twisty' + (open ? ' open' : '')} aria-expanded={open} aria-label={(open ? 'طي' : 'فتح') + ' «' + c.unit.name + '»'} onClick={() => toggleUnit(id)}>{open ? '▾' : '◂'}</button>
          ) : <span className="rs-twisty-gap" aria-hidden="true" />}
          {selectable ? (
            <button type="button" className={'da-unit' + (on ? ' on' : '') + (isRS ? ' is-multi' : '')} aria-pressed={on} disabled={!c.eligible} data-unit={c.unit.name} onClick={() => selectUnit(id)}>
              <b>{isRS ? <span className="da-check" aria-hidden="true">{on ? '☑' : '☐'}</span> : on ? '✓ ' : ''}{c.unit.name}</b>
              <small className={c.eligible ? '' : 'da-why'}>{c.note}</small>
            </button>
          ) : <span className="da-unit is-plain">{c.unit.name}</span>}
        </div>
        {open && kids && <ul className="da-campkids">{n.children.map((k) => unitRow(k, selectable))}</ul>}
      </li>
    );
  };
  const campRow = (n: CampNode<HubUnit>, depth: number): React.ReactNode => {
    const id = n.site.siteId;
    const open = openCamps.has(id);
    const has = n.units.length + n.children.length > 0;
    const chosen = campId === id;
    return (
      <li key={id} className={'da-camp' + (chosen ? ' on' : '')} data-camp={id}>
        <div className="da-camprow">
          {has ? (
            <button type="button" className={'rs-twisty' + (open ? ' open' : '')} aria-expanded={open} aria-label={(open ? 'طي' : 'فتح') + ' «' + n.site.name + '»'} onClick={() => toggleCamp(id)}>{open ? '▾' : '◂'}</button>
          ) : <span className="rs-twisty-gap" aria-hidden="true" />}
          <button type="button" className="da-campname" aria-pressed={chosen} data-camp-pick={n.site.code ?? id} onClick={() => pickCamp(id)}>
            <Icon name="tent" />
            <span><b>{n.site.name}</b>{n.site.code && <small className="tz-code"> {n.site.code}</small>}
              <small>{depth > 0 ? 'موقع داخلي · ' : ''}{n.units.length === 0 ? 'لا وحدات لك فيه' : n.units.length === 1 ? 'وحدة واحدة' : n.units.length + ' وحدات'}</small></span>
            {chosen && <span className="da-chosen">المختار</span>}
          </button>
        </div>
        {chosen && n.units.length > 0 && !n.units.some((c) => c.eligible) && <p className="sw-hint da-campnote">{isRS ? 'لا وحدة لك تُنقل من هذا الموقع الآن.' : 'لا وحدة لك تُطلب لها مناطق انتشار في هذا الموقع.'}</p>}
        {open && has && (
          <ul className="da-campkids">
            {unitForest(n.units).map((u) => unitRow(u, true))}
            {n.children.map((k) => campRow(k, depth + 1))}
          </ul>
        )}
      </li>
    );
  };
  const step1 = (
    <div className="sw-body" data-testid="areas-step-1">
      {units === null ? <p className="sw-hint">جارٍ التحميل…</p> : tree.camps.length === 0 && tree.unstationed.length === 0 ? (
        <p className="sw-hint">لا وحدات لك تقدم طلباتها.</p>
      ) : (
        <>
          <p className="sw-hint">{isRS
            ? 'اختر الوحدة أو الوحدات التي تنتقل، من القائمة أو من الخريطة: يظهر موقعها الحالي تلقائياً.'
            : 'اختر الموقع من القائمة أو من الخريطة، ثم الوحدة المتمركزة فيه: يبدأ الطلب من هذا الموقع.'}</p>
          {tree.camps.length === 0 && <p className="sw-hint">لا وحدة لك متمركزة في موقع بعد.</p>}
          <ul className="da-camps" data-testid="area-camps">{tree.camps.map((n) => campRow(n, 0))}</ul>
          {tree.unstationed.length > 0 && (
            <details className="da-unstationed" data-testid="area-unstationed">
              <summary>وحدات بلا تمركز معتمد ({tree.unstationed.length})</summary>
              <p className="micro tz-muted">{isRS ? 'يُسجَّل تمركزها المبدئي مع موقعها في «تحديد مواقع التمركز المبدئية»؛ لا تُنقل قبل ذلك.' : 'يُسجَّل تمركزها المبدئي مع موقعها في «تحديد مواقع التمركز المبدئية»، ثم تُطلب مناطق انتشارها هنا.'}</p>
              <ul className="da-camps">{unitForest(tree.unstationed).map((u) => unitRow(u, false))}</ul>
            </details>
          )}
          {isRS && picked.length > 0 && (
            <p className={requester ? 'sw-done' : 'sw-err'} data-testid="restation-scope">
              {requester ? <>✓ {picked.length === 1 ? 'وحدة واحدة تنتقل' : picked.length + ' وحدات تنتقل'} · تقدّم الطلب «{requester.name}».</> : 'الوحدات المختارة ليست في فرع واحد: اختر وحدات تضمها وحدة واحدة.'}
            </p>
          )}
          {isRS && (
            <div className="da-kind" data-testid="kind-choice" role="radiogroup" aria-label="نوع إعادة التمركز">
              <button type="button" role="radio" aria-checked={kind === 'PERMANENT'} className={'da-kind-card' + (kind === 'PERMANENT' ? ' on' : '')} data-testid="kind-permanent" onClick={() => { setKind('PERMANENT'); setErr(''); }}>
                <b>دائم</b><small>تنتقل الوحدات إلى الموقع الجديد بعد الاعتماد والتفعيل.</small>
              </button>
              <button type="button" role="radio" aria-checked={kind === 'TEMPORARY'} className={'da-kind-card' + (kind === 'TEMPORARY' ? ' on' : '')} data-testid="kind-temporary" onClick={() => { setKind('TEMPORARY'); setErr(''); }}>
                <b>مؤقت</b><small>لفترة بتاريخ بداية ونهاية، ثم تعود الوحدات إلى موقعها الدائم.</small>
              </button>
              {kind === 'TEMPORARY' && (
                <div className="da-dates" data-testid="temporary-dates">
                  <label><span>من</span><input type="date" aria-label="بداية التمركز المؤقت" value={isoDay(start)} onChange={(e) => setStart(dayStart(e.target.value))} /></label>
                  <label><span>إلى</span><input type="date" aria-label="نهاية التمركز المؤقت" value={isoDay(end)} onChange={(e) => setEnd(dayStart(e.target.value))} /></label>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  const dims = target && (target === 'site' ? newSite : areas[target]) ? editor.current?.shapeSize ?? null : null;
  const dimsChip = (t: Target) => t === target && dims && <span className="da-chip" data-testid={`dims-${t}`}>{Math.round(dims.width).toLocaleString('ar-AE')} م × {Math.round(dims.length).toLocaleString('ar-AE')} م</span>;
  const chips = (r: AreaRole) => {
    const x = measure(r);
    if (!x) return null;
    const leg = legOf(r);
    const av = areaVerdict(x.area, leg);
    return (
      <>
        <div className="da-chips" data-testid={`chips-${r}`}>
          <span className="da-chip">{kmChip(x.distance)}</span>
          <span className="da-chip">{areaChip(x.area)}</span>
          {dimsChip(r)}
          {x.verdict && <span className={'da-chip is-' + x.verdict.tone}>{x.verdict.text}</span>}
          {av && <span className={'da-chip is-' + av.tone} data-testid={`area-verdict-${r}`}>{av.text}</span>}
          {assessedOf(r)?.moved && <span className="da-chip is-warn" data-testid={`reach-moved-${r}`}>أُعيدت إلى أقصى مسافة</span>}
          <button type="button" className={'da-chip da-info' + (info === r ? ' on' : '')} aria-expanded={info === r} aria-label="التفاصيل" data-testid={`info-${r}`} onClick={() => setInfo(info === r ? null : r)}>ⓘ</button>
        </div>
        {info === r && (
          <dl className="da-details" data-testid={`details-${r}`}>
            <div><dt>المسافة</dt><dd>{kmChip(x.distance)} {measuredFrom(purpose, r)}، من مركز إلى مركز</dd></div>
            <div><dt>المساحة</dt><dd>{areaChip(x.area)}</dd></div>
            <div><dt>التضاريس</dt><dd>{leg?.terrainApplies ? 'تُحسب فئة الانحدار وسماحها عند فحص الخادم.' : 'لا تؤثر في هذه المسافة في السياسة النافذة.'}</dd></div>
            <div><dt>الحد الأدنى</dt><dd>{leg ? kmChip(leg.minM) : '—'}</dd></div>
            <div><dt>الحد الأقصى</dt><dd>{leg && policy ? (assessedOf(r)?.text ?? reachText(reachFor(r, leg, policy.values))) : '—'}</dd></div>
            <div><dt>سبب التجاوز</dt><dd>{x.over || '—'}</dd></div>
            {(leg?.minAreaM2 != null || leg?.maxAreaM2 != null) && <div><dt>حدود المساحة</dt><dd>{leg?.minAreaM2 != null ? areaChip(leg.minAreaM2) : '—'} – {leg?.maxAreaM2 != null ? areaChip(leg.maxAreaM2) : '—'}</dd></div>}
            <div><dt>نسخة السياسة</dt><dd>{policy ? policy.version : 'لا سياسة نافذة'}</dd></div>
          </dl>
        )}
      </>
    );
  };

  /** «أدوات الرسم والتحكم (مثل Word)» (owner brief §7, reference panel 5), for the new site and each area. */
  const toolbar = (t: Target) => {
    const has = t === 'site' ? !!newSite : !!areas[t];
    const copyOf = t === 'site' ? (isShape(unit?.site?.geometry) ? { id: 'copy-current', label: 'نسخة الحالي', title: 'نسخة من الموقع الحالي: شكله وحجمه، بنقرة' } : null)
      : t === 'alternative' && areas.primary ? { id: 'copy-alternative', label: 'نسخة الرئيسية', title: 'نسخة من منطقة الانتشار الرئيسية: شكلها وحجمها، بنقرة' } : null;
    return (
      <div className="da-toolbar" role="toolbar" aria-label="أدوات الرسم والتحكم" data-testid={`tools-${t}`}>
        <div className="da-tgroup">
          <button type="button" className={'da-tool' + (tool === 'select' && !placing && !drawing ? ' on' : '')} data-tool="select" disabled={!has || drawing} title="تحديد: الإطار ومقابضه — الزوايا تكبّر وتصغّر، الجوانب تغيّر العرض أو الطول، ↻ يدوّر" onClick={() => setTool('select')}><ToolGlyph k="select" /><span>تحديد</span></button>
          <button type="button" className={'da-tool' + (tool === 'move' && !placing && !drawing ? ' on' : '')} data-tool="move" disabled={!has || drawing} title="تحريك: اسحب الشكل كاملاً" onClick={() => setTool('move')}><ToolGlyph k="move" /><span>تحريك</span></button>
        </div>
        <div className="da-tgroup">
          {copyOf && (
            <button type="button" className={'da-tool' + (placeShape === 'COPY' ? ' on' : '')} data-testid={copyOf.id} data-tool="copy" disabled={drawing} title={copyOf.title} onClick={() => pickShape('COPY')}><ToolGlyph k="COPY" /><span>{copyOf.label}</span></button>
          )}
          {([['CIRCLE', 'دائرة', `circle-${t}`], ['ELLIPSE', 'بيضاوي', `ellipse-${t}`], ['SQUARE', 'مربع', `place-${t}`], ['RECTANGLE', 'مستطيل', `rect-${t}`]] as const).map(([k, label, id]) => (
            <button key={k} type="button" className={'da-tool' + (placeShape === k ? ' on' : '')} data-testid={id} data-tool={k} disabled={drawing} title={`${label} بمساحة ${areaChip(sizeFor(t))}، بنقرة على الخريطة`} onClick={() => pickShape(k)}><ToolGlyph k={k} /><span>{label}</span></button>
          ))}
          <button type="button" className={'da-tool' + (drawing ? ' on' : '')} data-testid={`draw-${t}`} data-tool="draw" title="رسم حر: انقر عند كل زاوية، وانقر مرتين للإنهاء"
            onClick={() => { setPlacing(false); if (drawing) editor.current?.cancelDrawing(); else { if (t === 'site') setCopied(null); editor.current?.startDrawing(null, 0); } }}><ToolGlyph k="draw" /><span>رسم حر</span></button>
        </div>
        <div className="da-tgroup">
          <button type="button" className={'da-tool' + (tool === 'vertices' ? ' on' : '')} data-tool="vertices" disabled={!has || drawing} title="تعديل الرؤوس واحداً واحداً" onClick={() => setTool(tool === 'vertices' ? 'select' : 'vertices')}><ToolGlyph k="vertices" /><span>الرؤوس</span></button>
          <button type="button" className="da-tool" data-tool="undo" disabled={!has || drawing} onClick={() => editor.current?.undo()}><ToolGlyph k="undo" /><span>تراجع</span></button>
          <button type="button" className="da-tool" data-tool="redo" disabled={!has || drawing} onClick={() => editor.current?.redo()}><ToolGlyph k="redo" /><span>إعادة</span></button>
          <button type="button" className="da-tool" data-tool="reset" disabled={!has || drawing} title="إعادة الضبط: الشكل كما وُضع" onClick={() => editor.current?.reset()}><ToolGlyph k="reset" /><span>إعادة الضبط</span></button>
          <button type="button" className="da-tool is-del" data-testid={`remove-${t}`} data-tool="delete" disabled={!has || drawing}
            onClick={() => { editor.current?.load(null, false); if (t === 'site') { setNewSite(null); setCopied(null); } else setAreas((a) => ({ ...a, [t]: null })); setInfo(null); }}><ToolGlyph k="delete" /><span>حذف</span></button>
        </div>
      </div>
    );
  };
  const placingHint = (t: Target, has: boolean, name: string) =>
    placing ? <p className="sw-hint">انقر على الخريطة في مكان {t === 'site' ? 'الموقع الجديد' : 'المنطقة'}.</p>
      : drawing ? (
        <div className="sw-drawing">
          <p className="sw-hint">انقر عند كل زاوية. للإغلاق: انقر على أول نقطة، أو انقر مرتين.</p>
          <button type="button" className="button primary" data-testid="finish-draw" onClick={() => editor.current?.finishDrawing()}>إنهاء الرسم</button>
        </div>
      ) : has ? <p className="sw-done" data-testid={`done-${t}`}>✓ {t === 'site' ? 'وُضع' : 'وُضعت'} {name}. {tool === 'select' ? 'اسحب المقابض: الزوايا للتكبير والتصغير، الجوانب للعرض أو الطول، ↻ للتدوير.' : tool === 'move' ? 'اسحبه كاملاً لنقله.' : 'اسحب الرؤوس المرقمة.'}</p>
        : <p className="sw-hint">لم {t === 'site' ? 'يوضع' : 'توضع'} بعد.</p>;

  // «موقع التمركز الجديد» (phase 4): a ready shape the size of the current site, a copy of it, or a drawing; an area beyond
  // the policy's maximum may be sent, flagged for the final approver, or fitted to the maximum here (ADR-087)
  const siteStep = (
    <div className="sw-body" data-testid="restation-step-site">
      <p className="da-look da-look-site"><span aria-hidden="true" /> {SITE_NAME} — {maxSite != null ? `حتى ${areaChip(maxSite)}` : 'بلا حد للمساحة'}</p>
      {toolbar('site')}
      {placingHint('site', !!newSite, SITE_NAME)}
      {siteMeasure && (
        <div className="da-chips" data-testid="chips-site">
          {siteMeasure.distance != null && <span className="da-chip">{kmChip(siteMeasure.distance)} من الموقع الحالي</span>}
          <span className="da-chip">{areaChip(siteMeasure.area)}</span>
          {dimsChip('site')}
          <span className={'da-chip is-' + (siteOver ? 'warn' : 'ok')} data-testid="site-verdict">{siteOver ? '! أكبر من الحد الأقصى' : '✓ ضمن الحد الأقصى'}</span>
        </div>
      )}
      {siteOver && maxSite != null && (
        <div className="stw-fit" data-testid="site-over">
          <small>المساحة تتجاوز الحد الأقصى ({areaChip(maxSite)}). يمكنك المتابعة والإرسال: يُعرض التجاوز على المعتمد النهائي، فيقبله أو يعيد الطلب لتعديل المساحة. أو صغّر الشكل كله بالنسبة نفسها حول مركزه حتى الحد الأقصى («تراجع» يعيده).</small>
          <button type="button" className="button" data-testid="fit-site" onClick={() => editor.current?.scaleToArea(maxSite)}>ضبط المساحة على المسموح</button>
        </div>
      )}
    </div>
  );

  const areaStep = (r: AreaRole) => {
    const leg = legOf(r);
    return (
      <div className="sw-body" data-testid={`areas-step-${r === 'primary' ? 2 : 3}`}>
        <p className={'da-look da-look-' + r}><span aria-hidden="true" /> {AREA_NAME[r]} — {measuredFrom(purpose, r)}{leg ? ` · ${rangeText(leg)}` : ''}</p>
        {toolbar(r)}
        {placingHint(r, !!areas[r], AREA_NAME[r])}
        {leg && policy && (
          <p className="micro tz-muted" data-testid={`reach-${r}`}>
            {assessedOf(r)
              ? `${assessedOf(r)!.moved ? 'أُعيدت المنطقة إلى أقصى مسافة تسمح بها الأرض تحتها — ' : ''}على هذه الأرض${assessedOf(r)!.label ? ` («${assessedOf(r)!.label}»)` : ''}: ${assessedOf(r)!.text}.`
              : STOPS_AT_REACH[r]
                ? `تتوقف المنطقة عند ${reachText(reachFor(r, leg, policy.values))}، ولا تُوضع أبعد منه.`
                : `${reachText(reachFor(r, leg, policy.values))}؛ يمكن وضعها أبعد منه، فتُرسل مع تنبيه ويقررها المعتمد النهائي.`}
          </p>
        )}
        {chips(r)}
      </div>
    );
  };

  const line = (r: AreaRole) => {
    const x = measure(r);
    return x ? `${kmChip(x.distance)} ${measuredFrom(purpose, r)} · ${areaChip(x.area)}${x.verdict ? ' · ' + x.verdict.text : ''}` : '—';
  };
  const review = (
    <div className="sw-body" data-testid="areas-step-4">
      <dl className="sw-sum" data-testid="areas-summary">
        {isRS ? (
          <>
            <div><dt>الوحدات المنتقلة</dt><dd>{scopeNames.join('، ') || '—'}</dd></div>
            <div><dt>تقدّم الطلب</dt><dd>{requester?.name ?? '—'}</dd></div>
            <div><dt>النوع</dt><dd data-testid="review-kind">{kind === 'TEMPORARY' ? `مؤقت${start ? ' · من ' + isoDay(start) : ''}${end ? ' إلى ' + isoDay(end) : ''}` : 'دائم'}</dd></div>
            <div><dt>الموقع الحالي</dt><dd>{currentSiteNames.join('، ') || '—'}</dd></div>
            <div><dt>{SITE_NAME}</dt><dd data-testid="review-site">{siteMeasure ? `${siteMeasure.distance != null ? kmChip(siteMeasure.distance) + ' من الموقع الحالي · ' : ''}${areaChip(siteMeasure.area)}${siteOver ? ' · ! أكبر من الحد الأقصى: يقرر المعتمد النهائي' : ''}` : '—'}</dd></div>
          </>
        ) : (
          <>
            <div><dt>الوحدة</dt><dd>{unit?.name ?? '—'}</dd></div>
            <div><dt>الموقع الحالي</dt><dd>{unit?.site?.name ?? '—'} — لا يتغير</dd></div>
          </>
        )}
        <div><dt>{AREA_NAME.primary}</dt><dd>{line('primary')}</dd></div>
        <div><dt>{AREA_NAME.alternative}</dt><dd>{line('alternative')}</dd></div>
        <div><dt>عند التفعيل</dt><dd>{PURPOSE_WRITES[purpose]}</dd></div>
        <div><dt>نسخة السياسة</dt><dd>{policy ? policy.version : '—'}</dd></div>
      </dl>
      <p className="sw-hint">{isRS
        ? 'يفحص الخادم الموقع الجديد والمسافتين مع طبيعة الأرض والأرض المشغولة قبل الإرسال، ثم يمر الطلب بمسار الاعتماد المعتاد حتى التفعيل.'
        : 'يفحص الخادم المسافتين مع طبيعة الأرض والأرض المشغولة قبل الإرسال، ثم يمر الطلب بمسار الاعتماد المعتاد حتى التفعيل.'}</p>
      {loaded?.returned && (
        <div className="sw-returned" data-testid="returned-note">
          <b>أُعيد الطلب للتعديل</b> — {loaded.returned.byName} ({loaded.returned.stageLabel}): {loaded.returned.reason}
          {loaded.parts && <ReturnedParts parts={loaded.parts} />}
        </div>
      )}
      {legacy.length > 0 && (
        <p className="sw-hint da-legacy" role="note" data-testid="legacy-note">
          يحمل هذا الطلب، من محرره السابق، ما لا يُعدَّل هنا: {legacy.join('، ')}. يُحفظ كما هو مع الطلب ولا يُحذف؛ يراه المعتمدون في تفاصيل الطلب.
        </p>
      )}
      <label className="sw-f"><span className="sw-l">سبب الطلب</span>
        <textarea className="sw-input" rows={2} aria-label="سبب الطلب" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {draft?.sent ? (
        <div className="sw-done" role="status" data-testid="areas-sent">
          ✓ أُرسل الطلب <bdi>{draft.number}</bdi> للاعتماد. {isRS ? 'يمر بمسار الاعتماد المعتاد، وتنتقل الوحدات عند التفعيل.' : 'يمر بمسار الاعتماد المعتاد، ولا يتغير موقع الوحدة.'}
          <div className="sc-actions" style={{ marginTop: 8 }}>
            <a className="button primary" href={'#restationing/' + draft.id}>فتح الطلب</a>
            <button type="button" className="button" onClick={onClose}>إغلاق</button>
          </div>
        </div>
      ) : (
        <>
          <button type="button" className="sw-go" data-testid="send-areas" disabled={busy || drawing} onClick={() => void save(true)}>{busy ? 'جارٍ الإرسال…' : 'إرسال للاعتماد'}</button>
          <button type="button" className="button da-draft" data-testid="save-draft" disabled={busy || drawing} onClick={() => void save(false)}>حفظ كمسودة</button>
          {draft && !draft.sent && savedHere && <p className="sw-hint" role="status" data-testid="draft-saved">✓ حُفظت المسودة <bdi>{draft.number}</bdi>. تُرسل من هنا أو من «الطلبات».</p>}
        </>
      )}
      {sendErr && <p className="sw-err" role="alert" data-testid="send-error">{sendErr}</p>}
    </div>
  );

  const nextProblem = step < last ? problemFor(step + 1) : '';
  const title = (isRS ? 'طلب إعادة تمركز' : 'طلب مناطق انتشار') + (loaded ? ' ' + loaded.number : '');
  const panel = (
    <section className="sw-wizard da-wizard" data-testid={isRS ? 'restation-request' : 'areas-request'} data-step={step} data-stage={stage}>
      <div className="sw-top">
        <button type="button" className="sw-back" onClick={onClose}>→ رجوع</button>
        <h3 className="sw-title">{title}</h3>
      </div>
      {contextLine}
      {/* five steps in a narrow column: the numbers, and the current step's name in full (each name in its title) */}
      <ol className={'sw-steps' + (last > 4 ? ' many' : '')} aria-label={`الخطوة ${step} من ${last}`}>
        {steps.map((t, i) => (
          <li key={t} className={'sw-step' + (i + 1 === step ? ' on' : i + 1 < step ? ' done' : '')} aria-current={i + 1 === step ? 'step' : undefined} title={t}>
            <button type="button" onClick={() => goStep(i + 1)}><b>{i + 1 < step ? '✓' : i + 1}</b><span>{t}</span></button>
          </li>
        ))}
      </ol>
      {err && <p className="sw-err" role="alert">{err}</p>}
      {stage === 'pick' ? step1 : stage === 'site' ? siteStep : role ? areaStep(role) : review}
      <div className="sw-nav">
        {step < last && <button type="button" className="sw-go" data-testid="areas-next" disabled={drawing || !!nextProblem} onClick={() => goStep(step + 1)}>التالي ←</button>}
        {step < last && nextProblem && <p className="sw-hint" data-testid="next-why">{nextProblem}</p>}
        <div className="sw-nav2">
          {step > 1 ? <button type="button" className="sw-link" onClick={() => goStep(step - 1)}>→ السابق</button> : <span />}
          <button type="button" className="sw-link sw-cancel" onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </section>
  );

  // the left: what this request is, in one card, and how its shapes look on the map
  const context = (
    <section className="tz-card da-context" data-testid="areas-context">
      <h4>ما يطلبه هذا الطلب</h4>
      <p className="micro">{isRS
        ? 'نقل الوحدة أو الوحدات إلى موقع تمركز جديد، مع منطقتي الانتشار الجديدتين. الموقع الحالي يظهر تلقائياً، ولا يتغير شيء قبل التفعيل.'
        : 'منطقتا انتشار لوحدة متمركزة، من موقعها الحالي. لا يتغير موقع التمركز؛ لنقل الوحدة «طلب إعادة تمركز».'}</p>
      <ul className="da-legend">
        <li><span className="da-swatch is-current" style={{ borderColor: MAP_COLOURS.CURRENT }} /> الموقع الحالي</li>
        {isRS && <li><span className="da-swatch is-site" style={{ borderColor: MAP_COLOURS.SITE, background: MAP_COLOURS.SITE + '30' }} /> {SITE_NAME}</li>}
        <li><span className="da-swatch is-primary" style={{ borderColor: MAP_COLOURS.PRIMARY, background: MAP_COLOURS.PRIMARY + '38' }} /> {AREA_NAME.primary} — حد متصل</li>
        <li><span className="da-swatch is-alternative" style={{ borderColor: MAP_COLOURS.ALTERNATIVE, background: MAP_COLOURS.ALTERNATIVE + '1f' }} /> {AREA_NAME.alternative} — حد متقطع</li>
      </ul>
      {policy === null && <p className="sw-err">لا سياسة تمركز نافذة: لا تُقاس المسافات.</p>}
      {policy && <p className="micro tz-muted">السياسة النافذة، النسخة {policy.version}: {isRS && maxSite != null ? `مساحة الموقع حتى ${areaChip(maxSite)}، ` : ''}الرئيسية {rangeText(policy.values.primary)}، الفرعية {rangeText(policy.values.alternative)}.</p>}
    </section>
  );

  const mapTitle = target === 'site' ? SITE_NAME : role ? AREA_NAME[role] : stage === 'review' ? 'الطلب كما سيُرسل' : title;
  return (
    <OperationalWorkspace
      create
      swapSides
      sheetKey={(isRS ? 'restation:' : 'areas:') + (scopeIds.join(',') || '')}
      rail={panel}
      railLabel="الخطوات"
      contextLabel="السياق"
      context={context}
      centre={
        <MapFrame
          title={<span className="tz-mapstep" data-testid="map-step"><Icon name="layers" /><b>{mapTitle}</b>{unit?.site && <small>{unit.site.name}</small>}</span>}
          mode={mode}
          setMode={setMode}
          view={view}
          setView={setView}
          has3d={!!terrain3d}
          placing={placing || drawing}
        >
          {terrain3d !== undefined && (
            <RequestMap view={view} terrain3d={terrain3d} request={preview} checks={legChecks} mode={mode} fitMaxZoom={12} hideSite={!isRS} fit={false} onMap={onMap}
              referenceInteractive={step === 1 || (!placing && !drawing)} fitSites={fitAll} highlight={campId}
              pick={placing || drawing || (isRS && stage !== 'pick') ? null : { selectedId: campId, onPick: (sid) => { if (sid) chooseOnMap(sid); } }}
              focus={focusReq} />
          )}
          {mapReady && areasOn && <SlopeControl on={slopeOn} setOn={setSlopeOn} limits={slopeLimits} available={!!terrain3d} inside={slopeInside} />}
          {placing && (
            <div className="tz-placing" role="status">
              انقر على الخريطة لوضع «{target === 'site' ? SITE_NAME : role ? AREA_NAME[role] : ''}»
              <button className="tz-tool" onClick={() => setPlacing(false)}>إلغاء</button>
            </div>
          )}
        </MapFrame>
      }
    />
  );
}
