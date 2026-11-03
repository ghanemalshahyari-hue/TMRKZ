import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../../frontend/src/components/ui';
import L from '../../../../frontend/src/lib/leaflet';
import { centroid, type Ring } from '../../../../frontend/src/lib/footprint';
import type { LatLng } from '../../../../frontend/src/lib/geo';
import basemapUrl from '../../../../map-packages/regional-basemap-2026.10/basemap.svg?url';
import { BASEMAP_BOUNDS, ORGS } from '../data';
import { svgBasemap } from '../svgBasemap';
import { symbolHtml, useOrgSymbols } from '../symbols';
import { OrgCard, RequestCard, ReservationCard, SiteCard, type CardCtx } from './cards';
import { ActionDialog, type Ask } from './dialog';
import { comparison, formatKm, mainSiteOf, orgName, rangeText, siteOf } from './compare';
import { DAY, blocking, check, clashes, day, descendants, perform, permanentOf, person, temporaryOf, type Action, type World } from './domain';
import { NOW, baseWorld } from './fixtures';
import { fitPadding } from './fit';
import { RequestEditor } from './RequestEditor';
import { SCENARIOS, type Sel } from './scenarios';

const ll = (r: Ring) => r.map((p) => [p.lat, p.lng] as L.LatLngTuple);
const C = { perm: '#2f6db0', temp: '#0e8f8f', areaP: '#7b4fb3', areaA: '#a46fd6', candP: '#1f9d55', candA: '#d9822b', off: '#8a999d' };

/** The scenario in the address (#s=7), applied to a fresh fictional world. */
function fromHash() {
  const n = Number(/s=(\d+)/.exec(location.hash)?.[1] ?? 0);
  const sc = SCENARIOS.find((s) => s.n === n) ?? null;
  let w = baseWorld();
  for (const [who, a] of sc?.setup ?? []) w = perform(w, who, a);
  return { sc, w };
}

