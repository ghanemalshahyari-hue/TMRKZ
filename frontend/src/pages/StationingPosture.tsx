import { useEffect, useMemo, useState } from 'react';
import { api, type PostureUnit } from '../api/client';
import type { Map as MlMap } from 'maplibre-gl';
import type { RestationingRequest } from '../api/types';
import { PITCH_3D, installedTerrain3d, type MapView } from '../components/map/maplibre';
import type { BasemapMode, Terrain3dSource } from '../components/map/maplibre/offlineStyle';
import { Icon } from '../components/ui';
import { MapFrame, MapLegend } from '../components/workspace/MapFrame';
import { EmptyCentre } from '../components/workspace/EmptyCentre';
import { OperationalWorkspace } from '../components/workspace/OperationalWorkspace';
import { RequestMap } from '../components/workspace/RequestMap';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { PURPOSE_TITLE, UNIT_STATE, isPurpose } from '../lib/requestPurpose';

/** One unit's posture as the map's request shape: its site as «current», its own two areas. Nothing here is a request or can be edited. */
function asMapRequest(u: PostureUnit): RestationingRequest {
  return {
    id: 'posture', number: '', state: 'ACTIVATED_PERMANENT',
    requestingUnit: { id: u.id, name: u.name }, requester: { id: '', name: '' }, units: [],
    currentSites: u.site ? [{ unit: u.name, site: { id: u.site.id, name: u.site.name }, geometry: u.site.geometry as RestationingRequest['currentSites'][number]['geometry'] }] : [],
    purpose: 'DEPLOYMENT_AREAS',
    content: {
      kind: u.kind === 'TEMPORARY' ? 'TEMPORARY' : 'PERMANENT',
      scope: [], reason: '', primary: u.primary ?? null, alternative: u.alternative ?? null,
      site: u.site?.geometry && u.site.geometry.type !== 'Point' ? { geometry: u.site.geometry, copiedFrom: u.site.id, shape: 'FREE' } : null,
    } as unknown as RestationingRequest['content'],
    policyVersion: null, routeNo: 0, route: [], previousRoutes: [], revisions: [], returned: null, paused: null, finalApprover: null,
    can: { edit: false, submit: false, decide: false, activate: false },
  } as unknown as RestationingRequest;
}

type Cohort = 'all' | 'onSite' | 'offSite';

/**
 * «مساحة التمركز» — the operational posture workspace (owner, 20 Nov 2026 reset): a READ-ONLY view of the units the person
 * may see, their current stationing sites, and their deployment areas. There are no request controls here. Creating or
 * editing a request happens through «＋ إنشاء»; managing requests happens on «الطلبات». This page replaces the previous
 * request drawer idle state and is the professional evolution of PosturePage.
 */
