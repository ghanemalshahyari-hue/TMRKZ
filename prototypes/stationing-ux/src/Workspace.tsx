import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import L from '../../../frontend/src/lib/leaflet';
import { areaM2, centroid, formatArea } from '../../../frontend/src/lib/footprint';
import basemapUrl from '../../../map-packages/regional-basemap-2026.10/basemap.svg?url';
import { svgBasemap } from './svgBasemap';
import {
  BASEMAP_BOUNDS,
  ORGS,
  SITES,
  STATUS_GLYPH,
  STATUS_LABEL,
  childrenOf,
  descendantsOf,
  orgById,
  orgsAt,
  pathOf,
  siteById,
  sitesOf,
  type Site,
} from './data';
import { Editor, loadDraft, type Draft } from './Editor';
import { clusterPoints, estimateWidth, placeLabels, type Box, type LabelCandidate } from './layout';
import { SheetContext, type SheetHeight } from './sheet';
import { SymbolMark, symbolHtml, useOrgSymbols, type Symbols } from './symbols';

type Selection = { kind: 'org'; orgId: string; includeSub: boolean } | { kind: 'site'; siteId: string; orgId: string | null } | { kind: 'stack'; siteIds: string[] } | null;
type Prefs = { labels: 'auto' | 'all' | 'selection'; boundaries: 'auto' | 'all'; symbols: 'selection' | 'zoom'; background: boolean };
type Editing = { siteId: string; orgId: string; draft: Draft | null };

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const anchorOf = (s: Site) => (s.ring ? centroid(s.ring) : { lat: s.lat, lng: s.lng });
/** Leaflet 1.9 does not turn Enter on a focused marker into a click: Enter and Space activate it here. */
const activate = (e: L.LeafletKeyboardEvent, run: () => void) => {
  if (e.originalEvent.key !== 'Enter' && e.originalEvent.key !== ' ') return;
  e.originalEvent.preventDefault();
  run();
};
/** Zoom from which boundaries and organisation symbols appear by default (names: from LABEL_ZOOM, never overlapping). */
const DETAIL_ZOOM = 15;
const LABEL_ZOOM = 13;

function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mm = window.matchMedia(q);
    const on = () => setM(mm.matches);
    mm.addEventListener('change', on);
    return () => mm.removeEventListener('change', on);
  }, [q]);
  return m;
}

/**
 * Prototype of a map-first «مساحة التمركز». The map fills the page; everything else is contextual: one search, a
 * collapsible organisation hierarchy over the map, a card for the selected site or organisation, map tools that open on
 * request, and the relocation editor only while a proposal is being made. Sites are clustered when they are close on
 * screen; names, boundaries and organisation symbols appear for the selection and when zoomed in, and labels never
 * overlap. On tablets and phones the cards and the editor are a bottom sheet.
 */