export function ModelApp() {
  const init = useMemo(fromHash, []);
  const [world, setWorld] = useState<World>(init.w);
  const [actor, setActor] = useState(init.sc?.actor ?? 'p-req');
  const [sel, setSel] = useState<Sel>(init.sc?.sel ?? null);
  const [step, setStep] = useState(init.sc?.step ?? 1);
  const [showAreas, setShowAreas] = useState(!!init.sc?.showAreas);
  const [expandTemps, setExpandTemps] = useState(!!init.sc?.expandTemps);
  const [notice, setNotice] = useState<string | null>(null);
  const [legend, setLegend] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 900);
  const [ask, setAsk] = useState<Ask | null>(null);
  /** Narrow screens: a bottom sheet with three practical heights; the map stays a working surface (B4). */
  const [sheet, setSheet] = useState<'collapsed' | 'medium' | 'expanded'>('medium');
  const symbols = useOrgSymbols();
  const mapEl = useRef<HTMLDivElement>(null);
  const uxEl = useRef<HTMLDivElement>(null);
  const dockEl = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);

  // drawing a proposal on a phone: the sheet steps down to its working height; otherwise medium
  useEffect(() => setSheet(sel?.k === 'edit' && (step === 3 || step === 4) ? 'collapsed' : 'medium'), [sel, step]);
  // the map's own controls (zoom, scale) always sit just above the sheet
  useEffect(() => {
    const d = dockEl.current;
    if (!d) return;
    const ro = new ResizeObserver(() => uxEl.current?.style.setProperty('--sheet', (narrow ? d.offsetHeight : 0) + 'px'));
    ro.observe(d);
    return () => ro.disconnect();
  }, [narrow]);
  // a test hook for the browser evidence (prototype only): the simulated state and the map
  useEffect(() => {
    (window as unknown as { __stationingModel: unknown }).__stationingModel = { world, map, step, sheet };
  });

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 900);
    window.addEventListener('resize', onResize);
    const onHash = () => location.reload();
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  useEffect(() => {
    const m = L.map(mapEl.current!, { zoomControl: false, zoomSnap: 0.25, attributionControl: true });
    // tiled, drawn once per tile: a single SVG overlay was re-rasterised on every zoom step (map lag)
    svgBasemap(basemapUrl, BASEMAP_BOUNDS, 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap').addTo(m);
    m.fitBounds(L.latLngBounds(BASEMAP_BOUNDS).pad(-0.2));
    L.control.zoom({ position: 'bottomleft', zoomInTitle: 'تكبير', zoomOutTitle: 'تصغير' }).addTo(m);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(m);
    setMap(m);
    return () => void m.remove();
  }, []);

  const confirmAsk = (reason: string, policyRef: string) => {
    if (!ask) return;
    const a = { ...ask.action, reason, ...(ask.policyRef ? { policyRef } : {}) } as Action;
    setAsk(null);
    act(a);
  };
  const act = (a: Action) => {
    const v = check(world, actor, a);
    if (!v.ok) return setNotice(v.reason);
    setWorld((w) => perform(w, actor, a));
    setNotice(null);
    // the result is the new state at the top of the card
    requestAnimationFrame(() => document.querySelector('.md-dock .md-card')?.scrollTo({ top: 0 }));
    if (a.t === 'SUBMIT') setSel({ k: 'req', id: a.req });
  };
  const newRequest = (org: string) => {
    const id = 'r-new-' + world.events.length;
    const cur = mainSiteOf(world, org)!;
    setWorld((w) => {
      const c = structuredClone(w);
      const n = c.requests.length + 401;
      c.requests.push({
        id,
        number: 'MV-2026-0' + n,
        org,
        scope: { whole: true, units: [] },
        duration: { type: 'PERMANENT', start: w.now + 30 * DAY },
        fromSiteId: cur.id,
        candidates: {
          PRIMARY: { role: 'PRIMARY', name: 'الموقع الرئيسي المقترح', ring: cur.ring.map((p) => ({ ...p })), siteId: null, status: 'PROPOSED' },
          ALTERNATIVE: { role: 'ALTERNATIVE', name: 'الموقع البديل المقترح', ring: cur.ring.map((p) => ({ ...p })), siteId: null, status: 'PROPOSED' },
        },
        active: 'PRIMARY',
        state: 'DRAFT',
        requester: actor,
        stages: c.requests[0].stages.map((s) => ({ ...s, mark: undefined, by: undefined, candidate: undefined })),
        cursor: 0,
      });
      return c;
    });
    setStep(1);
    setSel({ k: 'edit', id });
  };

  // ---- map layers: only what the current context needs (progressive disclosure) ----
  const fitKey = JSON.stringify(sel) + ':' + (sel?.k === 'edit' && step >= 3 && step <= 4 ? 'editing' : step) + ':' + expandTemps + ':' + showAreas;
  const lastFit = useRef('');
  useEffect(() => {
    if (!map) return;
    const g = L.layerGroup().addTo(map);
    const bounds: L.LatLng[] = [];
    const keep = (r: Ring) => r.forEach((p) => bounds.push(L.latLng(p.lat, p.lng)));
    const poly = (r: Ring, color: string, o: L.PolylineOptions = {}, fit = true) => {
      if (fit) keep(r);
      return L.polygon(ll(r), { color, weight: 2.5, fillColor: color, fillOpacity: 0.16, ...o }).addTo(g);
    };
    const tag = (at: LatLng, html: string, cls: string, onClick?: () => void) => {
      const m = L.marker([at.lat, at.lng], { interactive: !!onClick, keyboard: !!onClick, icon: L.divIcon({ className: 'md-tag-icon', html: '<span class="md-tag ' + cls + '">' + html + '</span>', iconSize: [0, 0] }) }).addTo(g);
      if (onClick) m.on('click', onClick).on('keypress', (e: L.LeafletKeyboardEvent) => (e.originalEvent.key === 'Enter' || e.originalEvent.key === ' ') && onClick());
      return m;
    };
    const line = (a: LatLng, b: LatLng, color: string, chip?: string, dash = '7 6', at = 0.5, short?: string) => {
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color, weight: 2.4, dashArray: dash, interactive: false }).addTo(g);
      if (chip) {
        const m = tag({ lat: a.lat + (b.lat - a.lat) * at, lng: a.lng + (b.lng - a.lng) * at }, chip, 'chip');
        const el = m.getElement()?.querySelector('.md-tag') as HTMLElement | null;
        if (el) Object.assign(el.dataset, { full: chip, short: short ?? chip });
      }
    };
    /** A shape's name on the side away from its neighbours: above, below, or beside it when it lies between them. */
    const named = (r: Ring, others: LatLng[], html: string, cls: string) => {
      const c = centroid(r);
      if (others.every((o) => c.lat >= o.lat)) return tag(top(r), html, cls + ' up');
      if (others.every((o) => c.lat < o.lat)) return tag(bottom(r), html, cls + ' down');
      // between its neighbours: beside it, on the side of the screen with more room
      const x = map.latLngToContainerPoint([c.lat, c.lng]).x;
      return x > map.getSize().x / 2 - (narrow ? 0 : 230)
        ? tag(r.reduce((a, p) => (p.lng < a.lng ? p : a), r[0]), html, cls + ' side-w')
        : tag(r.reduce((a, p) => (p.lng > a.lng ? p : a), r[0]), html, cls + ' side');
    };
    const sym = (org: string, at: LatLng, label: string, cls: string, onClick?: () => void) =>
      tag(at, symbolHtml(symbols.get(org), 20) + '<b>' + label + '</b>', 'site ' + cls, onClick);
    const top = (r: Ring) => r.reduce((a, p) => (p.lat > a.lat ? p : a), r[0]);
    const bottom = (r: Ring) => r.reduce((a, p) => (p.lat < a.lat ? p : a), r[0]);

    const drawOrg = (id: string) => {
      const perm = permanentOf(world, id);
      const site = siteOf(world, perm?.siteId);
      if (!perm || !site) return;
      poly(site.ring, C.perm, { weight: 3 });
      sym(id, top(site.ring), 'التمركز الدائم · ' + site.name, 'perm');
      const t = temporaryOf(world, id);
      if (t) {
        const ts = siteOf(world, t.siteId)!;
        poly(ts.ring, C.temp, { dashArray: '10 6', weight: 3 });
        tag(top(ts.ring), (t.state === 'ACTIVE' ? 'التمركز الفعلي المؤقت حتى ' : 'مؤقت مُفعَّل يبدأ ') + day(t.state === 'ACTIVE' ? t.plannedEnd! : t.plannedStart!), 'temp');
        line(centroid(site.ring), centroid(ts.ring), C.temp, undefined, '3 7');
      }
      if (showAreas)
        for (const a of world.areas.filter((x) => x.stationingId === perm.id && x.status === 'ACTIVE')) {
          poly(a.ring, a.role === 'PRIMARY_AREA' ? C.areaP : C.areaA, { dashArray: a.role === 'PRIMARY_AREA' ? '2 6' : '1 5', weight: 2.5, fillOpacity: 0.1 });
          named(a.ring, [centroid(site.ring)], a.role === 'PRIMARY_AREA' ? 'المنطقة الرئيسية المرتبطة بالتمركز' : 'المنطقة البديلة المرتبطة بالتمركز', a.role === 'PRIMARY_AREA' ? 'area-p' : 'area-a');
        }
      // units that moved together with this organisation are part of its own temporary stationing, not a separate group
      const away = descendants(world, id).filter((u) => temporaryOf(world, u) && temporaryOf(world, u)!.requestId !== t?.requestId);
      if (away.length) {
        if (!expandTemps) {
          tag(bottom(site.ring), '⇢ وحدات تابعة في تمركز مؤقت (' + away.length + ')', 'group', () => setExpandTemps(true));
        } else {
          const bySite = new Map<string, string[]>();
          for (const u of away) bySite.set(temporaryOf(world, u)!.siteId, [...(bySite.get(temporaryOf(world, u)!.siteId) ?? []), u]);
          const centres = [...bySite.keys()].map((sid) => centroid(siteOf(world, sid)!.ring));
          for (const [sid, us] of bySite) {
            const ts = siteOf(world, sid)!;
            const others = [centroid(site.ring), ...centres.filter((c) => c !== centroid(ts.ring) && (c.lat !== centroid(ts.ring).lat || c.lng !== centroid(ts.ring).lng))];
            poly(ts.ring, C.temp, { dashArray: '10 6', weight: 3 });
            named(ts.ring, others, 'مؤقت: ' + us.map(orgName).join('، ') + ' · حتى ' + day(temporaryOf(world, us[0])!.plannedEnd!), 'temp');
            line(centroid(site.ring), centroid(ts.ring), C.temp, undefined, '3 7');
          }
        }
      }
    };

    const drawRequest = (id: string, editing?: 'PRIMARY' | 'ALTERNATIVE' | 'NONE') => {
      const r = world.requests.find((x) => x.id === id)!;
      const rows = comparison(world, r);
      const cur = rows[0];
      const p = rows.find((x) => x.key === 'PRIMARY')!;
      const a = rows.find((x) => x.key === 'ALTERNATIVE');
      // the alternative appears once it is being defined (step 4) or reviewed, not while the primary is placed
      const showAlt = !!a && editing !== 'PRIMARY' && (editing === 'ALTERNATIVE' || step >= 4 || r.state !== 'DRAFT');
      const [cc, pcc, acc] = [centroid(cur.ring), centroid(p.ring), a ? centroid(a.ring) : null];
      poly(cur.ring, C.perm, { weight: 3 });
      named(cur.ring, [pcc], symbolHtml(symbols.get(r.org), 20) + '<b>التمركز الحالي · ' + cur.name + '</b>', 'site perm');
      const pc = r.candidates.PRIMARY;
      const ac = r.candidates.ALTERNATIVE;
      const st = (s: string) => (s === 'NOT_ACCEPTED' ? ' · لم يُقبل' : s === 'APPROVED' ? ' · معتمد' : s === 'STANDBY' ? ' · احتياطي' : s === 'UNDER_REVIEW' ? ' · قيد المراجعة' : '');
      if (editing !== 'PRIMARY') {
        poly(p.ring, pc.status === 'NOT_ACCEPTED' ? C.off : C.candP, { weight: 3, dashArray: pc.status === 'NOT_ACCEPTED' ? '4 6' : undefined });
        named(p.ring, showAlt && acc ? [cc, acc] : [cc], 'الرئيسي المقترح' + st(pc.status), pc.status === 'NOT_ACCEPTED' ? 'off' : 'cand-p');
      }
      // on narrow screens a short distance on the map; the configured range is in the card's comparison
      const chip = (d: number, range: { min: number; max: number }, ok: boolean, from = '') =>
        formatKm(d) + from + (narrow ? '' : ' · المهيأ ' + rangeText(range)) + (ok ? ' ✓' : ' ✕');
      const short = (d: number, ok: boolean) => formatKm(d) + (ok ? ' ✓' : ' ✕');
      // while a candidate is being dragged the engine draws its own live connector and distance: no duplicate
      if (editing !== 'PRIMARY') line(cc, pcc, '#16324f', chip(p.dist!, p.range!, !!p.inRange), '7 6', narrow ? 0.35 : 0.42, short(p.dist!, !!p.inRange));
      if (showAlt && a && ac && acc) {
        if (editing !== 'ALTERNATIVE') {
          poly(a.ring, ac.status === 'NOT_ACCEPTED' ? C.off : C.candA, { weight: 3, dashArray: '9 6', fillOpacity: ac.status === 'STANDBY' ? 0.08 : 0.16 });
          named(a.ring, [pcc], 'البديل المقترح' + st(ac.status), 'cand-a');
        }
        if (editing !== 'ALTERNATIVE') line(pcc, acc, C.candA, chip(a.dist!, a.range!, !!a.inRange, ' من الرئيسي'), '4 6', narrow ? 0.72 : 0.58, short(a.dist!, !!a.inRange));
      }
      // a temporary stationing that ends at the permanent activation (D13)
      const ending = new Map<string, number>(); // one shape and name per temporary site, with its unit count
      for (const tid of r.state === 'APPROVED_NOT_ACTIVATED' ? (r.supersedes ?? []) : []) {
        const t = world.stationings.find((s) => s.id === tid);
        if (t && t.state !== 'ENDED') ending.set(t.siteId, (ending.get(t.siteId) ?? 0) + 1);
      }
      for (const [sid, n] of ending) {
        const ts = siteOf(world, sid)!;
        poly(ts.ring, C.temp, { dashArray: '10 6', weight: 3 });
        tag(bottom(ts.ring), 'مؤقت ساري (' + n + ' وحدة) — ينتهي ذرياً عند التفعيل', 'temp down');
      }
      if (showAreas) drawAreas(r.org);
    };
    const drawAreas = (org: string) => {
      const perm = permanentOf(world, org);
      for (const a of world.areas.filter((x) => x.stationingId === perm?.id && x.status === 'ACTIVE')) poly(a.ring, a.role === 'PRIMARY_AREA' ? C.areaP : C.areaA, { dashArray: '2 6', fillOpacity: 0.1 });
    };

    if (!sel) {
      for (const o of ORGS.filter((x) => x.parentId === 'o-root')) {
        const s = mainSiteOf(world, o.id);
        if (s) sym(o.id, centroid(s.ring), o.name, 'perm small', () => setSel({ k: 'org', id: o.id }));
        if (s) keep(s.ring);
      }
    } else if (sel.k === 'org') drawOrg(sel.id);
    else if (sel.k === 'req') drawRequest(sel.id);
    else if (sel.k === 'edit') drawRequest(sel.id, step === 3 ? 'PRIMARY' : step === 4 ? 'ALTERNATIVE' : 'NONE');
    else if (sel.k === 'res') {
      const res = world.reservations.find((x) => x.id === sel.id)!;
      const cl = clashes(world, res.org, res.ring, res.from, res.to, res.id);
      const blocked = blocking(cl).length > 0;
      for (const x of cl) {
        const area = world.areas.find((a) => a.id === x.id);
        const other = world.reservations.find((r) => r.id === x.id);
        if (area) {
          poly(area.ring, area.role === 'PRIMARY_AREA' ? C.areaP : C.areaA, { dashArray: '2 6', fillOpacity: 0.1 });
          named(area.ring, [centroid(res.ring)], (area.role === 'PRIMARY_AREA' ? 'المنطقة الرئيسية المرتبطة بتمركز ' : 'المنطقة البديلة المرتبطة بتمركز ') + orgName(area.org), 'area-p');
        }
        if (other) poly(other.ring, C.off, { dashArray: '4 4' });
      }
      const color = res.state === 'ACTIVE' ? C.candP : blocked ? '#c0392b' : C.candP;
      poly(res.ring, color, { weight: 3, fillOpacity: 0.3 });
      tag(top(res.ring), res.number + ' · ' + orgName(res.org) + (blocked && res.state !== 'ACTIVE' ? ' · منع' : res.state === 'ACTIVE' ? ' · نافذ' : ' · لا تعارض'), 'res ' + (blocked && res.state !== 'ACTIVE' ? 'bad' : 'good') + ' up');
    } else if (sel.k === 'site') {
      const s = siteOf(world, sel.id)!;
      poly(s.ring, C.perm, { weight: 3 });
      tag(top(s.ring), 'الموقع: ' + s.name, 'site perm');
      for (const b of world.stationings.filter((x) => x.kind === 'PERMANENT' && x.state === 'CURRENT' && x.siteId === sel.id)) {
        const t = temporaryOf(world, b.org);
        const ts = t && siteOf(world, t.siteId);
        if (ts) {
          poly(ts.ring, C.temp, { dashArray: '10 6', weight: 3 });
          tag(top(ts.ring), orgName(b.org) + ' هنا مؤقتاً حتى ' + day(t!.plannedEnd!), 'temp');
          line(centroid(s.ring), centroid(ts.ring), C.temp, undefined, '3 7');
        }
      }
    }

    if (lastFit.current !== fitKey && bounds.length && !(sel?.k === 'edit' && (step === 3 || step === 4))) {
      lastFit.current = fitKey;
      map.flyToBounds(L.latLngBounds(bounds), { ...fitPadding(narrow), maxZoom: 15, duration: 0.4 });
    }
    // a distance chip that collides with a name is shortened, then hidden (its full value stays in the card)
    const declutter = () => {
      const box = map.getContainer().getBoundingClientRect();
      const controls = [...map.getContainer().querySelectorAll<HTMLElement>('.leaflet-control-zoom, .leaflet-control-scale, .leaflet-control-attribution')].map((c) => c.getBoundingClientRect());
      const all = [...map.getContainer().querySelectorAll<HTMLElement>('.md-tag')];
      // a name never sits under the zoom or scale controls, nor past the map's edge: it shifts sideways just enough
      for (const t of all.filter((x) => !x.classList.contains('chip'))) {
        t.style.marginLeft = '';
        let r = t.getBoundingClientRect();
        const under = controls.find((c) => r.left < c.right && c.left < r.right && r.top < c.bottom && c.top < r.bottom);
        let shift = under ? under.right - r.left + 6 : 0;
        if (r.left + shift < box.left + 4) shift = box.left + 4 - r.left;
        if (r.right + shift > box.right - 4) shift = box.right - 4 - r.right;
        if (shift) {
          t.style.marginLeft = shift + 'px';
          r = t.getBoundingClientRect();
        }
      }
      const names = all.filter((t) => !t.classList.contains('chip')).map((t) => t.getBoundingClientRect());
      const placed: DOMRect[] = [];
      const hits = (r: DOMRect) => [...names, ...controls, ...placed].some((o) => r.left < o.right && o.left < r.right && r.top < o.bottom && o.top < r.bottom);
      for (const c of all.filter((t) => t.classList.contains('chip'))) {
        c.classList.remove('hidden');
        c.textContent = c.dataset.full ?? c.textContent;
        if (hits(c.getBoundingClientRect())) c.textContent = c.dataset.short ?? c.textContent;
        if (hits(c.getBoundingClientRect())) c.classList.add('hidden');
        else placed.push(c.getBoundingClientRect());
      }
    };
    map.on('moveend zoomend', declutter);
    const later = window.setTimeout(declutter, 650);
    return () => {
      window.clearTimeout(later);
      map.off('moveend zoomend', declutter);
      g.remove();
    };
  }, [map, world, sel, step, showAreas, expandTemps, symbols, fitKey, narrow]);

  const ctx: CardCtx = { world, actor, act, ask: setAsk, select: (s) => (setSel(s), setNotice(null)), symbols, showAreas, setShowAreas, expandTemps, setExpandTemps, newRequest };
  const me = person(world, actor)!;
  const sc = SCENARIOS.find((s) => '#s=' + s.n === location.hash);

  return (
    <>
      <div className="demo-ribbon proto-ribbon">
        <span>
          <i /> نموذج مجال التمركز V2 · بيانات وهمية · الحالات والصلاحيات والوقت محاكاة · لا اتصال بالخادم
        </span>
        <span className="proto-ribbon-note">ليس الصفحة المعتمدة؛ لم يُدمج في التطبيق</span>
      </div>
      <aside id="sidebar" className="sidebar proto-sidebar">
        <a className="brand" href="#">
          <span className="brand-logo">
            <Icon name="map" />
          </span>
          <span>
            <strong>
              TMRKZ<span>.</span>
            </strong>
            <small>المواقع · المرافق · الإجراءات</small>
          </span>
        </a>
        <span className="nav-section">مساحة العمل</span>
        <nav aria-label="القائمة الرئيسية">
          <a className="nav-item active" href="#">
            <Icon name="map" />
            <span>مساحة التمركز</span>
          </a>
        </nav>
      </aside>
      <div className="app-shell proto-shell">
        <header className="app-header">
          <div className="breadcrumb">
            <span>مساحة التمركز</span>
            <i>/</i>
            <b>نموذج المجال V2 (محاكاة)</b>
          </div>
          <div className="header-actions">
            <span className="identity-name" data-testid="identity">
              {me.name} · {me.title}
            </span>
          </div>
        </header>
        <main id="main" className="proto-main">
          <div className="md-sim" role="region" aria-label="أدوات المحاكاة">
            <div className="md-sim-row">
              <span className="md-sim-tag">محاكاة</span>
              <label>
                المشهد
                <select value={sc?.n ?? ''} onChange={(e) => (location.hash = 's=' + e.target.value)} data-testid="scenario">
                  <option value="">—</option>
                  {SCENARIOS.map((s) => (
                    <option key={s.n} value={s.n}>
                      {s.n}. {s.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                بصفة
                <select id="md-actor" value={actor} onChange={(e) => (setActor(e.target.value), setNotice(null))} data-testid="actor">
                  {world.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.title}
                    </option>
                  ))}
                </select>
              </label>
              <span className="md-time" data-testid="time">
                الوقت: {day(world.now)}
                {world.now !== NOW && ' (+' + Math.round((world.now - NOW) / DAY) + ' يوم)'}
              </span>
              <button className="ux-chip" onClick={() => act({ t: 'TICK', to: world.now + DAY })} title="تقديم الوقت المحاكى يوماً">
                +يوم
              </button>
              <button className="ux-chip" onClick={() => act({ t: 'TICK', to: world.now + 7 * DAY })} title="تقديم الوقت المحاكى أسبوعاً">
                +أسبوع
              </button>
              <button className={'ux-chip ' + (legend ? 'on' : '')} aria-expanded={legend} onClick={() => setLegend(!legend)}>
                مفتاح الخريطة
              </button>
            </div>
            {sc && (
              <p className="md-sim-hint" data-testid="scenario-note">
                <b>
                  {sc.n}. {sc.title}
                </b>{' '}
                — {sc.hint}
              </p>
            )}
          </div>
          <div ref={uxEl} className={'ux md' + (narrow ? ' phone' : '')}>
            <div ref={mapEl} className="ux-map" aria-label="خريطة التمركز" />
            {legend && (
              <div className="ux-pop md-legend ux-overlay" role="dialog" aria-label="مفتاح الخريطة">
                <ul>
                  <li><i className="md-swatch perm" /> التمركز الدائم · المقر الرئيسي الحالي</li>
                  <li><i className="md-swatch temp" /> التمركز الفعلي المؤقت (فوق الدائم)</li>
                  <li><i className="md-swatch area-p" /> المنطقة الرئيسية المرتبطة بالتمركز</li>
                  <li><i className="md-swatch area-a" /> المنطقة البديلة المرتبطة بالتمركز</li>
                  <li><i className="md-swatch cand-p" /> الموقع الرئيسي المقترح لإعادة التمركز</li>
                  <li><i className="md-swatch cand-a" /> الموقع البديل المقترح لإعادة التمركز</li>
                  <li><i className="md-swatch off" /> مرشح لم يُقبل</li>
                </ul>
                <p className="ux-note">المنطقتان المرتبطتان تُكشفان من بطاقة الجهة، ولا تظهر الطبقات كلها معاً.</p>
              </div>
            )}
            {notice && (
              <div className="md-notice ux-overlay" role="alert" data-testid="notice">
                {notice}
                <button className="ux-x" aria-label="إغلاق" onClick={() => setNotice(null)}>✕</button>
              </div>
            )}

            <div ref={dockEl} className={'md-dock ux-overlay' + (narrow ? ' sheet-' + sheet : '')} data-sheet={narrow ? sheet : 'desktop'}>
              {narrow && (
                <button
                  className="md-handle"
                  onClick={() => setSheet(sheet === 'collapsed' ? 'medium' : sheet === 'medium' ? 'expanded' : 'collapsed')}
                  aria-label={'ارتفاع اللوحة: ' + { collapsed: 'مطوية', medium: 'متوسطة', expanded: 'كاملة' }[sheet] + ' — اضغط للتغيير'}
                  data-testid="sheet-handle"
                >
                  <span />
                </button>
              )}
              {sel?.k === 'org' && <OrgCard c={ctx} id={sel.id} />}
              {sel?.k === 'req' && <RequestCard key={sel.id + actor} c={ctx} id={sel.id} />}
              {sel?.k === 'res' && <ReservationCard key={sel.id + actor} c={ctx} id={sel.id} />}
              {sel?.k === 'site' && <SiteCard c={ctx} id={sel.id} />}
              {sel?.k === 'edit' && (
                <RequestEditor
                  world={world}
                  setWorld={setWorld}
                  map={map}
                  id={sel.id}
                  actor={actor}
                  step={step}
                  setStep={setStep}
                  symbols={symbols}
                  act={act}
                  narrow={narrow}
                  sheet={sheet}
                  onClose={() => setSel({ k: 'org', id: world.requests.find((r) => r.id === sel.id)!.org })}
                />
              )}
              {!sel && (
                <section className="ux-card md-card md-intro">
                  <h2>التمركز الحالي للجهات</h2>
                  <p className="ux-hint">اختر جهة من الخريطة أو مشهداً من شريط المحاكاة. تظهر الطبقات حسب السياق فقط.</p>
                  <ul className="md-list">
                    {ORGS.filter((o) => o.parentId === 'o-root').map((o) => (
                      <li key={o.id}>
                        <button className="md-row" onClick={() => setSel({ k: 'org', id: o.id })}>
                          <b>{o.name}</b>
                          <small>{mainSiteOf(world, o.id)?.name}</small>
                          <small>{descendants(world, o.id).filter((u) => temporaryOf(world, u)).length ? 'وحدات في تمركز مؤقت' : ''}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>
        </main>
      </div>
      {ask && <ActionDialog ask={ask} world={world} actor={actor} onCancel={() => setAsk(null)} onConfirm={confirmAsk} />}
    </>
  );
}
