import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from '../lib/leaflet';
import { api, isAbort } from '../api/client';
import type { MapContext, MapFeature, MapPackage, OrgBranch, Relocation, SiteNode } from '../api/types';
import { MapCanvas, featureAnchor, featureBounds, type FitTarget, type SiteHit, type Viewport } from '../components/map/MapCanvas';
import { BackgroundPanel } from '../components/map/MapPanels';
import { OrgSymbolLayer } from '../components/map/OrgSymbolLayer';
import { StationOrgTree } from '../components/stationing/StationOrgTree';
import { StationingPanel, type StationLayers } from '../components/stationing/StationingPanel';
import { OrgSymbol } from '../components/UnitSymbol';
import { Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { formatKm, distanceM } from '../lib/geo';
import { DEFAULT_LAYERS } from '../lib/mapState';
import { parseStationingHash } from '../lib/stationingLink';
import '../styles/stationing.css';

type Org = { id: string; name: string };
const LAYER_KEY = 'tmrkz.stationing.layers.';
// organisation symbols are on: an organisation is chosen from its own symbol on the map as well as from the tree
const DEFAULT_STATION_LAYERS: StationLayers = { range: true, occupied: true, symbols: true, sites: true };
/** Stable objects: the map redraws its markers whenever these change identity. */
const CANVAS_LAYERS = { ...DEFAULT_LAYERS, sites: { visible: true, opacity: 0.25 } };
const NO_FEATURES: MapFeature[] = [];

function loadLayers(personId: string): StationLayers {
  try {
    return { ...DEFAULT_STATION_LAYERS, ...JSON.parse(localStorage.getItem(LAYER_KEY + personId) ?? '{}') };
  } catch {
    return DEFAULT_STATION_LAYERS;
  }
}

/** Second hash segment: a saved stationing draft to reopen (#stationing/<requestId>). */
function draftFromHash(): string | null {
  return parseStationingHash(location.hash).draft ?? null;
}

/** Markers closer than this on screen are one click target; a click there asks which site is meant (V-06). */
const STACK_PX = 24;

/**
 * Map-first stationing workspace (owner brief of 30 Oct 2026, ADR-025): the organisation tree on the right, the map in
 * the middle and the request panel on the left. Choose an organisation and one of its sites, choose «تمركز / إعادة
 * تمركز» at the site, drag the proposed marker, read the distance, the allowed range and occupied sites, then confirm or
 * cancel. Everything shown comes from the server for this person; nothing is written until a draft is saved or a
 * request is submitted, and the current site's marker is never moved by a proposal.
 */
export function StationingPage() {
  const app = useApp();
  const { me, can, revision } = app;
  const [ctx, setCtx] = useState<MapContext | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [background, setBackground] = useState<MapPackage | null>(null);
  const [bgOpen, setBgOpen] = useState(false);
  const [map, setMap] = useState<L.Map | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [features, setFeatures] = useState<MapFeature[]>([]);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState<string | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [orgSites, setOrgSites] = useState<MapFeature[]>([]);
  const [orgSitesLoading, setOrgSitesLoading] = useState(false);
  const [site, setSite] = useState<MapFeature | null>(null);
  const [popup, setPopup] = useState(false);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  const [stationing, setStationing] = useState(false);
  const [reopen, setReopen] = useState<{ requestId: string; relocation: Relocation; start: string | null; reason: string } | null>(null);
  const [period, setPeriod] = useState<{ start: string; end: string | null } | null>(null);
  const [layers, setLayers] = useState<StationLayers>(() => loadLayers(me.id));
  const [fit, setFit] = useState<FitTarget | null>(null);
  const [picked, setPicked] = useState<{ siteId: string; key: number } | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measureText, setMeasureText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ orgs: OrgBranch[]; sites: SiteNode[] } | null>(null);
  /** Several sites drawn at one point: the menu first asks which one (V-06). */
  const [stack, setStack] = useState<MapFeature[] | null>(null);
  const [revealOrg, setRevealOrg] = useState<{ ids: string[]; key: number } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  /** An organisation chosen with its site (a link): the map stays on the site instead of fitting all its sites. */
  const skipOrgFit = useRef(false);
  const stationingRef = useRef(stationing);
  stationingRef.current = stationing;
  const seq = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(LAYER_KEY + me.id, JSON.stringify(layers));
    } catch {
      /* per-viewer convenience only */
    }
  }, [layers, me.id]);

  useEffect(() => {
    api
      .mapContext()
      .then((c) => {
        setCtx(c);
        setBackground((cur) => cur ?? c.backgrounds.find((b) => b.kind === 'AERIAL') ?? c.backgrounds.find((b) => b.kind === 'ROADS') ?? c.backgrounds[0] ?? null);
      })
      .catch((e: Error) => setCtxError(e.message));
  }, [revision]);

  // the period the map colours: today, or the proposal's period while a stationing request is being prepared
  const pq = useMemo(() => {
    if (stationing && period) return period.end ? { from: period.start, to: period.end, open: false } : { from: period.start, to: undefined, open: true };
    const now = new Date();
    return { from: now.toISOString().slice(0, 13) + ':00:00.000Z', to: new Date(now.getTime() + 86400000).toISOString().slice(0, 13) + ':00:00.000Z', open: false };
  }, [stationing, period?.start, period?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  // every site in the viewport (occupancy matters around a proposal), cancelled and superseded like the main map
  useEffect(() => {
    if (!viewport) return;
    const id = ++seq.current;
    const ctl = new AbortController();
    setLoading(true);
    api
      .mapFeatures({ bbox: viewport.bbox, zoom: Math.round(viewport.zoom * 2) / 2, from: pq.from, to: pq.to, open: pq.open, packageId: background?.id }, ctl.signal)
      .then((d) => {
        if (id !== seq.current) return;
        setFeatures(d.features);
        setStale(null);
      })
      .catch((e) => !isAbort(e) && id === seq.current && setStale((e as Error).message))
      .finally(() => id === seq.current && setLoading(false));
    return () => ctl.abort();
  }, [viewport?.bbox, viewport?.zoom, pq.from, pq.to, pq.open, background?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // the selected organisation's linked sites (responsible or using them), wherever they are
  useEffect(() => {
    if (!org) {
      setOrgSites([]);
      return;
    }
    const ctl = new AbortController();
    setOrgSitesLoading(true);
    api
      .mapFeatures({ orgId: org.id, includeSubOrgs: false, from: pq.from, to: pq.to, open: pq.open }, ctl.signal)
      .then((d) => {
        setOrgSites(d.features);
        const keepView = skipOrgFit.current;
        skipOrgFit.current = false;
        if (!stationing && !keepView) {
          const all = d.features.map((f) => featureBounds(f)).filter(Boolean) as L.LatLngBounds[];
          if (all.length) {
            const b = all.reduce((acc, x) => acc.extend(x), all[0].pad(0));
            setFit({ bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], key: Date.now(), maxZoom: 15 });
          }
        }
      })
      .catch((e) => {
        if (isAbort(e)) return;
        setOrgSites([]);
        setNotice((e as Error).message);
      })
      .finally(() => !ctl.signal.aborted && setOrgSitesLoading(false));
    return () => ctl.abort();
  }, [org?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // reopen a saved draft from its request id
  useEffect(() => {
    const id = draftFromHash();
    if (!id) return;
    Promise.all([api.request(id), api.relocation(id)])
      .then(async ([r, rel]) => {
        if (!rel) return setNotice('هذا الطلب ليس له مقترح تمركز.');
        if (r.status !== 'DRAFT' && r.status !== 'RETURNED') setNotice('الطلب ' + r.number + ' مُرسل؛ يُعرض هنا للاطلاع ويُتابع من «الطلبات».');
        const d = await api.mapFeatures({ siteIds: rel.fromSite.id, time: new Date().toISOString() });
        const f = d.features[0];
        if (!f) return setNotice('المقر الحالي لهذا الطلب لم يعد ظاهراً لك.');
        setOrg({ id: rel.organization.id, name: rel.organization.name });
        setSite(f);
        setReopen({ requestId: id, relocation: rel, start: r.period?.start ?? null, reason: String((r.values as Record<string, unknown> | undefined)?.reason ?? '') });
        setStationing(true);
        const b = L.latLngBounds([[rel.centroid[0], rel.centroid[1]]]);
        const a = featureAnchor(f);
        if (a) b.extend(a);
        setFit({ bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], key: Date.now(), maxZoom: 14 });
      })
      .catch((e: Error) => setNotice(e.message));
  }, []);

  // a site opened from another screen (#stationing/site/<id>/org/<id>, V-09): select the organisation and the site, show
  // the organisation in the tree and open the site's menu; the address returns to #stationing once applied
  useEffect(() => {
    const apply = () => {
      const link = parseStationingHash(location.hash);
      if (!link.site || stationingRef.current) return;
      history.replaceState(null, '', '#stationing');
      api
        .mapFeatures({ siteIds: link.site, time: new Date().toISOString() })
        .then(async (d) => {
          const f = d.features[0];
          if (!f) return setNotice('الموقع المطلوب غير ظاهر لك على الخريطة.');
          const linked = [f.responsibleOrg, ...(f.occupants ?? [])].find((o) => o && o.id === link.org);
          let o: Org | null = linked ? { id: linked.id, name: linked.name } : null;
          if (!o && link.org) o = await api.org(link.org).then((x) => ({ id: x.org.id, name: x.org.name })).catch(() => null);
          if (!o && f.responsibleOrg) o = { id: f.responsibleOrg.id, name: f.responsibleOrg.name };
          if (o) {
            skipOrgFit.current = true;
            setOrg(o);
            setRevealOrg({ ids: ancestorsOf(o.id), key: Date.now() });
          }
          setStack(null);
          setSite(f);
          setPopup(true);
          const b = featureBounds(f);
          if (b) setFit({ bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], key: Date.now(), maxZoom: 16 });
        })
        .catch((e: Error) => setNotice(e.message));
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the site menu takes the keyboard focus when it opens; Escape closes it and returns to the site's marker (V-16)
  useEffect(() => {
    if (!popup || !popupPos) return;
    const el = popupRef.current;
    if (!el || el.contains(document.activeElement)) return;
    (el.querySelector<HTMLElement>('button:not(:disabled):not(.stw-x)') ?? el).focus({ preventScroll: true });
  }, [popup, !!popupPos, stack, site?.siteId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!popup) return;
    const id = site?.siteId;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setPopup(false);
      setStack(null);
      if (id) window.setTimeout(() => document.querySelector<HTMLElement>(`.pin-icon:has(.pin-wrap[data-site="${id}"])`)?.focus({ preventScroll: true }), 0);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [popup, site?.siteId]);

  // scale bar
  useEffect(() => {
    if (!map) return;
    const c = L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 140 }).addTo(map);
    return () => {
      c.remove();
    };
  }, [map]);

  // the on-site menu follows its marker while the map moves
  useEffect(() => {
    if (!map || !site || !popup) return setPopupPos(null);
    const at = featureAnchor(site);
    if (!at) return;
    const place = () => {
      const p = map.latLngToContainerPoint(at);
      setPopupPos({ x: p.x, y: p.y });
    };
    place();
    map.on('move zoom resize', place);
    return () => {
      map.off('move zoom resize', place);
    };
  }, [map, site, popup]);

  // distance measuring tool: click points on the map; the total length is shown
  useEffect(() => {
    if (!map || !measuring) return;
    const pts: L.LatLng[] = [];
    const g = L.layerGroup().addTo(map);
    const line = L.polyline([], { color: '#1f5fd6', weight: 3, interactive: false }).addTo(g);
    const onClick = (e: L.LeafletMouseEvent) => {
      pts.push(e.latlng);
      line.setLatLngs(pts);
      L.circleMarker(e.latlng, { radius: 4, color: '#1f5fd6', fillOpacity: 1, interactive: false }).addTo(g);
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += distanceM(pts[i - 1], pts[i]);
      setMeasureText(pts.length < 2 ? 'انقر النقطة التالية' : formatKm(total));
    };
    setMeasureText('انقر نقطة البداية على الخريطة');
    map.on('click', onClick);
    map.getContainer().classList.add('stw-measuring');
    return () => {
      map.off('click', onClick);
      map.getContainer().classList.remove('stw-measuring');
      g.remove();
      setMeasureText(null);
    };
  }, [map, measuring]);

  // search in the top bar: organisations and sites the person may see
  useEffect(() => {
    if (q.trim().length < 2) return setHits(null);
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      Promise.all([api.orgSearch(q.trim(), ctl.signal).catch(() => []), api.siteSearch(q.trim(), ctl.signal).catch(() => [])]).then(
        ([orgs, sites]) => !ctl.signal.aborted && setHits({ orgs: orgs.slice(0, 6), sites: sites.slice(0, 6) }),
      );
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const chooseOrg = useCallback(
    (o: Org | null) => {
      if (stationing) return setNotice('أكمل طلب التمركز المفتوح أو ألغِه قبل اختيار جهة أخرى.');
      setOrg(o);
      setSite(null);
      setPopup(false);
    },
    [stationing],
  );

  const chooseSite = (f: MapFeature, openMenu = true) => {
    if (stationing) return;
    setSite(f);
    setPopup(openMenu);
    // a symbol click has just chosen its organisation (several may share the site): keep it; else the responsible one
    const responsible = f.responsibleOrg;
    if (responsible) setOrg((cur) => cur ?? { id: responsible.id, name: responsible.name });
    const b = featureBounds(f);
    if (b) setFit({ bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], key: Date.now(), maxZoom: Math.max(map?.getZoom() ?? 13, 13) });
  };

  const onSiteHit = (id: string, hit: SiteHit) => {
    if (measuring) return;
    if (stationing) return setPicked({ siteId: id, key: Date.now() });
    const f = features.find((x) => x.siteId === id) ?? orgSites.find((x) => x.siteId === id);
    if (!f) return;
    // a pointer click on a marker that hides others (a main site and its sub-site at one point): ask which site (V-06);
    // the keyboard reaches each marker on its own, and a symbol or a boundary names its site, so they choose directly
    const at = featureAnchor(f);
    if (map && at && !hit.keyboard && hit.element?.classList.contains('pin-icon')) {
      const p = map.latLngToContainerPoint(at);
      const drawn = hit.element.querySelector('.pin-wrap')?.getBoundingClientRect();
      const near = features.filter((x) => {
        if (x.siteId === f.siteId) return true;
        const a = featureAnchor(x);
        if (!a) return false;
        if (map.latLngToContainerPoint(a).distanceTo(p) <= STACK_PX) return true;
        // another marker whose head lies under the clicked marker as drawn (its pin and name) cannot be clicked
        const h = document.querySelector(`.pin-wrap[data-site="${x.siteId}"] .pin-head`)?.getBoundingClientRect();
        if (!h || !drawn) return false;
        const cx = h.left + h.width / 2;
        const cy = h.top + h.height / 2;
        return cx >= drawn.left - 4 && cx <= drawn.right + 4 && cy >= drawn.top - 4 && cy <= drawn.bottom + 4;
      });
      if (near.length > 1) {
        setSite(f);
        setStack(near);
        setPopup(true);
        return;
      }
    }
    setStack(null);
    chooseSite(f);
  };

  /** The ancestors of an organisation, top first (the organisation structure the application already holds). */
  const orgsRef = useRef(app.orgs);
  orgsRef.current = app.orgs;
  const ancestorsOf = (id: string): string[] => {
    const byId = new Map(orgsRef.current.map((o) => [o.id, o]));
    const out: string[] = [];
    let cur = byId.get(id)?.parentId ?? null;
    while (cur && out.length < 40) {
      out.unshift(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    return out;
  };

  const startStationing = () => {
    if (!site || !org) return;
    setPopup(false);
    setReopen(null);
    setStationing(true);
  };

  const closeStationing = () => {
    setStationing(false);
    setReopen(null);
    setPeriod(null);
    if (draftFromHash()) history.replaceState(null, '', '#stationing');
  };

  const fitOrgSites = () => {
    const all = orgSites.map((f) => featureBounds(f)).filter(Boolean) as L.LatLngBounds[];
    if (!all.length) return setNotice('لا مواقع مرتبطة ظاهرة لهذه الجهة.');
    const b = all.reduce((acc, x) => acc.extend(x), all[0].pad(0));
    setFit({ bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], key: Date.now(), maxZoom: 15 });
    setPopup(false);
  };

  const shown = layers.sites ? features : NO_FEATURES;
  return (
    <div className="stw" dir="rtl">
      <Heading
        en="STATIONING / MAP WORKSPACE"
        title="مساحة التمركز"
        description="اختر الجهة ومقرها من الشجرة أو الخريطة، ثم اقترح موقعاً جديداً ضمن النطاق المسموح؛ لا يتغير الموقع الفعلي قبل الاعتماد."
        actions={
        <div className="stw-top-search">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="البحث عن جهة أو موقع …" aria-label="البحث عن جهة أو موقع" />
            {hits && (
              <div className="stw-search-pop" role="listbox">
                {hits.orgs.length + hits.sites.length === 0 && <p className="stw-note">لا نتائج ضمن ما يحق لك رؤيته.</p>}
                {hits.orgs.map((o) => (
                  <button key={'o' + o.id} onClick={() => (chooseOrg({ id: o.id, name: o.name }), setQ(''))}>
                    <small>جهة</small>
                    <b>{o.name}</b>
                  </button>
                ))}
                {hits.sites.map((s) => (
                  <button
                    key={'s' + s.id}
                    onClick={() => {
                      setQ('');
                      api.mapFeatures({ siteIds: s.id, time: new Date().toISOString() }).then((d) => d.features[0] && chooseSite(d.features[0]));
                    }}
                  >
                    <small>موقع</small>
                    <b>{s.name}</b>
                  </button>
                ))}
              </div>
            )}
          </div>
        }
      />

      {notice && (
        <div className="stw-notice" role="status">
          {notice}
          <button onClick={() => setNotice(null)} aria-label="إخفاء">✕</button>
        </div>
      )}

      <div className={'stw-body ' + (stationing ? 'with-panel' : '')}>
        <StationOrgTree
          selectedId={org?.id ?? null}
          onSelect={chooseOrg}
          sites={orgSites}
          sitesLoading={orgSitesLoading}
          selectedSiteId={site?.siteId ?? null}
          onSite={(f) => chooseSite(f)}
          revision={revision}
          revealPath={revealOrg}
        />

        <section className="stw-mapwrap" aria-label="خريطة التمركز">
          {ctxError ? (
            <p className="stw-note red">{ctxError}</p>
          ) : ctx ? (
            <MapCanvas
              className="stw-map"
              features={shown}
              stale={!!stale}
              selectedSiteId={site?.siteId ?? null}
              onSelect={onSiteHit}
              onBackgroundClick={() => !stationing && setPopup(false)}
              mode="availability"
              background={background}
              layers={CANVAS_LAYERS}
              initialExtent={ctx.extent ?? null}
              onViewport={setViewport}
              fitTarget={fit}
              onMap={setMap}
              hiddenSiteId={stationing ? site?.siteId ?? null : null}
              label="خريطة التمركز"
            >
              <div className="stw-chips" role="group" aria-label="الطبقات">
                {(
                  [
                    ['range', 'النطاق المسموح'],
                    ['occupied', 'المناطق المحجوزة'],
                    ['symbols', 'رموز الجهات'],
                    ['sites', 'المواقع'],
                  ] as [keyof StationLayers, string][]
                ).map(([k, label]) => (
                  <label key={k} className={'stw-chip ' + k}>
                    <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
                    {label}
                  </label>
                ))}
                <button className={'stw-chip btn ' + (bgOpen ? 'on' : '')} onClick={() => setBgOpen((v) => !v)} aria-expanded={bgOpen}>
                  ☰ الطبقات
                </button>
              </div>
              {bgOpen && (
                <div className="stw-bg-pop">
                  <BackgroundPanel context={ctx} selected={background} onSelect={(p) => (setBackground(p), setBgOpen(false))} />
                </div>
              )}
              <div className="stw-zoom" role="group" aria-label="أدوات الخريطة">
                <button onClick={() => map?.zoomIn()} aria-label="تكبير">＋</button>
                <button onClick={() => map?.zoomOut()} aria-label="تصغير">−</button>
                <button
                  onClick={() => {
                    const list = site ? [site] : orgSites.length ? orgSites : features;
                    const all = list.map((f) => featureBounds(f)).filter(Boolean) as L.LatLngBounds[];
                    if (!all.length) return;
                    const b = all.reduce((acc, x) => acc.extend(x), all[0].pad(0));
                    setFit({ bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]], key: Date.now(), maxZoom: 15 });
                  }}
                  aria-label="ملاءمة الاختيار"
                  title="ملاءمة الاختيار"
                >
                  ◎
                </button>
                <button className={measuring ? 'on' : ''} onClick={() => setMeasuring((v) => !v)} aria-pressed={measuring} aria-label="قياس المسافة" title="قياس المسافة">
                  📏
                </button>
              </div>
              {measureText && <div className="stw-measure">📏 {measureText}</div>}
              <OrgSymbolLayer
                map={map}
                features={shown}
                enabled={layers.symbols}
                onSelect={onSiteHit}
                onSelectOrg={(o) => !stationing && setOrg({ id: o.id, name: o.name })}
              />
              {(loading || stale) && <div className={'stw-status ' + (stale ? 'error' : '')}>{stale ? 'تعذر تحديث الخريطة: ' + stale : 'جارٍ تحديث البيانات…'}</div>}
              {!background && <div className="stw-status">لا توجد خلفية خرائط مثبتة؛ تُعرض المواقع وحدودها دون خلفية.</div>}
            </MapCanvas>
          ) : (
            <p className="stw-note">جارٍ تحميل سياق الخريطة…</p>
          )}

          {popup && site && popupPos && !stationing && stack && (
            <div ref={popupRef} tabIndex={-1} className="stw-popup" style={{ left: popupPos.x, top: popupPos.y }} role="dialog" aria-label="عدة مواقع في هذا الموضع">
              <button className="stw-x" onClick={() => (setPopup(false), setStack(null))} aria-label="إغلاق">✕</button>
              <div className="stw-popup-head">
                <span>
                  <b>عدة مواقع في هذا الموضع</b>
                  <small>اختر الموقع المقصود</small>
                </span>
              </div>
              <ul className="stw-stack">
                {stack.map((x) => (
                  <li key={x.siteId}>
                    <button className="stw-menu-item" onClick={() => (setStack(null), chooseSite(x))}>
                      <b>{x.name}</b>
                      <small>{x.parentId ? 'موقع فرعي' : 'موقع رئيسي'}{x.code ? ' · ' + x.code : ''}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {popup && site && popupPos && !stationing && !stack && (
            <div ref={popupRef} tabIndex={-1} className="stw-popup" style={{ left: popupPos.x, top: popupPos.y }} role="dialog" aria-label={'إجراءات ' + site.name}>
              <button className="stw-x" onClick={() => setPopup(false)} aria-label="إغلاق">✕</button>
              <div className="stw-popup-head">
                <OrgSymbol orgId={org?.id ?? site.responsibleOrg?.id} size={18} />
                <span>
                  <b>{org?.name ?? site.responsibleOrg?.name ?? 'جهة غير ظاهرة'}</b>
                  <small>{site.name}</small>
                  <small className="stw-mono">{featureAnchor(site) ? featureAnchor(site)!.lat.toFixed(4) + ' , ' + featureAnchor(site)!.lng.toFixed(4) : ''}</small>
                </span>
              </div>
              <button
                className="stw-menu-item primary"
                onClick={startStationing}
                disabled={!can('CREATE') || !org}
                title={!can('CREATE') ? 'لا تملك صلاحية تقديم الطلبات' : !org ? 'اختر الجهة من الشجرة أولاً' : undefined}
              >
                ⇄ طلب تمركز / إعادة تمركز
              </button>
              {!can('CREATE') && <small className="stw-note">لا تملك صلاحية تقديم الطلبات؛ يمنحها مدير الصلاحيات.</small>}
              <button className="stw-menu-item" onClick={fitOrgSites} disabled={!org}>
                ⌖ عرض المواقع المرتبطة
              </button>
            </div>
          )}
        </section>

        {stationing && site && org ? (
          <StationingPanel
            key={(reopen?.requestId ?? 'new') + site.siteId + org.id}
            map={map}
            org={org}
            site={site}
            features={features}
            layers={layers}
            pickedSite={picked}
            reopen={reopen}
            measuring={measuring}
            onPeriod={setPeriod}
            onClose={closeStationing}
            onSaved={(id, submitted) => {
              if (submitted) {
                closeStationing();
                app.setSelectedRequestId(id);
              } else history.replaceState(null, '', '#stationing/' + id);
            }}
          />
        ) : (
          <aside className="stw-panel guide" aria-label="خطوات الطلب">
            <h2>طلب تمركز من الخريطة</h2>
            <ol className="stw-guide">
              <li className={org ? 'done' : 'now'}>
                <b>اختيار الجهة والمقر الحالي</b>
                <small>{org ? org.name + (site ? ' · ' + site.name : ' — اختر مقرها من الشجرة أو الخريطة') : 'اختر الجهة من الشجرة أو من البحث'}</small>
              </li>
              <li className={site ? 'now' : ''}>
                <b>تحديد النوع والمستوى والمدة</b>
                <small>«طلب تمركز / إعادة تمركز» من قائمة المقر على الخريطة</small>
              </li>
              <li>
                <b>سحب العلامة على الخريطة</b>
                <small>تظهر المسافة والنطاق المسموح أثناء السحب</small>
              </li>
              <li>
                <b>التحقق من التوفر</b>
                <small>المواقع المحجوزة بالأحمر ولا يمكن اختيارها</small>
              </li>
              <li>
                <b>مراجعة وإرسال الطلب</b>
                <small>لا يتغير الموقع الفعلي قبل الاعتماد</small>
              </li>
            </ol>
            {site && !popup && (
              <button className="stw-btn primary" onClick={() => setPopup(true)}>
                فتح قائمة «{site.name}»
              </button>
            )}
            <p className="stw-hint">البيانات المعروضة من الخادم ضمن صلاحياتك؛ اسم الجهة الشاغلة لا يظهر إلا لمن يملك الاطلاع.</p>
          </aside>
        )}
      </div>
    </div>
  );
}