export function Workspace() {
  const narrow = useMedia('(max-width: 1100px)');
  const phone = useMedia('(max-width: 760px)');
  const wide = useMedia('(min-width: 1600px)');
  const symbols = useOrgSymbols();
  const mapEl = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  const [view, setView] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [panel, setPanel] = useState<'layers' | 'legend' | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({ labels: 'auto', boundaries: 'auto', symbols: 'selection', background: true });
  const [hover, setHover] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const layers = useRef<{ sites: L.LayerGroup; shapes: L.LayerGroup; bg: L.GridLayer } | null>(null);

  /** Height the bottom sheet covers on tablets and phones (the map keeps selections above it). */
  const sheetPx = useCallback(() => (narrow ? Math.min(window.innerHeight * 0.46, 460) : 0), [narrow]);
  const say = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((t) => (t === m ? null : t)), 4200);
  }, []);

  // the hierarchy opens by itself only on large screens, over the map
  useEffect(() => setTreeOpen(wide), [wide]);

  // ---- the map ----
  useEffect(() => {
    if (!mapEl.current) return;
    const m = L.map(mapEl.current, { zoomControl: false, minZoom: 10, maxZoom: 18, attributionControl: true, zoomSnap: 0.5 });
    m.attributionControl.setPrefix('Leaflet');
    // tiled, drawn once per tile: a single SVG overlay was re-rasterised on every zoom step (map lag)
    const bg = svgBasemap(basemapUrl, BASEMAP_BOUNDS, 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap').addTo(m);
    L.control.scale({ position: 'bottomright', imperial: false, maxWidth: 120 }).addTo(m);
    const shapes = L.layerGroup().addTo(m);
    const sites = L.layerGroup().addTo(m);
    layers.current = { sites, shapes, bg };
    m.fitBounds(L.latLngBounds(SITES.map((s) => [s.lat, s.lng] as L.LatLngTuple)).pad(0.08));
    const tick = () => setView((v) => v + 1);
    m.on('moveend zoomend resize', tick);
    setMap(m);
    return () => {
      m.off('moveend zoomend resize', tick);
      m.remove();
      layers.current = null;
    };
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => map?.invalidateSize(), 220);
    return () => window.clearTimeout(t);
  }, [map, narrow, phone, treeOpen, !!editing, selection?.kind]);

  useEffect(() => {
    const l = layers.current;
    if (!map || !l) return;
    if (prefs.background && !map.hasLayer(l.bg)) l.bg.addTo(map);
    if (!prefs.background && map.hasLayer(l.bg)) l.bg.remove();
  }, [map, prefs.background]);

  // a saved draft opened from its address (#draft/<id>): the editor reopens with its footprint
  useEffect(() => {
    const open = () => {
      const m = /^#draft\/([\w-]+)$/.exec(location.hash);
      const d = m ? loadDraft(m[1]) : null;
      if (!d) return;
      setSelection({ kind: 'site', siteId: d.siteId, orgId: d.orgId });
      setEditing({ siteId: d.siteId, orgId: d.orgId, draft: d });
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);

  // ---- what is highlighted: the selected organisation's sites (with its units), or the selected site ----
  const highlight = useMemo(() => {
    if (!selection) return new Set<string>();
    if (selection.kind === 'site') return new Set([selection.siteId]);
    if (selection.kind === 'stack') return new Set(selection.siteIds);
    const ids = [selection.orgId, ...(selection.includeSub ? descendantsOf(selection.orgId) : [])];
    return new Set(sitesOf(ids).map((s) => s.id));
  }, [selection]);

  const selectSite = useCallback(
    (id: string, orgId?: string | null, fly = true) => {
      const s = siteById.get(id);
      if (!s || editing) return;
      setSelection((cur) => {
        const keep = orgId ?? (cur?.kind === 'org' && orgsAt(s).includes(cur.orgId) ? cur.orgId : null);
        return { kind: 'site', siteId: id, orgId: keep ?? s.responsible };
      });
      if (fly && map) {
        const b = s.ring ? L.latLngBounds(s.ring.map((p) => [p.lat, p.lng] as L.LatLngTuple)) : L.latLngBounds([[s.lat, s.lng]]);
        if (!map.getBounds().pad(-0.15).contains(b) || map.getZoom() < 14) map.flyToBounds(b.pad(1.5), { maxZoom: 16, duration: 0.45, paddingBottomRight: [0, sheetPx()] });
      }
    },
    [map, editing, sheetPx],
  );

  const selectOrg = useCallback(
    (id: string) => {
      if (editing) return;
      setSelection({ kind: 'org', orgId: id, includeSub: true });
      const list = sitesOf([id, ...descendantsOf(id)]);
      if (map && list.length) map.flyToBounds(L.latLngBounds(list.map((s) => [s.lat, s.lng] as L.LatLngTuple)).pad(0.35), { maxZoom: 15, duration: 0.45, paddingBottomRight: [0, sheetPx()] });
      if (narrow) setTreeOpen(false);
    },
    [map, editing, narrow, sheetPx],
  );

  // ---- drawing the sites: clusters, single markers, boundaries, collision-aware names, symbols on selection ----
  useEffect(() => {
    const l = layers.current;
    if (!map || !l) return;
    // a redraw replaces the markers: the one with the keyboard focus gets it back afterwards
    const focused = (document.activeElement as HTMLElement | null)?.closest('.ux-pin-icon')?.querySelector('[data-site]')?.getAttribute('data-site') ?? null;
    l.sites.clearLayers();
    l.shapes.clearLayers();
    if (editing) return; // the editor draws the registered site, the proposal and the occupied sites itself
    const zoom = map.getZoom();
    const size = map.getSize();
    const selected = selection?.kind === 'site' ? selection.siteId : null;
    const dimOthers = !!selection;
    const singles: Site[] = [];
    const loose: { id: string; x: number; y: number }[] = [];
    const looseHl: { id: string; x: number; y: number }[] = [];
    for (const s of SITES) {
      const p = map.latLngToContainerPoint(anchorOf(s));
      if (p.x < -80 || p.y < -80 || p.x > size.x + 80 || p.y > size.y + 80) continue;
      if (s.id === selected || zoom >= 17 || (selection?.kind === 'stack' && highlight.has(s.id))) singles.push(s);
      else (highlight.has(s.id) ? looseHl : loose).push({ id: s.id, x: p.x, y: p.y });
    }
    // the selection's sites group only among themselves, tighter, so they stay apart from the rest and rarely merge
    const clusters = [
      ...clusterPoints(loose, zoom >= DETAIL_ZOOM ? 30 : 48).map((c) => ({ ...c, hl: false })),
      ...clusterPoints(looseHl, 30).map((c) => ({ ...c, hl: true })),
    ];
    const groups = clusters.filter((c) => c.ids.length > 1);
    clusters.filter((c) => c.ids.length === 1).forEach((c) => singles.push(siteById.get(c.ids[0])!));

    // obstacles for names: markers, cluster bubbles and the panels floating over the map
    const mapBox = map.getContainer().getBoundingClientRect();
    const obstacles: Box[] = [];
    singles.forEach((s) => {
      const p = map.latLngToContainerPoint(anchorOf(s));
      obstacles.push({ x: p.x - 13, y: p.y - 13, w: 26, h: 26 });
    });
    groups.forEach((g) => obstacles.push({ x: g.x - 20, y: g.y - 20, w: 40, h: 40 }));
    // the selected site's organisation symbols sit above its marker: no other name goes there
    const sel = selected ? siteById.get(selected) : null;
    if (sel && singles.includes(sel)) {
      const p = map.latLngToContainerPoint(anchorOf(sel));
      obstacles.push({ x: p.x - 70, y: p.y - 62, w: 140, h: 40 });
    }
    document.querySelectorAll<HTMLElement>('.ux-overlay').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) obstacles.push({ x: r.left - mapBox.left, y: r.top - mapBox.top, w: r.width, h: r.height });
    });
    const showAllNames = prefs.labels === 'all' || (prefs.labels === 'auto' && zoom >= LABEL_ZOOM);
    const cands: LabelCandidate[] = singles
      .filter((s) => s.id === selected || s.id === hover || (prefs.labels !== 'selection' && highlight.has(s.id)) || showAllNames)
      .map((s) => {
        const p = map.latLngToContainerPoint(anchorOf(s));
        return { id: s.id, x: p.x, y: p.y, w: estimateWidth(s.name), h: 22, priority: s.id === selected ? 9 : s.id === hover ? 8 : highlight.has(s.id) ? 5 : 1 };
      });
    const placed = placeLabels(cands, obstacles, { x: 4, y: 4, w: size.x - 8, h: size.y - 8 });

    // boundaries: the selection's at any zoom, every site's when zoomed in (or on request)
    for (const s of singles) {
      if (!s.ring) continue;
      const hl = highlight.has(s.id);
      if (!hl && !(prefs.boundaries === 'all' || zoom >= DETAIL_ZOOM)) continue;
      L.polygon(
        s.ring.map((p) => [p.lat, p.lng] as L.LatLngTuple),
        {
          className: 'ux-boundary' + (s.id === selected ? ' sel' : hl ? ' hl' : dimOthers ? ' dim' : ''),
          weight: s.id === selected ? 3 : 2,
          interactive: true,
          bubblingMouseEvents: false,
        },
      )
        .on('click', () => selectSite(s.id, null, false))
        .addTo(l.shapes);
    }

    const showSymbols = (s: Site) => s.id === selected || (prefs.symbols === 'zoom' && zoom >= DETAIL_ZOOM) || (s.id === hover && !phone);
    for (const s of singles) {
      const at = anchorOf(s);
      const where = placed.get(s.id);
      const hl = highlight.has(s.id);
      const orgs = orgsAt(s);
      const html =
        '<div class="ux-pin st-' + s.status + (s.id === selected ? ' sel' : hl ? ' hl' : dimOthers ? ' dim' : '') + (s.ring ? '' : ' point') + '" data-site="' + s.id + '">' +
        '<span class="ux-dot"><i>' + STATUS_GLYPH[s.status] + '</i></span>' +
        (where ? '<span class="ux-lbl ' + where + '">' + esc(s.name) + '</span>' : '') +
        (showSymbols(s) ? '<span class="ux-syms">' + orgs.map((o) => symbolHtml(symbols.get(o), 18)).join('') + '</span>' : '') +
        '</div>';
      const marker = L.marker([at.lat, at.lng], {
        icon: L.divIcon({ className: 'ux-pin-icon', html, iconSize: [0, 0] }),
        keyboard: true,
        title: s.name + ' — ' + STATUS_LABEL[s.status] + (orgs.length > 1 ? ' — ' + orgs.length + ' جهات' : ''),
        riseOnHover: true,
        autoPanOnFocus: false,
        zIndexOffset: s.id === selected ? 1000 : hl ? 500 : 0,
      })
        .on('click', () => selectSite(s.id, null, false))
        .on('keypress', (e: L.LeafletKeyboardEvent) => activate(e, () => selectSite(s.id, null, false)))
        .on('mouseover', () => !phone && setHover(s.id))
        .on('mouseout', () => setHover((h) => (h === s.id ? null : h)))
        .addTo(l.sites);
      marker.getElement()?.setAttribute('aria-label', s.name + '، ' + STATUS_LABEL[s.status] + '، ' + orgs.map((o) => orgById.get(o)?.name).join('، '));
      if (s.id === focused) marker.getElement()?.focus({ preventScroll: true });
    }

    for (const g of groups) {
      const ll = map.containerPointToLatLng([g.x, g.y]);
      const members = g.ids.map((id) => siteById.get(id)!);
      const busy = members.filter((m) => m.status === 'BUSY').length;
      const html =
        '<div class="ux-cluster' + (g.hl ? ' hl' : dimOthers ? ' dim' : '') + '" style="--busy:' + Math.round((busy / members.length) * 100) + '%"><b>' + g.ids.length + '</b></div>';
      const open = () => {
        const b = L.latLngBounds(members.map((m) => [m.lat, m.lng] as L.LatLngTuple));
        // sites practically at one point: ask which one instead of zooming further
        if (map.getZoom() >= 16 || b.getNorthEast().distanceTo(b.getSouthWest()) < 40) setSelection({ kind: 'stack', siteIds: g.ids });
        else map.flyToBounds(b.pad(0.6), { maxZoom: 17, duration: 0.45 });
      };
      L.marker(ll, {
        icon: L.divIcon({ className: 'ux-pin-icon', html, iconSize: [0, 0] }),
        keyboard: true,
        autoPanOnFocus: false,
        zIndexOffset: g.hl ? 500 : 0,
        title: g.ids.length + (g.hl ? ' مواقع من الاختيار' : ' مواقع متقاربة') + ' — للتكبير عليها',
      })
        .on('click', open)
        .on('keypress', (e: L.LeafletKeyboardEvent) => activate(e, open))
        .addTo(l.sites)
        .getElement()
        ?.setAttribute('aria-label', g.ids.length + (g.hl ? ' مواقع من الاختيار متقاربة: ' : ' مواقع متقاربة: ') + members.map((m) => m.name).join('، '));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, view, selection, highlight, hover, prefs, symbols, editing, phone]);

  // the card takes the focus when it opens; Escape closes cards and popovers (not the editor, which has its own cancel)
  useEffect(() => {
    if (selection && !editing) cardRef.current?.focus({ preventScroll: true });
  }, [selection?.kind, selection && 'siteId' in selection ? selection.siteId : selection && 'orgId' in selection ? selection.orgId : null, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (panel) return setPanel(null);
      if (q) return setQ('');
      if (editing) return;
      if (selection) {
        const id = selection.kind === 'site' ? selection.siteId : null;
        setSelection(null);
        if (id) window.setTimeout(() => document.querySelector<HTMLElement>(`.ux-pin-icon:has([data-site="${id}"])`)?.focus({ preventScroll: true }), 0);
      } else if (treeOpen && narrow) setTreeOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panel, q, editing, selection, treeOpen, narrow]);

  const hits = useMemo(() => {
    const t = q.trim();
    if (t.length < 2) return null;
    return { orgs: ORGS.filter((o) => o.name.includes(t)).slice(0, 6), sites: SITES.filter((s) => s.name.includes(t) || s.code.toLowerCase() === t.toLowerCase()).slice(0, 6) };
  }, [q]);

  const fitAll = () => map?.flyToBounds(L.latLngBounds(SITES.map((s) => [s.lat, s.lng] as L.LatLngTuple)).pad(0.08), { duration: 0.45 });

  // ---- the contextual card (or bottom sheet) ----
  let card: ReactNode = null;
  if (editing) {
    card = (
      <Editor
        key={(editing.draft?.id ?? 'new') + editing.siteId + editing.orgId}
        map={map}
        site={siteById.get(editing.siteId)!}
        orgId={editing.orgId}
        symbols={symbols}
        draft={editing.draft}
        narrow={narrow}
        onClose={(msg) => {
          setEditing(null);
          if (/^#draft\//.test(location.hash)) history.replaceState(null, '', location.pathname);
          if (msg) say(msg);
        }}
        onSaved={(d) => {
          history.replaceState(null, '', '#draft/' + d.id);
          setEditing((cur) => (cur ? { ...cur, draft: d } : cur));
          say('حُفظت المسودة في هذا المتصفح (نموذج أولي، لا خادم). رابطها: #draft/' + d.id);
        }}
      />
    );
  } else if (selection?.kind === 'site') {
    const s = siteById.get(selection.siteId)!;
    const parent = s.parentId ? siteById.get(s.parentId) : null;
    const orgs = orgsAt(s);
    card = (
      <section className="ux-card" ref={cardRef} tabIndex={-1} aria-label={'الموقع ' + s.name}>
        <header className="ux-card-head">
          <span className={'ux-state st-' + s.status}>
            {STATUS_GLYPH[s.status]} {STATUS_LABEL[s.status]}
          </span>
          <button className="ux-x" onClick={() => setSelection(null)} aria-label="إغلاق بطاقة الموقع">
            ✕
          </button>
        </header>
        <h2>{s.name}</h2>
        <p className="ux-sub">
          {parent ? 'موقع فرعي في «' + parent.name + '»' : 'موقع رئيسي'} · <span className="ux-mono">{s.code}</span> ·{' '}
          {s.ring ? 'حدود مسجلة، ' + formatArea(areaM2(s.ring)) : 'دون حدود مسجلة (علامة فقط)'}
        </p>
        <fieldset className="ux-orgs">
          <legend>{orgs.length > 1 ? 'الجهات في هذا الموقع (' + orgs.length + ')' : 'الجهة في هذا الموقع'}</legend>
          {orgs.map((id) => {
            const o = orgById.get(id)!;
            return (
              <label key={id} className={'ux-org-row ' + (selection.orgId === id ? 'on' : '')}>
                <input type="radio" name="ux-org" checked={selection.orgId === id} onChange={() => setSelection({ ...selection, orgId: id })} />
                <SymbolMark url={symbols.get(id)} name={o.name} />
                <span>
                  <b>{o.name}</b>
                  <small>{id === s.responsible ? 'مسؤولة عن الموقع' : 'تستخدم الموقع'}</small>
                </span>
              </label>
            );
          })}
        </fieldset>
        <div className="ux-actions">
          <button className="ux-btn primary" onClick={() => selection.orgId && setEditing({ siteId: s.id, orgId: selection.orgId, draft: null })}>
            ⇄ طلب تمركز / إعادة تمركز
          </button>
          <button className="ux-btn" onClick={() => selection.orgId && selectOrg(selection.orgId)}>
            عرض مواقع الجهة
          </button>
        </div>
        <p className="ux-note">تمركز «{orgById.get(selection.orgId ?? s.responsible)?.name}». لا يتغير الموقع المعتمد قبل الاعتماد.</p>
      </section>
    );
  } else if (selection?.kind === 'org') {
    const o = orgById.get(selection.orgId)!;
    const direct = sitesOf([o.id]);
    const sub = sitesOf(descendantsOf(o.id)).filter((s) => !direct.includes(s));
    const list = [...direct, ...(selection.includeSub ? sub : [])];
    card = (
      <section className="ux-card" ref={cardRef} tabIndex={-1} aria-label={'الجهة ' + o.name}>
        <header className="ux-card-head">
          <span className="ux-crumbs">{pathOf(o.id).map((p) => p.name).join(' ‹ ') || 'المستوى الأعلى'}</span>
          <button className="ux-x" onClick={() => setSelection(null)} aria-label="إلغاء تحديد الجهة">
            ✕
          </button>
        </header>
        <h2 className="ux-with-sym">
          <SymbolMark url={symbols.get(o.id)} name={o.name} size={26} /> {o.name}
        </h2>
        <p className="ux-sub">
          {direct.length ? direct.length + ' مواقع مرتبطة بها مباشرة' : 'ليست لها مواقع مباشرة'}
          {sub.length ? ' · ' + sub.length + ' في وحداتها التابعة' : ''}
        </p>
        {sub.length > 0 && (
          <label className="ux-check">
            <input type="checkbox" checked={selection.includeSub} onChange={(e) => setSelection({ ...selection, includeSub: e.target.checked })} /> إظهار مواقع الوحدات التابعة
          </label>
        )}
        <ul className="ux-site-list">
          {list.map((s) => (
            <li key={s.id}>
              <button onClick={() => selectSite(s.id, orgsAt(s).includes(o.id) ? o.id : null)}>
                <span className={'ux-mini st-' + s.status}>{STATUS_GLYPH[s.status]}</span>
                <span>
                  <b>{s.name}</b>
                  <small>{direct.includes(s) ? (s.responsible === o.id ? 'مسؤولة عنه' : 'تستخدمه') : orgsAt(s).map((x) => orgById.get(x)?.name).filter((n, i, a) => a.indexOf(n) === i).slice(0, 2).join('، ')}</small>
                </span>
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="ux-note">لا مواقع ظاهرة لهذه الجهة ولا لوحداتها.</li>}
        </ul>
      </section>
    );
  } else if (selection?.kind === 'stack') {
    card = (
      <section className="ux-card" ref={cardRef} tabIndex={-1} aria-label="عدة مواقع في موضع واحد">
        <header className="ux-card-head">
          <b>عدة مواقع في هذا الموضع</b>
          <button className="ux-x" onClick={() => setSelection(null)} aria-label="إغلاق">
            ✕
          </button>
        </header>
        <ul className="ux-site-list">
          {selection.siteIds.map((id) => {
            const s = siteById.get(id)!;
            return (
              <li key={id}>
                <button onClick={() => selectSite(id, null, true)}>
                  <span className={'ux-mini st-' + s.status}>{STATUS_GLYPH[s.status]}</span>
                  <span>
                    <b>{s.name}</b>
                    <small>{s.parentId ? 'موقع فرعي' : 'موقع رئيسي'}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  const selectedOrgId = selection?.kind === 'org' ? selection.orgId : selection?.kind === 'site' ? selection.orgId : null;
  return (
    <div className={'ux' + (narrow ? ' narrow' : '') + (phone ? ' phone' : '') + (editing ? ' editing' : '')}>
      <div ref={mapEl} className="ux-map" role="application" aria-label="خريطة التمركز" />

      <div className="ux-top ux-overlay">
        <div className="ux-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث عن جهة أو موقع…" aria-label="البحث عن جهة أو موقع" disabled={!!editing} />
          {hits && (
            <div className="ux-hits" role="listbox" aria-label="نتائج البحث">
              {hits.orgs.length + hits.sites.length === 0 && <p className="ux-note">لا نتائج.</p>}
              {hits.orgs.map((o) => (
                <button key={o.id} role="option" aria-selected={false} onClick={() => (selectOrg(o.id), setQ(''))}>
                  <SymbolMark url={symbols.get(o.id)} name={o.name} size={18} />
                  <span>
                    <b>{o.name}</b>
                    <small>جهة · {pathOf(o.id).map((p) => p.name).join(' ‹ ') || 'المستوى الأعلى'}</small>
                  </span>
                </button>
              ))}
              {hits.sites.map((s) => (
                <button key={s.id} role="option" aria-selected={false} onClick={() => (selectSite(s.id), setQ(''))}>
                  <span className={'ux-mini st-' + s.status}>{STATUS_GLYPH[s.status]}</span>
                  <span>
                    <b>{s.name}</b>
                    <small>موقع · {s.code}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className={'ux-chip ' + (treeOpen ? 'on' : '')} onClick={() => setTreeOpen((v) => !v)} aria-expanded={treeOpen} disabled={!!editing}>
          ☷ الجهات
        </button>
        {selection && !editing && (
          <span className="ux-context" role="status">
            {selection.kind === 'org' ? 'الجهة: ' + orgById.get(selection.orgId)?.name : selection.kind === 'site' ? 'الموقع: ' + siteById.get(selection.siteId)?.name : 'عدة مواقع'}
            <button onClick={() => setSelection(null)} aria-label="إلغاء التحديد">
              ✕
            </button>
          </span>
        )}
      </div>

      {treeOpen && !editing && (
        <aside className="ux-tree ux-overlay" aria-label="الهيكل التنظيمي">
          <header>
            <b>الجهات</b>
            <button className="ux-x" onClick={() => setTreeOpen(false)} aria-label="طي الجهات">
              ✕
            </button>
          </header>
          <Tree selectedId={selectedOrgId} symbols={symbols} onSelect={selectOrg} />
        </aside>
      )}

      <div className="ux-controls ux-overlay" role="group" aria-label="أدوات الخريطة">
        <button onClick={() => map?.zoomIn()} aria-label="تكبير">
          ＋
        </button>
        <button onClick={() => map?.zoomOut()} aria-label="تصغير">
          −
        </button>
        <button onClick={fitAll} aria-label="عرض كل المواقع" title="عرض كل المواقع">
          ⤢
        </button>
        <button className={panel === 'layers' ? 'on' : ''} onClick={() => setPanel(panel === 'layers' ? null : 'layers')} aria-expanded={panel === 'layers'} aria-label="الطبقات والخلفية" title="الطبقات والخلفية">
          ☰
        </button>
        <button className={panel === 'legend' ? 'on' : ''} onClick={() => setPanel(panel === 'legend' ? null : 'legend')} aria-expanded={panel === 'legend'} aria-label="مفتاح الخريطة" title="مفتاح الخريطة">
          ⓘ
        </button>
      </div>

      {panel === 'layers' && (
        <div className="ux-pop ux-overlay" role="dialog" aria-label="الطبقات والخلفية">
          <h3>الخلفية</h3>
          <label className="ux-check">
            <input type="checkbox" checked={prefs.background} onChange={(e) => setPrefs({ ...prefs, background: e.target.checked })} /> خلفية إقليمية توضيحية (محلية)
          </label>
          <h3>أسماء المواقع</h3>
          {(
            [
              ['auto', 'تلقائي: عند التكبير وللاختيار'],
              ['all', 'دائماً (دون تداخل)'],
              ['selection', 'للموقع المختار فقط'],
            ] as const
          ).map(([v, l]) => (
            <label key={v} className="ux-check">
              <input type="radio" name="labels" checked={prefs.labels === v} onChange={() => setPrefs({ ...prefs, labels: v })} /> {l}
            </label>
          ))}
          <h3>الحدود ورموز الجهات</h3>
          <label className="ux-check">
            <input type="checkbox" checked={prefs.boundaries === 'all'} onChange={(e) => setPrefs({ ...prefs, boundaries: e.target.checked ? 'all' : 'auto' })} /> حدود كل المواقع (الافتراضي: عند التكبير وللاختيار)
          </label>
          <label className="ux-check">
            <input type="checkbox" checked={prefs.symbols === 'zoom'} onChange={(e) => setPrefs({ ...prefs, symbols: e.target.checked ? 'zoom' : 'selection' })} /> رموز الجهات عند التكبير (الافتراضي: للموقع المختار)
          </label>
        </div>
      )}
      {panel === 'legend' && (
        <div className="ux-pop ux-overlay" role="dialog" aria-label="مفتاح الخريطة">
          <h3>مفتاح الخريطة</h3>
          <ul className="ux-legend">
            <li>
              <span className="ux-mini st-FREE">✓</span> متاح للفترة
            </li>
            <li>
              <span className="ux-mini st-PARTIAL">◐</span> إشغال جزئي
            </li>
            <li>
              <span className="ux-mini st-BUSY">✕</span> غير متاح
            </li>
            <li>
              <span className="ux-mini point">✓</span> موقع دون حدود مسجلة (إطار متقطع)
            </li>
            <li>
              <span className="ux-cl-swatch">5</span> مجموعة مواقع متقاربة؛ انقر للتكبير
            </li>
            <li>
              <span className="ux-sym generic" style={{ height: 13, width: 18 }} /> جهة لم يُحدد لها رمز
            </li>
          </ul>
          <p className="ux-note">الألوان الباهتة: مواقع خارج الاختيار الحالي. الأسماء والحدود ورموز الجهات تظهر عند التكبير وللمواقع المختارة.</p>
        </div>
      )}

      {card && <div className={'ux-dock ux-overlay' + (narrow ? ' sheet' : '')}>{narrow ? <Sheet key={editing ? 'editor' : 'card'} initial={editing ? 'peek' : 'half'}>{card}</Sheet> : card}</div>}
      {/* the local background covers a fixed area: say so when the view goes past it (each move re-renders through `view`) */}
      {map && prefs.background && !L.latLngBounds(BASEMAP_BOUNDS).contains(map.getBounds()) && (
        <p className="ux-edge-note">الخلفية المحلية لا تغطي المنطقة الرمادية</p>
      )}
      {toast && (
        <div className="ux-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

/** The organisation hierarchy, one level at a time; names wrap instead of being cut, the symbol has its own column. */
function Tree({ selectedId, symbols, onSelect }: { selectedId: string | null; symbols: Symbols; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(['o-root']));
  useEffect(() => {
    if (!selectedId) return;
    setOpen((o) => new Set([...o, ...pathOf(selectedId).map((p) => p.id)]));
  }, [selectedId]);
  const row = (id: string, depth: number): ReactNode => {
    const o = orgById.get(id)!;
    const kids = childrenOf(id);
    const isOpen = open.has(id);
    const direct = sitesOf([id]).length;
    return (
      <li key={id} role="treeitem" aria-expanded={kids.length ? isOpen : undefined} aria-selected={selectedId === id}>
        <div className={'ux-tree-row ' + (selectedId === id ? 'on' : '')} style={{ paddingInlineStart: 4 + depth * 14 }}>
          {kids.length ? (
            <button
              className="ux-toggle"
              onClick={() => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))}
              aria-label={(isOpen ? 'طي ' : 'فتح ') + o.name}
            >
              {isOpen ? '▾' : '◂'}
            </button>
          ) : (
            <span className="ux-toggle" aria-hidden="true" />
          )}
          <button className="ux-tree-label" onClick={() => onSelect(id)}>
            <SymbolMark url={symbols.get(id)} name={o.name} size={18} />
            <span>{o.name}</span>
            {direct > 0 && <small title={direct + ' مواقع مرتبطة مباشرة'}>{direct}</small>}
          </button>
        </div>
        {isOpen && kids.length > 0 && <ul role="group">{kids.map((k) => row(k.id, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <ul className="ux-tree-list" role="tree" aria-label="الجهات">
      {childrenOf(null).map((r) => row(r.id, 0))}
    </ul>
  );
}

/** A bottom sheet on tablets and phones: three heights, changed by the handle (tap or drag) or the keyboard. */
function Sheet({ children, initial }: { children: ReactNode; initial: 'peek' | 'half' }) {
  const [h, setH] = useState<SheetHeight>(initial);
  const drag = useRef<{ y: number; start: number } | null>(null);
  const dragged = useRef(false);
  const el = useRef<HTMLDivElement>(null);
  const order = ['peek', 'half', 'full'] as const;
  // the map's scale and attribution sit just above the sheet, whatever its height
  useEffect(() => {
    const sheet = el.current;
    const host = sheet?.closest<HTMLElement>('.ux');
    if (!sheet || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty('--sheet', Math.round(sheet.getBoundingClientRect().height) + 'px'));
    ro.observe(sheet);
    return () => {
      ro.disconnect();
      host.style.removeProperty('--sheet');
    };
  }, []);
  const next = () => {
    if (dragged.current) return void (dragged.current = false);
    setH(order[(order.indexOf(h) + 1) % 3]);
  };
  return (
    <div ref={el} className={'ux-sheet ' + h}>
      <button
        className="ux-handle"
        aria-label={'تغيير ارتفاع اللوحة (الحالي: ' + (h === 'peek' ? 'مصغرة' : h === 'half' ? 'نصف الشاشة' : 'كاملة') + ')'}
        onClick={next}
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, start: el.current?.getBoundingClientRect().height ?? 0 };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          const dy = d.y - e.clientY;
          if (Math.abs(dy) < 12) return;
          e.preventDefault();
          dragged.current = true;
          setH(dy > 0 ? (h === 'peek' ? 'half' : 'full') : h === 'full' ? 'half' : 'peek');
        }}
      >
        <i />
      </button>
      {/* the keyboard reaching content hidden by the lowered sheet raises it (its head and main action stay visible) */}
      <div
        className="ux-sheet-body"
        onFocus={(e) => {
          const t = e.target as HTMLElement;
          if (h === 'peek' && t.matches(':focus-visible') && !t.closest('.ux-card-head, .ux-actions.sticky')) setH('half');
        }}
      >
        <SheetContext.Provider value={setH}>{children}</SheetContext.Provider>
      </div>
    </div>
  );
}
