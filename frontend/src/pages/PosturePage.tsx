import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type PostureUnit } from '../api/client';
import type { GeoPolygon, RestationingListItem, RestationingRequest, RestationingState, SiteGeometry } from '../api/types';
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { PITCH_3D, addOverlayLayer, installedTerrain3d, type MapView } from '../components/map/maplibre';
import { MAP_COLOURS } from '../components/workspace/RequestMap';
import type { BasemapMode, Terrain3dSource } from '../components/map/maplibre/offlineStyle';
import { flatSource } from '../components/tree/tree';
import { UnitTree } from '../components/tree/UnitTree';
import { Icon } from '../components/ui';
import { MapModeSwitcher, ViewSwitcher, MapLegend } from '../components/workspace/MapFrame';
import { EmptyCentre } from '../components/workspace/EmptyCentre';
import { RequestMap } from '../components/workspace/RequestMap';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { PURPOSE_TITLE, UNIT_STATE, isPurpose } from '../lib/requestPurpose';

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
 * Owner, 21 Nov 2026 operational-posture model: the right rail is organised by camp (الموقع), not by flat unit. Four
 * tabs — the first two group units UNDER their camps (so the rail reads «موقع → وحدات داخل الموقع»), «غير متمركزة» lists
 * organisational hierarchy under its top unit, and «طلبات» is split into two groups (stationing vs deployment).
 */
type Cohort = 'stationed' | 'incomplete' | 'noStationing' | 'requests';
const COHORTS: readonly [Cohort, string][] = [
  ['stationed', 'الوحدات المتمركزة'],
  ['incomplete', 'وحدات بدون مناطق انتشار'],
  ['noStationing', 'وحدات غير متمركزة'],
  ['requests', 'طلبات التمركز والانتشار'],
];

type LayerState = {
  sites: boolean; units: boolean; primary: boolean; sub: boolean;
  boundaries: boolean; terrain: boolean; satellite: boolean;
};

type Selection = { kind: 'unit'; unitId: string } | { kind: 'site'; siteId: string } | null;

/**
 * «الموقف العملياتي» — posture map that renders EVERY authorised unit's current site + PRIMARY + SUB + marker from the
 * single `/operational-posture` API response (not a single-unit synthetic request). The selected unit still gets the
 * stronger emphasis layer (via RequestMap on top), so the overview stays visible under it. Clicking a posture marker
 * or a shared site opens the single-context selection card; one-at-a-time rule (brief §12): never two cards.
 */
