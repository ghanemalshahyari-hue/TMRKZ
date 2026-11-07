import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from 'maplibre-gl';
import { Marker } from 'maplibre-gl';
import { api, type SiteOccupants } from '../api/client';
import type { RestationingRequest, SiteDetail, SiteGeometry } from '../api/types';
import { SiteEditor, addOverlayLayer, frame, installedTerrain3d, type MapView, type SiteLive } from '../components/map/maplibre';
import type { BasemapMode, Terrain3dSource } from '../components/map/maplibre/offlineStyle';
import { Icon } from '../components/ui';
import { MapFrame, MapLegend } from '../components/workspace/MapFrame';
import { OperationalWorkspace } from '../components/workspace/OperationalWorkspace';
import { RequestMap } from '../components/workspace/RequestMap';
import { useRegisteredSites } from '../components/workspace/useRegisteredSites';
import { useApp } from '../lib/app';
import { anchorOf, partsOf } from '../lib/siteGeometry';

const EMPTY_MAP = {
  id: 'setup', number: '', state: 'DRAFT', requestingUnit: { id: '', name: '' }, requester: { id: '', name: '' }, units: [], currentSites: [],
  content: { kind: 'PERMANENT', scope: [], site: null, primary: null, alternative: null, reason: '', exceptions: {}, occupants: {} },
  policyVersion: null, routeNo: 0, route: [], previousRoutes: [], revisions: [], returned: null, paused: null, finalApprover: null,
  can: { edit: false, submit: false, decide: false, activate: false },
} as unknown as RestationingRequest;

