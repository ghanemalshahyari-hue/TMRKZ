import { useEffect, useMemo, useRef, useState } from 'react';
import { NavigationControl, ScaleControl, type MapLayerMouseEvent, type MapLayerTouchEvent, type Map as MlMap, type MapMouseEvent } from 'maplibre-gl';
import { api } from '../api/client';
import type { GeoPolygon, RestationingChecks, RestationingContent, RestationingLeg, RestationingRequest, RestationingUnit, SiteGeometry, StationingPolicyValues } from '../api/types';
import { DemSampler, SITE_LOOK, SiteEditor, addOverlayLayer, frame, installedTerrain3d, showSlope, type EditorLook, type MapView, type SiteLive } from '../components/map/maplibre';
import type { BasemapMode, Terrain3dSource } from '../components/map/maplibre/offlineStyle';
import { Icon } from '../components/ui';
import { ApprovalRouteStrip } from '../components/workspace/ApprovalRouteStrip';
import { DeploymentCheckCard } from '../components/workspace/DeploymentCheckCard';
import { MapFrame, MapLegend } from '../components/workspace/MapFrame';
import { RequestContext, SiteSearch, StepTracker } from '../components/workspace/NewRequestParts';
import { OperationalWorkspace } from '../components/workspace/OperationalWorkspace';
import { MAP_COLOURS, RequestMap } from '../components/workspace/RequestMap';
import { StatePill } from '../components/workspace/StatePill';
import { ROLE_TITLE, SlopeControl, TerrainPanel, cardLines, geometryKey, useAreaInsight, useProfile } from '../components/workspace/TerrainPanel';
import { TerrainCards, type CardRole, type CardSpec, type ChipSpec } from '../components/workspace/terrainCards';
import { useRegisteredSites } from '../components/workspace/useRegisteredSites';
import { useApp } from '../lib/app';
import { formatArea, formatMeters } from '../lib/footprint';
import { parseCoordinates } from '../lib/coords';
import { describeAreaDefault, initialArea, resolveAreaDefault, type AreaDefault } from '../lib/deploymentDefault';
import { legText } from '../lib/requestMap';
import { distanceM, type LatLng } from '../lib/geo';
import { anchorOf, labelPoint, partsOf, validateSite } from '../lib/siteGeometry';
import { VERDICT, connectors, discrepancy, previewLeg, serverLegFor, type Connector, type ConnectorKind } from '../lib/terrainAnalysis';
import { renderSymbol } from '../lib/unitSymbols';
import { canOpen as flowCanOpen, completed, deriveRequesting, firstOpen, unitsAtSite, type FlowInput, type FlowStep } from '../lib/newRequestFlow';
import { occupiedFeatures, occupiedSites, overlapsOccupied } from '../lib/occupied';
import type { RefSite } from '../lib/sitesLayer';
import { DRAW_NEW_BOUNDARY } from '../lib/stationingV3';

type Placing = 'site' | 'primary' | 'alternative' | null;

/** A deployment area is edited on the map with the site's own editor (owner, 5 Nov 2026), in its own colour and tag. */
const AREA_LOOK: Record<'primary' | 'alternative', EditorLook> = {
  primary: { tag: 'الانتشار الرئيسي', stroke: '#d9822b', fill: '#e8963a', symbol: false },
  alternative: { tag: 'الانتشار البديل', stroke: '#7b4fc0', fill: '#7b4fc0', symbol: false },
};
/** The re-stationing move is information only: no minimum, no maximum, no verdict. */
const MOVE_LABEL = (d: number) => ({ text: 'المسافة: ' + formatMeters(d) + ' — للعلم فقط', tone: 'none' as const });
const isoDay = (s?: string | null) => (s ? s.slice(0, 10) : '');
const kmText = (m: number) => (m / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 2 }) + ' كم';
const midpoint = (c: Connector) => ({ lat: (c.from.lat + c.to.lat) / 2, lng: (c.from.lng + c.to.lng) / 2 });
/** The geometry a card stands for, and the connector that measures it (the leg ending at it). */
const ROLE_OF_TARGET = { site: 'SITE', primary: 'PRIMARY', alternative: 'ALTERNATIVE' } as const;
const LEG_OF_ROLE: Record<CardRole, ConnectorKind> = { CURRENT: 'move', SITE: 'move', PRIMARY: 'primary', ALTERNATIVE: 'alternative' };
const ROLE_OF_LEG: Record<ConnectorKind, CardRole> = { move: 'SITE', primary: 'PRIMARY', alternative: 'ALTERNATIVE' };
const ROLE_OF_LEG_KIND = { primary: 'PRIMARY', alternative: 'ALTERNATIVE' } as const;
/** The connectors a moving shape changes: the one ending at it and the one leaving it. */
const TOUCHES: Record<CardRole, ConnectorKind[]> = { CURRENT: ['move'], SITE: ['move', 'primary'], PRIMARY: ['primary', 'alternative'], ALTERNATIVE: ['alternative'] };
const dayStart = (d: string) => (d ? new Date(d + 'T00:00:00+04:00').toISOString() : null);
/** The question of each step, in the left panel. */
const QUESTION: Record<FlowStep, string> = {
  1: 'اختر الموقع الحالي من الخريطة',
  2: 'حدد الوحدات التي ستنتقل',
  3: 'نوع إعادة التمركز',
  4: 'حدد موقع إعادة التمركز الجديد على الخريطة',
  5: 'منطقة الانتشار',
  6: 'الفحص والمراجعة',
};
/** What the map is showing at each step (the map header; the panel keeps the request's title and the question). */
const MAP_SAYS: Record<FlowStep, string> = {
  1: 'اضغط على أحد المواقع لعرض الوحدات المتمركزة فيه',
  2: 'الموقع الحالي محدد على الخريطة',
  3: 'الموقع الحالي محدد على الخريطة',
  4: 'الموقع الجديد: اسحبه إلى أي مكان — لا قيد على المسافة من الموقع الحالي',
  5: 'منطقة الانتشار: المسافة من مركز إلى مركز مع النطاق المسموح',
  6: 'الطلب كما سيُرسل',
};

/**
 * A re-stationing request, MAP FIRST (owner correction of 5 Nov 2026): choose the current site on the map (a click
 * shows its card; «بدء طلب إعادة تمركز من هذا الموقع» starts), choose who moves among the units stationed there (none
 * by itself), the type, then the new site on the map (a copy of the current boundary moved anywhere, or a new shape;
 * no distance rule), the deployment areas (their bands only now), and the server's checks before «إرسال للاعتماد».
 * One step's question at a time on the left, the context on the right, the map in the centre throughout. The draft is
 * created on the server only when the person acts at the new-site step; the unit the request comes from is derived
 * from the person's options and shown, not asked.
 */