export function PosturePage() {
  const app = useApp();
  const [units, setUnits] = useState<PostureUnit[] | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [q, setQ] = useState('');
  const [cohort, setCohort] = useState<Cohort>('stationed');
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
  // Pending requests (geometry needed for brief §23 «قيد الاعتماد»): fetch the list once, then fetch the selected unit's
  // full request on demand so the proposed site/primary/sub can be drawn with the distinct amber-dashed style.
  const [pendingList, setPendingList] = useState<RestationingListItem[]>([]);
  const [pendingReq, setPendingReq] = useState<RestationingRequest | null>(null);

  const selected = selection?.kind === 'unit' ? selection.unitId : null;
  const siteInfoId = selection?.kind === 'site' ? selection.siteId : null;

  useEffect(() => {
    map?.easeTo({ pitch: view === '3d' ? PITCH_3D : 0, duration: 500 });
  }, [map, view]);
  useEffect(() => {
    installedTerrain3d().then(setTerrain3d);
    // Owner, 21 Nov 2026 operational-posture model §AF: no auto-selection on first open. The map renders the full
    // authorised posture; selection only happens after the user clicks a row, a search result, a marker or an area.
    api.operationalPosture().then((p) => setUnits(p.units)).catch((e: Error) => (setUnits([]), app.toast(e.message)));
    // Pending-request list for the posture layer. Pending = states the operator should see as proposed changes.
    const PENDING: RestationingState[] = ['UNDER_REVIEW', 'RETURNED_FOR_CHANGES', 'CANCELLATION_PENDING', 'START_HELD_PENDING_CANCELLATION', 'APPROVED_NOT_ACTIVATED'];
    api.restationingRequests().then((rows) => setPendingList(rows.filter((r) => PENDING.includes(r.state)))).catch(() => setPendingList([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);

  const tree = useMemo(() => flatSource(units ?? []), [units]);
  const unit = units?.find((u) => u.id === selected) ?? null;

  // When a selected unit has a pending request, fetch it and draw the proposal on the map (brief §F «distinct style»).
  useEffect(() => {
    if (!unit || !unit.request || pendingList.length === 0) { setPendingReq(null); return; }
    const match = pendingList.find((r) => r.requestingUnit.id === unit.id && r.purpose === unit.request?.purpose);
    if (!match) { setPendingReq(null); return; }
    let live = true;
    api.restationingRequest(match.id).then((req) => { if (live) setPendingReq(req); }).catch(() => { if (live) setPendingReq(null); });
    return () => { live = false; };
  }, [unit, pendingList]);

  // Pending-geometry GeoJSON: proposed site + proposed PRIMARY + proposed SUB from the fetched request's content.
  const pendingFC = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];
    if (pendingReq) {
      const c = pendingReq.content;
      const unitId = pendingReq.requestingUnit.id;
      if (c.site?.geometry) features.push({ type: 'Feature', geometry: c.site.geometry as unknown as GeoJSON.Geometry, properties: { role: 'SITE', unitId, requestNumber: pendingReq.number } });
      if (c.primary) features.push({ type: 'Feature', geometry: c.primary as GeoJSON.Geometry, properties: { role: 'PRIMARY', unitId, requestNumber: pendingReq.number } });
      if (c.alternative) features.push({ type: 'Feature', geometry: c.alternative as GeoJSON.Geometry, properties: { role: 'SUB', unitId, requestNumber: pendingReq.number } });
    }
    return { type: 'FeatureCollection', features };
  }, [pendingReq]);
  const req = useMemo(() => (unit ? asMapRequest(unit) : null), [unit]);
  useEffect(() => setFit((k) => k + 1), [selected]);

  // Posture overlay (brief §22 "several units' PRIMARY/SUB areas coexist" only — site polygons and site markers are
  // already rendered by RequestMap's ref-site/ref-marker/ref-label layers via useRegisteredSites, so we do NOT add our
  // own duplicates there; adding them caused visible stacking and double-labelling).
  const postureFC = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];
    for (const u of units ?? []) {
      const primary = u.primary as GeomLike;
      if (primary && (primary.type === 'Polygon' || primary.type === 'MultiPolygon')) {
        features.push({ type: 'Feature', geometry: primary as GeoJSON.Geometry, properties: { role: 'PRIMARY', unitId: u.id } });
      }
      const alt = u.alternative as GeomLike;
      if (alt && (alt.type === 'Polygon' || alt.type === 'MultiPolygon')) {
        features.push({ type: 'Feature', geometry: alt as GeoJSON.Geometry, properties: { role: 'SUB', unitId: u.id } });
      }
    }
    return { type: 'FeatureCollection', features };
  }, [units]);

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

  // One-selection helpers. A unit selection closes any site info; a site selection closes any unit selection.
  const selectUnit = (id: string) => setSelection({ kind: 'unit', unitId: id });
  const selectSite = (id: string) => setSelection({ kind: 'site', siteId: id });
  const clearSelection = () => setSelection(null);

  /**
   * Click resolver (brief §9/§10/§12): a site that has one authorised posture unit → select that unit; several → chooser;
   * a reference site with no posture unit → open the site info card (single-context rule). Return true always so the
   * underlying RequestMap doesn't also open its own info card.
   */
  const clickSite = (siteId: string | null): boolean => {
    if (!siteId) return true;
    const unitIds = siteToUnits.get(siteId) ?? [];
    if (unitIds.length === 1) { selectUnit(unitIds[0]); return true; }
    if (unitIds.length > 1) { setChooser({ siteId, siteName: sitesById.get(siteId) ?? siteId, unitIds }); return true; }
    selectSite(siteId);
    return true;
  };

  // Keep a ref so the map click handler reads the latest resolver.
  const clickSiteRef = useRef(clickSite);
  clickSiteRef.current = clickSite;

  // Posture overlay (PRIMARY/SUB polygons for ALL authorised units). RequestMap already draws the selected unit's full
  // request shape on top AND all registered sites+markers via ref-* layers (useRegisteredSites + bindSiteClicks), so we
  // do NOT add site polygons or site markers here — that was the overlap in the earlier screenshots. We only draw the
  // posture areas (PRIMARY/SUB) for every unit, with opacity that drops when the selection emphasises another unit.
  useEffect(() => {
    if (!map) return;
    const existing = map.getSource('posture-all') as GeoJSONSource | undefined;
    if (existing) { existing.setData(postureFC); return; }
    map.addSource('posture-all', { type: 'geojson', data: postureFC });
    addOverlayLayer(map, {
      id: 'posture-primary-fill', type: 'fill', source: 'posture-all',
      filter: ['==', ['get', 'role'], 'PRIMARY'],
      paint: { 'fill-color': MAP_COLOURS.PRIMARY, 'fill-opacity': 0.18 },
    });
    addOverlayLayer(map, {
      id: 'posture-primary-line', type: 'line', source: 'posture-all',
      filter: ['==', ['get', 'role'], 'PRIMARY'],
      paint: { 'line-color': MAP_COLOURS.PRIMARY, 'line-width': 1.6, 'line-opacity': 0.9 },
    });
    addOverlayLayer(map, {
      id: 'posture-sub-fill', type: 'fill', source: 'posture-all',
      filter: ['==', ['get', 'role'], 'SUB'],
      paint: { 'fill-color': MAP_COLOURS.ALTERNATIVE, 'fill-opacity': 0.14 },
    });
    addOverlayLayer(map, {
      id: 'posture-sub-line', type: 'line', source: 'posture-all',
      filter: ['==', ['get', 'role'], 'SUB'],
      paint: { 'line-color': MAP_COLOURS.ALTERNATIVE, 'line-width': 1.4, 'line-dasharray': [3, 2], 'line-opacity': 0.9 },
    });
    // Clicks on an area polygon select its owning unit (brief §J; the chooser still opens for a shared site via
    // RequestMap's ref-marker click path which routes through pick.onPick / clickSiteRef).
    const onAreaClick = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      const uid = e.features?.[0]?.properties?.unitId as string | undefined;
      if (uid) setSelection({ kind: 'unit', unitId: uid });
    };
    const onEnter = () => (map.getCanvas().style.cursor = 'pointer');
    const onLeave = () => (map.getCanvas().style.cursor = '');
    for (const id of ['posture-primary-fill', 'posture-sub-fill']) {
      map.on('click', id, onAreaClick);
      map.on('mouseenter', id, onEnter);
      map.on('mouseleave', id, onLeave);
    }
    // Pending-request proposal layers — amber-dashed so an operator never confuses them with approved posture.
    map.addSource('pending-sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(map, {
      id: 'pending-site-fill', type: 'fill', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'SITE'],
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.16 },
    });
    addOverlayLayer(map, {
      id: 'pending-site-line', type: 'line', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'SITE'],
      paint: { 'line-color': '#f59e0b', 'line-width': 2.2, 'line-dasharray': [2, 2] },
    });
    addOverlayLayer(map, {
      id: 'pending-primary-fill', type: 'fill', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'PRIMARY'],
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.22 },
    });
    addOverlayLayer(map, {
      id: 'pending-primary-line', type: 'line', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'PRIMARY'],
      paint: { 'line-color': '#f59e0b', 'line-width': 2.4, 'line-dasharray': [3, 2] },
    });
    addOverlayLayer(map, {
      id: 'pending-sub-fill', type: 'fill', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'SUB'],
      paint: { 'fill-color': '#d97706', 'fill-opacity': 0.18 },
    });
    addOverlayLayer(map, {
      id: 'pending-sub-line', type: 'line', source: 'pending-sel',
      filter: ['==', ['get', 'role'], 'SUB'],
      paint: { 'line-color': '#d97706', 'line-width': 2.2, 'line-dasharray': [1.5, 2] },
    });
    // keep the silence warning for the clickSiteRef usage elsewhere
    void clickSiteRef;
  }, [map, postureFC]);

  // Push pending request geometry whenever it changes; leaves current posture rendering untouched.
  useEffect(() => {
    if (!map) return;
    const src = map.getSource('pending-sel') as GeoJSONSource | undefined;
    if (src) src.setData(pendingFC);
  }, [map, pendingFC]);

  // Layer visibility + emphasis. Selection does NOT remove other units (brief §F) — it only dims them.
  useEffect(() => {
    if (!map) return;
    const show = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    show('posture-primary-fill', layers.primary);
    show('posture-primary-line', layers.primary);
    show('posture-sub-fill', layers.sub);
    show('posture-sub-line', layers.sub);
    const op = (areaOpacity / 100);
    const dim = 0.35;
    if (map.getLayer('posture-primary-fill')) {
      map.setPaintProperty('posture-primary-fill', 'fill-opacity', (
        selected ? ['case', ['==', ['get', 'unitId'], selected], op * 0.35, op * 0.35 * dim] : op * 0.3
      ) as never);
    }
    if (map.getLayer('posture-sub-fill')) {
      map.setPaintProperty('posture-sub-fill', 'fill-opacity', (
        selected ? ['case', ['==', ['get', 'unitId'], selected], op * 0.28, op * 0.28 * dim] : op * 0.22
      ) as never);
    }
    if (map.getLayer('posture-primary-line')) {
      map.setPaintProperty('posture-primary-line', 'line-opacity', (
        selected ? ['case', ['==', ['get', 'unitId'], selected], 1, 0.35] : 0.85
      ) as never);
    }
    if (map.getLayer('posture-sub-line')) {
      map.setPaintProperty('posture-sub-line', 'line-opacity', (
        selected ? ['case', ['==', ['get', 'unitId'], selected], 1, 0.35] : 0.85
      ) as never);
    }
  }, [map, layers, areaOpacity, selected]);

  const counts = useMemo(() => {
    const list = units ?? [];
    const all = list.length;
    const stationed = list.filter((u) => !!u.site && !!u.primary && !!u.alternative).length;
    const incomplete = list.filter((u) => !!u.site && (!u.primary || !u.alternative)).length;
    const noStationing = list.filter((u) => !u.site).length;
    const requests = list.filter((u) => !!u.request).length;
    const temporary = list.filter((u) => u.kind === 'TEMPORARY').length;
    const sites = new Set(list.filter((u) => u.site).map((u) => u.site!.id)).size;
    const withPrimary = list.filter((u) => !!u.primary).length;
    const withSub = list.filter((u) => !!u.alternative).length;
    return { all, stationed, incomplete, noStationing, requests, temporary, sites, withPrimary, withSub };
  }, [units]);

  // Search is applied across every cohort — it narrows the pool before grouping.
  const matches = useMemo(() => {
    const low = q.trim().toLowerCase();
    return (units ?? []).filter((u) => !low || u.code.toLowerCase().includes(low) || u.name.toLowerCase().includes(low) || (u.site?.name ?? '').toLowerCase().includes(low));
  }, [units, q]);

  // Group units UNDER their camp/site (tabs 1 and 2).
  type Camp = { siteId: string; siteName: string; units: PostureUnit[] };
  const byCamp = (list: PostureUnit[]): Camp[] => {
    const m = new Map<string, Camp>();
    for (const u of list) if (u.site) {
      const c = m.get(u.site.id) ?? { siteId: u.site.id, siteName: u.site.name, units: [] };
      c.units.push(u);
      m.set(u.site.id, c);
    }
    return [...m.values()].sort((a, b) => a.siteName.localeCompare(b.siteName, 'ar'));
  };
  const stationedCamps = useMemo(() => byCamp(matches.filter((u) => !!u.site && !!u.primary && !!u.alternative)), [matches]);
  const incompleteCamps = useMemo(() => byCamp(matches.filter((u) => !!u.site && (!u.primary || !u.alternative))), [matches]);

  // «غير متمركزة»: build a shallow org-tree from the unit list's parentId → children.
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

  // «طلبات التمركز والانتشار» — split per purpose (stationing vs deployment areas) and group by unit.
  const requestsByPurpose = useMemo(() => {
    const rs = matches.filter((u) => u.request?.purpose === 'RESTATIONING');
    const da = matches.filter((u) => u.request?.purpose === 'DEPLOYMENT_AREAS');
    return { rs, da };
  }, [matches]);

  const siteInfoCard = useMemo(() => {
    if (!siteInfoId) return null;
    return { siteId: siteInfoId, siteName: sitesById.get(siteInfoId) ?? siteInfoId };
  }, [siteInfoId, sitesById]);

  if (app.state?.empty) {
    return (
      <div className="tz-posture3 tz-posture3-empty" data-testid="posture-empty">
        <EmptyCentre title="لا توجد بيانات تمركز ضمن نطاقك" hint="تظهر الخريطة بعد استيراد الوحدات وتسجيل المواقع." />
      </div>
    );
  }

  return (
    <div className="tz-posture3" data-testid="stationing-posture">
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
              highlight={unit?.site?.id ?? null}
              fitSites
              pick={{ selectedId: unit?.site?.id ?? null, onPick: (siteId) => clickSite(siteId) }}
            />
          )}
        </div>

        {/* Left floating Layers panel — physical LEFT regardless of RTL (brief §16). */}
        <aside className="tz-posture3-layers" aria-label="طبقات الخريطة" data-testid="posture-layers">
          <header><Icon name="layers" /> <b>الطبقات</b></header>
          <ul>
            <li><label><input type="checkbox" checked={layers.sites} onChange={(e) => setLayers((l) => ({ ...l, sites: e.target.checked }))} /> <span><Icon name="pin" /> مواقع التمركز</span></label></li>
            <li><label><input type="checkbox" checked={layers.units} onChange={(e) => setLayers((l) => ({ ...l, units: e.target.checked }))} /> <span><Icon name="units" /> الوحدات</span></label></li>
            <li><label><input type="checkbox" checked={layers.primary} onChange={(e) => setLayers((l) => ({ ...l, primary: e.target.checked }))} /> <span><i className="tz-sw tz-sw-primary" /> مناطق الانتشار الرئيسية</span></label></li>
            <li><label><input type="checkbox" checked={layers.sub} onChange={(e) => setLayers((l) => ({ ...l, sub: e.target.checked }))} /> <span><i className="tz-sw tz-sw-sub" /> مناطق الانتشار الفرعية</span></label></li>
            <li><label><input type="checkbox" checked={layers.boundaries} onChange={(e) => setLayers((l) => ({ ...l, boundaries: e.target.checked }))} /> <span><Icon name="boundary" /> حدود المواقع</span></label></li>
            <li><label><input type="checkbox" checked={mode === 'terrain'} onChange={(e) => { const on = e.target.checked; setMode(on ? 'terrain' : 'street'); setLayers((l) => ({ ...l, terrain: on })); }} /> <span><Icon name="chart" /> التضاريس (الانحدار)</span></label></li>
            <li><label className="is-disabled" title="غير مثبتة في حزمة الخرائط الحالية"><input type="checkbox" checked={layers.satellite} disabled /> <span><Icon name="eye" /> الصور الفضائية</span></label></li>
          </ul>
          <div className="tz-posture3-opacity">
            <label><span>شفافية المناطق</span><span className="tz-posture3-opacity-value">{areaOpacity}%</span></label>
            <input type="range" min={0} max={100} step={5} value={areaOpacity} onChange={(e) => setAreaOpacity(Number(e.target.value))} aria-label="شفافية المناطق" />
          </div>
        </aside>

        {/* Right docked Units panel — physical RIGHT regardless of RTL (brief §16). */}
        <aside className="tz-posture3-units" aria-label="الوحدات" data-testid="posture-units-panel">
          <header>
            <span className="tz-posture3-units-title"><Icon name="units" /> <b>الوحدات</b> <em>({counts.all.toLocaleString('ar-AE')})</em></span>
          </header>
          <div className="tz-posture3-units-search">
            <Icon name="search" />
            <input type="search" aria-label="بحث عن وحدة" placeholder="بحث عن وحدة…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="tz-posture3-units-tabs" role="tablist">
            {COHORTS.map(([k, label]) => {
              const n = k === 'stationed' ? counts.stationed : k === 'incomplete' ? counts.incomplete : k === 'noStationing' ? counts.noStationing : counts.requests;
              return (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={cohort === k}
                  data-testid={'cohort-' + k}
                  className={'tz-posture3-tab' + (cohort === k ? ' is-active' : '')}
                  onClick={() => setCohort(k)}
                >
                  {label} <span>({n.toLocaleString('ar-AE')})</span>
                </button>
              );
            })}
            <button type="button" className="tz-posture3-browse" onClick={() => setDrawerOpen(true)} data-testid="posture-browse" title="استعراض الوحدات حسب الهيكل الكامل">
              <Icon name="tree" />
            </button>
          </div>
          {/* Hierarchical rail bodies — one per cohort. Camps for stationed/incomplete, org-tree for unstationed, split
             groups for requests. */}
          <div className="tz-posture3-camps" role="listbox" aria-label={(COHORTS.find(([k]) => k === cohort) ?? [,''])[1]}>
            {!units && <div className="tz-posture3-empty-row">جارٍ التحميل…</div>}

            {units && cohort === 'stationed' && stationedCamps.length === 0 && <div className="tz-posture3-empty-row">لا توجد وحدات متمركزة مطابقة.</div>}
            {units && cohort === 'stationed' && stationedCamps.map((c) => (
              <CampGroup key={c.siteId} camp={c} open={openCamp.has(c.siteId)} onToggle={() => toggleCamp(c.siteId)} selected={selected} onPick={(uid) => selectUnit(uid)} />
            ))}

            {units && cohort === 'incomplete' && incompleteCamps.length === 0 && <div className="tz-posture3-empty-row">لا توجد وحدات بدون مناطق انتشار.</div>}
            {units && cohort === 'incomplete' && incompleteCamps.map((c) => (
              <CampGroup key={c.siteId} camp={c} open={openCamp.has(c.siteId)} onToggle={() => toggleCamp(c.siteId)} selected={selected} onPick={(uid) => selectUnit(uid)} missing />
            ))}

            {units && cohort === 'noStationing' && noStationingTree.length === 0 && <div className="tz-posture3-empty-row">لا توجد وحدات غير متمركزة.</div>}
            {units && cohort === 'noStationing' && noStationingTree.map((n) => (
              <OrgBranch key={n.unit.id} node={n} open={openOrg} onToggle={toggleOrg} selected={selected} onPick={(uid) => selectUnit(uid)} />
            ))}

            {units && cohort === 'requests' && (requestsByPurpose.rs.length + requestsByPurpose.da.length) === 0 && <div className="tz-posture3-empty-row">لا توجد طلبات جارية.</div>}
            {units && cohort === 'requests' && (
              <>
                {requestsByPurpose.rs.length > 0 && (
                  <section className="tz-posture3-reqgroup">
                    <header><Icon name="swap" /> <b>طلبات إعادة التمركز</b> <em>({requestsByPurpose.rs.length.toLocaleString('ar-AE')})</em></header>
                    <ul>{requestsByPurpose.rs.map((u) => <RequestRow key={u.id} unit={u} selected={selected} onPick={(uid) => selectUnit(uid)} />)}</ul>
                  </section>
                )}
                {requestsByPurpose.da.length > 0 && (
                  <section className="tz-posture3-reqgroup">
                    <header><Icon name="layers" /> <b>طلبات مناطق الانتشار</b> <em>({requestsByPurpose.da.length.toLocaleString('ar-AE')})</em></header>
                    <ul>{requestsByPurpose.da.map((u) => <RequestRow key={u.id} unit={u} selected={selected} onPick={(uid) => selectUnit(uid)} />)}</ul>
                  </section>
                )}
              </>
            )}
          </div>
        </aside>

        {/* ONE context card at a time (brief §12/§18): either the selected unit OR a reference site, never both. */}
        {unit && selection?.kind === 'unit' && (
          <aside className="tz-posture3-detail" aria-label="تفاصيل الوحدة المختارة" data-testid="posture-details">
            <header>
              <span className="tz-posture3-detail-icon"><Icon name="building" /></span>
              <div>
                <b>الوحدة {unit.code || unit.name}</b>
                <small>{unit.name}</small>
              </div>
              <button type="button" className="tz-posture3-detail-close" aria-label="إغلاق البطاقة" onClick={clearSelection}>×</button>
            </header>
            <dl className="tz-posture3-detail-body">
              <div><dt><Icon name="pin" /> الموقع الحالي</dt><dd data-testid="posture-site">{unit.site?.name ?? 'بلا تمركز معتمد'}</dd></div>
              <div><dt><Icon name="layers" /> نوع التمركز</dt><dd data-testid="posture-kind">{unit.kind === 'TEMPORARY' ? 'مؤقت' : unit.kind ? 'دائم' : '—'}{unit.plannedEnd ? ' · حتى ' + fullDate(unit.plannedEnd) : ''}</dd></div>
              <div><dt><i className="tz-sw tz-sw-primary" /> منطقة الانتشار الرئيسية</dt><dd data-testid="posture-primary">{unit.primary ? 'معتمدة' : 'لا توجد'}</dd></div>
              <div><dt><i className="tz-sw tz-sw-sub" /> منطقة الانتشار الفرعية</dt><dd data-testid="posture-alternative">{unit.alternative ? 'معتمدة' : 'لا توجد'}</dd></div>
              <div><dt><Icon name="check" /> الحالة</dt><dd>{UNIT_STATE[unit.state] ?? unit.state}</dd></div>
              {!!unit.otherUnitsAtSite && <div><dt><Icon name="units" /> وحدات أخرى في الموقع</dt><dd data-testid="posture-others">{unit.otherUnitsAtSite}</dd></div>}
              {unit.request && <div><dt><Icon name="file" /> طلب جارٍ</dt><dd data-testid="posture-request">{(isPurpose(unit.request.purpose) ? PURPOSE_TITLE[unit.request.purpose] : unit.request.purpose) + ' · ' + unit.request.state}</dd></div>}
            </dl>
            {pendingReq && (pendingReq.content.site || pendingReq.content.primary || pendingReq.content.alternative) && (
              <div className="tz-posture3-pending">
                <header><i className="tz-posture3-pending-swatch" aria-hidden /> <b>المقترح قيد الاعتماد</b> <small>{pendingReq.number}</small></header>
                <ul>
                  {pendingReq.content.site && <li><i className="tz-posture3-pending-swatch is-site" aria-hidden /> موقع مقترح</li>}
                  {pendingReq.content.primary && <li><i className="tz-posture3-pending-swatch is-primary" aria-hidden /> منطقة انتشار رئيسية مقترحة</li>}
                  {pendingReq.content.alternative && <li><i className="tz-posture3-pending-swatch is-sub" aria-hidden /> منطقة انتشار فرعية مقترحة</li>}
                </ul>
                <p>تظهر هذه العناصر على الخريطة بخط برتقالي منقّط لتمييزها عن الموقف الحالي.</p>
              </div>
            )}
          </aside>
        )}

        {siteInfoCard && (
          <aside className="tz-posture3-detail tz-posture3-detail-site" aria-label="تفاصيل الموقع" data-testid="posture-site-info">
            <header>
              <span className="tz-posture3-detail-icon"><Icon name="pin" /></span>
              <div>
                <b>{siteInfoCard.siteName}</b>
                <small>موقع مرجعي — لا توجد وحدات لك فيه</small>
              </div>
              <button type="button" className="tz-posture3-detail-close" aria-label="إغلاق البطاقة" onClick={clearSelection}>×</button>
            </header>
            <p className="tz-posture3-detail-note">يُعرض هذا الموقع للمرجع فقط. لا يُكشف عن الوحدات غير المرئية ضمن صلاحيتك.</p>
          </aside>
        )}

        <div className="tz-posture3-mapctl" aria-label="أدوات الخريطة">
          <MapModeSwitcher mode={mode} setMode={setMode} />
          <ViewSwitcher view={view} setView={setView} available={!!terrain3d} />
          <button type="button" className="tz-posture3-mapctl-btn" onClick={() => setFit((k) => k + 1)} title="الحدود والمناطق">
            <Icon name="target" />
          </button>
        </div>

        <div className="tz-posture3-legend"><MapLegend stage="full" fold /></div>
      </div>

      <footer className="tz-posture3-dock" aria-label="موجز الموقف">
        <span><Icon name="pin" /> <b>{counts.sites.toLocaleString('ar-AE')}</b> <small>المواقع المستخدمة</small></span>
        <span><Icon name="building" /> <b>{counts.stationed.toLocaleString('ar-AE')}</b> <small>وحدات داخل الموقع</small></span>
        <span><Icon name="target" /> <b>{counts.noStationing.toLocaleString('ar-AE')}</b> <small>بلا تمركز معتمد</small></span>
        <span><Icon name="clock" /> <b>{counts.temporary.toLocaleString('ar-AE')}</b> <small>تمركز مؤقت</small></span>
        <span><i className="tz-sw tz-sw-primary" /> <b>{counts.withPrimary.toLocaleString('ar-AE')}</b> <small>وحدات بمنطقة رئيسية</small></span>
        <span><i className="tz-sw tz-sw-sub" /> <b>{counts.withSub.toLocaleString('ar-AE')}</b> <small>وحدات بمنطقة فرعية</small></span>
        <span><Icon name="units" /> <b>{counts.all.toLocaleString('ar-AE')}</b> <small>الوحدات الظاهرة</small></span>
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
                selected={selected}
                trail={tree.trail(selected)}
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
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Rail sub-components (owner, 21 Nov 2026 posture-rail rebuild): camps + org branches + request rows.
// ---------------------------------------------------------------------------------------------------------------------

