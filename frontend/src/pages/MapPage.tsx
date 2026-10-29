import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type L from 'leaflet';
import { api, isAbort, urls, type ApiError } from '../api/client';
import type { ImportJob, MapContext, MapFeature, MapFeatures, MapPackage, SiteDetail, SiteRequestActionCode } from '../api/types';
import { BoundaryEditor } from '../components/map/BoundaryEditor';
import { OrgTree, SiteTree } from '../components/map/BrowseTrees';
import { ImportDialog, PackageManager } from '../components/map/MapAdmin';
import { MapCanvas, featureBounds, type FitTarget, type SiteHit, type Viewport } from '../components/map/MapCanvas';
import { BackgroundPanel, CoverageNote, LayersPanel, Legend } from '../components/map/MapPanels';
import { RowActionsButton, SiteActionMenu, type MenuAnchor, type SiteActionsState } from '../components/map/SiteActionMenu';
import { SiteDetailPanel, type SiteAction } from '../components/map/SiteDetailPanel';
import { useApp } from '../lib/app';
import { fullDate, fullTime } from '../lib/dates';
import {
  AVAILABILITY_STYLE,
  DEFAULT_LAYERS,
  UNKNOWN_STYLE,
  defaultPeriod,
  loadMapContext,
  periodQuery,
  saveMapContext,
  switchPeriodMode,
  type LayerSettings,
  type MapMode,
  type MapPeriod,
  type SavedMapContext,
} from '../lib/mapState';

type OrgFilter = { id: string; name: string; includeSub: boolean };
/** The on-site menu: always for the selected site; the anchor object is kept stable while it is open. */
type MenuState = { siteId: string; name: string; anchor: MenuAnchor; keyboard: boolean; opener: HTMLElement | null };

function periodSummary(p: MapPeriod): string {
  const q = periodQuery(p);
  if (!q) return 'فترة غير مكتملة';
  if (p.mode === 'OPEN') return 'من ' + fullTime(q.from) + ' — مفتوحة المدة';
  return (p.mode === 'HOURS' ? fullTime(q.from) + ' ← ' + fullTime(q.to) : fullDate(q.from) + ' ← ' + fullDate(q.to) + ' (غير مشمول)');
}

/**
 * The map is the workspace: choose an organisation or a site, a period and resources, read availability, and start a
 * request in a drawer without losing the selection. Every layer comes from the server for the current viewport and
 * period; a failed refresh shows a neutral state instead of the previous answer.
 */