type Form = { name: string; code: string; kind: string; parentId: string; notes: string; reason: string };
const BLANK: Form = { name: '', code: '', kind: 'موقع', parentId: '', notes: '', reason: '' };

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
  const [vertexMode, setVertexMode] = useState(false);
  const mapRef = useRef<MlMap | null>(null);
  const editor = useRef<SiteEditor | null>(null);
  const marker = useRef<Marker | null>(null);
  const parts = useRef<SiteGeometry | null>(null);
  const placingRef = useRef(false);
  placingRef.current = placing;
  useEffect(() => {
    installedTerrain3d().then(setTerrain3d);
    return () => {
      editor.current?.destroy();
      marker.current?.remove();
    };
  }, []);
  const onMap = (m: MlMap) => {
    mapRef.current = m;
    m.addSource('setup-earlier', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    addOverlayLayer(m, { id: 'setup-earlier-fill', type: 'fill', source: 'setup-earlier', paint: { 'fill-color': '#2f9e6e', 'fill-opacity': 0.25 } }, 'top');
    addOverlayLayer(m, { id: 'setup-earlier-line', type: 'line', source: 'setup-earlier', paint: { 'line-color': '#2f9e6e', 'line-width': 2, 'line-dasharray': [2, 1.6] } }, 'top');
    editor.current = new SiteEditor(m, {
      onChange: (l: SiteLive, final: boolean) => {
        setDrawing(l.mode === 'draw');
        if (final) setGeometry(l.geometry ?? null);
      },
      maxAreaM2: () => null,
    });
    m.on('click', (e: MapMouseEvent) => {
      if (!placingRef.current) return;
      setPlacing(false);
      setPoint({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      marker.current?.remove();
      marker.current = new Marker({ color: '#d9822b' }).setLngLat(e.lngLat).addTo(m);
    });
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
    if (!g || !(g.type === 'Polygon' || g.type === 'MultiPolygon')) editor.current?.startDrawing(null, 4);
  };
  const sites = useMemo(() => registered.sites.filter((s) => s.view !== 'CONTEXT'), [registered.sites]);
  const byParent = useMemo(() => {
    const m = new Map<string, typeof sites>();
    for (const s of sites) m.set(s.parentId ?? '', [...(m.get(s.parentId ?? '') ?? []), s]);
    return m;
  }, [sites]);
  const site = sites.find((s) => s.siteId === selected) ?? null;
  const orgs = useMemo(() => app.orgs.filter((o) => !q.trim() || o.name.includes(q.trim())).slice(0, 200), [app.orgs, q]);
  const startAdd = () => {
    setAdding(true);
    setSelected(null);
    setForm(BLANK);
    setGeometry(null);
    setPoint(null);
    parts.current = null;
    marker.current?.remove();
    editor.current?.load(null, false);
  };
  const draw = () => {
    setPlacing(false);
    parts.current = null;
    editor.current?.load(null, false);
    editor.current?.startDrawing(null, 4);
  };
  /** Another part: what is drawn so far is kept, and the new outline joins it as one MultiPolygon (it then moves as one). */
  const addPart = () => {
    if (!geometry) return;
    parts.current = geometry;
    showEarlier(geometry);
    editor.current?.load(null, false);
    // the map stays by the first part, which stays drawn while the next one is placed
    editor.current?.startDrawing(anchorOf(partsOf(geometry)), 4);
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
  const save = () =>
    act(async () => {
      const at = shape === 'POINT' ? point : geometry ? anchorOf(partsOf(geometry)) : null;
      if (!at) throw new Error('حدد الموقع على الخريطة أولاً.');
      const site = { code: form.code.trim(), name: form.name.trim(), kind: form.kind.trim(), parentId: form.parentId || null, responsibleOrgId: null, capacity: null, location: at, notes: form.notes || null, reason: form.reason };
      // one act on the server: a boundary it refuses leaves no site behind
      if (shape === 'POLYGON' && geometry) await api.createSiteWithBoundary({ site, boundary: { geometry, crs: 'EPSG:4326', expectedVersion: 0, reason: form.reason, method: 'DRAWN' } });
      else await api.createSite(site);
    }, 'سُجل الموقع', () => {
      setAdding(false);
      editor.current?.load(null, false);
      marker.current?.remove();
    });
  const legend = <MapLegend stage="sites" fold={view === '3d'} />;
  const tree = (parent: string, depth: number): React.ReactNode =>
    (byParent.get(parent) ?? []).map((s) => (
      <div key={s.siteId}>
        <button className={'rs-item' + (s.siteId === selected ? ' active' : '')} data-site={s.code} style={{ paddingInlineStart: 10 + depth * 16 }} onClick={() => (setAdding(false), setSelected(s.siteId))}>
          <span className="rs-item-head"><b>{s.name}</b><small className="tz-code">{s.code}</small></span>
          <small>{depth === 0 ? 'موقع رئيسي' : 'موقع فرعي'} · {s.boundary ? 'حدود مسجلة' : 'علامة'}</small>
        </button>
        {tree(s.siteId, depth + 1)}
      </div>
    ));
  const roots = sites.filter((s) => !s.parentId || !sites.some((x) => x.siteId === s.parentId));
  const rail = (
    <div className="tz-rail">
      <section className="tz-drawer open tz-site-list" aria-label="المواقع">
        <div className="tz-drawer-head">
          <span className="tz-drawer-toggle"><Icon name="pin" /><span>المواقع</span><span className="tz-chip">{sites.length}</span></span>
          {canSites && <button className="button primary compact tz-new" data-testid="add-site" onClick={startAdd}>＋ إضافة موقع</button>}
        </div>
        <div className="rs-list" data-testid="setup-tree">
          {roots.length === 0 && <div className="tz-muted tz-pad">لا مواقع بعد. ابدأ بـ«إضافة موقع».</div>}
          {roots.map((s) => (
            <div key={s.siteId}>
              <button className={'rs-item' + (s.siteId === selected ? ' active' : '')} data-site={s.code} onClick={() => (setAdding(false), setSelected(s.siteId))}>
                <span className="rs-item-head"><b>{s.name}</b><small className="tz-code">{s.code}</small></span>
                <small>موقع رئيسي · {s.boundary ? 'حدود مسجلة' : 'علامة'}</small>
              </button>
              {tree(s.siteId, 1)}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
  const addPanel = (
    <section className="tz-card" data-testid="add-site-form">
      <h3>إضافة موقع</h3>
      <div className="rs-tools">
        <button className={'button' + (shape === 'POLYGON' ? ' on' : '')} aria-pressed={shape === 'POLYGON'} onClick={() => setShape('POLYGON')}>حدود</button>
        <button className={'button' + (shape === 'POINT' ? ' on' : '')} aria-pressed={shape === 'POINT'} onClick={() => setShape('POINT')}>نقطة</button>
      </div>
      {shape === 'POLYGON' ? (
        <div className="rs-tools">
          <button className="button" data-testid="draw-site" onClick={draw}>رسم الحدود</button>
          <button className="button" disabled={!geometry || drawing} data-testid="add-part" onClick={addPart}>جزء آخر</button>
          <small className="tz-muted">{drawing ? 'انقر على الخريطة لوضع الرؤوس.' : geometry ? 'الحدود جاهزة: اسحبها لنقلها كاملة.' : 'لم تُرسم بعد.'}</small>
        </div>
      ) : (
        <div className="rs-tools">
          <button className={'button' + (placing ? ' on' : '')} data-testid="place-point" onClick={() => setPlacing(!placing)}>تحديد على الخريطة</button>
          <small className="tz-muted">{placing ? 'انقر على الخريطة.' : point ? point.lat.toFixed(5) + '، ' + point.lng.toFixed(5) : 'لم تُحدد بعد.'}</small>
        </div>
      )}
      {shape === 'POLYGON' && (geometry || drawing) && shapeTools}
      <label className="field"><span>اسم الموقع</span><input aria-label="اسم الموقع" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label className="field"><span>رمز الموقع</span><input aria-label="رمز الموقع" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
      <label className="field"><span>التصنيف</span><input aria-label="تصنيف الموقع" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} /></label>
      <label className="field"><span>الموقع الرئيسي (إن كان فرعياً)</span>
        <select aria-label="الموقع الرئيسي" value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
          <option value="">— موقع رئيسي —</option>
          {sites.map((s) => <option key={s.siteId} value={s.siteId}>{s.name}</option>)}
        </select>
      </label>
      <label className="field"><span>ملاحظات</span><textarea aria-label="ملاحظات الموقع" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      <label className="field"><span>سبب التسجيل (مطلوب)</span><textarea aria-label="سبب تسجيل الموقع" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
      <div className="rs-tools">
        <button className="button primary" data-testid="save-site" disabled={busy || drawing || form.reason.trim().length < 5 || !form.name.trim() || !form.code.trim() || (shape === 'POINT' ? !point : !geometry)} onClick={save}>حفظ الموقع</button>
        <button className="button" onClick={() => setAdding(false)}>إلغاء</button>
      </div>
    </section>
  );
  const sitePanel = site && (
    <>
      <section className="tz-card rs-summary">
        <h2 className="tz-site-title">{site.name}</h2>
        <p className="tz-muted micro">{site.code} · موقع واحد على الخريطة، مهما تعددت الوحدات التي تستخدمه.</p>
      </section>
      {canSites && detail?.canManage && (
        <section className="tz-card" data-testid="edit-site">
          <h4>تعديل بيانات الموقع</h4>
          <label className="field"><span>الاسم</span><input aria-label="اسم الموقع" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label className="field"><span>التصنيف</span><input aria-label="تصنيف الموقع" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} /></label>
          <label className="field"><span>الموقع الرئيسي</span>
            <select aria-label="الموقع الرئيسي" value={edit.parentId} onChange={(e) => setEdit({ ...edit, parentId: e.target.value })}>
              <option value="">— موقع رئيسي —</option>
              {sites.filter((s) => s.siteId !== site.siteId).map((s) => <option key={s.siteId} value={s.siteId}>{s.name}</option>)}
            </select>
          </label>
          <label className="field"><span>ملاحظات (تبقى كما هي إن تُركت فارغة)</span><input aria-label="ملاحظات الموقع" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
          <label className="field"><span>السبب (مطلوب)</span><textarea aria-label="سبب التعديل" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></label>
          <div className="rs-tools">
            <button className="button" data-testid="save-edit" disabled={busy || editingShape || edit.reason.trim().length < 5 || !edit.name.trim()} onClick={() => act(() => api.updateSite(site.siteId, { code: edit.code, name: edit.name.trim(), kind: edit.kind.trim(), parentId: edit.parentId || null, capacity: detail.capacity, location: detail.location, notes: edit.notes.trim() || null, reason: edit.reason }), 'حُفظت بيانات الموقع', () => setEdit({ ...edit, reason: '', notes: '' }))}>حفظ البيانات</button>
            {!editingShape && <button className="button" data-testid="edit-shape" onClick={startShape}>تعديل الحدود</button>}
            {editingShape && (
              <>
                <button className="button primary" data-testid="save-shape" disabled={busy || drawing || !geometry || edit.reason.trim().length < 5} onClick={() => act(() => api.saveSiteGeometry(site.siteId, { geometry: geometry!, crs: 'EPSG:4326', expectedVersion: detail.geometryVersion ?? 0, reason: edit.reason, method: 'DRAWN' }), 'حُفظت الحدود', () => { setEditingShape(false); editor.current?.load(null, false); setEdit({ ...edit, reason: '' }); })}>حفظ الحدود</button>
                <button className="button" onClick={() => { setEditingShape(false); editor.current?.load(null, false); }}>إلغاء</button>
              </>
            )}
          </div>
          {editingShape && shapeTools}
          {editingShape && <p className="micro tz-muted">اسحب الحدود لنقلها كاملة. تُحفظ نسخة جديدة بسببها، ولا يُكتب شيء قبل الحفظ.</p>}
        </section>
      )}
      <section className="tz-card" data-testid="stationed-here">
        <h4>الوحدات المتمركزة حالياً</h4>
        {occ?.stationed.length === 0 && !occ?.otherStationed && <p className="tz-muted">لا تمركز حالي.</p>}
        <ul className="tz-sites">{occ?.stationed.map((u) => <li key={u.orgId}><b>{u.orgName}</b></li>)}</ul>
        {!!occ?.otherStationed && <p className="tz-muted" data-testid="others-here">جهة أخرى في الموقع: {occ.otherStationed}</p>}
        {canCorrect && (
          <>
            <h4 style={{ marginTop: 10 }}>تثبيت التمركز (تصحيح مُدقَّق)</h4>
            <p className="micro tz-muted">للتهيئة الأولى والتصحيح فقط: كل وحدة تُختار بنفسها، ولا ينتقل معها من يتبعها. أما الطلب العادي فيمر بالاعتمادات.</p>
            <OrgSelect q={q} setQ={setQ} orgs={orgs} value={stOrg} onChange={setStOrg} label="وحدة التمركز" />
            <label className="field"><span>السبب</span><textarea aria-label="سبب التمركز" value={stReason} onChange={(e) => setStReason(e.target.value)} /></label>
            <button className="button" data-testid="correct-stationing" disabled={busy || !stOrg || stReason.trim().length < 5} onClick={() => act(() => api.correctStationing({ organizationId: stOrg, siteId: site.siteId, reason: stReason }), 'سُجل التمركز', () => (setStOrg(''), setStReason('')))}>تثبيت</button>
          </>
        )}
      </section>
      <section className="tz-card" data-testid="linked-here">
        <h4>الوحدات المرتبطة <small>(الربط ليس تمركزاً)</small></h4>
        {occ?.linked.length === 0 && <p className="tz-muted">لا ارتباطات.</p>}
        <ul className="tz-sites">
          {occ?.linked.map((l) => (
            <li key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><b>{l.orgName}</b>{canLinks && <button className="button compact" style={{ width: 'auto', flex: 'none' }} onClick={() => { const why = window.prompt('سبب إنهاء الربط'); if (why && why.trim().length >= 5) void act(() => api.endSiteLink(l.id, why), 'أُنهي الربط'); }}> إنهاء</button>}</li>
          ))}
        </ul>
        {canLinks && (
          <>
            <OrgSelect q={q} setQ={setQ} orgs={orgs} value={linkOrg} onChange={setLinkOrg} label="وحدة الربط" />
            <label className="field"><span>السبب</span><textarea aria-label="سبب الربط" value={linkReason} onChange={(e) => setLinkReason(e.target.value)} /></label>
            <button className="button" data-testid="add-link" disabled={busy || !linkOrg || linkReason.trim().length < 5} onClick={() => act(() => api.createSiteLink({ siteId: site.siteId, organizationId: linkOrg, reason: linkReason }), 'أُضيف الربط', () => (setLinkOrg(''), setLinkReason('')))}>إضافة ربط</button>
          </>
        )}
      </section>
    </>
  );
  return (
    <OperationalWorkspace
      listRail
      railLabel="المواقع"
      contextLabel="التهيئة"
      sheetKey={(adding ? 'add' : '') + (selected ?? '')}
      rail={rail}
      context={<aside className="tz-context" aria-label="تهيئة الموقع"><div className="tz-context-body" data-testid="setup-context">{adding ? addPanel : sitePanel ?? <section className="tz-card"><h3>تهيئة المواقع والتمركز</h3><p className="tz-muted">هذه مساحة التهيئة الأولى والتصحيح، وكل خطوة فيها تُسجَّل بسببها. اختر موقعاً أو أضف موقعاً جديداً.</p></section>}</div></aside>}
      centre={
        <MapFrame title={<span className="tz-mapstep"><Icon name="map" /><b>تهيئة المواقع والتمركز</b></span>} mode={mode} setMode={setMode} view={view} setView={setView} has3d={!!terrain3d} placing={placing || drawing} legend={legend}>
          {terrain3d !== undefined && <RequestMap view={view} terrain3d={terrain3d} request={EMPTY_MAP} checks={null} mode={mode} fitMaxZoom={13} hideSite fit={false} onMap={onMap} referenceInteractive={!adding && !editingShape} fitSites pick={adding || editingShape ? null : { selectedId: selected, onPick: (id) => setSelected(id) }} focus={selected ? { siteId: selected, key: selected.length } : null} />}
        </MapFrame>
      }
    />
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
