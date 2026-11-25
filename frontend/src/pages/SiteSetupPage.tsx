import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { Marker, NavigationControl, ScaleControl } from 'maplibre-gl';
import { api, newIdempotencyKey, type SiteDeletionImpact, type SiteDeletionRequest, type SiteOccupants, type SiteSetupBody, type SiteSetupCheck } from '../api/client';
import type { GeoPolygon, RestationingLeg, RestationingRequest, SiteDetail, SiteGeometry, StationingPolicyValues } from '../api/types';
import { PITCH_3D, SITE_LOOK, SiteEditor, addOverlayLayer, frame, installedTerrain3d, type MapView, type SiteLive } from '../components/map/maplibre';
import type { BasemapMode, Terrain3dSource } from '../components/map/maplibre/offlineStyle';
import { OrgTree } from '../components/map/BrowseTrees';
import { AREA_LOOK } from '../components/stationing/AreaControls';
import { PointsTable } from '../components/stationing/PointsTable';
import { SiteSymbolPicker, SymbolArt } from '../components/stationing/SiteSymbolPicker';
import { Icon } from '../components/ui';
import { MapFrame, MapLegend } from '../components/workspace/MapFrame';
import { StationingShell } from '../components/workspace/StationingShell';
import { EmptyCentre } from '../components/workspace/EmptyCentre';
import { OperationalWorkspace } from '../components/workspace/OperationalWorkspace';
import { RequestMap } from '../components/workspace/RequestMap';
import { useAreaInsight } from '../components/workspace/TerrainPanel';
import { useRegisteredSites } from '../components/workspace/useRegisteredSites';
import { useApp } from '../lib/app';
import { formatIn, type FormatKey } from '../lib/coordFormats';
import { initialArea, resolveAreaDefault, type AreaDefault } from '../lib/deploymentDefault';
import { formatArea } from '../lib/footprint';
import { distanceM } from '../lib/geo';
import { legText } from '../lib/requestMap';
import { anchorOf, partsOf, siteArea } from '../lib/siteGeometry';
import { isSetupAdmin, policyLeg, setupBody, unitBlock, withArea, withResponsible, type SetupStep, type UnitPlan } from '../lib/siteSetupFlow';
import { rendererStandard, symbolEntry } from '../lib/siteSymbols';
import { renderSymbol } from '../lib/unitSymbols';
import { INITIAL_STEPS, MAIN_KINDS, cornersOf, initialProblem, outlineOf, rowsOf, shapeText, type PointRow } from '../lib/siteWizard';
import { previewLeg } from '../lib/terrainAnalysis';

const EMPTY_MAP = {
  id: 'setup', number: '', state: 'DRAFT', requestingUnit: { id: '', name: '' }, requester: { id: '', name: '' }, units: [], currentSites: [],
  content: { kind: 'PERMANENT', scope: [], site: null, primary: null, alternative: null, reason: '', exceptions: {}, occupants: {} },
  policyVersion: null, routeNo: 0, route: [], previousRoutes: [], revisions: [], returned: null, paused: null, finalApprover: null,
  can: { edit: false, submit: false, decide: false, activate: false },
} as unknown as RestationingRequest;

type Form = { name: string; code: string; kind: string; parentId: string; notes: string; reason: string; ownerId?: string };
const BLANK: Form = { name: '', code: '', kind: 'موقع', parentId: '', notes: '', reason: '' };
// «موقع جديد» as in MOVER's «المواقع» drawer (owner, 10 Nov 2026: «do the same as we did there»; MOVER owner 1 Nov 2026: simple
// enough for a child): one question per card, three steps — the data, the shape, review and save. «معسكر» by default, as there.
const NEW_SITE: Form = { ...BLANK, kind: 'معسكر', ownerId: '' };
/** What the map editor holds: the site, or one unit's deployment area (steps 4 and 5 of the setup administrator). */
type EditTarget = 'site' | { unit: string; role: 'primary' | 'alternative' };
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * «تهيئة المواقع والتمركز»: the controlled setup of an empty installation, not a daily request (ADR-045). Each step asks a written
 * reason and is audited by the server, which also checks the right behind it: registering a site and its shape, its parent
 * site, the links of units to it (a link is not stationing) and an audited correction of authoritative stationing. It never
 * changes Oracle's hierarchy: one physical site is one object, however many units use it.
 */