export function MapPage() {
  const app = useApp();
  const { me, selectedSiteId, setSelectedSiteId, revision, can } = app;
  const saved = useRef<SavedMapContext>(loadMapContext(me.id));
  const [ctx, setCtx] = useState<MapContext | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [org, setOrg] = useState<OrgFilter | null>(saved.current.org ?? null);
  const [period, setPeriod] = useState<MapPeriod>(() => saved.current.period ?? defaultPeriod());
  const [mode, setMode] = useState<MapMode>(saved.current.mode ?? 'availability');
  const [layers, setLayers] = useState<LayerSettings>(() => ({ ...DEFAULT_LAYERS, ...(saved.current.layers ?? {}) }));
  const [tab, setTab] = useState<'orgs' | 'sites'>(saved.current.tab ?? 'sites');
  const [toolsCollapsed, setToolsCollapsed] = useState(saved.current.toolsCollapsed ?? false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [data, setData] = useState<MapFeatures | null>(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [background, setBackground] = useState<MapPackage | null>(null);
  const [previewPkg, setPreviewPkg] = useState<MapPackage | null>(null);
  const [panel, setPanel] = useState<'bg' | 'layers' | null>(null);
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [siteFeature, setSiteFeature] = useState<MapFeature | null>(null);
  const [siteLoading, setSiteLoading] = useState(false);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [resources, setResources] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [siteActions, setSiteActions] = useState<SiteActionsState | null>(null);
  const [fit, setFit] = useState<FitTarget | null>(null);
  const [reveal, setReveal] = useState<{ ids: string[]; key: number } | null>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  /** The site whose record is being edited; fixed when the editor opens, whatever is selected afterwards. */
  const [editingSite, setEditingSite] = useState<SiteDetail | null>(null);
  const editing = !!editingSite;
  const [importFor, setImportFor] = useState<{ id: string; name: string } | null | false>(false);
  const [packagesOpen, setPackagesOpen] = useState(false);
  const [localRevision, setLocalRevision] = useState(0);
  const seq = useRef(0);
  const revealed = useRef<string | null>(null);
  const viewRef = useRef<SavedMapContext['view']>(saved.current.view);

  const pq = periodQuery(period);

  // remember the context of this person only (identifiers and view, never data)
  useEffect(() => {
    saveMapContext(me.id, {
      org: org ?? undefined,
      siteId: selectedSiteId ?? undefined,
      period,
      view: viewRef.current,
      packageId: background?.id ?? null,
      layers,
      mode,
      tab,
      toolsCollapsed,
    });
  }, [me.id, org, selectedSiteId, period, background?.id, layers, mode, tab, toolsCollapsed, viewport]);

  // context: extent of what this person may see, installed backgrounds, rights
  useEffect(() => {
    let live = true;
    api
      .mapContext()
      .then((c) => {
        if (!live) return;
        setCtx(c);
        setCtxError(null);
        setBackground((cur) => {
          if (cur && c.backgrounds.some((b) => b.id === cur.id)) return cur;
          const wanted = saved.current.packageId;
          if (wanted === null && saved.current.packageId !== undefined) return null;
          return c.backgrounds.find((b) => b.id === wanted) ?? c.backgrounds.find((b) => b.kind === 'ROADS') ?? c.backgrounds[0] ?? null;
        });
      })
      .catch((e: Error) => live && setCtxError(e.message));
    return () => {
      live = false;
    };
  }, [revision, localRevision]);

  // restore a saved site selection only if it is still visible
  useEffect(() => {
    if (!selectedSiteId && saved.current.siteId) setSelectedSiteId(saved.current.siteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // viewport layers: debounced by the map, previous request cancelled, late answers ignored
  useEffect(() => {
    if (!viewport || !pq) return;
    const id = ++seq.current;
    const ctl = new AbortController();
    setLoading(true);
    api
      .mapFeatures(
        {
          bbox: viewport.bbox,
          zoom: Math.round(viewport.zoom * 2) / 2,
          from: pq.from,
          to: pq.to,
          open: pq.open,
          orgId: org?.id,
          includeSubOrgs: org ? org.includeSub : undefined,
          resourceIds: resources.length ? resources.join(',') : undefined,
          packageId: background?.id,
        },
        ctl.signal,
      )
      .then((d) => {
        if (id !== seq.current) return;
        setData(d);
        setStale(null);
        setNotice((d as MapFeatures & { limits?: { message?: string } }).limits?.message ?? null);
      })
      .catch((e: ApiError) => {
        if (isAbort(e) || id !== seq.current) return;
        if (e.status === 404 && org) {
          setOrg(null);
          setNotice('الجهة المختارة لم تعد ضمن نطاقك؛ أزيل مرشح الجهة.');
          return;
        }
        setStale(e.message);
      })
      .finally(() => id === seq.current && setLoading(false));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport?.bbox, viewport?.zoom, pq?.from, pq?.to, pq?.open, org?.id, org?.includeSub, resources.join(','), background?.id, revision, localRevision]);

  // the selected site: record, path, and resource states for the period wherever the viewport is
  useEffect(() => {
    if (!selectedSiteId) {
      setSite(null);
      setSiteFeature(null);
      return;
    }
    let live = true;
    setSiteLoading(true);
    api
      .site(selectedSiteId)
      .then((s) => {
        if (!live) return;
        setSite(s);
        setSiteError(null);
        if (revealed.current !== s.id) {
          revealed.current = s.id;
          setReveal({ ids: s.path.map((p) => p.id), key: Date.now() });
        }
      })
      .catch((e: ApiError) => {
        if (!live) return;
        setSite(null);
        if (e.status === 404) {
          setSelectedSiteId(null);
          setNotice('الموقع المحفوظ لم يعد ضمن نطاقك.');
        } else setSiteError(e.message);
      })
      .finally(() => live && setSiteLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSiteId, revision, localRevision, data?.asOf]);

  useEffect(() => {
    if (!selectedSiteId || !pq) return;
    const ctl = new AbortController();
    setSiteLoading(true);
    api
      .mapFeatures({ siteIds: selectedSiteId, from: pq.from, to: pq.to, open: pq.open, resourceIds: resources.length ? resources.join(',') : undefined }, ctl.signal)
      .then((d) => {
        setSiteFeature(d.features[0] ?? null);
        setSiteError(null);
      })
      .catch((e: Error) => !isAbort(e) && setSiteError(e.message))
      .finally(() => !ctl.signal.aborted && setSiteLoading(false));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSiteId, pq?.from, pq?.to, pq?.open, resources.join(','), revision, localRevision, data?.asOf]);

  // default resource choice: only an unambiguous one (a single resource); with several, the person chooses — clicking a
  // parent site never claims the whole parent by itself
  const lastSite = useRef<string | null>(null);
  useEffect(() => {
    if (!siteFeature || lastSite.current === siteFeature.siteId) return;
    lastSite.current = siteFeature.siteId;
    setResources(siteFeature.resources.length === 1 ? [siteFeature.resources[0].id] : []);
  }, [siteFeature]);

  // the request actions this person may start from the selected site (server decision; a late answer for an earlier
  // selection is dropped)
  useEffect(() => {
    if (!selectedSiteId) {
      setSiteActions(null);
      return;
    }
    const ctl = new AbortController();
    const id = selectedSiteId;
    setSiteActions((cur) => (cur?.siteId === id ? cur : { siteId: id, data: null, error: null }));
    api
      .siteRequestActions(id, ctl.signal)
      .then((d) => setSiteActions({ siteId: id, data: d, error: null }))
      .catch((e: ApiError) => !isAbort(e) && setSiteActions({ siteId: id, data: null, error: e.message }));
    return () => ctl.abort();
  }, [selectedSiteId, revision, localRevision]);

  // the menu belongs to the selected site: a different selection or the boundary editor closes it
  useEffect(() => {
    if (menu && (menu.siteId !== selectedSiteId || editingSite)) setMenu(null);
  }, [selectedSiteId, editingSite, menu]);

  const select = useCallback(
    (id: string | null, fitTo: boolean) => {
      setSelectedSiteId(id);
      if (id !== lastSite.current) setResources([]);
      if (!id || !fitTo) return;
      api
        .mapFeatures({ siteIds: id, time: new Date().toISOString() })
        .then((d) => {
          const b = d.features[0] ? featureBounds(d.features[0]) : null;
          if (b) setFit({ bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], key: Date.now(), maxZoom: 17 });
          else setNotice('لا يوجد للموقع علامة أو حدود على الخريطة.');
        })
        .catch(() => undefined);
    },
    [setSelectedSiteId],
  );

  const onViewport = useCallback((v: Viewport) => {
    viewRef.current = { center: v.center, zoom: v.zoom };
    setViewport(v);
  }, []);

  const features = data?.features ?? [];
  const counts = useMemo(() => {
    const c = { FREE: 0, PARTIAL: 0, BUSY: 0, NO_RESOURCES: 0 } as Record<string, number>;
    features.forEach((f) => (c[f.availability] = (c[f.availability] ?? 0) + 1));
    return c;
  }, [features]);

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenu((m) => {
      if (m && restoreFocus) {
        const back = m.opener?.isConnected ? m.opener : document.querySelector<HTMLElement>(`.pin-icon:has(.pin-wrap[data-site="${m.siteId}"])`);
        window.setTimeout(() => back?.focus({ preventScroll: true }), 0);
      }
      return null;
    });
  }, []);

  /** A site activated on the map (marker or boundary): select it and open its menu at that point. */
  const onSiteHit = useCallback(
    (id: string, hit: SiteHit) => {
      select(id, false);
      if (editingSite) return;
      const f = features.find((x) => x.siteId === id);
      setMenu({ siteId: id, name: f?.name ?? '', anchor: { kind: 'map', latlng: hit.latlng, offset: hit.element ? 46 : 14 }, keyboard: hit.keyboard, opener: hit.element });
    },
    [select, editingSite, features],
  );

  /** The same menu from a tree or list row: the site is selected and fitted, the menu opens beside the row. */
  const openMenuFromRow = (id: string, name: string, el: HTMLElement, keyboard: boolean) => {
    if (menu?.siteId === id && menu.anchor.kind === 'element' && menu.anchor.el === el) return setMenu(null);
    select(id, true);
    setMenu({ siteId: id, name, anchor: { kind: 'element', el }, keyboard, opener: el });
  };

  /**
   * The one command behind every entry path (map menu, tree, list, side panel): open the request drawer with the
   * chosen published type, the selected organisation, this site, the resources chosen for it, and the map period.
   * Nothing is written until the person saves or submits; the server re-checks everything.
   */
  const startRequest = (siteId: string, action: SiteRequestActionCode, typeCode: string) => {
    setMenu(null);
    const f = siteFeature?.siteId === siteId ? siteFeature : features.find((x) => x.siteId === siteId);
    const own = f?.resources ?? [];
    const chosen = resources.filter((id) => own.some((r) => r.id === id));
    const open = action === 'OPEN_ENDED';
    const p = !open && period.mode === 'OPEN' ? switchPeriodMode(period, 'DAYS') : period;
    app.openWizard({
      origin: 'MAP',
      siteId,
      typeCode,
      layout: 'drawer',
      prefill: {
        ownerOrgId: org?.id,
        resourceIds: chosen.length ? chosen : own.length === 1 ? [own[0].id] : [],
        unit: p.mode === 'HOURS' ? 'HOURS' : 'DAYS',
        start: p.start,
        end: open ? '' : p.end,
        permanent: open,
        siteName: f?.name ?? site?.name,
      },
    });
  };

  const act = async (a: SiteAction) => {
    if (!site) return;
    if (a.kind === 'FIT') {
      const f = siteFeature ?? features.find((x) => x.siteId === site.id);
      const b = f ? featureBounds(f) : null;
      if (b) setFit({ bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], key: Date.now(), maxZoom: 17 });
      return;
    }
    if (a.kind === 'EDIT_BOUNDARY') return setEditingSite(site);
    if (a.kind === 'IMPORT_BOUNDARY') return setImportFor({ id: site.id, name: site.name });
    if (a.kind === 'CHANGE') {
      try {
        const d = await api.changeRequest(a.reservationId, a.typeCode);
        app.openWizard({ origin: 'MAP', requestId: d.id, layout: 'drawer' });
      } catch (e) {
        app.toast((e as Error).message);
      }
      return;
    }
    startRequest(site.id, a.action, a.typeCode);
  };

  const onImported = (job: ImportJob) => {
    app.toast('نُشرت حدود ' + job.features.length + ' موقع بإصدارات جديدة');
    setLocalRevision((r) => r + 1);
  };

  const setMode2 = (m: PeriodMode2) => setPeriod((p) => switchPeriodMode(p, m));

  if (ctxError) return <div className="note red">{ctxError}</div>;

  const menuFeature = menu ? ((siteFeature?.siteId === menu.siteId ? siteFeature : features.find((x) => x.siteId === menu.siteId)) ?? null) : null;

  const shownBackground = background;
  const initialExtent = ctx?.extent ?? null;

  return (
    <div className="map-workspace">
      <section className="card context-bar" aria-label="سياق العرض">
        <div className="context-summary">
          <span>
            <small>الجهة</small>
            <b>{org ? org.name + (org.includeSub ? ' (مع الفروع)' : '') : 'كل الجهات المسموحة'}</b>
            {org && (
              <button className="link-button text-link" onClick={() => setOrg(null)}>
                إزالة
              </button>
            )}
          </span>
          <span>
            <small>الموقع</small>
            <b>{site ? site.name : 'لم يُختر'}</b>
          </span>
          <span>
            <small>الفترة</small>
            <b>{periodSummary(period)}</b>
          </span>
          <span>
            <small>الخلفية</small>
            <b>{shownBackground ? shownBackground.name : 'دون خلفية'}</b>
          </span>
          <button className="button compact ghost" onClick={() => setToolsCollapsed((v) => !v)} aria-expanded={!toolsCollapsed}>
            {toolsCollapsed ? 'إظهار أدوات الفترة' : 'طي الأدوات'}
          </button>
        </div>
        {!toolsCollapsed && (
          <div className="period-tools" role="group" aria-label="الفترة">
            <div className="segmented" role="radiogroup" aria-label="نوع الفترة">
              {(
                [
                  ['HOURS', 'بالساعات'],
                  ['DAYS', 'بالأيام'],
                  ['OPEN', 'مفتوحة المدة'],
                ] as [PeriodMode2, string][]
              ).map(([m, l]) => (
                <button key={m} role="radio" aria-checked={period.mode === m} className={period.mode === m ? 'active' : ''} onClick={() => setMode2(m)}>
                  {l}
                </button>
              ))}
            </div>
            <label>
              {period.mode === 'OPEN' ? 'من' : 'البداية'}
              <input
                type={period.mode === 'HOURS' ? 'datetime-local' : 'date'}
                value={period.mode === 'HOURS' ? period.start : period.start.slice(0, 10)}
                onChange={(e) => e.target.value && setPeriod({ ...period, start: e.target.value })}
                aria-label="بداية الفترة"
              />
            </label>
            {period.mode !== 'OPEN' && (
              <label>
                النهاية (غير مشمولة)
                <input
                  type={period.mode === 'HOURS' ? 'datetime-local' : 'date'}
                  value={period.mode === 'HOURS' ? period.end : period.end.slice(0, 10)}
                  onChange={(e) => e.target.value && setPeriod({ ...period, end: e.target.value })}
                  aria-label="نهاية الفترة"
                />
              </label>
            )}
            {!pq && <span className="micro note red">الفترة غير صحيحة: النهاية يجب أن تكون بعد البداية.</span>}
            <span className="micro muted">التوقيت: {ctx?.timezone ?? 'Asia/Dubai'} · الفترات نصف مفتوحة [البداية، النهاية)</span>
          </div>
        )}
      </section>

      <div className={'stats-strip ' + (statsOpen ? 'open' : '')}>
        <button className="link-button text-link" onClick={() => setStatsOpen((v) => !v)} aria-expanded={statsOpen}>
          {statsOpen ? 'إخفاء الملخص' : 'ملخص نطاق العرض'}
        </button>
        {statsOpen && (
          <span className="micro">
            {features.length} موقع في نافذة العرض · {AVAILABILITY_STYLE.FREE.symbol} متاح {counts.FREE} · {AVAILABILITY_STYLE.PARTIAL.symbol} جزئي {counts.PARTIAL} ·{' '}
            {AVAILABILITY_STYLE.BUSY.symbol} غير متاح {counts.BUSY} · طلبات قيد المراجعة لك: {app.counts.submitted}
          </span>
        )}
      </div>
      {notice && (
        <div className="note orange map-notice" role="status">
          {notice}{' '}
          <button className="link-button text-link" onClick={() => setNotice(null)}>
            إخفاء
          </button>
        </div>
      )}

      <div className={'map-grid ' + (editing ? 'editing ' : '') + (editing || selectedSiteId ? 'with-detail' : '')}>
        <aside className="card browse-panel" aria-label="التصفح">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'orgs'} className={tab === 'orgs' ? 'active' : ''} onClick={() => setTab('orgs')}>
              الجهات
            </button>
            <button role="tab" aria-selected={tab === 'sites'} className={tab === 'sites' ? 'active' : ''} onClick={() => setTab('sites')}>
              المواقع
            </button>
          </div>
          {tab === 'orgs' ? (
            <OrgTree
              selectedId={org?.id ?? null}
              includeSub={org?.includeSub ?? true}
              onSelect={(o) => (o ? setOrg({ ...o, includeSub: org?.includeSub ?? true }) : setOrg(null))}
              onIncludeSub={(v) => org && setOrg({ ...org, includeSub: v })}
              revision={revision}
            />
          ) : (
            <SiteTree
              selectedId={selectedSiteId}
              onSelect={(id) => select(id, true)}
              onActions={openMenuFromRow}
              menuSiteId={menu?.anchor.kind === 'element' ? menu.siteId : null}
              revision={revision + localRevision}
              revealPath={reveal}
            />
          )}
          {org && (
            <div className="org-sites">
              <h3>مواقع مرتبطة بـ«{org.name}» في نافذة العرض</h3>
              {features.length === 0 && <p className="micro muted">{loading ? 'جارٍ التحميل…' : 'لا مواقع ضمن نافذة العرض؛ حرّك الخريطة أو كبّر النطاق.'}</p>}
              <ul>
                {features.map((f) => (
                  <li key={f.siteId} className="site-row-item">
                    <button className={'site-row ' + (selectedSiteId === f.siteId ? 'active' : '')} onClick={() => select(f.siteId, true)}>
                      <span>{f.code}</span>
                      <div>
                        <b>{f.name}</b>
                        <small>
                          {(f.relations ?? []).map((r) => (r === 'RESPONSIBLE' ? 'الجهة مسؤولة' : 'الجهة شاغلة في الفترة')).join(' · ')}
                        </small>
                      </div>
                      <i className="dot" style={{ color: AVAILABILITY_STYLE[f.availability].color }} title={AVAILABILITY_STYLE[f.availability].label} />
                    </button>
                    <RowActionsButton
                      name={f.name}
                      open={menu?.siteId === f.siteId && menu.anchor.kind === 'element'}
                      onOpen={(el, kb) => openMenuFromRow(f.siteId, f.name, el, kb)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <div className="map-column">
          {ctx ? (
            <MapCanvas
              className="workspace-map"
              features={features}
              stale={!!stale}
              selectedSiteId={selectedSiteId}
              onSelect={onSiteHit}
              onBackgroundClick={() => menu && closeMenu(false)}
              mode={mode}
              background={shownBackground}
              layers={layers}
              initialView={saved.current.view ?? null}
              initialExtent={initialExtent}
              onViewport={onViewport}
              fitTarget={fit}
              onMap={setMap}
              hiddenSiteId={editingSite?.id ?? null}
            >
              <div className="map-toolbar">
                <div className="map-mode" role="radiogroup" aria-label="وضع الألوان">
                  <button role="radio" aria-checked={mode === 'availability'} className={mode === 'availability' ? 'active' : ''} onClick={() => setMode('availability')}>
                    الإتاحة للفترة
                  </button>
                  <button role="radio" aria-checked={mode === 'requests'} className={mode === 'requests' ? 'active' : ''} onClick={() => setMode('requests')}>
                    حالة الطلبات
                  </button>
                </div>
                <div className="map-tools text-tools">
                  <button className="button compact" aria-expanded={panel === 'bg'} onClick={() => setPanel(panel === 'bg' ? null : 'bg')}>
                    الخلفية
                  </button>
                  <button className="button compact" aria-expanded={panel === 'layers'} onClick={() => setPanel(panel === 'layers' ? null : 'layers')}>
                    الطبقات
                  </button>
                  <button className={'button compact ' + (layers.labels ? 'pressed' : '')} aria-pressed={layers.labels} onClick={() => setLayers({ ...layers, labels: !layers.labels })}>
                    الأسماء
                  </button>
                  <button
                    className="button compact"
                    onClick={() => {
                      const f = selectedSiteId ? siteFeature : null;
                      const list = f ? [f] : features;
                      const all = list.map((x) => featureBounds(x)).filter(Boolean) as L.LatLngBounds[];
                      if (!all.length && initialExtent) {
                        setFit({ bounds: [[initialExtent[1], initialExtent[0]], [initialExtent[3], initialExtent[2]]], key: Date.now() });
                        return;
                      }
                      if (!all.length) return;
                      const b = all.reduce((acc, x) => acc.extend(x), all[0].pad(0));
                      setFit({ bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], key: Date.now(), maxZoom: 17 });
                    }}
                  >
                    ملاءمة الاختيار
                  </button>
                  <button className="icon-button" onClick={() => map?.zoomIn()} aria-label="تكبير الخريطة">
                    ＋
                  </button>
                  <button className="icon-button" onClick={() => map?.zoomOut()} aria-label="تصغير الخريطة">
                    −
                  </button>
                </div>
              </div>
              {panel === 'bg' && (
                <BackgroundPanel
                  context={ctx}
                  selected={background}
                  preview={previewPkg}
                  onSelect={(p) => {
                    setBackground(p);
                    setPanel(null);
                  }}
                  onManage={() => (setPanel(null), setPackagesOpen(true))}
                />
              )}
              {panel === 'layers' && <LayersPanel layers={layers} onChange={setLayers} canSeeRequests={can('VIEW')} />}
              <Legend mode={mode} stale={!!stale} />
              <CoverageNote coverage={stale ? null : data?.coverage ?? null} background={shownBackground} />
              {(loading || stale) && (
                <div className={'map-status ' + (stale ? 'error' : '')} role="status">
                  {stale ? 'تعذر تحديث الخريطة: ' + stale + ' — الألوان محايدة حتى ينجح التحديث.' : 'جارٍ تحديث البيانات من الخادم…'}
                </div>
              )}
            </MapCanvas>
          ) : (
            <section className="card map-card workspace-map empty">جارٍ تحميل سياق الخريطة…</section>
          )}
          <div className="map-admin-links">
            {ctx?.canEditBoundaries && (
              <button className="button compact ghost" onClick={() => setImportFor(null)}>
                استيراد حدود المواقع
              </button>
            )}
            {ctx?.canManagePackages && (
              <button className="button compact ghost" onClick={() => setPackagesOpen(true)}>
                مدير الخرائط
              </button>
            )}
            {ctx?.canExport && (
              <a className="button compact ghost" href={urls.boundariesExport()}>
                تصدير الحدود المسموحة (GeoJSON)
              </a>
            )}
            {data && <span className="micro muted">بيانات الخادم · {fullTime(data.asOf)}</span>}
          </div>
        </div>

        {editingSite && map ? (
          <BoundaryEditor
            key={editingSite.id}
            map={map}
            site={editingSite}
            onCancel={() => setEditingSite(null)}
            onDone={(v) => {
              app.toast('حُفظت حدود «' + editingSite.name + '» بالإصدار ' + v);
              setEditingSite(null);
              setLocalRevision((r) => r + 1);
            }}
          />
        ) : selectedSiteId ? (
          <SiteDetailPanel
            site={site}
            feature={siteFeature}
            loading={siteLoading}
            error={siteError}
            period={period}
            selectedResources={resources}
            onToggleResource={(id, on) => setResources((cur) => (on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id)))}
            onAction={act}
            actions={siteActions?.siteId === selectedSiteId ? siteActions : null}
            canCreate={can('CREATE')}
            requestTypes={app.requestTypes}
            onClose={() => select(null, false)}
          />
        ) : null}
      </div>

      {menu && (
        <SiteActionMenu
          map={map}
          anchor={menu.anchor}
          title={menuFeature?.name ?? site?.name ?? menu.name}
          subtitle={((menuFeature?.parentId ?? site?.parentId) ? 'منطقة أو موقع فرعي' : 'موقع رئيسي') + ' · ' + (menuFeature?.code ?? site?.code ?? '')}
          state={menuFeature ? (stale ? UNKNOWN_STYLE : AVAILABILITY_STYLE[menuFeature.availability]) : null}
          availability={periodSummary(period)}
          actions={siteActions?.siteId === menu.siteId ? siteActions : null}
          keyboard={menu.keyboard}
          onChoose={(a, code) => startRequest(menu.siteId, a, code)}
          onClose={closeMenu}
        />
      )}
      <ImportDialog open={importFor !== false} targetSite={importFor || null} onClose={() => setImportFor(false)} onPublished={onImported} />
      <PackageManager
        open={packagesOpen}
        onClose={() => setPackagesOpen(false)}
        onChanged={() => setLocalRevision((r) => r + 1)}
        onPreview={(p) => {
          setPreviewPkg(p);
          setBackground(p);
          setPackagesOpen(false);
          setFit({ bounds: [[p.coverage.minLat, p.coverage.minLng], [p.coverage.maxLat, p.coverage.maxLng]], key: Date.now() });
        }}
      />
    </div>
  );
}

type PeriodMode2 = MapPeriod['mode'];