export function StationingPosture() {
  const app = useApp();
  const [units, setUnits] = useState<PostureUnit[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [cohort, setCohort] = useState<Cohort>('all');
  const [mode, setMode] = useState<BasemapMode>('terrain');
  const [view, setView] = useState<MapView>('2d');
  const [terrain3d, setTerrain3d] = useState<Terrain3dSource | null | undefined>(undefined);
  const [fit, setFit] = useState(0);
  const [map, setMap] = useState<MlMap | null>(null);
  useEffect(() => {
    map?.easeTo({ pitch: view === '3d' ? PITCH_3D : 0, duration: 500 });
  }, [map, view]);
  useEffect(() => {
    installedTerrain3d().then(setTerrain3d);
    api.operationalPosture().then((p) => {
      setUnits(p.units);
      setSelected((s) => s ?? p.units.find((u) => u.site)?.id ?? p.units[0]?.id ?? null);
    }).catch((e: Error) => (setUnits([]), app.toast(e.message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);

  const counts = useMemo(() => {
    const all = units?.length ?? 0;
    const onSite = units?.filter((u) => !!u.site).length ?? 0;
    const offSite = all - onSite;
    const temp = units?.filter((u) => u.kind === 'TEMPORARY').length ?? 0;
    const sites = new Set((units ?? []).filter((u) => u.site).map((u) => u.site!.id)).size;
    return { all, onSite, offSite, temp, sites };
  }, [units]);

  const filtered = useMemo(() => {
    const low = q.trim().toLowerCase();
    return (units ?? [])
      .filter((u) => cohort === 'all' ? true : cohort === 'onSite' ? !!u.site : !u.site)
      .filter((u) => !low || u.code.toLowerCase().includes(low) || u.name.toLowerCase().includes(low) || (u.site?.name ?? '').toLowerCase().includes(low));
  }, [units, cohort, q]);

  const unit = units?.find((u) => u.id === selected) ?? null;
  const req = useMemo(() => (unit ? asMapRequest(unit) : null), [unit]);
  useEffect(() => setFit((k) => k + 1), [selected]);

  // Right rail: searchable, filterable unit list.
  const rail = (
    <div className="tz-rail tz-posture-rail" data-testid="posture-rail">
      <section className="tz-drawer open tz-site-list" aria-label="وحداتي">
        <div className="tz-drawer-head">
          <span className="tz-drawer-toggle"><Icon name="units" /><span>الوحدات</span><span className="tz-chip" data-testid="posture-count">{counts.all.toLocaleString('ar-AE')}</span></span>
        </div>
        <div className="tz-posture-search">
          <input type="search" aria-label="بحث عن وحدة" placeholder="بحث عن وحدة…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="tz-posture-tabs" role="tablist" aria-label="تصفية الوحدات">
          {([
            ['all', 'الكل', counts.all],
            ['onSite', 'داخل الموقع', counts.onSite],
            ['offSite', 'خارج الموقع', counts.offSite],
          ] as [Cohort, string, number][]).map(([k, label, n]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={cohort === k}
              data-testid={'cohort-' + k}
              className={'tz-posture-tab' + (cohort === k ? ' is-active' : '')}
              onClick={() => setCohort(k)}
            >
              {label}<span className="tz-posture-tab-num">({n.toLocaleString('ar-AE')})</span>
            </button>
          ))}
        </div>
        <ul className="tz-posture-list" role="listbox" aria-label="الوحدات">
          {!units && <li className="tz-muted tz-pad">جارٍ التحميل…</li>}
          {units && filtered.length === 0 && <li className="tz-muted tz-pad">لا وحدات مطابقة.</li>}
          {filtered.slice(0, 500).map((u) => (
            <li key={u.id}>
              <button
                type="button"
                role="option"
                aria-selected={selected === u.id}
                data-testid="posture-unit"
                className={'tz-posture-card' + (selected === u.id ? ' is-selected' : '')}
                onClick={() => setSelected(u.id)}
              >
                <span className="tz-posture-icon"><Icon name="building" /></span>
                <span className="tz-posture-meta">
                  <b>{u.code || u.name}</b>
                  <small>{u.name}</small>
                  <small className="muted">{u.site ? u.site.name : 'بلا تمركز حالي'}</small>
                </span>
                <span className={'tz-posture-state ' + (u.site ? 'on' : 'off')} aria-hidden>●</span>
              </button>
            </li>
          ))}
          {filtered.length > 500 && <li className="tz-muted tz-pad">يُعرض 500 من {filtered.length.toLocaleString('ar-AE')} — ضيّق البحث لعرض البقية.</li>}
        </ul>
      </section>
    </div>
  );

  // Center-left overlay on the map (same footprint as other workspaces' context card) — read only.
  const context = (
    <aside className="tz-context" aria-label="موقف الوحدة">
      <div className="tz-context-body" data-testid="posture-details">
        {!unit && <section className="tz-card"><p className="tz-muted">اختر وحدة من القائمة لعرض تفاصيلها هنا.</p></section>}
        {unit && (
          <section className="tz-card rs-summary" data-testid="posture-unit-card">
            <header className="tz-posture-head">
              <span className="tz-posture-head-icon"><Icon name="building" /></span>
              <div>
                <h2 className="tz-site-title">{unit.code || unit.name}</h2>
                <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{unit.name}</p>
              </div>
            </header>
            <dl className="rs-facts">
              <div><dt>الموقع الحالي</dt><dd data-testid="posture-site">{unit.site?.name ?? 'لا يوجد تمركز حالي'}</dd></div>
              <div><dt>نوع التمركز</dt><dd>{unit.kind === 'TEMPORARY' ? 'مؤقت' : unit.kind ? 'دائم' : '—'}{unit.plannedEnd ? ' · حتى ' + fullDate(unit.plannedEnd) : ''}</dd></div>
              <div><dt>الحالة</dt><dd>{UNIT_STATE[unit.state] ?? unit.state}</dd></div>
              <div><dt>المنطقة الرئيسية</dt><dd data-testid="posture-primary">{unit.primary ? 'معتمدة' : 'لا توجد'}</dd></div>
              <div><dt>المنطقة الفرعية</dt><dd data-testid="posture-alternative">{unit.alternative ? 'معتمدة' : 'لا توجد'}</dd></div>
              {!!unit.otherUnitsAtSite && <div><dt>وحدات أخرى في الموقع</dt><dd data-testid="posture-others">{unit.otherUnitsAtSite}</dd></div>}
              {unit.request && (
                <div><dt>طلب جارٍ</dt><dd data-testid="posture-request">{(isPurpose(unit.request.purpose) ? PURPOSE_TITLE[unit.request.purpose] : unit.request.purpose) + ' · ' + unit.request.state}</dd></div>
              )}
            </dl>
            <p className="muted micro" style={{ marginTop: 6 }}>عرض فقط — لا يتغيّر من هنا شيء. الطلبات من «＋ إنشاء» ومتابعتها في «الطلبات».</p>
          </section>
        )}
      </div>
    </aside>
  );

  // Bottom strip: aggregate counts, same ones the owner's design shows.
  const bottom = (
    <footer className="tz-posture-strip" aria-label="موجز الموقف">
      <span><b>{counts.sites.toLocaleString('ar-AE')}</b><small>مواقع تمركز</small></span>
      <span><b>{counts.onSite.toLocaleString('ar-AE')}</b><small>وحدة داخل الموقع</small></span>
      <span><b>{counts.offSite.toLocaleString('ar-AE')}</b><small>وحدة خارج الموقع</small></span>
      <span><b>{counts.temp.toLocaleString('ar-AE')}</b><small>تمركز مؤقت</small></span>
      <span><b>{(units ?? []).filter((u) => u.request).length.toLocaleString('ar-AE')}</b><small>طلبات جارية على وحدات</small></span>
    </footer>
  );

  return (
    <div className="tz-posture-shell" data-testid="stationing-posture">
      <OperationalWorkspace
        listRail
        railLabel="الوحدات"
        contextLabel="الموقف"
        sheetKey={selected ?? ''}
        rail={rail}
        context={context}
        centre={app.state?.empty ? (
          <EmptyCentre title="لا توجد بيانات تمركز ضمن نطاقك" hint="تظهر الخريطة بعد استيراد الوحدات وتسجيل المواقع." />
        ) : (
          <MapFrame
            title={<span className="tz-mapstep"><Icon name="map" /><b>الموقف العملياتي</b>{unit && <small>{unit.name}</small>}</span>}
            mode={mode}
            setMode={setMode}
            view={view}
            setView={setView}
            has3d={!!terrain3d}
            onFit={() => setFit((k) => k + 1)}
            legend={<MapLegend stage="full" fold />}
          >
            {terrain3d !== undefined && req && (
              <RequestMap
                view={view}
                terrain3d={terrain3d}
                request={req}
                checks={null}
                mode={mode}
                fitMaxZoom={13}
                hideSite
                fit
                fitKey={fit}
                referenceInteractive={false}
                onMap={(m) => setMap(m)}
                selected={null}
              />
            )}
          </MapFrame>
        )}
      />
      {bottom}
    </div>
  );
}

export default StationingPosture;
