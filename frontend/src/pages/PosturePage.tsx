import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type PostureUnit } from '../api/client';
import type { GeoPolygon, RestationingRequest, SiteGeometry } from '../api/types';
import type { Map as MlMap } from 'maplibre-gl';
import { PITCH_3D, installedTerrain3d, type MapView } from '../components/map/maplibre';
import type { BasemapMode, Terrain3dSource } from '../components/map/maplibre/offlineStyle';
import { flatSource } from '../components/tree/tree';
import { UnitTree } from '../components/tree/UnitTree';
import { Icon } from '../components/ui';
import { MapFrame, MapLegend } from '../components/workspace/MapFrame';
import { EmptyCentre } from '../components/workspace/EmptyCentre';
import { RequestMap } from '../components/workspace/RequestMap';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { PURPOSE_TITLE, UNIT_STATE, isPurpose } from '../lib/requestPurpose';

/** One unit's posture as the map's request shape: its site as «current», its own two areas. Read-only. */
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

type Cohort = 'all' | 'stationed' | 'noStationing' | 'temporary';
const COHORTS: readonly [Cohort, string][] = [
  ['all', 'الكل'],
  ['stationed', 'متمركزة'],
  ['noStationing', 'بلا تمركز معتمد'],
  ['temporary', 'تمركز مؤقت'],
];

const STRIP_CAP = 60;

/**
 * «الموقف العملياتي» — the owner-approved Design 2 (21 Nov 2026 UI closure Phase 1): a title + subtitle, a horizontal
 * unit selector with search and cohort filters at the top, a dominant map in the centre, the selected unit's details
 * on the side, and a scoped posture summary along the bottom. The hierarchy «استعراض الوحدات» is a drawer that opens
 * from the top strip — the full tree is no longer a permanent rail.
 */