function CampGroup({ camp, open, onToggle, selected, onPick, missing = false }: { camp: { siteId: string; siteName: string; units: PostureUnit[] }; open: boolean; onToggle: () => void; selected: string | null; onPick: (unitId: string) => void; missing?: boolean }) {
  return (
    <section className={'tz-posture3-camp' + (open ? ' is-open' : '')} data-testid="posture-camp" data-site={camp.siteId}>
      <button type="button" className="tz-posture3-camp-head" aria-expanded={open} onClick={onToggle}>
        <span className="tz-posture3-camp-twist" aria-hidden>{open ? '▾' : '◂'}</span>
        <span className="tz-posture3-camp-icon"><Icon name="pin" /></span>
        <span className="tz-posture3-camp-meta">
          <b>{camp.siteName}</b>
          <small>{camp.units.length.toLocaleString('ar-AE') + ' ' + (camp.units.length === 1 ? 'وحدة' : 'وحدات')}{missing ? ' · ينقص ' + (camp.units.filter((u) => !u.primary).length > 0 ? 'الرئيسية' : '') + (camp.units.filter((u) => !u.primary).length > 0 && camp.units.filter((u) => !u.alternative).length > 0 ? ' / ' : '') + (camp.units.filter((u) => !u.alternative).length > 0 ? 'الفرعية' : '') : ''}</small>
        </span>
      </button>
      {open && (
        <ul className="tz-posture3-camp-units">
          {camp.units.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                data-testid="posture-unit"
                data-unit={u.id}
                className={'tz-posture3-unit-row' + (selected === u.id ? ' is-selected' : '')}
                onClick={() => onPick(u.id)}
                title={u.site?.name ?? ''}
              >
                <span className="tz-posture3-unit-icon"><Icon name="building" /></span>
                <span className="tz-posture3-unit-meta">
                  <b>{u.code || u.name}</b>
                  <small>{u.name}</small>
                </span>
                <span className={'tz-posture3-unit-state ' + (u.kind === 'TEMPORARY' ? 'temp' : missing ? 'warn' : 'on')} aria-hidden>●</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
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
        <span className="tz-posture3-unit-state off" aria-hidden>●</span>
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

function RequestRow({ unit, selected, onPick }: { unit: PostureUnit; selected: string | null; onPick: (unitId: string) => void }) {
  return (
    <li>
      <button
        type="button"
        data-testid="posture-unit"
        data-unit={unit.id}
        className={'tz-posture3-unit-row' + (selected === unit.id ? ' is-selected' : '')}
        onClick={() => onPick(unit.id)}
        title={unit.request?.state ?? ''}
      >
        <span className="tz-posture3-unit-icon"><Icon name="file" /></span>
        <span className="tz-posture3-unit-meta">
          <b>{unit.code || unit.name}</b>
          <small>{unit.name}{unit.request ? ' · ' + unit.request.state : ''}</small>
        </span>
        <span className="tz-posture3-unit-state warn" aria-hidden>●</span>
      </button>
    </li>
  );
}

export type { SiteGeometry };

export default PosturePage;