export function RestationingEditor({ requestId, preselectUnit = null, preselectSite = null, onClose, historyOpen, setHistoryOpen }: {
  requestId: string | null;
  /** #restationing/new?unit=: that unit's current site is located on the map for the person to confirm. */
  preselectUnit?: string | null;
  /** #restationing/new?site=: that site is the current site (from the Sites page). */
  preselectSite?: string | null;
  onClose: (id?: string) => void;
  historyOpen: boolean;
  setHistoryOpen: (o: boolean) => void;
}) {
  const app = useApp();
  const registered = useRegisteredSites();
  const [id, setId] = useState<string | null>(requestId);
  const [loaded, setLoaded] = useState<RestationingRequest | null>(null);
  const [content, setContent] = useState<RestationingContent>({ kind: 'PERMANENT', scope: [], site: null, primary: null, alternative: null, reason: '', exceptions: {}, occupants: {} });
  const [step, setStep] = useState<FlowStep>(preselectSite ? 2 : 1);
  const [currentSite, setCurrentSite] = useState<string | null>(preselectSite);
  const [picked, setPicked] = useState<string | null>(null);
  // the sites that share the last clicked point (a main site and its sub-site), when more than one
  const [stack, setStack] = useState<string[] | null>(null);
  const pickOne = (sid: string | null) => (setPicked(sid), setStack(null), sid && setFocus({ siteId: sid, key: Date.now() }));
  const [focus, setFocus] = useState<{ siteId: string; key: number } | null>(preselectSite ? { siteId: preselectSite, key: 1 } : null);
  const [placing, setPlacing] = useState<Placing>(null);
  const [checks, setChecks] = useState<RestationingChecks | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<BasemapMode>('street');
  // «2D | 3D» (owner brief «TRUE OFFLINE 3D TERRAIN», 6 Nov 2026): presentation only — the request, the edited geometry,
  // its history and the selection never change with it. 3D needs the installed package's elevation tiles.
  const [view, setViewState] = useState<MapView>('2d');
  const viewRef = useRef(view);
  viewRef.current = view;
  const [terrain3d, setTerrain3d] = useState<Terrain3dSource | null | undefined>(undefined);
  useEffect(() => {
    installedTerrain3d().then(setTerrain3d);
  }, []);
  const sampler = useMemo(() => (terrain3d ? new DemSampler(terrain3d.url) : null), [terrain3d]);
  const placingRef = useRef<Placing>(null);
  placingRef.current = placing;
  const clickRef = useRef<(e: MapMouseEvent) => void>(() => undefined);
  // the proposed site is edited on the map by SiteEditor: one grouped move, or (advanced) one vertex of one part
  const editorRef = useRef<SiteEditor | null>(null);
  const liveListeners = useRef(new Set<(l: SiteLive) => void>());
  const [siteOk, setSiteOk] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [drawingNow, setDrawingNow] = useState(false);
  const drawingRef = useRef(false);
  const [occupiedHits, setOccupiedHits] = useState<string[]>([]);
  const stepRef = useRef(step);
  stepRef.current = step;
  const contentRef = useRef(content);
  contentRef.current = content;
  const checksRef = useRef(checks);
  checksRef.current = checks;
  // the deployment step edits one area at a time, with the same editor and the same gestures as the site
  const [deployTarget, setDeployTarget] = useState<'primary' | 'alternative'>('primary');
  const editTarget: 'site' | 'primary' | 'alternative' = step === 5 ? deployTarget : 'site';
  const editTargetRef = useRef(editTarget);
  editTargetRef.current = editTarget;
  const loadedTarget = useRef<string | null>(null);
  // the maximum area in force, shown beside the live area from the start; the server's check on save stays authoritative
  const [policyMaxArea, setPolicyMaxArea] = useState<number | null>(null);
  const [policyAreaDefault, setPolicyAreaDefault] = useState<AreaDefault | null>(null);
  // the version in force and its reference: an acceptance environment's test value says so there
  const [policyVersion, setPolicyVersion] = useState<{ version: number; reference: string | null } | null>(null);
  const [policyValues, setPolicyValues] = useState<StationingPolicyValues | null>(null);
  useEffect(() => {
    api
      .stationingPolicy()
      .then((p) => {
        setPolicyValues(p.inForce?.values ?? null);
        setPolicyMaxArea(p.inForce?.values.maxFootprintAreaM2 ?? null);
        setPolicyAreaDefault((p.inForce?.values as { deploymentAreaDefault?: AreaDefault | null } | undefined)?.deploymentAreaDefault ?? null);
        setPolicyVersion(p.inForce ? { version: p.inForce.version, reference: p.inForce.reference } : null);
      })
      .catch(() => setPolicyMaxArea(null));
  }, []);
  const areaDefault = resolveAreaDefault(policyAreaDefault);
  const areaDefaultRef = useRef(areaDefault);
  areaDefaultRef.current = areaDefault;
  const maxAreaM2 = checks?.maxFootprintAreaM2 ?? policyMaxArea;
  const maxAreaRef = useRef(maxAreaM2);
  maxAreaRef.current = maxAreaM2;
  // the units this person may request for (the server's own list): the requesting unit is derived from them
  const [units, setUnits] = useState<RestationingUnit[]>([]);
  useEffect(() => {
    api.restationingUnits().then(setUnits).catch(() => setUnits([]));
  }, []);

  // an existing draft reopens at its first open step, with its current site and moving units
  useEffect(() => {
    if (!requestId) return;
    api.restationingRequest(requestId).then((r) => {
      setLoaded(r);
      setContent({ ...r.content, exceptions: r.content.exceptions ?? {}, occupants: r.content.occupants ?? {} });
      setCurrentSite(r.currentSites[0]?.site.id ?? null);
      const s = firstOpen({ site: true, units: r.content.scope.length, kind: r.content.kind, start: r.content.start, end: r.content.end, proposed: !!r.content.site, primary: !!r.content.primary, alternative: !!r.content.alternative });
      setStep(Math.max(4, s) as FlowStep);
      // a reopened draft is a new editing session from the saved geometry
      editorRef.current?.load(r.content.site?.geometry ?? null);
    });
    api.restationingChecks(requestId).then(setChecks);
  }, [requestId]);

  // from a unit: its authoritative current site is located and its card opened; the person confirms before starting
  const located = useRef(false);
  useEffect(() => {
    if (requestId || !preselectUnit || located.current || !registered.loaded) return;
    located.current = true;
    const rec = registered.current.find((c) => c.orgId === preselectUnit);
    if (!rec) return app.toast('لا تمركز حالي ظاهر لك لهذه الوحدة؛ اختر الموقع الحالي من الخريطة.');
    setPicked(rec.siteId);
    setFocus({ siteId: rec.siteId, key: Date.now() });
  }, [registered.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<RestationingContent>) => setContent((c) => ({ ...c, ...patch }));
  const here = useMemo(() => unitsAtSite(registered.current, currentSite, units), [registered.current, currentSite, units]);
  const siteOf = (sid: string | null) => (sid ? registered.all.find((s) => s.siteId === sid) ?? null : null);
  const current = siteOf(currentSite);
  const pickedSite = siteOf(picked);
  const requestingId = loaded?.requestingUnit.id ?? deriveRequesting(units, content.scope);
  const requesting = loaded?.requestingUnit ?? (requestingId ? { id: requestingId, name: units.find((u) => u.id === requestingId)?.name ?? '' } : null);
  const flow: FlowInput = { site: !!currentSite, units: content.scope.length, kind: content.kind, start: content.start, end: content.end, proposed: !!content.site, primary: !!content.primary, alternative: !!content.alternative };
  const done = completed(flow);
  const may = (s: FlowStep) => flowCanOpen(flow, s);
  const go = (s: FlowStep) => {
    if (!may(s)) return;
    setPlacing(null);
    setStep(s);
  };

  /** A new site editing session: the copy, a drawn shape, or nothing (redraw chosen). Undo/redo/reset start here. */
  const loadSite = (geometry: SiteGeometry | null, copiedFrom: string | null, shape: 'COPY' | 'DRAWN') => {
    setContent((c) => ({ ...c, site: geometry ? { geometry, copiedFrom, shape } : null }));
    setOccupiedHits([]);
    editorRef.current?.setMode('move');
    editorRef.current?.load(geometry);
  };

  /** A committed change on the map (drop of a drag, undo, redo, reset): the content follows; a moved copy stays COPY. */
  const onSite = (live: SiteLive, final: boolean) => {
    liveListeners.current.forEach((l) => l(live));
    const nowDrawing = live.mode === 'draw';
    if (drawingRef.current !== nowDrawing) {
      drawingRef.current = nowDrawing;
      setDrawingNow(nowDrawing);
    }
    if (!final) return;
    // a deployment area: the content follows its drop, undo, redo or reset; the server checks its distance on save
    const target = editTargetRef.current;
    if (target !== 'site') {
      const g = live.geometry && live.geometry.type === 'Polygon' ? (live.geometry as GeoPolygon) : null;
      setContent((c) => ({ ...c, [target]: g }));
      return;
    }
    setSiteOk(live.geometry == null || live.ok);
    // occupied ground, checked on a drop and never per frame; the server's occupancy check still decides
    const hits = overlapsOccupied(live.geometry, occupiedRef.current).map((o) => o.name);
    setOccupiedHits(hits);
    editorRef.current?.setConflict(hits.length > 0);
    setContent((c) => {
      if (!live.geometry) return c.site ? { ...c, site: null } : c;
      const shape = c.site?.shape === 'COPY' && live.vertexEdited ? 'EDITED' : (c.site?.shape ?? 'DRAWN');
      return { ...c, site: { geometry: live.geometry, copiedFrom: c.site?.copiedFrom ?? null, shape } };
    });
  };

  const onMap = (m: MlMap) => {
    mapInst.current = m;
    // a metric scale bar, as on the accepted Stationing map
    m.addControl(new ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-right');
    m.on('click', (e) => clickRef.current(e));
    // the maximum footprint is the site's rule; a deployment area has none
    editorRef.current = new SiteEditor(m, { onChange: (l, f) => onSiteRef.current(l, f), maxAreaM2: () => (editTargetRef.current === 'site' ? maxAreaRef.current : null) });
    editorRef.current.load(contentRef.current.site?.geometry ?? null);
    loadedTarget.current = 'site';
    // the current site stays visible as reference above the copy that starts exactly on it
    if (!m.getLayer('rs-current-top'))
      addOverlayLayer(m, { id: 'rs-current-top', type: 'line', source: 'rs', filter: ['==', ['get', 'role'], 'CURRENT'], paint: { 'line-color': MAP_COLOURS.CURRENT, 'line-width': 2.2, 'line-dasharray': [2, 1.6] } }, 'top');
    // the other deployment area, drawn on the map: a press on it makes it the one edited (then dragged like the site)
    const pickArea = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
      if (stepRef.current !== 5 || placingRef.current) return;
      const role = e.features?.[0]?.properties?.role;
      const k = role === 'PRIMARY' ? 'primary' : role === 'ALTERNATIVE' ? 'alternative' : null;
      if (k && k !== editTargetRef.current) setDeployTarget(k);
    };
    m.on('mousedown', 'rs-hatch', pickArea);
    m.on('touchstart', 'rs-hatch', pickArea);
    m.on('mousedown', 'rs-area-fill', pickArea);
    m.on('touchstart', 'rs-area-fill', pickArea);
    // the 3D view's cards and connector chips on the ground: a click selects what the terrain panel shows
    cardsRef.current = new TerrainCards(m, (r) => selectRef.current(r, null), (k) => selectRef.current(ROLE_OF_LEG[k], k));
    setMapReady(true);
  };
  const onSiteRef = useRef(onSite);
  onSiteRef.current = onSite;
  useEffect(() => () => editorRef.current?.destroy(), []);
  const mapInst = useRef<MlMap | null>(null);
  const cardsRef = useRef<TerrainCards | null>(null);
  useEffect(() => () => cardsRef.current?.destroy(), []);
  // the accepted Stationing editor's marks (owner, 5 Nov 2026): the organisation's symbol on the proposal and on the
  // current site (a neutral pin without one); while the new site is placed the move is measured from the current site
  const symbolOrg = content.scope[0] ?? null;
  useEffect(() => {
    if (!mapReady) return;
    let alive = true;
    if (!symbolOrg) {
      editorRef.current?.setSymbol(null);
      return;
    }
    api
      .unitSymbols([symbolOrg])
      .then(async (lookup) => {
        const s = lookup.symbols[symbolOrg];
        const r = s ? await renderSymbol(s.sidc, s.standard, 30) : null;
        if (alive) editorRef.current?.setSymbol(r?.valid ? '<img class="stw-sym-img" src="' + r.url + '" alt="" />' : null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbolOrg, mapReady]);
  useEffect(() => {
    const ed = editorRef.current;
    const m = mapInst.current;
    if (!ed || !m) return;
    const placingSite = step === 4;
    // measured from the same centre as the panel's distance (the current site's shared anchor, or its marker); a
    // deployment area centre to centre: the primary from the new site, the alternative from the primary (O-04)
    const at = origin;
    const legFrom = step === 5 ? (deployTarget === 'primary' ? content.site?.geometry ?? null : ((content.primary as SiteGeometry | null) ?? null)) : null;
    ed.setOrigin(placingSite && current && at ? { at, label: current.name + ' · الموقع الحالي' } : legFrom ? { at: anchorOf(partsOf(legFrom)), label: null } : null);
    // a deployment leg's chip follows the same rule as the terrain panel (set below, with the leg's analysis)
    if (step !== 5) ed.setDistanceLabel(placingSite ? MOVE_LABEL : null);
    // the current site's name is then on its own tag (with the symbol), not as a map label
    if (m.getLayer('rs-label')) m.setFilter('rs-label', placingSite ? ['all', ['has', 'label'], ['!=', ['get', 'role'], 'CURRENT']] : ['has', 'label']);
    const refLabel: ['in', ['get', string], ['literal', string[]]] = ['in', ['get', 'role'], ['literal', ['REF_LABEL', 'REF_MARKER']]];
    if (m.getLayer('ref-label')) m.setFilter('ref-label', placingSite && current ? ['all', refLabel, ['!=', ['get', 'siteId'], current.siteId]] : refLabel);
  }, [step, current?.siteId, current?.geometry, mapReady, deployTarget, content.site, content.primary, checks]); // eslint-disable-line react-hooks/exhaustive-deps
  // the edited shape follows the step: the site (steps 4 and 6), or the chosen deployment area (step 5)
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !mapReady || loadedTarget.current === editTarget) return;
    loadedTarget.current = editTarget;
    ed.cancelDrawing();
    setPlacing(null);
    ed.setConflict(false);
    ed.setLook(editTarget === 'site' ? SITE_LOOK : AREA_LOOK[editTarget]);
    ed.setMode('move');
    const c = contentRef.current;
    const g = editTarget === 'site' ? c.site?.geometry ?? null : ((c[editTarget] as SiteGeometry | null) ?? null);
    ed.load(g, editTarget === 'site');
    // a deployment area: the area in view, or before it exists the distance it may be at around where it is measured
    if (editTarget !== 'site') frameLeg(editTarget, g);
  }, [editTarget, mapReady]); // eslint-disable-line react-hooks/exhaustive-deps
  /**
   * The map around a deployment area's leg: the area itself when it exists, otherwise (and when the area is about to be
   * placed or drawn) everything up to the leg's allowed maximum around its start — no ring is drawn, only the view.
   */
  const frameLeg = (k: 'primary' | 'alternative', area: SiteGeometry | null) => {
    const c = contentRef.current;
    const from = k === 'primary' ? c.site?.geometry ?? null : ((c.primary as SiteGeometry | null) ?? null);
    const l = checksRef.current?.legs?.find((x) => x.leg === k);
    const m = mapInst.current;
    if (!from || !m) return;
    const o = anchorOf(partsOf(area ?? from));
    const r = area ? 900 : (l?.effectiveMaxM ?? 6000) * 1.05;
    const dLat = r / 110_900;
    const dLng = r / (111_320 * Math.cos((o.lat * Math.PI) / 180));
    // in 3D the same view, tilted (owner brief §29: the leg's two ends, never somewhere unrelated)
    const pts = [{ lat: o.lat - dLat, lng: o.lng - dLng }, { lat: o.lat + dLat, lng: o.lng + dLng }];
    if (area && viewRef.current === '3d') pts.push(anchorOf(partsOf(from)));
    frame(m, pts, viewRef.current, { duration: 400, padding: { top: 40, right: 40, bottom: 150, left: 70 }, maxZoom: 22 });
  };
  // the next map click places the shape: crosshair while waiting for it
  useEffect(() => {
    mapInst.current?.getContainer().classList.toggle('stw-picking', !!placing);
  }, [placing]);
  // the server's maximum footprint arrives with the checks: validate the site against it
  useEffect(() => {
    editorRef.current?.refresh();
  }, [checks?.maxFootprintAreaM2]);
  const toggle = (org: string) => set({ scope: content.scope.includes(org) ? content.scope.filter((x) => x !== org) : [...content.scope, org] });

  const chooseSite = (sid: string) => {
    setCurrentSite(sid);
    setPicked(null);
    // nothing moves by itself: none of the units stationed there is chosen
    set({ scope: [] });
    setStep(2);
  };

  /** The draft on the server: created only now, from the person's own actions; the requesting unit is derived. */
  const save = async (): Promise<string | null> => {
    if (!id && !requestingId) {
      app.toast('لا يمكنك طلب إعادة تمركز لهذه الوحدات ضمن صلاحياتك.');
      return null;
    }
    setBusy(true);
    try {
      const r = id ? await api.editRestationing(id, content) : await api.createRestationing(requestingId!, content);
      setId(r.id);
      setLoaded(r);
      setChecks(await api.restationingChecks(r.id));
      return r.id;
    } catch (e) {
      app.toast((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      await api.submitRestationing(saved);
      app.toast('أُرسل الطلب للاعتماد');
      onClose(saved);
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onMapClick = (e: MapMouseEvent) => {
    const p = placingRef.current;
    if (!p) return;
    const { lng, lat } = e.lngLat;
    setPlacing(null);
    if (p === 'site') return editorRef.current?.moveTo({ lat, lng });
    const d = areaDefaultRef.current.value;
    if (p === editTargetRef.current && d) editorRef.current?.load(initialArea({ lat, lng }, d), false);
  };

  clickRef.current = onMapClick;

  // the current site has only a display marker, no registered boundary: there is nothing to copy, the new site is drawn
  const markerOnly = !!current && (!current.geometry || current.geometry.type === 'Point');
  const shapeOf = (g: RefSite['geometry']) => (g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? (g as unknown as SiteGeometry) : null);
  /** The current footprint as the proposed site, on the map at once and selected — client-side: nothing is saved. */
  const copyCurrent = () => {
    const g = shapeOf(current?.geometry ?? null) ?? shapeOf((loaded?.currentSites[0]?.geometry as RefSite['geometry']) ?? null);
    if (!g) return;
    loadSite(g, current?.siteId ?? loaded?.currentSites[0]?.site.id ?? null, 'COPY');
  };

  /** «ب · رسم حدود جديدة»: a new boundary of the chosen number of vertices, clicked on the map (the retired editor's S7). */
  const [target, setTarget] = useState(4);
  const redraw = () => {
    if (content.site) loadSite(null, null, 'DRAWN');
    setPlacing(null);
    editorRef.current?.startDrawing(origin, target);
  };
  /** «أ · نقل الحدود الحالية»: a fresh copy of the current boundary to move (the retired editor's S4). */
  const moveTab = () => {
    editorRef.current?.cancelDrawing();
    copyCurrent();
  };
  const currentShape = shapeOf(current?.geometry ?? null) ?? shapeOf((loaded?.currentSites[0]?.geometry as RefSite['geometry']) ?? null);
  const currentArea = useMemo(() => (currentShape ? validateSite(partsOf(currentShape)).areaM2 : null), [currentShape]);
  const origin: LatLng | null = currentShape ? anchorOf(partsOf(currentShape)) : current?.lat != null && current.lng != null ? { lat: current.lat, lng: current.lng } : null;

  // entering the new-site step: the current footprint appears as the proposed site, ready to drag; a marker-only
  // current site opens drawing instead (MOVE FIRST → EDIT IF NEEDED)
  const autoFor = useRef<string | null>(null);
  useEffect(() => {
    if (step !== 4 || !mapReady || !editorRef.current || content.site || editorRef.current.isDrawing) return;
    const key = currentSite ?? 'none';
    if (autoFor.current === key) return;
    autoFor.current = key;
    if (shapeOf(current?.geometry ?? null)) copyCurrent();
    else if (current?.lat != null && current?.lng != null) editorRef.current.startDrawing({ lat: current.lat, lng: current.lng }, target);
  }, [step, mapReady, currentSite, current?.geometry]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveAndGo = async (s: FlowStep) => {
    if (await save()) go(s);
  };

  const preview: RestationingRequest = {
    ...(loaded ?? {
      id: 'new', number: 'جديد', state: 'DRAFT', requestingUnit: requesting ?? { id: '', name: '' }, requester: { id: '', name: '' }, units: [], currentSites: [],
      policyVersion: null, routeNo: 0, route: [], previousRoutes: [], revisions: [], returned: null, paused: null, finalApprover: null,
      can: { edit: true, submit: true, decide: false, activate: false },
    }),
    // before the first save the current site is known on the page: it is drawn as «الموقع الحالي» under the copy
    currentSites: loaded?.currentSites ?? (current && shapeOf(current.geometry) ? [{ unit: '', site: { id: current.siteId, name: current.name }, geometry: current.geometry }] : []),
    content,
  };
  const occupied = useMemo(() => occupiedSites(registered.current, registered.all, content.scope), [registered.current, registered.all, content.scope]);
  const occupiedRef = useRef(occupied);
  occupiedRef.current = occupied;
  const occupiedFc = useMemo(() => occupiedFeatures(occupied), [occupied]);
  const leg = (k: 'primary' | 'alternative') => checks?.legs?.find((l) => l.leg === k);

  // ---- terrain: the geometries, their analysis, the connectors and the 3D view (owner brief «TRUE OFFLINE 3D TERRAIN»)
  const [pickedRole, setPickedRole] = useState<CardRole | null>(null);
  const [pickedLeg, setPickedLeg] = useState<ConnectorKind | null>(null);
  useEffect(() => {
    setPickedRole(null);
    setPickedLeg(null);
  }, [step, deployTarget]);
  const geo: Record<CardRole, SiteGeometry | null> = {
    CURRENT: step >= 4 ? currentShape : null,
    SITE: step >= 4 ? content.site?.geometry ?? null : null,
    PRIMARY: step >= 4 ? ((content.primary as SiteGeometry | null) ?? null) : null,
    ALTERNATIVE: step >= 4 ? ((content.alternative as SiteGeometry | null) ?? null) : null,
  };
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const roles = (['CURRENT', 'SITE', 'PRIMARY', 'ALTERNATIVE'] as CardRole[]).filter((r) => geo[r]);
  const defaultRole: CardRole | null = step === 5 ? (deployTarget === 'primary' ? 'PRIMARY' : 'ALTERNATIVE') : step >= 4 ? 'SITE' : null;
  const selectedRole = pickedRole && geo[pickedRole] ? pickedRole : defaultRole && geo[defaultRole] ? defaultRole : roles[0] ?? null;
  const pinnedVersion = loaded?.policyVersion ?? null;
  const insights: Record<CardRole, ReturnType<typeof useAreaInsight>> = {
    CURRENT: useAreaInsight(geo.CURRENT, sampler, pinnedVersion),
    SITE: useAreaInsight(geo.SITE, sampler, pinnedVersion),
    PRIMARY: useAreaInsight(geo.PRIMARY, sampler, pinnedVersion),
    ALTERNATIVE: useAreaInsight(geo.ALTERNATIVE, sampler, pinnedVersion),
  };
  const conns = connectors({ current: geo.CURRENT, site: geo.SITE, primary: geo.PRIMARY, alternative: geo.ALTERNATIVE });
  /** A deployment leg's rule: the server's check when it checked exactly this geometry, otherwise the analysis preview. */
  const ruleOf = (k: 'primary' | 'alternative') => {
    const c = conns.find((x) => x.kind === k);
    const preview = previewLeg(k, c?.distanceM ?? null, insights[ROLE_OF_LEG_KIND[k]]?.assess ?? null, policyValues);
    const keyOf = (site: unknown, primary: unknown, alternative: unknown) =>
      geometryKey(site as SiteGeometry) + '|' + geometryKey(primary as SiteGeometry) + (k === 'alternative' ? '|' + geometryKey(alternative as SiteGeometry) : '');
    const server = serverLegFor(k, checks, loaded ? keyOf(loaded.content.site?.geometry, loaded.content.primary, loaded.content.alternative) : null, keyOf(geo.SITE, geo.PRIMARY, geo.ALTERNATIVE));
    return { leg: server ?? preview, source: (server ? 'server' : 'preview') as 'server' | 'preview', discrepancy: discrepancy(preview, server) };
  };
  const rules = { primary: ruleOf('primary'), alternative: ruleOf('alternative') };
  // the edited leg's chip on the map: the server's check of exactly this geometry, otherwise the preview of the
  // server's analysis of the area where it now is — never the range of a check made before the area moved
  const legsKey = JSON.stringify([rules.primary.leg, rules.alternative.leg].map((l) => l && [l.status, l.effectiveMinM, l.effectiveMaxM, l.baseMaxM, l.exceptionMaxM]));
  useEffect(() => {
    if (step !== 5 || !mapReady) return;
    const l = rules[deployTarget].leg;
    editorRef.current?.setDistanceLabel((d: number) => legText(d, l));
  }, [step, deployTarget, legsKey, mapReady, content.site, content.primary, checks]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The legs as the map labels them (the same rule as the panel); the server's checks keep their own card. */
  const mapChecks: RestationingChecks | null =
    step >= 5 ? { ...(checks ?? { ok: true, problems: [], policyVersion: null }), legs: [rules.primary.leg, rules.alternative.leg].filter((l): l is RestationingLeg => !!l) } : null;
  const legKind = pickedLeg && conns.some((c) => c.kind === pickedLeg) ? pickedLeg : selectedRole && conns.some((c) => c.kind === LEG_OF_ROLE[selectedRole]) ? LEG_OF_ROLE[selectedRole] : conns[0]?.kind ?? null;
  const legConn = conns.find((c) => c.kind === legKind) ?? null;
  const profile = useProfile(legConn, sampler);
  const chipOf = (c: Connector): ChipSpec => {
    if (c.kind === 'move') return { kind: 'move', at: midpoint(c), from: c.from, to: c.to, text: kmText(c.distanceM) + ' — للعلم فقط', tone: 'none', title: c.fromLabel + ' ← ' + c.toLabel + ': للعلم فقط، لا قيد' };
    const r = rules[c.kind];
    const pending = insights[ROLE_OF_LEG[c.kind]]?.pending;
    // the leg in focus says its rule on the map: distance · effective range · verdict (the server decides on save)
    const rule = r.leg && legKind === c.kind ? ` · الفعّال ${(r.leg.effectiveMinM / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 2 })}–${kmText(r.leg.effectiveMaxM)} · ${VERDICT[r.leg.status].text}` : '';
    return { kind: c.kind, at: midpoint(c), from: c.from, to: c.to, text: kmText(c.distanceM) + rule, tone: r.leg ? VERDICT[r.leg.status].tone : pending ? 'pending' : 'none', title: c.fromLabel + ' ← ' + c.toLabel + (r.leg ? ' · ' + VERDICT[r.leg.status].text : '') };
  };
  const cardOf = (r: CardRole): CardSpec => {
    const extra: [string, string][] = [];
    const move = conns.find((c) => c.kind === 'move');
    if (r === 'SITE' && move) extra.push(['من الموقع الحالي', kmText(move.distanceM) + ' — للعلم فقط']);
    if (r === 'PRIMARY' || r === 'ALTERNATIVE') {
      const l = rules[r === 'PRIMARY' ? 'primary' : 'alternative'].leg;
      if (l?.distanceM != null) extra.push(['المسافة', kmText(l.distanceM)], ['الحد الفعّال', 'حتى ' + kmText(l.effectiveMaxM)], ['الحكم', VERDICT[l.status].text]);
    }
    const { compact, lines } = cardLines(r, insights[r], extra);
    return { role: r, at: labelPoint(geo[r]!), title: ROLE_TITLE[r], sub: r === 'CURRENT' ? current?.name ?? loaded?.currentSites[0]?.site.name : undefined, compact, lines, selected: r === selectedRole };
  };
  // the cards and chips follow every committed change; the editor's own drag frames move them in place (below)
  useEffect(() => {
    const cards = cardsRef.current;
    if (!cards) return;
    cards.setVisible(view === '3d' && step >= 4);
    cards.setCards(roles.map(cardOf));
    cards.setChips(conns.map(chipOf));
  });
  useEffect(() => {
    const listeners = liveListeners.current;
    const follow = (live: SiteLive) => {
      const cards = cardsRef.current;
      if (!cards || viewRef.current !== '3d' || !live.geometry || live.mode === 'draw') return;
      const role = ROLE_OF_TARGET[editTargetRef.current];
      cards.moveCard(role, labelPoint(live.geometry));
      const g = { ...geoRef.current, [role]: live.geometry };
      for (const c of connectors({ current: g.CURRENT, site: g.SITE, primary: g.PRIMARY, alternative: g.ALTERNATIVE }))
        if (TOUCHES[role].includes(c.kind)) cards.moveChip(c.kind, midpoint(c), kmText(c.distanceM) + (c.kind === 'move' ? ' — للعلم فقط' : ''));
    };
    listeners.add(follow);
    return () => {
      listeners.delete(follow);
    };
  }, []);
  // «الانحدار»: the policy's slope classes over the ground (display only), in 2D and 3D
  const [slopeOn, setSlopeOn] = useState(false);
  const bands = policyValues?.terrainSlopeClassification?.classes ?? null;
  useEffect(() => {
    const m = mapInst.current;
    if (!m || !mapReady || !terrain3d || !bands) return;
    showSlope(m, slopeOn, mode, terrain3d.url, bands);
  }, [slopeOn, mode, mapReady, terrain3d, bands]);
  // the compass (with the tilt) while the view is 3D
  const compass = useRef<NavigationControl | null>(null);
  useEffect(() => {
    const m = mapInst.current;
    if (!m || !mapReady) return;
    if (view === '3d' && !compass.current) {
      compass.current = new NavigationControl({ showZoom: false, visualizePitch: true });
      m.addControl(compass.current, 'top-left');
    } else if (view === '2d' && compass.current) {
      m.removeControl(compass.current);
      compass.current = null;
    }
  }, [view, mapReady]);
  /**
   * Selecting a geometry (its card, chip or the panel) shows its analysis; in 3D the camera also frames it with the
   * geometry its leg starts from (§29: proposed with current, primary with proposed, alternative with primary).
   */
  const select = (r: CardRole, k: ConnectorKind | null) => {
    setPickedRole(r);
    setPickedLeg(k);
    const m = mapInst.current;
    if (!m || viewRef.current !== '3d') return;
    const g = geoRef.current;
    if (k) {
      // a connector: both of its ends
      const ends: Record<ConnectorKind, CardRole[]> = { move: ['CURRENT', 'SITE'], primary: ['SITE', 'PRIMARY'], alternative: ['PRIMARY', 'ALTERNATIVE'] };
      const points = ends[k].flatMap((x) => (g[x] ? partsOf(g[x]!).flatMap((p) => p[0]) : []));
      if (points.length) frame(m, points, '3d', { maxZoom: 15.5 });
      return;
    }
    // a geometry: itself, with enough of the ground around it to read the slopes it lies on (at least about 2 km)
    if (!g[r]) return;
    const pts = partsOf(g[r]!).flatMap((p) => p[0]);
    const c = anchorOf(partsOf(g[r]!));
    const dLat = 1000 / 110_900;
    const dLng = 1000 / (111_320 * Math.cos((c.lat * Math.PI) / 180));
    frame(m, [...pts, { lat: c.lat - dLat, lng: c.lng - dLng }, { lat: c.lat + dLat, lng: c.lng + dLng }], '3d', { maxZoom: 16 });
  };
  const selectRef = useRef(select);
  selectRef.current = select;
  /** «الحدود والمناطق»: every geometry of the request in view (tilted in 3D). */
  const frameAll = () => {
    const m = mapInst.current;
    const points = roles.flatMap((r) => partsOf(geo[r]!).flatMap((p) => p[0]));
    if (m && points.length) frame(m, points, view, { maxZoom: 15.5 });
  };
  /** 2D ↔ 3D: the camera keeps the place; 3D frames what this step is about (§29), 2D lies flat again, north up. */
  const setView = (v: MapView) => {
    if (v === view || (v === '3d' && !terrain3d)) return;
    setViewState(v);
    const m = mapInst.current;
    if (!m) return;
    if (v === '2d') return void m.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    const pts = (rs: CardRole[]) => rs.flatMap((r) => (geo[r] ? partsOf(geo[r]!).flatMap((p) => p[0]) : []));
    const what: CardRole[] = step === 5 ? (deployTarget === 'primary' ? ['SITE', 'PRIMARY'] : ['PRIMARY', 'ALTERNATIVE']) : step === 4 ? ['CURRENT', 'SITE'] : roles;
    const points = pts(what);
    if (points.length) frame(m, points, '3d', { maxZoom: 15.5 });
    else m.easeTo({ pitch: 55, duration: 700 });
  };
  const terrainPanel = step >= 4 && (
    <TerrainPanel
      role={selectedRole}
      roles={roles}
      onRole={(r) => select(r, null)}
      insight={selectedRole ? insights[selectedRole] : null}
      rule={selectedRole === 'PRIMARY' ? rules.primary : selectedRole === 'ALTERNATIVE' ? rules.alternative : null}
      move={selectedRole === 'SITE' ? conns.find((c) => c.kind === 'move')?.distanceM ?? null : null}
      connector={legConn}
      kinds={conns.map((c) => c.kind)}
      onLeg={(k) => select(ROLE_OF_LEG[k], k)}
      profile={profile}
      demAvailable={!!sampler}
    />
  );
  const PLACING: Record<Exclude<Placing, null>, string> = { site: 'موقع إعادة التمركز', primary: 'منطقة الانتشار الرئيسية', alternative: 'منطقة الانتشار البديلة' };
  const KIND = content.kind === 'TEMPORARY' ? 'مؤقت' : 'دائم';

  /** What the earlier steps settled, one line each, with a way back to change it. */
  const summary = (
    <ul className="tz-flow-summary">
      {step > 1 && current && (
        <li>
          الموقع الحالي: <b>{current.name}</b> ✓{' '}
          {!id && (
            <button className="link" onClick={() => (setCurrentSite(null), set({ scope: [] }), setStep(1))}>
              تغيير
            </button>
          )}
        </li>
      )}
      {step > 1 && !current && currentSite && <li>الموقع الحالي: <b>{loaded?.currentSites[0]?.site.name ?? '—'}</b> ✓</li>}
      {step === 2 && <li>الوحدات: {here.length === 1 ? 'وحدة واحدة موجودة' : `${here.length} وحدات موجودة`}</li>}
      {step > 2 && (
        <li>
          الوحدات المنتقلة: <b>{content.scope.length}</b> ✓ <button className="link" onClick={() => go(2)}>تغيير</button>
        </li>
      )}
      {step > 3 && (
        <li>
          النوع: <b>{KIND}</b> ✓ <button className="link" onClick={() => go(3)}>تغيير</button>
        </li>
      )}
      {step > 4 && content.site && (
        <li>
          الموقع الجديد ✓ <button className="link" onClick={() => go(4)}>تغيير</button>
        </li>
      )}
    </ul>
  );

  const panel = (
    <aside className="tz-flow" aria-label="خطوات الطلب">
      <div className="tz-flow-head">
        <h2>{id ? 'تعديل ' + (loaded?.number ?? '') : 'طلب إعادة تمركز جديد'}</h2>
        <StepTracker step={step} done={done} canOpen={may} onOpen={go} />
      </div>
      <div className="tz-flow-body">
        <p className="tz-flow-stepno">الخطوة {step} من 6</p>
        <h3 className="tz-flow-q" data-testid="flow-question">{QUESTION[step]}</h3>
        {summary}

        {step === 1 && (
          <>
            <p className="tz-flow-hint">اضغط على أحد المواقع في الخريطة</p>
            <SiteSearch sites={registered.all} current={registered.current} onPick={pickOne} />
          </>
        )}

        {step === 2 && (
          <fieldset className="tz-flow-units" data-testid="units-to-move">
            <legend>الوحدات المتمركزة في الموقع</legend>
            {here.length === 0 && <small className="tz-muted">لا وحدات متمركزة ظاهرة لك في هذا الموقع.</small>}
            {here.map((u) => (
              <label key={u.orgId} className="rs-check">
                <input type="checkbox" checked={content.scope.includes(u.orgId)} onChange={() => toggle(u.orgId)} /> {u.orgName}
                {!u.requestable && <small className="tz-muted"> — من فرع آخر: لا تنتقل إلا إذا اخترتها ووافق الخادم</small>}
                {u.orgId === preselectUnit && <small className="tz-muted"> — الوحدة التي بدأت منها</small>}
              </label>
            ))}
            <small className="tz-muted">لا ينتقل أحد تلقائياً: لا الشاغلون الآخرون ولا التابعون ولا الوحدات المرتبطة.</small>
            {content.scope.length > 0 && !requestingId && !id && <small className="rs-bad">لا يمكنك طلب إعادة تمركز للوحدات المختارة ضمن صلاحياتك.</small>}
            <button className="button primary" disabled={!may(3)} onClick={() => go(3)}>
              التالي: نوع إعادة التمركز
            </button>
          </fieldset>
        )}

        {step === 3 && (
          <div className="tz-flow-kind">
            {/* two clear choices, one selected; choosing saves nothing (the draft is created at the new-site step) */}
            <div className="tz-kind-cards" role="radiogroup" aria-label="نوع إعادة التمركز" data-testid="kind-choice">
              <button role="radio" aria-checked={content.kind === 'PERMANENT'} className={'tz-kind-card' + (content.kind === 'PERMANENT' ? ' on' : '')}
                onClick={() => set({ kind: 'PERMANENT', start: null, end: null })}>
                <b>دائم</b>
                <small>تنتقل الوحدات إلى الموقع الجديد بعد الاعتماد والتفعيل</small>
              </button>
              <button role="radio" aria-checked={content.kind === 'TEMPORARY'} className={'tz-kind-card' + (content.kind === 'TEMPORARY' ? ' on' : '')}
                onClick={() => set({ kind: 'TEMPORARY' })}>
                <b>مؤقت</b>
                <small>لفترة محددة بتاريخ بداية ونهاية، ثم تعود الوحدات</small>
              </button>
            </div>
            {content.kind === 'TEMPORARY' && (
              <div className="rs-inline">
                <label>من <input type="date" value={isoDay(content.start)} onChange={(e) => set({ start: dayStart(e.target.value) })} /></label>
                <label>إلى <input type="date" value={isoDay(content.end)} onChange={(e) => set({ end: dayStart(e.target.value) })} /></label>
              </div>
            )}
            <button className="button primary" disabled={!may(4)} onClick={() => go(4)}>
              التالي: الموقع الجديد
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="tz-flow-site">
            <PlaceControls
              editor={editorRef}
              listeners={liveListeners}
              setMode={(m) => editorRef.current?.setMode(m)}
              maxAreaM2={maxAreaM2}
              occupiedHits={occupiedHits}
              shape={content.site?.shape ?? null}
              markerOnly={markerOnly}
              canCopy={!!currentShape}
              currentArea={currentArea}
              origin={origin}
              target={target}
              setTarget={(n) => {
                setTarget(n);
                editorRef.current?.setTarget(n);
              }}
              onMoveTab={moveTab}
              onDrawTab={redraw}
              picking={placing === 'site'}
              onPick={() => setPlacing(placing === 'site' ? null : 'site')}
            />
            <div className="rs-tools">
              <button className="button" disabled={busy || !content.site || drawingNow} onClick={save}>حفظ المسودة والفحص</button>
              <button className="button primary" disabled={busy || !content.site || !siteOk || drawingNow} onClick={() => saveAndGo(5)}>
                التالي: منطقة الانتشار
              </button>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="tz-flow-deploy">
            <AreaControls
              editor={editorRef}
              listeners={liveListeners}
              area={deployTarget}
              onArea={setDeployTarget}
              hasPrimary={!!content.primary}
              placing={placing === deployTarget}
              areaDefault={areaDefault}
              policyVersion={policyVersion}
              onPlace={() => {
                editorRef.current?.cancelDrawing();
                const on = placing !== deployTarget;
                setPlacing(on ? deployTarget : null);
                // the whole distance the area may be at, so the place can be clicked
                if (on) frameLeg(deployTarget, null);
              }}
              onDraw={() => {
                setPlacing(null);
                editorRef.current?.load(null, false);
                frameLeg(deployTarget, null);
                editorRef.current?.startDrawing(null, target);
              }}
              target={target}
              setTarget={(n) => {
                setTarget(n);
                editorRef.current?.setTarget(n);
              }}
              origin={deployTarget === 'primary' ? (content.site ? anchorOf(partsOf(content.site.geometry)) : null) : content.primary ? anchorOf(partsOf(content.primary as SiteGeometry)) : null}
              leg={rules[deployTarget].leg}
              checked={leg(deployTarget)}
            >
              {leg(deployTarget)?.status === 'NEEDS_EXCEPTION' && (
                <label>
                  سبب استثناء مسافة الانتشار — {deployTarget === 'primary' ? 'المنطقة الرئيسية' : 'المنطقة البديلة'}
                  <input value={content.exceptions?.[deployTarget] ?? ''} onChange={(e) => set({ exceptions: { ...(content.exceptions ?? {}), [deployTarget]: e.target.value } })} />
                </label>
              )}
            </AreaControls>
            <div className="rs-tools">
              <button className="button" disabled={busy} onClick={save}>حفظ المسودة والفحص</button>
              <button className="button primary" disabled={busy} onClick={() => saveAndGo(6)}>
                التالي: الفحص والمراجعة
              </button>
            </div>
          </div>
        )}

        {step === 6 && (
          <div className="tz-flow-review">
            {checks && <div className={'rs-verdict ' + (checks.ok ? 'ok' : 'no')}>{checks.ok ? 'الفحوص مستوفاة — يمكن الإرسال' : 'فحوص غير مستوفاة — راجع اللوحة'}</div>}
            <label>
              سبب الطلب
              <textarea value={content.reason} onChange={(e) => set({ reason: e.target.value })} />
            </label>
            <div className="rs-tools">
              <button className="button" disabled={busy} onClick={save}>حفظ المسودة والفحص</button>
              <button className="button primary" disabled={busy || !siteOk || (checks != null && !checks.ok)} onClick={submit}>إرسال للاعتماد</button>
            </div>
          </div>
        )}
      </div>
      <div className="tz-flow-foot">
        <button className="button compact" onClick={() => onClose(id ?? undefined)}>
          العودة إلى الطلبات
        </button>
      </div>
    </aside>
  );

  const context = step === 1 ? (
    <RequestContext site={pickedSite ?? null} units={pickedSite ? unitsAtSite(registered.current, pickedSite.siteId, units) : []} moving={[]} requesting={null} fromUnit={preselectUnit} onChoose={() => pickedSite && chooseSite(pickedSite.siteId)}
      stack={stack ? stack.map(siteOf).filter((s): s is NonNullable<typeof s> => !!s) : null} sites={registered.all} onSelect={pickOne} />
  ) : (
    <RequestContext first={terrainPanel} site={current ?? (currentSite && loaded ? { siteId: currentSite, code: '', name: loaded.currentSites[0]?.site.name ?? '', kind: '', geometry: null, lat: null, lng: null, parentId: null, onMap: false } : null)} units={here} moving={content.scope} requesting={requesting} fromUnit={preselectUnit}>
      {step >= 5 && <DeploymentCheckCard request={preview} checks={checks} />}
    </RequestContext>
  );

  return (
    <OperationalWorkspace
      create
      sheetKey={id ?? 'new'}
      rail={panel}
      railLabel="الخطوات"
      contextLabel="السياق"
      context={context}
      centre={
        <MapFrame
          title={
            // the request's title and the question are the panel's; the map header says what the map shows
            <span className="tz-mapstep" data-testid="map-step">
              <Icon name="map" />
              <span className="tz-crumb">الطلبات / {id ? 'تعديل ' + (loaded?.number ?? '') : 'طلب إعادة تمركز جديد'}</span>
              <b>{MAP_SAYS[step]}</b>
              {step >= 2 && step <= 3 && current && <small>{current.name}</small>}
            </span>
          }
          badge={id ? <StatePill state={loaded?.state ?? 'DRAFT'} /> : undefined}
          mode={mode}
          setMode={setMode}
          view={view}
          setView={setView}
          has3d={!!terrain3d}
          onFit={step >= 4 ? frameAll : undefined}
          legend={<MapLegend stage={step <= 3 ? 'sites' : step === 4 ? 'site' : 'full'} fold={view === '3d'} />}
          placing={!!placing}
          strip={id ? <ApprovalRouteStrip request={preview} checks={checks} open={historyOpen} setOpen={setHistoryOpen} /> : undefined}
        >
          {terrain3d !== undefined && <RequestMap
            view={view}
            terrain3d={terrain3d}
            selected={view === '3d' ? selectedRole : null}
            request={step === 4 ? { ...preview, content: { ...preview.content, site: null } } : step === 5 ? { ...preview, content: { ...preview.content, [deployTarget]: null } } : preview}
            // no deployment band before the deployment step, whatever a reopened draft already holds
            checks={mapChecks}
            mode={mode}
            fitMaxZoom={11.5}
            hideSite={step !== 5}
            fit={false}
            onMap={onMap}
            referenceInteractive={step !== 4 && !placing && !drawingNow}
            pick={step === 1 ? { selectedId: picked, onPick: (sid, here) => (setPicked(sid), setStack(here && here.length > 1 ? here : null)) } : step <= 3 ? { selectedId: currentSite, onPick: () => undefined } : null}
            // under the copy the current site is drawn in coral; a marker-only current site stays highlighted
            highlight={step <= 3 || markerOnly ? currentSite : null}
            occupied={step >= 4 ? occupiedFc : null}
            focus={focus}
            fitSites={!requestId && !preselectSite}
          />}
          {step === 4 && mapReady && (
            <div className="stw-zoom" role="group" aria-label="أدوات الخريطة">
              <button title="تكبير" aria-label="تكبير" onClick={() => mapInst.current?.zoomIn()}>+</button>
              <button title="تصغير" aria-label="تصغير" onClick={() => mapInst.current?.zoomOut()}>−</button>
              <button title="الموقع المقترح" aria-label="الموقع المقترح" disabled={!content.site && !drawingNow} onClick={() => editorRef.current?.focus()}>◎</button>
              <button title="مقارنة الموقعين" aria-label="مقارنة الموقعين" disabled={!content.site || !current} onClick={() => editorRef.current?.compare()}>⇆</button>
            </div>
          )}
          {mapReady && step >= 4 && <SlopeControl on={slopeOn} setOn={setSlopeOn} bands={bands} available={!!terrain3d} />}
          {placing && (
            <div className="tz-placing" role="status">
              انقر على الخريطة لوضع «{PLACING[placing]}»
              <button className="tz-tool" onClick={() => setPlacing(null)}>إلغاء</button>
            </div>
          )}
        </MapFrame>
      }
    />
  );
}

/**
 * The proposal panel of the accepted Stationing editor (retired page, approved polygon prototype of 2 Nov 2026), on the
 * V3 step: «أ · نقل الحدود الحالية» / «ب · رسم حدود جديدة» with «عدد الرؤوس», the live distance (information only —
 * re-stationing has no distance rule), the current and proposed areas and their difference, shape validity and occupied
 * ground, the vertex coordinates (optional), and ↶ تراجع · ↷ إعادة · إعادة الضبط · تعديل الرؤوس · ◎ المقترح ·
 * ⇆ مقارنة الموقعين. Updated on every frame of a drag from the editor, without re-rendering the map. Nothing is saved.
 */
function PlaceControls({ editor, listeners, setMode, maxAreaM2, occupiedHits, shape, markerOnly, canCopy, currentArea, origin, target, setTarget, onMoveTab, onDrawTab, picking, onPick }: {
  editor: React.RefObject<SiteEditor | null>;
  listeners: React.RefObject<Set<(l: SiteLive) => void>>;
  setMode: (m: 'move' | 'vertices') => void;
  maxAreaM2: number | null;
  occupiedHits: string[];
  shape: string | null;
  markerOnly: boolean;
  canCopy: boolean;
  currentArea: number | null;
  origin: LatLng | null;
  target: number;
  setTarget: (n: number) => void;
  onMoveTab: () => void;
  onDrawTab: () => void;
  picking: boolean;
  onPick: () => void;
}) {
  const [live, setLive] = useState<SiteLive | null>(null);
  const [vLat, setVLat] = useState('');
  const [vLng, setVLng] = useState('');
  const [vError, setVError] = useState('');
  useEffect(() => {
    const set = listeners.current;
    set.add(setLive);
    editor.current?.refresh();
    return () => {
      set.delete(setLive);
    };
  }, [editor, listeners]);
  const ed = editor.current;
  const open = live?.mode === 'draw';
  const drawing = open || shape === 'DRAWN';
  const d = open ? live?.draw ?? null : null;
  const many = (live?.parts ?? 0) > 1;
  const area = open ? (d && d.count >= 3 ? d.areaM2 : null) : live?.geometry ? live.areaM2 : null;
  const anchor = !open && live?.geometry ? anchorOf(partsOf(live.geometry)) : null;
  const dist = anchor && origin ? distanceM(origin, anchor) : null;
  const ok = open ? !!d && d.count >= 3 && d.ok : !!live?.ok;
  const problems = open ? d?.problems ?? [] : live?.problems ?? [];
  const vertexMode = live?.mode === 'vertices';
  const ring = !open && live?.geometry && live.activePart != null ? partsOf(live.geometry)[live.activePart]?.[0] ?? null : null;
  return (
    <div className="rs-site-controls tz-place stw-proposal-panel" data-testid={open ? 'draw-readout' : undefined} data-count={d?.count}>
      {/* two methods (owner, 5 Nov 2026): edit on the map, or pick the destination and the same shape moves there */}
      <div className="stw-tools two" role="group" aria-label="طريقة تحديد الموقع">
        <button className={'button' + (!picking ? ' on' : '')} aria-pressed={!picking} onClick={() => picking && onPick()}>
          اسحب/عدّل الحدود
        </button>
        <button className={'button' + (picking ? ' on' : '')} aria-pressed={picking} disabled={!live?.geometry || open} title={!live?.geometry ? 'ارسم الحدود أولاً' : undefined} onClick={onPick}>
          تحديد الموقع على الخريطة
        </button>
      </div>
      {picking && <p className="stw-hint" data-testid="pick-hint">انقر على المكان المطلوب: ينتقل الشكل نفسه ويقع مركزه على النقطة — المسافة للعلم فقط.</p>}
      <div className="stw-tabs" role="tablist" aria-label="طريقة الاقتراح">
        <button role="tab" aria-selected={!drawing} className={!drawing ? 'on' : ''} disabled={!canCopy} title={canCopy ? undefined : 'الموقع الحالي علامة فقط بلا حدود مسجلة'} onClick={onMoveTab}>
          أ · نقل الحدود الحالية
        </button>
        <button role="tab" aria-selected={drawing} className={drawing ? 'on' : ''} onClick={onDrawTab}>
          ب · {DRAW_NEW_BOUNDARY}
        </button>
      </div>
      <p className="stw-hint" data-testid={!drawing ? 'drag-instruction' : markerOnly ? 'marker-only' : undefined}>
        {open
          ? markerOnly
            ? 'الموقع الحالي علامة فقط — ارسم حدود الموقع الجديد على الخريطة: انقر لوضع الرؤوس بالترتيب.'
            : 'انقر على الخريطة لوضع الرؤوس بالترتيب، أو أدخل إحداثيات كل رأس أدناه.'
          : drawing
            ? 'اسحب المساحة أو رمزها لنقل الحدود كاملة، أو اسحب رأساً لتعديله.'
            : 'اسحب الموقع إلى موقع إعادة التمركز الجديد: اسحب المساحة الخضراء أو رمزها — يبقى الشكل والمساحة كما هما.'}
      </p>

      {drawing && (
        <div className="stw-row">
          <label className="stw-field inline">
            <span>عدد الرؤوس</span>
            <input type="number" min={3} max={20} value={target} aria-label="عدد الرؤوس" onChange={(e) => setTarget(Math.max(3, Math.min(20, Math.round(Number(e.target.value) || 3))))} />
          </label>
          <span className="stw-hint">
            {open ? d?.count ?? 0 : (ring?.length ?? target)} / {open ? live?.target ?? target : ring?.length ?? target} {!open ? '· مكتمل' : ''}
          </span>
        </div>
      )}
      {open && (
        <details className="stw-coords-box">
          <summary>إدخال الإحداثيات (اختياري)</summary>
          <div className="stw-coords">
            <label>
              <span>خط العرض</span>
              <input inputMode="decimal" value={vLat} onChange={(e) => setVLat(e.target.value)} aria-label="خط عرض الرأس" />
            </label>
            <label>
              <span>خط الطول</span>
              <input inputMode="decimal" value={vLng} onChange={(e) => setVLng(e.target.value)} aria-label="خط طول الرأس" />
            </label>
            <button
              className="button"
              onClick={() => {
                const r = parseCoordinates(vLat, vLng);
                if (!r.point) return setVError(r.error || 'أدخل خط العرض وخط الطول.');
                setVError('');
                ed?.addVertex(r.point);
                setVLat('');
                setVLng('');
              }}
            >
              إضافة رأس
            </button>
          </div>
          {vError && <p className="rs-bad">{vError}</p>}
        </details>
      )}

      <div className="stw-live">
        <span>المسافة من الموقع الحالي <em>(للعلم فقط)</em></span>
        <b>{dist != null ? formatMeters(dist) : '—'}</b>
      </div>
      <dl className="stw-read" data-testid="site-readout" data-shape={shape ?? ''}>
        <dt>المساحة الحالية</dt>
        <dd>{currentArea != null ? formatArea(currentArea) : 'علامة فقط'}</dd>
        <dt>المساحة المقترحة</dt>
        <dd>{area != null ? formatArea(area) : '—'}</dd>
        <dt>الحد الأقصى</dt>
        <dd>{maxAreaM2 != null ? formatArea(maxAreaM2) : '—'}</dd>
        <dt>الفرق في المساحة</dt>
        <dd>{area != null && currentArea ? pct((area - currentArea) / currentArea) : '—'}</dd>
        {many && (
          <>
            <dt>الأجزاء</dt>
            <dd>{live?.parts} — تنتقل معاً</dd>
          </>
        )}
        <dt>صحة الشكل</dt>
        <dd className={ok ? 'y' : open && (d?.count ?? 0) < 3 ? '' : 'n'} data-testid={open ? 'draw-validity' : 'site-validity'}>
          {open && (d?.count ?? 0) < 3 ? 'لم يكتمل الرسم' : ok ? '✓ صالح' : '✕ ' + (problems.join('، ') || 'غير صالح')}
        </dd>
        <dt>الإشغال</dt>
        <dd className={occupiedHits.length ? 'n' : 'y'} data-testid={occupiedHits.length ? 'occupied-warning' : undefined}>
          {occupiedHits.length ? '✕ يتداخل مع أرض مشغولة: ' + occupiedHits.join('، ') : '✓ لا تداخل'}
        </dd>
      </dl>

      {vertexMode && ring && (
        <details className="stw-coords-box">
          <summary>إحداثيات الرؤوس (اختياري)</summary>
          <table className="stw-vt" aria-label="رؤوس الحدود المقترحة">
            <thead>
              <tr>
                <th>#</th>
                <th>خط العرض</th>
                <th>خط الطول</th>
                <th>الضلع التالي</th>
              </tr>
            </thead>
            <tbody>
              {ring.map((v, i) => (
                <VertexRow key={i + ':' + v.lat + ':' + v.lng} i={i} v={v} next={distanceM(v, ring[(i + 1) % ring.length])} onSet={(p) => live?.activePart != null && ed?.setVertex(live.activePart, 0, i, p)} />
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div className="stw-tools">
        <button className="button" disabled={open ? !d?.count : !live?.canUndo} onClick={() => (open ? ed?.undoVertex() : ed?.undo())} title="تراجع">
          ↶ تراجع
        </button>
        <button className="button" disabled={open ? !live?.canRedoDraw : !live?.canRedo} onClick={() => (open ? ed?.redoVertex() : ed?.redo())} title="إعادة">
          ↷ إعادة
        </button>
        <button className="button" onClick={() => (open ? ed?.restartDrawing() : ed?.reset())}>
          إعادة الضبط
        </button>
        {!open && live?.geometry && (
          <button className={'button' + (vertexMode ? ' on' : '')} aria-pressed={vertexMode} onClick={() => setMode(vertexMode ? 'move' : 'vertices')}>
            تعديل الرؤوس
          </button>
        )}
        <button className="button" disabled={!live?.geometry && !d?.count} onClick={() => ed?.focus()}>
          ◎ المقترح
        </button>
        <button className="button" disabled={!live?.geometry || !origin} onClick={() => ed?.compare()}>
          ⇆ مقارنة الموقعين
        </button>
      </div>
      {many && vertexMode && (
        <div className="rs-tools rs-parts">
          {live!.partAreas.map((a, i) => (
            <button key={i} className={'chip' + (i === live!.activePart ? ' active' : '')} onClick={() => ed?.selectPart(i)}>
              الجزء {i + 1} · {formatArea(a)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A deployment area on the map, edited exactly as the re-stationing site (owner, 5 Nov 2026): «منطقة الانتشار
 * الرئيسية» / «البديلة», each placed by one click with the policy's initial footprint («تحديد المنطقة على الخريطة»)
 * or drawn vertex by vertex with «عدد الرؤوس» («رسم حدود المنطقة»); either way it is then dragged by its body or its
 * tag, its numbered vertices edited, ↶ ↷ إعادة الضبط, ◎ and ⇆. Its distance is measured centre to centre — the primary
 * from the new site, the alternative from the primary — with the leg's allowed range and a verdict from the server's
 * last check (the server decides on save). No range ring.
 */
function AreaControls({ editor, listeners, area, onArea, hasPrimary, placing, areaDefault, policyVersion, onPlace, onDraw, target, setTarget, origin, leg, checked, children }: {
  editor: React.RefObject<SiteEditor | null>;
  listeners: React.RefObject<Set<(l: SiteLive) => void>>;
  area: 'primary' | 'alternative';
  onArea: (k: 'primary' | 'alternative') => void;
  hasPrimary: boolean;
  placing: boolean;
  areaDefault: ReturnType<typeof resolveAreaDefault>;
  policyVersion: { version: number; reference: string | null } | null;
  onPlace: () => void;
  onDraw: () => void;
  target: number;
  setTarget: (n: number) => void;
  origin: LatLng | null;
  /** The leg as the map shows it: the server's check of exactly this geometry, otherwise the analysis preview. */
  leg: RestationingLeg | undefined;
  /** The server's check at the last save («تحقق الخادم»). */
  checked: RestationingLeg | undefined;
  children?: React.ReactNode;
}) {
  const [live, setLive] = useState<SiteLive | null>(null);
  useEffect(() => {
    const set = listeners.current;
    set.add(setLive);
    editor.current?.refresh();
    return () => {
      set.delete(setLive);
    };
  }, [editor, listeners]);
  const ed = editor.current;
  const open = live?.mode === 'draw';
  const d = open ? live?.draw ?? null : null;
  const has = !open && !!live?.geometry;
  const vertexMode = live?.mode === 'vertices';
  const anchor = has && live?.geometry ? anchorOf(partsOf(live.geometry)) : null;
  const dist = anchor && origin ? legText(distanceM(origin, anchor), leg) : null;
  const ring = has && live?.geometry && live.activePart != null ? partsOf(live.geometry)[live.activePart]?.[0] ?? null : null;
  return (
    <div className="rs-site-controls tz-place stw-proposal-panel" data-testid="area-controls" data-area={area}>
      <div className="stw-tabs" role="tablist" aria-label="منطقة الانتشار">
        <button role="tab" aria-selected={area === 'primary'} className={area === 'primary' ? 'on' : ''} onClick={() => onArea('primary')}>
          منطقة الانتشار الرئيسية
        </button>
        <button role="tab" aria-selected={area === 'alternative'} className={area === 'alternative' ? 'on' : ''} disabled={!hasPrimary} title={hasPrimary ? undefined : 'ضع منطقة الانتشار الرئيسية أولاً'} onClick={() => onArea('alternative')}>
          منطقة الانتشار البديلة
        </button>
      </div>
      <div className="stw-tools two" role="group" aria-label="طريقة وضع المنطقة">
        <button className={'button' + (placing ? ' on' : '')} aria-pressed={placing} disabled={!areaDefault.value} onClick={onPlace}>
          تحديد المنطقة على الخريطة
        </button>
        <button className={'button' + (open ? ' on' : '')} onClick={onDraw}>
          رسم حدود المنطقة
        </button>
      </div>
      <p className="stw-hint" data-testid="area-hint">
        {area === 'primary' ? 'تُقاس من مركز موقع إعادة التمركز. ' : 'تُقاس من مركز منطقة الانتشار الرئيسية. '}
        {placing
          ? 'انقر على المكان المطلوب لوضع المنطقة ثم عدّلها.'
          : open
            ? 'انقر على الخريطة لوضع الرؤوس بالترتيب.'
            : has
              ? 'اسحب المنطقة أو وسمها لنقلها كاملة، أو اسحب رأساً لتعديله.'
              : 'حدّد المنطقة بنقرة ثم عدّلها، أو ارسم حدودها.'}
      </p>
      <p className="stw-hint" data-testid="area-default">
        {areaDefault.source === 'POLICY'
          ? 'الشكل الابتدائي من سياسة التمركز' + (policyVersion ? ` (النسخة ${policyVersion.version})` : '') + ': ' + describeAreaDefault(areaDefault.value!) + (policyVersion?.reference ? ' — ' + policyVersion.reference : '')
          : 'لم يُحدَّد الشكل الابتدائي في سياسة التمركز: استخدم «رسم حدود المنطقة»'}
      </p>
      {open && (
        <div className="stw-row">
          <label className="stw-field inline">
            <span>عدد الرؤوس</span>
            <input type="number" min={3} max={20} value={target} aria-label="عدد الرؤوس" onChange={(e) => setTarget(Math.max(3, Math.min(20, Math.round(Number(e.target.value) || 3))))} />
          </label>
          <span className="stw-hint" data-testid="draw-readout" data-count={d?.count ?? 0}>
            {d?.count ?? 0} / {live?.target ?? target}
          </span>
        </div>
      )}
      <div className="stw-live stack">
        <span>المسافة {area === 'primary' ? 'من موقع إعادة التمركز' : 'من المنطقة الرئيسية'}</span>
        <b className={dist ? (dist.tone === 'ok' ? 'y' : dist.tone === 'none' ? '' : 'n') : ''} data-testid="area-distance">{dist?.text ?? '—'}</b>
      </div>
      <dl className="stw-read" data-testid="area-readout">
        <dt>المساحة</dt>
        <dd>{open ? (d && d.count >= 3 ? formatArea(d.areaM2) : '—') : has ? formatArea(live!.areaM2) : '—'}</dd>
        <dt>صحة الشكل</dt>
        <dd className={(open ? !!d && d.count >= 3 && d.ok : !!live?.ok && has) ? 'y' : ''}>
          {open ? ((d?.count ?? 0) < 3 ? 'لم يكتمل الرسم' : d?.ok ? '✓ صالح' : '✕ غير صالح') : has ? (live!.ok ? '✓ صالح' : '✕ ' + live!.problems.join('، ')) : '—'}
        </dd>
        <dt>تحقق الخادم</dt>
        <dd>{checked && checked.status !== 'NOT_PLACED' ? 'عند آخر حفظ: ' + (checked.status === 'OK' ? 'ضمن النطاق' : checked.status === 'NEEDS_EXCEPTION' ? 'يحتاج استثناء' : checked.status === 'OUT_OF_RANGE' ? 'خارج النطاق' : 'تعادل في طبيعة الأرض') : 'عند الحفظ'}</dd>
      </dl>
      {children}
      {vertexMode && ring && (
        <details className="stw-coords-box">
          <summary>إحداثيات الرؤوس (اختياري)</summary>
          <table className="stw-vt" aria-label="رؤوس منطقة الانتشار">
            <thead>
              <tr>
                <th>#</th>
                <th>خط العرض</th>
                <th>خط الطول</th>
                <th>الضلع التالي</th>
              </tr>
            </thead>
            <tbody>
              {ring.map((v, i) => (
                <VertexRow key={i + ':' + v.lat + ':' + v.lng} i={i} v={v} next={distanceM(v, ring[(i + 1) % ring.length])} onSet={(p) => live?.activePart != null && ed?.setVertex(live.activePart, 0, i, p)} />
              ))}
            </tbody>
          </table>
        </details>
      )}
      <div className="stw-tools">
        <button className="button" disabled={open ? !d?.count : !live?.canUndo} onClick={() => (open ? ed?.undoVertex() : ed?.undo())} title="تراجع">
          ↶ تراجع
        </button>
        <button className="button" disabled={open ? !live?.canRedoDraw : !live?.canRedo} onClick={() => (open ? ed?.redoVertex() : ed?.redo())} title="إعادة">
          ↷ إعادة
        </button>
        <button className="button" disabled={!has && !open} onClick={() => (open ? ed?.restartDrawing() : ed?.reset())}>
          إعادة الضبط
        </button>
        {has && (
          <button className={'button' + (vertexMode ? ' on' : '')} aria-pressed={vertexMode} onClick={() => ed?.setMode(vertexMode ? 'move' : 'vertices')}>
            تعديل الرؤوس
          </button>
        )}
        <button className="button" disabled={!has && !d?.count} onClick={() => ed?.focus()}>
          ◎ المنطقة
        </button>
        <button className="button" disabled={!has || !origin} onClick={() => ed?.compare()}>
          ⇆ المسافة
        </button>
      </div>
    </div>
  );
}

/** One vertex of the coordinates table: typed latitude and longitude, applied on Enter or when the field is left. */
function VertexRow({ i, v, next, onSet }: { i: number; v: LatLng; next: number; onSet: (p: LatLng) => void }) {
  const [lat, setLat] = useState(v.lat.toFixed(6));
  const [lng, setLng] = useState(v.lng.toFixed(6));
  const [bad, setBad] = useState(false);
  const apply = () => {
    const r = parseCoordinates(lat, lng);
    setBad(!r.point);
    if (r.point && (r.point.lat !== v.lat || r.point.lng !== v.lng)) onSet(r.point);
  };
  const key = (e: React.KeyboardEvent) => e.key === 'Enter' && apply();
  return (
    <tr className={bad ? 'bad' : undefined}>
      <td>{i + 1}</td>
      <td><input inputMode="decimal" value={lat} aria-label={'خط عرض الرأس ' + (i + 1)} onChange={(e) => setLat(e.target.value)} onBlur={apply} onKeyDown={key} /></td>
      <td><input inputMode="decimal" value={lng} aria-label={'خط طول الرأس ' + (i + 1)} onChange={(e) => setLng(e.target.value)} onBlur={apply} onKeyDown={key} /></td>
      <td>{formatMeters(next)}</td>
    </tr>
  );
}

/** A signed percentage as the retired panel showed it: «0٪», «-0.947٪», «+1,392.891٪». */
function pct(x: number): string {
  // a rigid move over kilometres changes the spheroidal area by thousandths of a percent (latitude): still the same shape
  if (Math.abs(x) < 0.00005) return '0٪';
  return (x > 0 ? '+' : '−') + Math.abs(x * 100).toLocaleString('ar', { maximumFractionDigits: 3, minimumFractionDigits: 3 }) + '٪';
}