export function PosturePage() {
  const app = useApp();
  const [units, setUnits] = useState<PostureUnit[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [cohort, setCohort] = useState<Cohort>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mode, setMode] = useState<BasemapMode>('terrain');
  const [view, setView] = useState<MapView>('2d');
  const [terrain3d, setTerrain3d] = useState<Terrain3dSource | null | undefined>(undefined);
  const [fit, setFit] = useState(0);
  const [map, setMap] = useState<MlMap | null>(null);
  /** When a map click lands on a site that holds several in-scope units: a chooser lists them (POSTURE-09). */
  const [chooser, setChooser] = useState<{ siteId: string; siteName: string; unitIds: string[] } | null>(null);
  const strip = useRef<HTMLDivElement>(null);

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

  const tree = useMemo(() => flatSource(units ?? []), [units]);
  const unit = units?.find((u) => u.id === selected) ?? null;
  const req = useMemo(() => (unit ? asMapRequest(unit) : null), [unit]);
  useEffect(() => setFit((k) => k + 1), [selected]);

  // Keep the selected chip in view as the person moves through the list.
  useEffect(() => {
    if (!strip.current || !selected) return;
    const el = strip.current.querySelector<HTMLElement>('[data-chip="' + CSS.escape(selected) + '"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [selected]);

  const counts = useMemo(() => {
    const all = units?.length ?? 0;
    const stationed = units?.filter((u) => !!u.site).length ?? 0;
    const temporary = units?.filter((u) => u.kind === 'TEMPORARY').length ?? 0;
    const noStationing = all - stationed;
    const sites = new Set((units ?? []).filter((u) => u.site).map((u) => u.site!.id)).size;
    return { all, stationed, noStationing, temporary, sites };
  }, [units]);

  const filtered = useMemo(() => {
    const low = q.trim().toLowerCase();
    return (units ?? [])
      .filter((u) =>
        cohort === 'all' ? true :
        cohort === 'stationed' ? !!u.site :
        cohort === 'temporary' ? u.kind === 'TEMPORARY' :
        !u.site,
      )
      .filter((u) => !low || u.code.toLowerCase().includes(low) || u.name.toLowerCase().includes(low) || (u.site?.name ?? '').toLowerCase().includes(low));
  }, [units, cohort, q]);

  // The horizontal strip holds the first STRIP_CAP matches plus the selected unit (even if filtered out) so the choice
  // is always visible. Beyond STRIP_CAP the owner opens the drawer for the rest.
  const stripUnits = useMemo(() => {
    const top = filtered.slice(0, STRIP_CAP);
    if (unit && !top.includes(unit)) return [unit, ...top];
    return top;
  }, [filtered, unit]);

  /**
   * Multi-value map: a site may host several in-scope units (owner, Phase 1 §6). A map click on such a site opens a
   * chooser; a click on a site with exactly one in-scope unit selects it; a click on a reference site falls through to
   * the normal information card (RequestMap.pick fallback).
   */
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
  const pickUnitBySite = (siteId: string | null): boolean => {
    if (!siteId) return false;
    const unitIds = siteToUnits.get(siteId) ?? [];
    if (unitIds.length === 0) return false;
    if (unitIds.length === 1) {
      setSelected(unitIds[0]);
    } else {
      setChooser({ siteId, siteName: sitesById.get(siteId) ?? siteId, unitIds });
    }
    return true;
  };

  if (app.state?.empty) {
    return (
      <div className="tz-posture2 tz-posture2-empty" data-testid="posture-empty">
        <EmptyCentre title="لا توجد بيانات تمركز ضمن نطاقك" hint="تظهر الخريطة بعد استيراد الوحدات وتسجيل المواقع." />
      </div>
    );
  }

  return (
    <div className="tz-posture2" data-testid="stationing-posture">
      <header className="tz-posture2-title">
        <div className="tz-posture2-titles">
          <h1>الموقف العملياتي</h1>
          <p>مواقع الوحدات وتمركزها ومناطق الانتشار</p>
        </div>
        <div className="tz-posture2-titlecounts" aria-label="موجز سريع">
          <span><b data-testid="posture-count">{counts.all.toLocaleString('ar-AE')}</b><small>الوحدات الظاهرة</small></span>
          <span><b>{counts.stationed.toLocaleString('ar-AE')}</b><small>متمركزة</small></span>
          <span><b>{counts.noStationing.toLocaleString('ar-AE')}</b><small>بلا تمركز</small></span>
        </div>
      </header>

      <nav className="tz-posture2-selector" aria-label="اختيار الوحدة">
        <div className="tz-posture2-search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="بحث عن وحدة"
            placeholder="بحث عن وحدة أو موقع…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="tz-posture2-tabs" role="tablist" aria-label="تصفية الوحدات">
          {COHORTS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={cohort === k}
              data-testid={'cohort-' + k}
              className={'tz-posture2-tab' + (cohort === k ? ' is-active' : '')}
              onClick={() => setCohort(k)}
            >
              {label}
              <span className="tz-posture2-tab-num">
                ({(k === 'all' ? counts.all : k === 'stationed' ? counts.stationed : k === 'temporary' ? counts.temporary : counts.noStationing).toLocaleString('ar-AE')})
              </span>
            </button>
          ))}
          <button type="button" className="tz-posture2-browse" onClick={() => setDrawerOpen(true)} data-testid="posture-browse">
            <Icon name="units" /> استعراض الوحدات
          </button>
        </div>
        <div className="tz-posture2-strip" ref={strip} role="listbox" aria-label="الوحدات">
          {!units && <span className="tz-posture2-chip is-muted">جارٍ التحميل…</span>}
          {units && stripUnits.length === 0 && <span className="tz-posture2-chip is-muted">لا وحدات مطابقة.</span>}
          {stripUnits.map((u) => (
            <button
              key={u.id}
              type="button"
              role="option"
              aria-selected={selected === u.id}
              data-testid="posture-unit"
              data-chip={u.id}
              className={'tz-posture2-chip' + (selected === u.id ? ' is-selected' : '') + (u.site ? ' is-stationed' : ' is-empty') + (u.kind === 'TEMPORARY' ? ' is-temporary' : '')}
              onClick={() => setSelected(u.id)}
              title={u.site?.name ?? 'بلا تمركز معتمد'}
            >
              <span className="tz-posture2-chip-dot" aria-hidden />
              <span className="tz-posture2-chip-text">
                <b>{u.code || u.name}</b>
                <small>{u.name}</small>
                <small className="muted">{u.site?.name ?? 'بلا تمركز معتمد'}</small>
              </span>
            </button>
          ))}
          {filtered.length > STRIP_CAP && (
            <button type="button" className="tz-posture2-chip is-more" onClick={() => setDrawerOpen(true)}>
              <Icon name="units" /> المزيد ({(filtered.length - STRIP_CAP).toLocaleString('ar-AE')})
            </button>
          )}
        </div>
      </nav>

      <div className="tz-posture2-main">
        <div className="tz-posture2-centre">
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
                referenceInteractive
                onMap={setMap}
                highlight={unit?.site?.id ?? null}
                fitSites
                pick={{ selectedId: unit?.site?.id ?? null, onPick: (siteId) => pickUnitBySite(siteId) }}
              />
            )}
          </MapFrame>
        </div>
        <aside className="tz-posture2-side" aria-label="تفاصيل الوحدة" data-testid="posture-details">
          {!unit && <section className="tz-card"><p className="tz-muted">اختر وحدة من الشريط العلوي أو من الخريطة لعرض تفاصيلها.</p></section>}
          {unit && (
            <section className="tz-card rs-summary" data-testid="posture-unit-card">
              <header className="tz-posture2-head">
                <span className="tz-posture2-head-icon"><Icon name="building" /></span>
                <div>
                  <h2 className="tz-site-title">{unit.code || unit.name}</h2>
                  <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>{unit.name}</p>
                </div>
              </header>
              <dl className="rs-facts">
                <div><dt>الموقع الحالي</dt><dd data-testid="posture-site">{unit.site?.name ?? 'بلا تمركز معتمد'}</dd></div>
                <div><dt>نوع التمركز</dt><dd>{unit.kind === 'TEMPORARY' ? 'مؤقت' : unit.kind ? 'دائم' : '—'}{unit.plannedEnd ? ' · حتى ' + fullDate(unit.plannedEnd) : ''}</dd></div>
                <div><dt>الحالة</dt><dd>{UNIT_STATE[unit.state] ?? unit.state}</dd></div>
                <div><dt>المنطقة الرئيسية</dt><dd data-testid="posture-primary">{unit.primary ? 'معتمدة' : 'لا توجد'}</dd></div>
                <div><dt>المنطقة الفرعية</dt><dd data-testid="posture-alternative">{unit.alternative ? 'معتمدة' : 'لا توجد'}</dd></div>
                {!!unit.otherUnitsAtSite && <div><dt>وحدات أخرى في الموقع</dt><dd data-testid="posture-others">{unit.otherUnitsAtSite}</dd></div>}
                {unit.request && (
                  <div><dt>طلب جارٍ</dt><dd data-testid="posture-request">{(isPurpose(unit.request.purpose) ? PURPOSE_TITLE[unit.request.purpose] : unit.request.purpose) + ' · ' + unit.request.state}</dd></div>
                )}
              </dl>
              <p className="muted micro" style={{ marginTop: 6 }}>عرض فقط — لا يتغيّر من هنا شيء.</p>
            </section>
          )}
        </aside>
      </div>

      <footer className="tz-posture2-strip-bot" aria-label="موجز الموقف">
        <span><b>{counts.all.toLocaleString('ar-AE')}</b><small>الوحدات الظاهرة</small></span>
        <span><b>{counts.stationed.toLocaleString('ar-AE')}</b><small>الوحدات المتمركزة</small></span>
        <span><b>{counts.noStationing.toLocaleString('ar-AE')}</b><small>بلا تمركز معتمد</small></span>
        <span><b>{counts.temporary.toLocaleString('ar-AE')}</b><small>تمركز مؤقت</small></span>
        <span><b>{counts.sites.toLocaleString('ar-AE')}</b><small>المواقع المستخدمة</small></span>
      </footer>

      {drawerOpen && units && (
        <div className="tz-posture2-drawer" role="dialog" aria-modal="true" aria-label="استعراض الوحدات" data-testid="posture-drawer">
          <div className="tz-posture2-drawer-shade" onClick={() => setDrawerOpen(false)} aria-hidden />
          <div className="tz-posture2-drawer-panel">
            <header className="tz-posture2-drawer-head">
              <b>استعراض الوحدات</b>
              <button type="button" className="tz-pbtn" aria-label="إغلاق" onClick={() => setDrawerOpen(false)}>×</button>
            </header>
            <div className="tz-posture2-drawer-body">
              <UnitTree
                source={tree}
                label="الوحدات"
                searchLabel="بحث في الوحدات"
                testId="posture-tree"
                selected={selected}
                trail={tree.trail(selected)}
                initialOpen={units.length <= 80 ? units.map((u) => u.id) : []}
                openSingleRoot
                onSelect={(u) => (setSelected(u.id), setDrawerOpen(false))}
                meta={(u) => u.site?.name ?? 'بلا تمركز معتمد'}
                empty="لا وحدات ضمن صلاحيتك."
              />
            </div>
          </div>
        </div>
      )}

      {chooser && (
        <div className="tz-posture2-chooser" role="dialog" aria-modal="true" aria-label={'وحدات في ' + chooser.siteName} data-testid="posture-site-chooser">
          <div className="tz-posture2-chooser-shade" onClick={() => setChooser(null)} aria-hidden />
          <div className="tz-posture2-chooser-panel">
            <header className="tz-posture2-chooser-head">
              <b>{chooser.siteName}</b>
              <small>{chooser.unitIds.length.toLocaleString('ar-AE')} وحدات ضمن صلاحيتك</small>
              <button type="button" className="tz-pbtn" aria-label="إغلاق" onClick={() => setChooser(null)}>×</button>
            </header>
            <ul className="tz-posture2-chooser-list">
              {chooser.unitIds.map((uid) => {
                const u = units?.find((x) => x.id === uid);
                if (!u) return null;
                return (
                  <li key={uid}>
                    <button type="button" className="tz-posture2-chooser-item" data-testid="posture-site-chooser-item" onClick={() => (setSelected(uid), setChooser(null))}>
                      <span className="tz-posture2-chooser-icon"><Icon name="building" /></span>
                      <span className="tz-posture2-chooser-meta">
                        <b>{u.code || u.name}</b>
                        <small>{u.name}</small>
                      </span>
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

export type { SiteGeometry };

export default PosturePage;