export function SiteSetupPage() {
  const app = useApp();
  const registered = useRegisteredSites();
  const canSites = app.can('MANAGE_FACILITIES');
  const canLinks = app.can('MANAGE_SITE_LINKS');
  const canCorrect = app.can('CORRECT_STATIONING');
  const [mode, setMode] = useState<BasemapMode>('street');
  const [view, setView] = useState<MapView>('2d');
  const [terrain3d, setTerrain3d] = useState<Terrain3dSource | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);
  const [shape, setShape] = useState<'POLYGON' | 'POINT'>('POLYGON');
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [geometry, setGeometry] = useState<SiteGeometry | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [occ, setOcc] = useState<SiteOccupants | null>(null);
  const [linkOrg, setLinkOrg] = useState('');
  const [linkReason, setLinkReason] = useState('');
  const [stOrg, setStOrg] = useState('');
  const [stReason, setStReason] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<SiteDetail | null>(null);
  const [edit, setEdit] = useState<Form>(BLANK);
  const [editingShape, setEditingShape] = useState(false);
  // the site's card (owner, 17 Nov 2026): its facts first, one «تعديل» for all of them, and the deletion — the administrator
  // deletes, everyone else asks the administrator (interface first: deleting and asking are connected after the review)
  const [cardEdit, setCardEdit] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [delReason, setDelReason] = useState('');
  const [delImpact, setDelImpact] = useState<SiteDeletionImpact | null>(null);
  const [delErr, setDelErr] = useState('');
  // the administrator sees which sites someone asked to delete (ADR-086)
  const [delRequests, setDelRequests] = useState<SiteDeletionRequest[]>([]);
  const [delAck, setDelAck] = useState(false);
  // the site list as a tree (owner, 17 Nov 2026): a camp's inside sites behind its arrow
  const [openSites, setOpenSites] = useState<Set<string>>(new Set());
  const [vertexMode, setVertexMode] = useState(false);
  // the «موقع جديد» wizard: three steps, or six for the setup administrator (ADR-067)
  const [step, setStep] = useState<SetupStep>(1);
  const [inside, setInside] = useState(false);
  const [otherKind, setOtherKind] = useState(false);
  const [parentQ, setParentQ] = useState('');
  const [owner, setOwner] = useState<{ id: string; name: string } | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [wizErr, setWizErr] = useState('');
  const [made, setMade] = useState<{ id: string; name: string; code: string; units?: number; unit?: string } | null>(null);
  // «جدول الإحداثيات»: shown on «اكتب الإحداثيات»; it follows the map and the map follows it
  const [typing, setTyping] = useState(false);
  const [rows, setRows] = useState<PointRow[]>([]);
  const [fmt, setFmt] = useState<FormatKey>('');
  const [pickRow, setPickRow] = useState<number | null>(null);
  const [drawInfo, setDrawInfo] = useState<{ count: number; canFinish: boolean } | null>(null);
  const [railQ, setRailQ] = useState('');
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // the site's map symbol (V32): chosen in «موقع جديد», changed later from the site's card with a reason
  const [symbol, setSymbol] = useState<string | null>(null);
  const [symEdit, setSymEdit] = useState<string | null | undefined>(undefined);
  const [fromCoords, setFromCoords] = useState(false);
  // «حفظ الموقع والتمركز المبدئي»: the server's refusal, said on the review step itself (ADR-081)
  const [saveError, setSaveError] = useState('');
  // «تهيئة المواقع والتمركز» (ADR-067): who holds facilities and corrections everywhere also stations units there and places
  // their areas, in the same wizard and one save; the server checks the right again (SiteSetupService.admin)
  const admin = isSetupAdmin(app.me.grants);
  // «صلاحيات تهيئة المواقع» (phase 7; ADR-089): whoever the settings' rule allows saves a site with its unit too; the server
  // checks the unit on the save
  const [mayRule, setMayRule] = useState(false);
  useEffect(() => {
    api.siteSetupAccess().then((r) => setMayRule(r.may), () => setMayRule(false));
  }, []);
  const maySave = admin || mayRule;
  const [plan, setPlan] = useState<UnitPlan[]>([]);
  // the responsible unit is the stationed unit (owner, 17 Nov 2026, ADR-076): it heads the setup's plan while responsible
  // «تحديد مواقع التمركز المبدئية» (owner brief, phase 2): the unit chosen first is the one stationed; one stationed already is not
  const ownerBlock = owner ? unitBlock(owner.id, registered.current) : '';
  const previousOwner = useRef<string | null>(null);
  useEffect(() => {
    if (!admin) return;
    setPlan((p) => withResponsible(p, owner, previousOwner.current, ownerBlock));
    previousOwner.current = owner?.id ?? null;
  }, [admin, owner?.id, ownerBlock]); // eslint-disable-line react-hooks/exhaustive-deps
  const [active, setActive] = useState<string | null>(null);
  const [placingArea, setPlacingArea] = useState(false);
  const [policy, setPolicy] = useState<{ version: number; reference: string | null; values: StationingPolicyValues } | null | undefined>(undefined);
  const [, setReview] = useState<{ key: string; check: SiteSetupCheck | null; error: string } | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const listeners = useRef(new Set<(l: SiteLive) => void>());
  const targetRef = useRef<EditTarget>('site');
  const maxFootprintRef = useRef<number | null>(null);
  const loadedKey = useRef('site');
  const placingAreaRef = useRef(false);
  placingAreaRef.current = placingArea;
  const idemKey = useRef('');
  const mapRef = useRef<MlMap | null>(null);
  const scaleRef = useRef<ScaleControl | null>(null);
  const editor = useRef<SiteEditor | null>(null);
  const marker = useRef<Marker | null>(null);
  const parts = useRef<SiteGeometry | null>(null);
  const placingRef = useRef(false);
  placingRef.current = placing;
  // the row a map click sets, and whether the latest shape came from the table (then the table is not rewritten from it)
  const pickRef = useRef<((p: { lat: number; lng: number }) => void) | null>(null);
  const fromTable = useRef(false);
  useEffect(() => {
    installedTerrain3d().then(setTerrain3d);
    return () => {
      editor.current?.destroy();
      marker.current?.remove();
    };
  }, []);
  // 3D looks from the side, 2D from above — also on an empty installation, where there is no site to frame (as on «الموقف»)
  useEffect(() => {
    mapRef.current?.easeTo({ pitch: view === '3d' ? PITCH_3D : 0, duration: 500 });
    // the scale is for the flat map: tilted, the ground's scale changes across the screen, and it is recalculated on every frame
    const m = mapRef.current;
    const sc = scaleRef.current;
    if (m && sc) {
      if (view === '3d' && m.hasControl(sc)) m.removeControl(sc);
      if (view !== '3d' && !m.hasControl(sc)) m.addControl(sc, 'bottom-right');
    }
  }, [view]);
  const onMap = (m: MlMap) => {
    mapRef.current = m;
    // as in the owner's reference: a north arrow and a scale on the map
    m.addControl(new NavigationControl({ showZoom: false, visualizePitch: true }), 'bottom-right');
    scaleRef.current = new ScaleControl({ unit: 'metric', maxWidth: 120 });
    m.addControl(scaleRef.current, 'bottom-right');
    m.addSource('setup-earlier', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(m, { id: 'setup-earlier-fill', type: 'fill', source: 'setup-earlier', paint: { 'fill-color': '#2f9e6e', 'fill-opacity': 0.25 } }, 'top');
    addOverlayLayer(m, { id: 'setup-earlier-line', type: 'line', source: 'setup-earlier', paint: { 'line-color': '#2f9e6e', 'line-width': 2, 'line-dasharray': [2, 1.6] } }, 'top');
    // the setup's plan under the shape being edited: the new site while an area is edited, and the areas already placed
    m.addSource('setup-plan', { type: 'geojson', data: EMPTY_FC });
    addOverlayLayer(m, { id: 'setup-plan-fill', type: 'fill', source: 'setup-plan', paint: { 'fill-color': ['match', ['get', 'role'], 'PRIMARY', '#e8963a', 'ALTERNATIVE', '#7b4fc0', '#2bb36a'], 'fill-opacity': 0.16 } }, 'top');
    addOverlayLayer(m, { id: 'setup-plan-line', type: 'line', source: 'setup-plan', paint: { 'line-color': ['match', ['get', 'role'], 'PRIMARY', '#d9822b', 'ALTERNATIVE', '#7b4fc0', '#1f9d55'], 'line-width': 1.8, 'line-dasharray': [2, 1.4] } }, 'top');
    editor.current = new SiteEditor(m, {
      onChange: (l: SiteLive, final: boolean) => {
        listeners.current.forEach((f) => f(l));
        setDrawing(l.mode === 'draw');
        setDrawInfo(l.draw ? { count: l.draw.count, canFinish: l.draw.canFinish } : null);
        if (!final) return;
        // the site, or the deployment area of the unit being edited: each change goes to what the editor holds
        const t = targetRef.current;
        if (t === 'site') setGeometry(l.geometry ?? null);
        else setPlan((p) => withArea(p, t.unit, t.role, l.geometry && l.geometry.type === 'Polygon' ? (l.geometry as unknown as GeoPolygon) : null));
      },
      // the site's boundary within the policy's maximum footprint (ADR-106): drawn red above it; the server refuses it
      maxAreaM2: () => (targetRef.current === 'site' ? maxFootprintRef.current : null),
    });
    m.on('click', (e: MapMouseEvent) => {
      if (pickRef.current) {
        const take = pickRef.current;
        pickRef.current = null;
        take({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        return;
      }
      // «تحديد المنطقة على الخريطة»: the policy's initial footprint around the click, then dragged and edited
      if (placingAreaRef.current) {
        setPlacingArea(false);
        const d = areaDefaultRef.current.value;
        if (d && targetRef.current !== 'site') editor.current?.load(initialArea({ lat: e.lngLat.lat, lng: e.lngLat.lng }, d), false);
        return;
      }
      if (!placingRef.current) return;
      setPlacing(false);
      setPoint({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      marker.current?.remove();
      marker.current = new Marker({ color: '#d9822b' }).setLngLat(e.lngLat).addTo(m);
    });
    setMapReady(true);
  };
  const reload = () => {
    if (selected) api.siteOccupants(selected).then(setOcc).catch(() => setOcc(null));
  };
  useEffect(() => {
    setOcc(null);
    reload();
    setDetail(null);
    if (selected) {
      api.site(selected).then((d) => {
        setDetail(d);
        setEdit({ name: d.name, code: d.code, kind: d.kind, parentId: d.parentId ?? '', notes: '', reason: '' });
      }).catch(() => setDetail(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, app.revision]);
  useEffect(() => setSymEdit(undefined), [selected]);
  useEffect(() => {
    if (editingShape) {
      setEditingShape(false);
      editor.current?.load(null, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  /** The registered boundary in the map editor, its parts moving as one; the register changes only when it is saved with a reason. */
  const startShape = () => {
    const g = detail?.geometry?.geojson as unknown as SiteGeometry | undefined;
    setEditingShape(true);
    setVertexMode(false);
    editor.current?.setMode('move');
    setGeometry(g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? g : null);
    editor.current?.load(g && (g.type === 'Polygon' || g.type === 'MultiPolygon') ? g : null, true);
    if (!g || !(g.type === 'Polygon' || g.type === 'MultiPolygon')) editor.current?.startDrawing(null, 0);
  };
  const sites = useMemo(() => registered.sites.filter((s) => s.view !== 'CONTEXT'), [registered.sites]);
  const byParent = useMemo(() => {
    const m = new Map<string, typeof sites>();
    for (const s of sites) m.set(s.parentId ?? '', [...(m.get(s.parentId ?? '') ?? []), s]);
    return m;
  }, [sites]);
  const site = sites.find((s) => s.siteId === selected) ?? null;
  const orgs = useMemo(() => app.orgs.filter((o) => !q.trim() || o.name.includes(q.trim())).slice(0, 200), [app.orgs, q]);
  // «＋ إضافة موقع», or a site inside a chosen camp (owner, 16 Nov 2026): the wizard opens with «يقع داخل» that camp and the map on it
  const startAdd = (parent?: { siteId: string; name: string }) => {
    setAdding(true);
    setSelected(null);
    setForm(parent ? { ...NEW_SITE, kind: 'موقع', parentId: parent.siteId } : NEW_SITE);
    setShape('POLYGON');
    setGeometry(null);
    setPoint(null);
    setPlacing(false);
    setStep(1);
    setInside(!!parent);
    setOtherKind(false);
    setParentQ('');
    setOwner(null);
    setOwnerOpen(false);
    setWizErr('');
    setMade(null);
    setTyping(false);
    setRows([]);
    setPickRow(null);
    pickRef.current = null;
    setFromCoords(false);
    setSymbol(null);
    setSaveError('');
    setFolded(new Set());
    parts.current = null;
    showEarlier(null);
    marker.current?.remove();
    editSite();
    editor.current?.load(null, false);
    setPlan([]);
    setActive(null);
    setPlacingArea(false);
    setReview(null);
    // one key per new site: a save sent twice (a double click, a retry after a lost answer) registers it once
    idemKey.current = newIdempotencyKey();
  };
  // the tab «تحديد مواقع التمركز المبدئية» opens on the work (owner, 17 Nov 2026: "you can click, that's it"): the steps start at once
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !mapReady || !canSites || selected || adding) return;
    opened.current = true;
    startAdd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);
  // the new site's name and symbol on the map, on its boundary or its point (owner's reference): it follows the shape and the data
  const labelRef = useRef<Marker | null>(null);
  const labelAt = adding && !made ? (shape === 'POINT' ? point : geometry ? anchorOf(partsOf(geometry)) : null) : null;
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !labelAt) {
      labelRef.current?.remove();
      labelRef.current = null;
      return;
    }
    const el = labelRef.current?.getElement() ?? document.createElement('div');
    el.className = 'sw-maplabel';
    el.dataset.testid = 'site-map-label';
    el.replaceChildren();
    const name = document.createElement('span');
    name.textContent = form.name.trim() || 'موقع جديد';
    el.append(name);
    let live = true;
    if (symbol) {
      renderSymbol(symbol, rendererStandard(symbol), 28).then((r) => {
        if (!live || !r.valid) return;
        const img = new Image();
        img.src = r.url;
        img.alt = '';
        el.prepend(img);
      }).catch(() => undefined);
    }
    if (!labelRef.current) labelRef.current = new Marker({ element: el, anchor: 'bottom', offset: [0, -34] }).setLngLat([labelAt.lng, labelAt.lat]).addTo(m);
    else labelRef.current.setLngLat([labelAt.lng, labelAt.lat]);
    return () => {
      live = false;
    };
  }, [labelAt?.lat, labelAt?.lng, form.name, symbol, mapReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const stopAdd = () => {
    if (drawing) editor.current?.cancelDrawing();
    setAdding(false);
    setPlacing(false);
    setPlacingArea(false);
    setPickRow(null);
    pickRef.current = null;
    setMade(null);
    editSite();
    editor.current?.load(null, false);
    marker.current?.remove();
    showEarlier(null);
  };
  /** The editor back on the site (its own look, no leg), before anything is loaded into it. */
  const editSite = () => {
    targetRef.current = 'site';
    loadedKey.current = 'site';
    editor.current?.setLook(SITE_LOOK);
    editor.current?.setOrigin(null);
    editor.current?.setDistanceLabel(null);
  };
  /** «التالي» / «السابق»: forward only once the step is complete; the reason stays in the card where the person is looking. */
  const goStep = (to: SetupStep) => {
    const forward = to > step;
    const problem = forward
      ? initialProblem({ name: form.name, kind: form.kind, inside, parentId: form.parentId, shape, point, geometry, drawing, unit: owner, unitBlock: ownerBlock }, Math.min(to, 3) as 1 | 2 | 3)
      : '';
    setWizErr(problem);
    if (problem) return;
    if (drawing) editor.current?.cancelDrawing();
    setPlacing(false);
    setPlacingArea(false);
    setPickRow(null);
    pickRef.current = null;
    // the areas are placed unit by unit: each area step opens on the first unit still without that area
    if (to === 4 || to === 5) {
      const role = to === 4 ? 'primary' : 'alternative';
      setActive((plan.find((u) => !u[role]) ?? plan[0])?.id ?? null);
    }
    setStep(to);
  };
  // ---- the setup administrator's steps 3–6 (ADR-067) ------------------------------------------------------------------------
  // the policy in force: whether areas are required, the ranges, the initial footprint of a click — never a value of the page
  useEffect(() => {
    if (!admin || !adding || policy !== undefined) return;
    api
      .stationingPolicy()
      .then((p) => setPolicy(p.inForce ? { version: p.inForce.version, reference: p.inForce.reference, values: p.inForce.values } : null))
      .catch(() => setPolicy(null));
  }, [admin, adding, policy]);
  const areaDefault = resolveAreaDefault((policy?.values as { deploymentAreaDefault?: AreaDefault | null } | undefined)?.deploymentAreaDefault ?? null);
  const areaDefaultRef = useRef(areaDefault);
  areaDefaultRef.current = areaDefault;
  maxFootprintRef.current = policy?.values.maxFootprintAreaM2 ?? null;
  // the site drawn before the policy was read is measured again against its maximum
  useEffect(() => {
    if (mapReady) editor.current?.refresh();
  }, [mapReady, policy?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  // what the editor holds: the site, or at steps 4 and 5 the area of the unit chosen there
  const areaRole: 'primary' | 'alternative' | null = adding && admin && !made ? (step === 4 ? 'primary' : step === 5 ? 'alternative' : null) : null;
  const activeUnit = plan.find((u) => u.id === active) ?? plan[0] ?? null;
  const editTarget: EditTarget = areaRole && activeUnit ? { unit: activeUnit.id, role: areaRole } : 'site';
  const targetKey = editTarget === 'site' ? 'site' : editTarget.unit + ':' + editTarget.role;
  const siteAnchor = shape === 'POINT' ? point : geometry ? anchorOf(partsOf(geometry)) : null;
  // a leg is measured centre to centre: the primary from the new site, the alternative from the unit's primary (O-04)
  const areaOrigin = editTarget === 'site' ? null : editTarget.role === 'primary' ? siteAnchor : activeUnit?.primary ? anchorOf(partsOf(activeUnit.primary as unknown as SiteGeometry)) : null;
  const editedArea = editTarget === 'site' ? null : ((activeUnit?.[editTarget.role] ?? null) as unknown as SiteGeometry | null);
  const insight = useAreaInsight(editedArea, null, policy?.version ?? null);
  const areaDistance = editedArea && areaOrigin ? distanceM(areaOrigin, anchorOf(partsOf(editedArea))) : null;
  const previewOf = (role: 'primary' | 'alternative'): RestationingLeg | undefined =>
    previewLeg(role, areaDistance, insight?.assess ?? null, policy?.values ?? null) ?? policyLeg(role, areaDistance, policy?.values);
  const leg = editTarget === 'site' ? undefined : previewOf(editTarget.role);
  /** The map around a leg: the area itself, or before it exists everything up to the policy's maximum around where it is measured from. */
  const frameArea = (role: 'primary' | 'alternative', area: SiteGeometry | null, from: { lat: number; lng: number } | null) => {
    const m = mapRef.current;
    if (!m || !from) return;
    const o = area ? anchorOf(partsOf(area)) : from;
    const r = area ? 900 : policy ? policy.values[role].maxM * 1.05 : null;
    if (r == null) return void m.easeTo({ center: [o.lng, o.lat], duration: 400 });
    const dLat = r / 110_900;
    const dLng = r / (111_320 * Math.cos((o.lat * Math.PI) / 180));
    frame(m, [{ lat: o.lat - dLat, lng: o.lng - dLng }, { lat: o.lat + dLat, lng: o.lng + dLng }], view, { duration: 400, padding: { top: 40, right: 40, bottom: 150, left: 70 }, maxZoom: 22 });
  };
  // the editor follows the target: the previous shape is closed first (its last change goes where it belongs), then the next loaded
  useEffect(() => {
    const ed = editor.current;
    if (!ed || !mapReady || loadedKey.current === targetKey) return;
    loadedKey.current = targetKey;
    ed.cancelDrawing();
    targetRef.current = editTarget;
    setPlacingArea(false);
    setVertexMode(false);
    ed.setMode('move');
    if (editTarget === 'site') {
      ed.setLook(SITE_LOOK);
      ed.setOrigin(null);
      ed.setDistanceLabel(null);
      ed.load(adding && !made && shape === 'POLYGON' ? geometry : null, false);
      return;
    }
    const g = (plan.find((u) => u.id === editTarget.unit)?.[editTarget.role] ?? null) as unknown as SiteGeometry | null;
    ed.setLook(AREA_LOOK[editTarget.role]);
    ed.setOrigin(areaOrigin ? { at: areaOrigin, label: null } : null);
    ed.load(g, false);
    frameArea(editTarget.role, g, areaOrigin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, mapReady]);
  // the leg's start and its chip on the map follow the edited area: distance · allowed range · verdict (the server decides)
  const legKey = JSON.stringify(leg ? [leg.status, leg.effectiveMinM, leg.effectiveMaxM, leg.exceptionMaxM] : null);
  useEffect(() => {
    const ed = editor.current;
    if (!ed || editTarget === 'site') return;
    ed.setOrigin(areaOrigin ? { at: areaOrigin, label: null } : null);
    ed.setDistanceLabel((d: number) => legText(d, leg));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, areaOrigin?.lat, areaOrigin?.lng, legKey]);
  // the plan under the edited shape: the new site while an area is edited, and every area placed but the one in the editor
  useEffect(() => {
    const src = mapRef.current?.getSource('setup-plan') as GeoJSONSource | undefined;
    if (!src) return;
    const features: GeoJSON.Feature[] = [];
    if (adding && admin && !made && step >= 3) {
      if (editTarget !== 'site' && shape === 'POLYGON' && geometry) features.push({ type: 'Feature', geometry: geometry as unknown as GeoJSON.Geometry, properties: { role: 'SITE' } });
      for (const u of plan)
        for (const role of ['primary', 'alternative'] as const) {
          const g = u[role];
          if (!g || (editTarget !== 'site' && editTarget.unit === u.id && editTarget.role === role)) continue;
          features.push({ type: 'Feature', geometry: g as unknown as GeoJSON.Geometry, properties: { role: role.toUpperCase(), unit: u.name } });
        }
    }
    src.setData({ type: 'FeatureCollection', features });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding, admin, made, step, targetKey, plan, geometry, shape, mapReady]);
  // «مراجعة وحفظ»: the server's own checks of exactly what will be sent, nothing written
  const bodyOf = (reason: string): SiteSetupBody | null => {
    const at = shape === 'POINT' ? point : geometry ? anchorOf(partsOf(geometry)) : null;
    if (!at) return null;
    const site = { code: '', name: form.name.trim(), kind: form.kind.trim(), parentId: (inside && form.parentId) || null, responsibleOrgId: owner?.id ?? null, capacity: null, location: at, notes: form.notes || null, reason, symbol };
    const boundary = shape === 'POLYGON' && geometry ? { geometry, crs: 'EPSG:4326', expectedVersion: 0, reason, method: fromCoords ? 'COORDINATES' : 'DRAWN' } : null;
    return setupBody(site, boundary, plan, reason);
  };
  /** What a check was made of: the body without its reasons (the reason is typed after the check, on the same card). */
  const keyOf = (b: SiteSetupBody | null) => (b ? JSON.stringify({ ...b, reason: '', site: { ...b.site, reason: '' }, boundary: b.boundary && { ...b.boundary, reason: '' } }) : '');
  const runCheck = () => {
    // the reason is asked on this same card and the save waits for it; the review is about the place, the units and the areas
    const body = bodyOf(form.reason.trim().length >= 5 ? form.reason : 'مراجعة قبل الحفظ');
    if (!body) return;
    const key = keyOf(body);
    setReview({ key, check: null, error: '' });
    api.siteSetupCheck(body).then(
      (check) => setReview((r) => (r?.key === key ? { key, check, error: '' } : r)),
      (e: Error) => setReview((r) => (r?.key === key ? { key, check: null, error: e.message } : r)),
    );
  };
  useEffect(() => {
    if (admin && adding && !made && step === 6) runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, adding, made, step]);
  const choosePoint = (p: { lat: number; lng: number }, fly = true) => {
    setPoint(p);
    marker.current?.remove();
    if (mapRef.current) {
      marker.current = new Marker({ color: '#d9822b' }).setLngLat([p.lng, p.lat]).addTo(mapRef.current);
      if (fly) mapRef.current.easeTo({ center: [p.lng, p.lat], zoom: Math.max(mapRef.current.getZoom(), 13), duration: 400 });
    }
  };
  /** The table changed: its points are joined in order on the map (a point site takes its one row). */
  const applyRows = (next: PointRow[], fly = false) => {
    setRows(next);
    if (shape === 'POINT') {
      const p = next[0]?.point ?? null;
      // marked only when the point really changes, or the mark would swallow the next click on the map
      fromTable.current = p ? !point || p.lat !== point.lat || p.lng !== point.lng : !!point;
      if (p) choosePoint(p, fly);
      else {
        setPoint(null);
        marker.current?.remove();
      }
      return;
    }
    const o = outlineOf(next);
    setWizErr(o.error && next.filter((r) => r.point).length >= 3 ? o.error : '');
    if (drawing) editor.current?.cancelDrawing();
    parts.current = null;
    showEarlier(null);
    fromTable.current = !!(o.geometry || geometry);
    editor.current?.load(o.geometry, false);
    editor.current?.setMode('move');
    setVertexMode(false);
    setGeometry(o.geometry);
    setFromCoords(!!o.geometry);
    if (fly && o.geometry && mapRef.current) frame(mapRef.current, partsOf(o.geometry).flatMap((p) => p[0]), view, { maxZoom: 15, duration: 400 });
  };
  // the map drew or moved the shape: the table shows its corners (one part; several parts are edited on the map)
  useEffect(() => {
    if (!adding || shape !== 'POLYGON' || drawing) return;
    if (fromTable.current) {
      fromTable.current = false;
      return;
    }
    const c = cornersOf(geometry);
    if (c) setRows(rowsOf(c, fmt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, drawing]);
  useEffect(() => {
    if (!adding || shape !== 'POINT') return;
    if (fromTable.current) {
      fromTable.current = false;
      return;
    }
    setRows(point ? rowsOf([point], fmt) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point]);
  /** «من الخريطة» on a row: the next click on the map is that point. */
  const pickFor = (i: number | null) => {
    setPickRow(i);
    setPlacing(false);
    if (drawing) editor.current?.cancelDrawing();
    pickRef.current = i === null ? null : (p) => {
      setPickRow(null);
      const base = shape === 'POINT' ? rows.slice(0, 1) : rows;
      const next = [...base];
      while (next.length <= i) next.push({ text: '', point: null, error: '' });
      next[i] = { text: formatIn(fmt, p.lat, p.lng), point: p, error: '' };
      applyRows(next);
    };
  };
  const pickShape = (s: 'POLYGON' | 'POINT') => {
    if (s === shape) return;
    if (drawing) editor.current?.cancelDrawing();
    setShape(s);
    setPlacing(false);
    setPickRow(null);
    pickRef.current = null;
    setRows([]);
    setGeometry(null);
    setPoint(null);
    parts.current = null;
    showEarlier(null);
    marker.current?.remove();
    editor.current?.load(null, false);
  };
  // free drawing (owner, 10 Nov 2026): as many corners as needed, closed on the first point, a double click, Enter or «إنهاء الرسم»
  const draw = () => {
    setPlacing(false);
    setPickRow(null);
    pickRef.current = null;
    setFromCoords(false);
    setWizErr('');
    parts.current = null;
    editor.current?.load(null, false);
    editor.current?.startDrawing(null, 0);
  };
  /** Another part: what is drawn so far is kept, and the new outline joins it as one MultiPolygon (it then moves as one). */
  const addPart = () => {
    if (!geometry) return;
    parts.current = geometry;
    showEarlier(geometry);
    editor.current?.load(null, false);
    // the map stays by the first part, which stays drawn while the next one is placed
    editor.current?.startDrawing(anchorOf(partsOf(geometry)), 0);
  };
  const showEarlier = (g: SiteGeometry | null) => {
    const m = mapRef.current;
    const src = m?.getSource('setup-earlier') as GeoJSONSource | undefined;
    src?.setData(g ? { type: 'Feature', geometry: g as unknown as GeoJSON.Geometry, properties: {} } : { type: 'FeatureCollection', features: [] });
  };
  useEffect(() => {
    const earlier = parts.current;
    if (!earlier || !geometry || drawing) return;
    const had = earlier.type === 'MultiPolygon' ? earlier.coordinates : [earlier.coordinates];
    const now = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
    parts.current = null;
    const merged = { type: 'MultiPolygon', coordinates: [...had, ...now] } as unknown as SiteGeometry;
    setGeometry(merged);
    editor.current?.setMode('move');
    setVertexMode(false);
    editor.current?.load(merged, false);
    showEarlier(null);
    if (mapRef.current) frame(mapRef.current, partsOf(merged).flatMap((p) => p[0]), view, { maxZoom: 15, duration: 300, padding: { top: 90, right: 90, bottom: 150, left: 90 } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, drawing]);
  // a finished outline moves as a whole; its vertices are edited on request, as in the request's editor
  const wasDrawing = useRef(false);
  useEffect(() => {
    if (wasDrawing.current && !drawing) {
      editor.current?.setMode('move');
      setVertexMode(false);
    }
    wasDrawing.current = drawing;
  }, [drawing]);
  const shapeTools = (
    <div className="stw-tools" data-testid="shape-tools">
      <button className="button" onClick={() => (drawing ? editor.current?.undoVertex() : editor.current?.undo())}>↶ تراجع</button>
      <button className="button" onClick={() => (drawing ? editor.current?.redoVertex() : editor.current?.redo())}>↷ إعادة</button>
      <button className="button" onClick={() => (drawing ? editor.current?.restartDrawing() : editor.current?.reset())}>إعادة الضبط</button>
      {!drawing && (
        <button className={'button' + (vertexMode ? ' on' : '')} aria-pressed={vertexMode} data-testid="vertex-toggle" onClick={() => { editor.current?.setMode(vertexMode ? 'move' : 'vertices'); setVertexMode(!vertexMode); }}>تعديل الرؤوس</button>
      )}
    </div>
  );
  const act = async (what: () => Promise<unknown>, done: string, after?: () => void) => {
    setBusy(true);
    try {
      await what();
      app.toast(done);
      app.bump();
      after?.();
      reload();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /**
   * «حفظ الموقع والتمركز المبدئي» (owner brief, phase 2, accepted 17 Nov 2026; ADR-081): the site, its boundary and the chosen
   * unit's initial stationing in one audited save, without deployment areas («طلب مناطق انتشار» asks for them afterwards).
   * The server checks the right again (SiteSetupService.admin), the unit's current stationing and the site's own rules.
   */
  const saveInitial = async () => {
    const at = shape === 'POINT' ? point : geometry ? anchorOf(partsOf(geometry)) : null;
    if (!owner) return setSaveError('اختر الوحدة أولاً: هي التي تتمركز في هذا الموقع.');
    if (!at) return setSaveError('حدد الموقع على الخريطة أولاً.');
    if (form.reason.trim().length < 5) return setSaveError('اكتب سبب التسجيل (5 أحرف على الأقل): يُحفظ في سجل التدقيق باسمك.');
    const reason = form.reason.trim();
    const site = { code: '', name: form.name.trim(), kind: form.kind.trim(), parentId: (inside && form.parentId) || null, responsibleOrgId: owner.id, capacity: null, location: at, notes: form.notes || null, reason, symbol };
    const boundary = shape === 'POLYGON' && geometry ? { geometry, crs: 'EPSG:4326', expectedVersion: 0, reason, method: fromCoords ? 'COORDINATES' : 'DRAWN' } : null;
    const body: SiteSetupBody = { site, boundary, units: [{ organizationId: owner.id, primary: null, alternative: null }], reason };
    setSaveError('');
    setBusy(true);
    try {
      const r = await api.siteSetup(body, idemKey.current);
      app.toast('سُجل الموقع والتمركز المبدئي');
      app.bump();
      setMade({ id: r.site.id, name: r.site.name, code: r.site.code, units: r.units.length, unit: r.units[0]?.name ?? owner.name });
      editor.current?.load(null, false);
      marker.current?.remove();
      showEarlier(null);
      reload();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const legend = <MapLegend stage="sites" fold={view === '3d'} />;
  const roots = sites.filter((s) => !s.parentId || !sites.some((x) => x.siteId === s.parentId));
  const nameOf = (id: string | null | undefined) => sites.find((x) => x.siteId === id)?.name ?? '';
  const toggleSite = (id: string) => setOpenSites((o) => { const n = new Set(o); if (!n.delete(id)) n.add(id); return n; });
  // a site chosen on the map or in the search opens the branches above it
  useEffect(() => {
    if (!selected) return;
    const ups: string[] = [];
    let up = sites.find((x) => x.siteId === selected)?.parentId ?? null;
    while (up && !ups.includes(up)) {
      ups.push(up);
      const id: string = up;
      up = sites.find((x) => x.siteId === id)?.parentId ?? null;
    }
    if (ups.length) setOpenSites((o) => (ups.every((u) => o.has(u)) ? o : new Set([...o, ...ups])));
  }, [selected, sites]);
  /** One site of the list with its inside sites under its arrow, at any depth. */
  const siteRow = (s: (typeof sites)[number], depth: number): React.ReactNode => {
    const kids = byParent.get(s.siteId) ?? [];
    const open = openSites.has(s.siteId);
    return (
      <div key={s.siteId} className={'rs-node' + (depth ? ' is-inside' : '')} data-depth={depth}>
        <div className="rs-noderow">
          {kids.length > 0 ? (
            <button type="button" className={'rs-twisty' + (open ? ' open' : '')} aria-expanded={open} data-twisty={s.code}
              aria-label={(open ? 'إخفاء' : 'عرض') + ' المواقع الداخلية لـ«' + s.name + '»'} title={(open ? 'إخفاء' : 'عرض') + ' المواقع الداخلية'} onClick={() => toggleSite(s.siteId)}>{open ? '▾' : '◂'}</button>
          ) : <span className="rs-twisty-gap" aria-hidden="true" />}
          <button className={'rs-item' + (s.siteId === selected ? ' active' : '')} data-site={s.code} onClick={() => (setAdding(false), setSelected(s.siteId))}>
            <span className="rs-item-head"><b>{s.name}</b><small className="tz-code">{s.code}</small></span>
            <small>{depth === 0 ? 'موقع رئيسي' : 'موقع داخلي'} · {s.boundary ? 'حدود مسجلة' : 'علامة'}{kids.length > 0 && <span className="rs-kids"> · {kids.length === 1 ? 'موقع داخلي واحد' : kids.length + ' مواقع داخلية'}</span>}{delRequests.some((q) => q.siteId === s.siteId) && <span className="rs-delreq" data-testid="delete-requested"> · طلب حذف</span>}</small>
          </button>
        </div>
        {canSites && s.siteId === selected && (
          <button className="tz-add-inside-row" data-testid="add-inside-row" onClick={() => startAdd({ siteId: s.siteId, name: s.name })}>＋ موقع داخل «{s.name}»</button>
        )}
        {open && kids.length > 0 && <div className="rs-children" data-testid={'inside-of-' + s.code}>{kids.map((k) => siteRow(k, depth + 1))}</div>}
      </div>
    );
  };
  // the data on the left, the work on the right (owner, 10 Nov 2026): the site list, and the steps or the chosen site's card
  const listPanel = () => (
    <div className="tz-rail">
      <section className="tz-drawer open tz-site-list" aria-label="المواقع">
        <div className="tz-drawer-head">
          <span className="tz-drawer-toggle"><Icon name="pin" /><span>المواقع</span><span className="tz-chip">{sites.length}</span></span>
        </div>
        {sites.length > 0 && (
          <div className="sw-railq">
            <input className="sw-input" type="search" aria-label="بحث في المواقع" placeholder="ابحث باسم الموقع أو رمزه" value={railQ} onChange={(e) => setRailQ(e.target.value)} />
          </div>
        )}
        <div className="rs-list" data-testid="setup-tree">
          {roots.length === 0 && <div className="tz-muted tz-pad">لا مواقع بعد. ابدأ بـ«إضافة موقع».</div>}
          {railQ.trim() && sites.filter((s) => s.name.includes(railQ.trim()) || s.code.toLowerCase().includes(railQ.trim().toLowerCase())).map((s) => (
            <button key={s.siteId} className={'rs-item' + (s.siteId === selected ? ' active' : '')} data-site={s.code} onClick={() => (setAdding(false), setSelected(s.siteId))}>
              <span className="rs-item-head"><b>{s.name}</b><small className="tz-code">{s.code}</small></span>
              <small>{s.parentId ? `داخل «${nameOf(s.parentId)}»` : 'موقع رئيسي'} · {s.boundary ? 'حدود مسجلة' : 'علامة'}</small>
            </button>
          ))}
          {!railQ.trim() && roots.map((s) => siteRow(s, 0))}
        </div>
      </section>
    </div>
  );
  const workPanel = () => (
    <div className="tz-rail">
      <section className="tz-drawer open tz-site-work" aria-label="موقع تمركز مبدئي">
        <div className="tz-drawer-head">
          <span className="tz-drawer-toggle"><Icon name="tent" /><span>موقع تمركز مبدئي</span></span>
          {canSites && <button className="button primary compact tz-new" data-testid="add-site" aria-pressed={adding && !made} disabled={adding && !made} onClick={() => startAdd()}>＋ موقع جديد</button>}
        </div>
        {/* «موقع جديد» right under its button, the whole height of the panel (owner, 10 Nov 2026) */}
        <div className="sw-fill" data-testid="setup-context">
          {adding ? addPanel : sitePanel ?? (
            <section className="tz-card">
              <h3>تحديد مواقع التمركز المبدئية</h3>
              <p className="tz-muted">اختر الوحدة، ثم أنشئ موقعها وارسم حدوده: يصبح تمركزها المبدئي. اختر موقعاً من قائمة «المواقع»، أو اضغط «＋ موقع جديد».</p>
            </section>
          )}
        </div>
      </section>
    </div>
  );
  // ---- «موقع جديد»: one question per card, as in MOVER --------------------------------------------------------------------
  // every card folds on its title and opens again (owner, 10 Nov 2026): a long list is chosen, then folded away
  const foldBtn = (key: string, label: string) => (
    // a neutral name, so a field's label is never matched by its card's fold button
    <button type="button" className="sw-fold" aria-expanded={!folded.has(key)} aria-label={folded.has(key) ? 'فتح البطاقة' : 'طي البطاقة'} title={(folded.has(key) ? 'فتح: ' : 'طي: ') + label} data-fold={key} onClick={() => setFolded((f) => { const n = new Set(f); if (!n.delete(key)) n.add(key); return n; })}>{folded.has(key) ? '◂' : '▾'}</button>
  );
  const card = (n: number, title: string, body: React.ReactNode, id?: string) => (
    <section className={'sw-q' + (folded.has('s' + step + '-' + n) ? ' folded' : '')} data-q={n} data-testid={id}>
      <h4 className="sw-qh"><span className="sw-n">{n}</span>{title}{foldBtn('s' + step + '-' + n, title)}</h4>
      {body}
    </section>
  );
  const parentSite = sites.find((s) => s.siteId === form.parentId) ?? null;
  const parentHits = sites.filter((s) => !parentQ.trim() || s.name.includes(parentQ.trim()) || s.code.toLowerCase().includes(parentQ.trim().toLowerCase())).slice(0, 30);
  const poly = shape === 'POLYGON';
  const step2 = (
    <div className="sw-body">
      {card(1, poly ? 'ارسم حدود الموقع' : 'حدّد مكان الموقع', (
        <>
          <div className="sw-choices">
            <button type="button" className={'sw-choice' + (poly ? ' on' : '')} aria-pressed={poly} data-testid="shape-polygon" onClick={() => pickShape('POLYGON')}>منطقة لها حدود</button>
            <button type="button" className={'sw-choice' + (!poly ? ' on' : '')} aria-pressed={!poly} data-testid="shape-point" onClick={() => pickShape('POINT')}>نقطة واحدة</button>
          </div>
          <div className="sw-ways">
            {poly ? (
              <button type="button" className={'sw-way' + (drawing ? ' on' : '')} data-testid="draw-site" onClick={draw}>
                <Icon name="boundary" /><b>{geometry ? 'ارسمها من جديد' : 'ارسم على الخريطة'}</b><small>انقر عند كل زاوية، وانقر مرتين للإنهاء</small>
              </button>
            ) : (
              <button type="button" className={'sw-way' + (placing ? ' on' : '')} data-testid="place-point" onClick={() => { setTyping(false); setWizErr(''); setPlacing(!placing); }}>
                <Icon name="pin" /><b>{point ? 'غيّر المكان' : 'حدّد المكان على الخريطة'}</b><small>نقرة واحدة</small>
              </button>
            )}
            <button type="button" className={'sw-way' + (typing ? ' on' : '')} data-testid="type-coords" aria-pressed={typing} onClick={() => { setPlacing(false); setTyping(!typing); if (!typing && rows.length === 0) setRows(poly ? [0, 1, 2].map(() => ({ text: '', point: null, error: '' })) : [{ text: '', point: null, error: '' }]); }}>
              <Icon name="grid" /><b>اكتب الإحداثيات</b><small>جدول بنقطة في كل سطر، بأي صيغة</small>
            </button>
          </div>
          {drawing ? (
            <div className="sw-drawing">
              <p className="sw-hint">انقر على الخريطة عند كل زاوية، بقدر ما تحتاج{drawInfo ? ` — ${drawInfo.count} حتى الآن` : ''}. للإغلاق: انقر على أول نقطة، أو انقر مرتين، أو اضغط «إنهاء الرسم».</p>
              <button type="button" className="button primary" data-testid="finish-draw" disabled={!drawInfo?.canFinish} onClick={() => editor.current?.finishDrawing()}>إنهاء الرسم</button>
            </div>
          ) : placing ? <p className="sw-hint">انقر على الخريطة في مكان الموقع.</p>
            : (poly ? geometry : point) ? <p className="sw-done" data-testid="shape-done">✓ {poly ? 'تم رسم الحدود: ' + shapeText(shape, geometry) + '. اسحبها لنقلها كاملة.' : 'تم تحديد المكان.'}</p>
            : <p className="sw-hint">لم {poly ? 'تُرسم' : 'يُحدد'} بعد.</p>}
          {typing && (poly && geometry && !cornersOf(geometry)
            ? <p className="sw-hint">لهذا الموقع أكثر من جزء: تُعدّل أجزاؤه على الخريطة.</p>
            : <PointsTable rows={rows} fmt={fmt} single={!poly} picking={pickRow} onRows={(r) => applyRows(r)} onFormat={setFmt} onPick={pickFor} />)}
          {poly && (geometry || drawing) && shapeTools}
          {poly && <button type="button" className="sw-link" disabled={!geometry || drawing} data-testid="add-part" onClick={addPart}>＋ جزء آخر لهذا الموقع (يتحرك معه)</button>}
        </>
      ))}
    </div>
  );
  // ---- «تحديد مواقع التمركز المبدئية» (owner brief and reference, phase 2): three steps, the unit first --------------------------
  const initialStep1 = (
    <div className="sw-body sw-form" data-testid="initial-step-1">
      <div className="sw-f">
        <span className="sw-l">الجهة / الوحدة</span>
        {owner && !ownerOpen ? (
          <div className={'sw-picked' + (ownerBlock ? ' is-blocked' : '')} data-testid="unit-picked"><span className="sw-ok">{ownerBlock ? '!' : '✓'}</span><div><b>{owner.name}</b>
            <small>{ownerBlock ? `${ownerBlock}: تمركزها المعتمد يتغير بطلب إعادة تمركز.` : 'تتمركز في هذا الموقع عند الحفظ — تمركزها المبدئي.'}</small></div>
            <button type="button" className="sw-link" onClick={() => setOwnerOpen(true)}>تغيير</button></div>
        ) : (
          <div className="sw-sub sw-tree" data-testid="unit-tree">
            <OrgTree selectedId={owner?.id ?? null} includeSub={false} onIncludeSub={() => undefined} subOption={false} revision={app.revision}
              onSelect={(o) => { setOwner(o); setOwnerOpen(false); }} />
          </div>
        )}
      </div>
      <label className="sw-f"><span className="sw-l">اسم الموقع</span>
        <input className="sw-input" aria-label="اسم الموقع" placeholder="مثال: معسكر صحة 1أ" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label className="sw-f"><span className="sw-l">نوع الموقع</span>
        <select className="sw-input" aria-label="نوع الموقع" value={otherKind ? '__other' : form.kind} onChange={(e) => {
          if (e.target.value === '__other') { setOtherKind(true); setForm({ ...form, kind: '' }); } else { setOtherKind(false); setForm({ ...form, kind: e.target.value }); }
        }}>
          {MAIN_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          <option value="__other">نوع آخر…</option>
        </select>
        {otherKind && <input className="sw-input" aria-label="تصنيف الموقع" placeholder="اكتب النوع" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} />}
      </label>
      <div className="sw-f"><span className="sw-l">موقع رئيسي أو داخلي</span>
        <div className="sw-choices">
          <button type="button" className={'sw-choice' + (!inside ? ' on' : '')} aria-pressed={!inside} data-testid="where-main" onClick={() => { setInside(false); setForm({ ...form, parentId: '' }); }}>موقع رئيسي</button>
          <button type="button" className={'sw-choice' + (inside ? ' on' : '')} aria-pressed={inside} data-testid="where-inside" disabled={sites.length === 0} onClick={() => setInside(true)}>موقع داخلي</button>
        </div>
        {inside && (parentSite ? (
          <div className="sw-picked" data-testid="parent-picked"><span className="sw-ok">✓</span><div><b>داخل «{parentSite.name}»</b><small>{parentSite.code}</small></div>
            <button type="button" className="sw-link" onClick={() => setForm({ ...form, parentId: '' })}>تغيير</button></div>
        ) : (
          <div className="sw-sub">
            <input className="sw-input" type="search" aria-label="بحث عن الموقع الأعلى" placeholder="ابحث عن الموقع الرئيسي باسمه أو رمزه" value={parentQ} onChange={(e) => setParentQ(e.target.value)} />
            <ul className="sw-list">
              {parentHits.map((s) => <li key={s.siteId}><button type="button" className="sw-row" data-parent-pick={s.code} onClick={() => setForm({ ...form, parentId: s.siteId })}><b>{s.name}</b><small>{s.code}</small></button></li>)}
              {parentHits.length === 0 && <li className="sw-hint">لا نتائج.</li>}
            </ul>
          </div>
        ))}
      </div>
      <div className="sw-f" data-testid="symbol-card"><span className="sw-l">رمز الموقع على الخريطة</span><SiteSymbolPicker value={symbol} onChange={setSymbol} /></div>
      <label className="sw-f"><span className="sw-l">الملاحظات</span>
        <textarea className="sw-input" rows={2} aria-label="ملاحظات الموقع" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </label>
    </div>
  );
  const initialSummary: [string, string][] = [
    ['الوحدة', owner ? `${owner.name} — التمركز المبدئي` : '—'],
    ['اسم الموقع', form.name.trim()],
    ['نوع الموقع', form.kind.trim()],
    ['الموقع', inside && parentSite ? `داخلي — داخل «${parentSite.name}»` : 'موقع رئيسي'],
    ['الرمز', symbol ? symbolEntry(symbol)?.label ?? symbol : 'بدون رمز'],
    ['الحدود', shapeText(shape, geometry)],
    ...(poly && geometry ? [['المساحة', formatArea(siteArea(partsOf(geometry)))] as [string, string]] : []),
    ['الملاحظات', form.notes.trim() || '—'],
    ['رمز الموقع', 'يُعطى تلقائياً عند الحفظ'],
  ];
  const initialStep3 = (
    <div className="sw-body" data-testid="initial-step-3">
      <dl className="sw-sum" data-testid="site-summary">{initialSummary.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="sw-done" data-testid="initial-note">بعد الحفظ يصبح هذا الموقع التمركز المبدئي المعتمد لـ«{owner?.name ?? 'الوحدة'}». ومناطق الانتشار تُطلب بعده من «طلب مناطق انتشار».</p>
      <label className="sw-f"><span className="sw-l">سبب التسجيل</span>
        <textarea className="sw-input" rows={2} aria-label="سبب تسجيل الموقع" placeholder="يُحفظ في سجل التدقيق باسمك" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </label>
      {!maySave && <p className="sw-err" role="note" data-testid="save-needs-right">حفظ الموقع مع تمركزه المبدئي يحتاج «صلاحيات تهيئة المواقع» (الإعدادات). اطلبها من مدير النظام.</p>}
      <button type="button" className="sw-go" data-testid="save-initial" disabled={drawing || busy || !maySave} onClick={() => void saveInitial()}>{busy ? 'جارٍ الحفظ…' : 'حفظ الموقع والتمركز المبدئي'}</button>
      {saveError && <p className="sw-err" role="alert" data-testid="save-error">{saveError}</p>}
    </div>
  );
  const stepBody = step === 1 ? initialStep1 : step === 2 ? step2 : initialStep3;
  const addPanel = (
    <section className="sw-wizard" data-testid="add-site-form" data-step={made ? 'done' : step}>
      <div className="sw-top">
        <button type="button" className="sw-back" onClick={stopAdd}>→ رجوع</button>
        <h3 className="sw-title">موقع تمركز مبدئي جديد</h3>
      </div>
      {made ? (
        <div className="sw-body" data-testid="site-made">
          <p className="sw-done">✓ سُجل «{made.name}» برمز <bdi data-testid="made-code">{made.code}</bdi></p>
          {!!made.units && <p className="sw-done" data-testid="made-units">✓ «{made.unit}» متمركزة فيه: هذا تمركزها المبدئي المعتمد، في حفظ واحد مُدقَّق.</p>}
          <p className="sw-hint">ظهر في قائمة المواقع وعلى الخريطة. مناطق انتشار الوحدة تُطلب من «طلب مناطق انتشار»، ويبدأ الطلب من هذا الموقع.</p>
          <button type="button" className="sw-go" onClick={() => { const id = made.id; stopAdd(); setSelected(id); }}>فتح بطاقة الموقع</button>
          <div className="sw-nav2">
            <button type="button" className="sw-link" onClick={() => startAdd()}>إضافة موقع آخر</button>
            <button type="button" className="sw-link" onClick={stopAdd}>إغلاق</button>
          </div>
        </div>
      ) : (
        <>
          {/* six steps keep the strip on one line: the current step is named, the others show their number (named on hover) */}
          <ol className="sw-steps" aria-label={`الخطوة ${step} من ${INITIAL_STEPS.length}`}>
            {INITIAL_STEPS.map((t, i) => (
              <li key={t} className={'sw-step' + (i + 1 === step ? ' on' : i + 1 < step ? ' done' : '')} aria-current={i + 1 === step ? 'step' : undefined} title={t}><b>{i + 1 < step ? '✓' : i + 1}</b><span>{t}</span></li>
            ))}
          </ol>
          {wizErr && <p className="sw-err" role="alert">{wizErr}</p>}
          {stepBody}
          <div className="sw-nav">
            {step < 3 && <button type="button" className="sw-go" data-testid="wizard-next" onClick={() => goStep((step + 1) as SetupStep)}>التالي ←</button>}
            <div className="sw-nav2">
              {step > 1 ? <button type="button" className="sw-link" data-testid="wizard-back" onClick={() => goStep((step - 1) as SetupStep)}>→ السابق</button> : <span />}
              <button type="button" className="sw-link sw-cancel" onClick={stopAdd}>إلغاء</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
  const siteGeo = detail?.geometry?.geojson as unknown as SiteGeometry | undefined;
  const siteKids = site ? byParent.get(site.siteId) ?? [] : [];
  const mayManage = canSites && !!detail?.canManage;
  const dataChanged = !!detail && (edit.name.trim() !== detail.name || edit.kind.trim() !== detail.kind || (edit.parentId || '') !== (detail.parentId ?? '') || !!edit.notes.trim());
  const symbolChanged = symEdit !== undefined && symEdit !== (detail?.symbol?.sidc ?? null);
  const openEdit = () => {
    if (!detail) return;
    setEdit({ name: detail.name, code: detail.code, kind: detail.kind, parentId: detail.parentId ?? '', notes: '', reason: '' });
    setSymEdit(detail.symbol?.sidc ?? null);
    setCardEdit(true);
    setDelOpen(false);
  };
  const closeEdit = () => {
    setCardEdit(false);
    setSymEdit(undefined);
    if (editingShape) {
      setEditingShape(false);
      editor.current?.load(null, false);
    }
  };
  // one «حفظ التعديلات» with one reason: the data, the symbol and the boundary, each only when it changed
  const saveCard = () => {
    if (!site || !detail) return;
    const reason = edit.reason.trim();
    return act(async () => {
      if (dataChanged) await api.updateSite(site.siteId, { code: edit.code, name: edit.name.trim(), kind: edit.kind.trim(), parentId: edit.parentId || null, capacity: detail.capacity, location: detail.location, notes: edit.notes.trim() || null, reason });
      if (symbolChanged) await api.setSiteSymbol(site.siteId, { symbol: symEdit ?? null, reason });
      if (editingShape && geometry) await api.saveSiteGeometry(site.siteId, { geometry, crs: 'EPSG:4326', expectedVersion: detail.geometryVersion ?? 0, reason, method: 'DRAWN' });
    }, 'حُفظت التعديلات', closeEdit);
  };
  useEffect(() => {
    setCardEdit(false);
    setDelOpen(false);
    setDelReason('');
    setDelImpact(null);
    setDelErr('');
    setDelAck(false);
  }, [selected]);
  useEffect(() => {
    if (admin) api.siteDeletionRequests().then(setDelRequests, () => setDelRequests([]));
  }, [admin, app.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  // the impact comes from the server when the panel opens: the inside sites, the units, and what stops it
  useEffect(() => {
    if (!delOpen || !site) return;
    setDelImpact(null);
    api.siteDeletion(site.siteId).then(setDelImpact, (e: Error) => setDelErr(e.message));
  }, [delOpen, site?.siteId]); // eslint-disable-line react-hooks/exhaustive-deps
  const runDelete = (what: () => Promise<unknown>, done: string, after?: () => void) => {
    setDelErr('');
    setBusy(true);
    what().then(() => {
      app.toast(done);
      app.bump();
      after?.();
    }, (e: Error) => setDelErr(e.message)).finally(() => setBusy(false));
  };
  const facts: [string, React.ReactNode][] = site ? [
    ['النوع', detail?.kind || '—'],
    ['المكان', detail?.parentId ? `داخل «${nameOf(detail.parentId)}»` : 'موقع رئيسي'],
    ['الوحدة المتمركزة', occ ? (occ.stationed.length ? occ.stationed.map((u) => u.orgName).join('، ') + ' — التمركز المبدئي' : 'لا تمركز') + (occ.otherStationed ? ` · وجهة أخرى: ${occ.otherStationed}` : '') : '…'],
    ['الحدود', siteGeo && (siteGeo.type === 'Polygon' || siteGeo.type === 'MultiPolygon') ? `منطقة مسجلة · ${formatArea(siteArea(partsOf(siteGeo)))}` : 'علامة على الخريطة'],
    ['المواقع الداخلية', siteKids.length ? siteKids.map((k) => k.name).join('، ') : '—'],
    ['الوحدات المرتبطة', occ?.linked.length ? occ.linked.map((l) => l.orgName).join('، ') + ' (الربط ليس تمركزاً)' : '—'],
  ] : [];
  // the owner's rules (17 Nov 2026): erased completely; a unit stationed there loses that initial stationing and its areas;
  // the inside sites go with it, each named in a warning first
  const subtree = (id: string): typeof sites => (byParent.get(id) ?? []).flatMap((k) => [k, ...subtree(k.siteId)]);
  const related = site ? subtree(site.siteId) : [];
  const unitsAt = (id: string) => registered.current.filter((r) => r.siteId === id).map((r) => `«${r.orgName}»`);
  const pendingDel = delImpact?.pending ?? null;
  const blockers = delImpact?.blockers ?? [];
  const insideDel = delImpact?.inside ?? related.map((k) => ({ id: k.siteId, code: k.code, name: k.name }));
  const deletePanel = site && (
    <section className="tz-card sc-delete" data-testid="delete-panel">
      <h4>{admin ? `حذف «${site.name}» نهائياً؟` : `طلب حذف «${site.name}»`}</h4>
      {!delImpact && !delErr && <p className="sw-hint">جارٍ فحص ما يشمله الحذف…</p>}
      <ul className="sc-impact">
        <li>يُحذف الموقع نهائياً من النظام: بياناته وحدوده ورمزه. لا يمكن التراجع عن الحذف.</li>
        {!!delImpact?.stationed.length && <li>يُحذف تمركز {delImpact.stationed.map((u) => `«${u.unit}»`).join('، ')} فيه ومناطق انتشاره، وتعود الوحدة بلا تمركز.</li>}
        <li>يبقى في سجل التدقيق سطر واحد: من حذف الموقع ومتى ولماذا.</li>
        {!admin && <li>يصل الطلب إلى مدير النظام، فيعتمد الحذف أو يرفضه، ويصلك قراره.</li>}
      </ul>
      {insideDel.length > 0 && (
        <div className="sc-warn" role="alert" data-testid="delete-related">
          <b>⚠ يُحذف معه {insideDel.length === 1 ? 'موقع داخلي واحد' : insideDel.length + ' مواقع داخلية'} وكل ما فيها:</b>
          <ul>
            {insideDel.map((k) => {
              const u = unitsAt(k.id);
              return <li key={k.id}>«{k.name}» <small className="tz-code">{k.code}</small>{u.length ? ` — ويُحذف تمركز ${u.join('، ')} فيه` : ''}</li>;
            })}
          </ul>
        </div>
      )}
      {blockers.length > 0 && (
        <div className="sc-warn" role="alert" data-testid="delete-blockers">
          <b>لا يُحذف الآن:</b>
          <ul>{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      )}
      {pendingDel && (
        <p className={admin ? 'sc-pending' : 'sw-hint'} data-testid="delete-request-open">
          {admin ? `طلب حذف من ${pendingDel.requester}: «${pendingDel.reason}»` : `طلب حذف مفتوح بانتظار مدير النظام: «${pendingDel.reason}»`}
        </p>
      )}
      {(admin || !pendingDel) && (
        <>
          <label className="sc-ack"><input type="checkbox" data-testid="delete-ack" checked={delAck} onChange={(e) => setDelAck(e.target.checked)} />
            <span>{insideDel.length ? 'أفهم أن الحذف نهائي ويشمل المواقع الداخلية أعلاه.' : 'أفهم أن الحذف نهائي.'}</span></label>
          <label className="sw-f"><span className="sw-l">{admin ? (pendingDel ? 'سبب القرار' : 'سبب الحذف') : 'سبب طلب الحذف'}</span>
            <textarea className="sw-input" rows={2} aria-label={admin ? 'سبب الحذف' : 'سبب طلب الحذف'} value={delReason} onChange={(e) => setDelReason(e.target.value)} />
          </label>
        </>
      )}
      <div className="sc-actions">
        {admin && (
          <button type="button" className="button sc-danger" data-testid="confirm-delete" disabled={busy || !delImpact || blockers.length > 0 || delReason.trim().length < 5 || !delAck}
            onClick={() => runDelete(() => (pendingDel ? api.decideSiteDeletion(pendingDel.id, 'APPROVE', delReason) : api.deleteSite(site.siteId, delReason)), 'حُذف الموقع', () => { setDelOpen(false); setSelected(null); setDelReason(''); })}>
            {pendingDel ? 'اعتماد الحذف' : insideDel.length ? `حذف الموقع و${insideDel.length === 1 ? 'موقعه الداخلي' : 'مواقعه الداخلية'}` : 'حذف الموقع'}
          </button>
        )}
        {admin && pendingDel && (
          <button type="button" className="button" data-testid="refuse-delete" disabled={busy || delReason.trim().length < 5}
            onClick={() => runDelete(() => api.decideSiteDeletion(pendingDel.id, 'REFUSE', delReason), 'رُفض طلب الحذف', () => { setDelOpen(false); setDelReason(''); })}>رفض الطلب</button>
        )}
        {!admin && !pendingDel && (
          <button type="button" className="button sc-danger" data-testid="send-delete-request" disabled={busy || !delImpact || delReason.trim().length < 5 || !delAck}
            onClick={() => runDelete(() => api.requestSiteDeletion(site.siteId, delReason), 'أُرسل طلب الحذف إلى مدير النظام', () => api.siteDeletion(site.siteId).then(setDelImpact))}>إرسال طلب الحذف</button>
        )}
        <button type="button" className="button" onClick={() => { setDelOpen(false); setDelAck(false); setDelErr(''); }}>إغلاق</button>
      </div>
      {delErr && <p className="sw-err" role="alert" data-testid="delete-error">{delErr}</p>}
    </section>
  );
  const sitePanel = site && (
    <>
      <section className="tz-card sc-card" data-testid="site-card">
        <div className="sc-head">
          <span className="sc-sym" data-symbol={detail?.symbol?.sidc ?? ''}>{detail?.symbol ? <SymbolArt sidc={detail.symbol.sidc} size={44} /> : <Icon name="pin" />}</span>
          <div>
            <h2 className="tz-site-title">{site.name}</h2>
            <p className="tz-muted micro">{site.code}{detail?.symbol ? ` · ${symbolEntry(detail.symbol.sidc)?.label ?? 'رمز مخصص'}` : ''}</p>
          </div>
        </div>
        {!cardEdit && <dl className="sw-sum sc-facts" data-testid="site-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
        {!cardEdit && (
          <div className="sc-actions" data-testid="site-actions">
            {mayManage && <button type="button" className="button primary" data-testid="edit-site" onClick={openEdit}>تعديل</button>}
            {canSites && <button type="button" className="button" data-testid="add-inside" onClick={() => startAdd({ siteId: site.siteId, name: site.name })}>＋ موقع داخل</button>}
            {mayManage && <button type="button" className="button sc-danger-link" data-testid={admin ? 'delete-site' : 'request-delete'} aria-pressed={delOpen} onClick={() => { setDelOpen(!delOpen); setDelErr(''); }}>{admin ? 'حذف الموقع' : 'طلب حذف'}</button>}
          </div>
        )}
        {cardEdit && detail && (
          <div className="sw-form sc-edit" data-testid="site-edit">
            <label className="sw-f"><span className="sw-l">اسم الموقع</span><input className="sw-input" aria-label="اسم الموقع" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="sw-f"><span className="sw-l">نوع الموقع</span><input className="sw-input" aria-label="تصنيف الموقع" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} /></label>
            <label className="sw-f"><span className="sw-l">يقع داخل</span>
              <select className="sw-input" aria-label="الموقع الرئيسي" value={edit.parentId} onChange={(e) => setEdit({ ...edit, parentId: e.target.value })}>
                <option value="">— موقع رئيسي —</option>
                {sites.filter((x) => x.siteId !== site.siteId).map((x) => <option key={x.siteId} value={x.siteId}>{x.name}</option>)}
              </select>
            </label>
            <div className="sw-f"><span className="sw-l">رمز الموقع على الخريطة</span><SiteSymbolPicker value={symEdit ?? null} onChange={setSymEdit} /></div>
            <div className="sw-f"><span className="sw-l">الحدود</span>
              {!editingShape ? <button type="button" className="button" data-testid="edit-shape" onClick={startShape}>تعديل الحدود على الخريطة</button>
                : <><p className="micro tz-muted">اسحب الحدود لنقلها كاملة، أو عدّل رؤوسها. لا يُكتب شيء قبل الحفظ.</p>{shapeTools}</>}
            </div>
            <label className="sw-f"><span className="sw-l">ملاحظات (تبقى كما هي إن تُركت فارغة)</span><input className="sw-input" aria-label="ملاحظات الموقع" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
            <label className="sw-f"><span className="sw-l">سبب التعديل</span><textarea className="sw-input" rows={2} aria-label="سبب التعديل" placeholder="يُحفظ في سجل التدقيق باسمك" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></label>
            <div className="sc-actions">
              <button type="button" className="button primary" data-testid="save-edit" disabled={busy || drawing || edit.reason.trim().length < 5 || !edit.name.trim() || !(dataChanged || symbolChanged || (editingShape && !!geometry))} onClick={() => void saveCard()}>حفظ التعديلات</button>
              <button type="button" className="button" onClick={closeEdit}>إلغاء</button>
            </div>
          </div>
        )}
      </section>
      {delOpen && !cardEdit && deletePanel}
      {!cardEdit && (canCorrect || canLinks) && (
        <details className="tz-card sc-more" data-testid="site-more">
          <summary>إجراءات أخرى</summary>
          {canCorrect && (
            <>
              <h4>تثبيت تمركز (تصحيح مُدقَّق)</h4>
              <p className="micro tz-muted">للتصحيح فقط: كل وحدة تُختار بنفسها، ولا ينتقل معها من يتبعها. أما الطلب العادي فيمر بالاعتمادات.</p>
              <OrgSelect q={q} setQ={setQ} orgs={orgs} value={stOrg} onChange={setStOrg} label="وحدة التمركز" />
              <label className="field"><span>السبب</span><textarea aria-label="سبب التمركز" value={stReason} onChange={(e) => setStReason(e.target.value)} /></label>
              <button className="button" data-testid="correct-stationing" disabled={busy || !stOrg || stReason.trim().length < 5} onClick={() => act(() => api.correctStationing({ organizationId: stOrg, siteId: site.siteId, reason: stReason }), 'سُجل التمركز', () => (setStOrg(''), setStReason('')))}>تثبيت</button>
            </>
          )}
          {canLinks && (
            <>
              <h4>ربط وحدة بالموقع <small>(الربط ليس تمركزاً)</small></h4>
              <ul className="tz-sites">
                {occ?.linked.map((l) => (
                  <li key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><b>{l.orgName}</b><button className="button compact" style={{ width: 'auto', flex: 'none' }} onClick={() => { const why = window.prompt('سبب إنهاء الربط'); if (why && why.trim().length >= 5) void act(() => api.endSiteLink(l.id, why), 'أُنهي الربط'); }}> إنهاء</button></li>
                ))}
              </ul>
              <OrgSelect q={q} setQ={setQ} orgs={orgs} value={linkOrg} onChange={setLinkOrg} label="وحدة الربط" />
              <label className="field"><span>السبب</span><textarea aria-label="سبب الربط" value={linkReason} onChange={(e) => setLinkReason(e.target.value)} /></label>
              <button className="button" data-testid="add-link" disabled={busy || !linkOrg || linkReason.trim().length < 5} onClick={() => act(() => api.createSiteLink({ siteId: site.siteId, organizationId: linkOrg, reason: linkReason }), 'أُضيف الربط', () => (setLinkOrg(''), setLinkReason('')))}>إضافة ربط</button>
            </>
          )}
        </details>
      )}
    </>
  );
  // Owner UX consolidation §4 (20 Nov 2026): Site Setup is a mode of «مساحة التمركز», not a separate page.
  return (
    <StationingShell mode="site-setup" onExit={() => (location.hash = 'restationing')} exitLabel="العودة إلى مساحة التمركز">
      <OperationalWorkspace
        listRail
        swapSides
        panels="siteSetup"
        railLabel="موقع تمركز مبدئي"
        contextLabel="المواقع"
        sheetKey={(adding ? 'add' : '') + (selected ?? '')}
        rail={workPanel()}
        context={listPanel()}
        centre={app.state?.empty ? (
          <EmptyCentre title="لم تُستورد الوحدات بعد" hint="تُهيأ مواقع التمركز بعد استيراد الوحدات من مصدر الموارد البشرية في الإعدادات." />
        ) : (
          <MapFrame title={<span className="tz-mapstep"><Icon name="tent" /><b>تحديد مواقع التمركز المبدئية</b></span>} mode={mode} setMode={setMode} view={view} setView={setView} has3d={!!terrain3d} placing={placing || drawing || placingArea} legend={legend}>
            {terrain3d !== undefined && <RequestMap view={view} terrain3d={terrain3d} request={EMPTY_MAP} checks={null} mode={mode} fitMaxZoom={13} hideSite fit={false} onMap={onMap} referenceInteractive={!adding && !editingShape} fitSites pick={adding || editingShape ? null : { selectedId: selected, onPick: (id) => setSelected(id) }} focus={selected ? { siteId: selected, key: selected.length } : adding && form.parentId ? { siteId: form.parentId, key: form.parentId.length + 1 } : null} />}
          </MapFrame>
        )}
      />
    </StationingShell>
  );
}

function OrgSelect({ q, setQ, orgs, value, onChange, label }: { q: string; setQ: (s: string) => void; orgs: { id: string; name: string }[]; value: string; onChange: (s: string) => void; label: string }) {
  return (
    <>
      <label className="field"><span>بحث عن وحدة</span><input aria-label={'بحث ' + label} value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <label className="field"><span>الوحدة</span>
        <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— اختر —</option>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
    </>
  );
}
