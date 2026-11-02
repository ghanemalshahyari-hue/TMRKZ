import L from '../../lib/leaflet';
import { centroid, edgeLengths, formatMeters, kinks, offsetsOf, pointInRing, rebuild, ringsIntersect, type Ring } from '../../lib/footprint';
import { bearing, destination, distanceM, type LatLng } from '../../lib/geo';

/** Live state of the proposal, reported every frame while moving (final=false) and once after each committed change. */
export type FootprintLive = {
  mode: 'move' | 'draw';
  ring: Ring | null;
  /** Every placed vertex, also while a new footprint is still being drawn. */
  verts: Ring;
  point: LatLng | null;
  anchor: LatLng | null;
  vertices: number;
  target: number;
  closed: boolean;
  dist: number;
  inRange: boolean;
  kinks: number;
  overlaps: string[];
  canUndo: boolean;
  canRedo: boolean;
};

type Snapshot = { verts: Ring; closed: boolean; point: LatLng | null };

export type EditorOptions = {
  origin: LatLng;
  /** The proposal's identity mark (the organisation's symbol, or a neutral pin when it has none). */
  symbolHtml: string;
  /** Allowed distance from the current premises (null: no rule configured). */
  range: () => { min: number; max: number | null } | null;
  /** Occupied registered sites in the proposal period (local, provisional; the server re-checks). */
  busy: () => { name: string; rings: Ring[] }[];
  /** True while map clicks and drags belong to something else (the distance tool, the details step). */
  paused: () => boolean;
  onLive: (live: FootprintLive, final: boolean) => void;
};

/**
 * The stationing footprint editor on the map (approved polygon prototype, 2 Nov 2026). All preview geometry lives in its
 * own layer group; the registered site, its boundary and its symbol are never touched. Two modes: «move» starts from a
 * copy of the current registered footprint, «draw» places a chosen number of vertices. In both the closed footprint is
 * dragged as ONE rigid object from its body or its symbol (shape and area kept, geodesically), vertices can be edited,
 * and every change can be undone, redone or reset. Moves are coalesced to one update per animation frame; nothing in
 * React re-renders while the pointer moves — the panel is told once the change is committed.
 */
export class FootprintEditor {
  private readonly map: L.Map;
  private readonly o: EditorOptions;
  private readonly group: L.LayerGroup;
  private readonly svg = L.svg({ padding: 0.5 });
  private readonly poly: L.Polygon;
  private readonly line: L.Polyline;
  private readonly connector: L.Polyline;
  private readonly chip: L.Marker;
  private readonly symbol: L.Marker;
  private vertexMarkers: L.Marker[] = [];
  private edgeLabels: L.Marker[] = [];
  private mode: 'move' | 'draw' = 'move';
  private verts: Ring = [];
  private closed = false;
  private point: LatLng | null = null;
  private target = 4;
  private start: Snapshot = { verts: [], closed: false, point: null };
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private editVertices = false;
  private readonly onMapClick = (e: L.LeafletMouseEvent) => {
    if (this.mode === 'draw' && !this.closed && !this.o.paused()) this.addVertex({ lat: e.latlng.lat, lng: e.latlng.lng });
  };
  /**
   * The whole-footprint drag starts on a pointer press on the proposal's body or symbol — mouse, touch or pen. It is taken
   * in the capture phase so the map's own drag (which would pan the map under a finger) never sees it.
   */
  private readonly onPointerDown = (e: PointerEvent) => {
    const t = e.target as Element | null;
    if (!t || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (t.closest('.stw-prop-path') || t.closest('.stw-prop-sym')) this.startBodyDrag(e);
  };

  constructor(map: L.Map, options: EditorOptions) {
    this.map = map;
    this.o = options;
    this.group = L.layerGroup().addTo(map);
    this.poly = L.polygon([], {
      renderer: this.svg,
      color: '#1f9d55',
      weight: 2.5,
      fillColor: '#2bb36a',
      fillOpacity: 0.32,
      bubblingMouseEvents: false,
      className: 'stw-prop-path',
    }).addTo(this.group);
    this.line = L.polyline([], { renderer: this.svg, color: '#1f9d55', weight: 2.2, dashArray: '5 5', interactive: false }).addTo(this.group);
    this.connector = L.polyline([], { renderer: this.svg, color: '#16324f', weight: 2, dashArray: '6 6', interactive: false }).addTo(this.group);
    this.chip = L.marker([0, 0], { interactive: false, zIndexOffset: 900, icon: L.divIcon({ className: 'stw-dist', html: '<span></span>', iconSize: [0, 0] }) });
    this.symbol = L.marker([0, 0], {
      interactive: true,
      keyboard: false,
      zIndexOffset: 1300,
      title: 'الموقع المقترح — اسحب الرمز أو المساحة لنقل الحدود كاملة',
      icon: L.divIcon({ className: 'stw-prop-symbol', html: '<div class="stw-prop-sym">' + options.symbolHtml + '<span class="lbl">مقترح</span></div>', iconSize: [0, 0] }),
    });
    map.getContainer().addEventListener('pointerdown', this.onPointerDown, true);
    map.on('click', this.onMapClick);
  }

  destroy() {
    this.map.getContainer().removeEventListener('pointerdown', this.onPointerDown, true);
    this.map.off('click', this.onMapClick);
    this.map.getContainer().classList.remove('stw-drawing');
    this.group.remove();
  }

  /** The organisation's symbol, swapped in once it is known (rare: not during a drag). */
  setSymbol(html: string) {
    this.symbol.setIcon(L.divIcon({ className: 'stw-prop-symbol', html: '<div class="stw-prop-sym">' + html + '<span class="lbl">مقترح</span></div>', iconSize: [0, 0] }));
    this.render(true);
  }

  // ---- modes ----

  /** A copy of the registered footprint (or of the point, for a site without a registered boundary) to move. */
  startMove(ring: Ring | null, at: LatLng) {
    this.mode = 'move';
    this.verts = ring ? ring.map((p) => ({ ...p })) : [];
    this.closed = !!ring;
    this.point = ring ? null : { ...at };
    this.editVertices = false;
    this.begin();
  }

  /** A new footprint: place {@code target} vertices on the map or by coordinates; an existing ring reopens a saved draft. */
  startDraw(target: number, ring?: Ring | null) {
    this.mode = 'draw';
    this.target = Math.max(3, target);
    this.verts = ring ? ring.map((p) => ({ ...p })) : [];
    this.closed = !!ring && ring.length >= 3;
    if (ring) this.target = Math.max(3, ring.length);
    this.point = null;
    this.editVertices = true;
    this.begin();
  }

  private begin() {
    this.start = this.snapshot();
    this.undoStack = [];
    this.redoStack = [];
    this.map.getContainer().classList.toggle('stw-drawing', this.mode === 'draw' && !this.closed);
    this.render(true);
    // a scale where a move of a few kilometres fits on the map; the symbol is the handle at any zoom
    const at = this.point ?? (this.verts.length ? centroid(this.verts) : this.o.origin);
    this.map.flyTo([at.lat, at.lng], 14, { duration: 0.4 });
  }

  setTarget(n: number) {
    this.target = Math.max(3, Math.min(20, Math.round(n)));
    if (this.mode === 'draw' && !this.closed && this.verts.length >= this.target) {
      this.push();
      this.verts = this.verts.slice(0, this.target);
      this.closed = true;
    }
    this.render(true);
  }

  setEditVertices(on: boolean) {
    this.editVertices = on;
    this.render(true);
  }

  addVertex(p: LatLng) {
    if (this.mode !== 'draw' || this.closed) return;
    this.push();
    this.verts.push(p);
    if (this.verts.length >= this.target) this.closed = true;
    this.render(true);
    if (this.closed) this.focus();
  }

  setVertex(i: number, p: LatLng) {
    if (!this.verts[i]) return;
    this.push();
    this.verts[i] = p;
    this.render(true);
  }

  /** Moves the closed footprint (or the point) rigidly so that its anchor lands on {@code to}. */
  moveTo(to: LatLng) {
    if (!this.closed && !this.point) return;
    this.push();
    if (this.point) this.point = { ...to };
    else this.verts = rebuild(offsetsOf(this.verts, centroid(this.verts)), to);
    this.render(true);
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  /** Back to where the mode started (the registered footprint's copy, or an empty drawing); undoable. */
  reset() {
    this.push();
    this.restore(this.start, false);
  }

  focus() {
    const pts = this.point ? [this.point] : this.verts;
    if (pts.length) this.map.flyToBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as L.LatLngTuple)).pad(0.6), { maxZoom: 17, duration: 0.4 });
  }

  /** Both locations in view: the registered footprint (or its anchor) and the proposal. */
  compare(original: Ring | null) {
    const pts = [...(original ?? [this.o.origin]), ...(this.point ? [this.point] : this.verts)];
    this.map.flyToBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as L.LatLngTuple)).pad(0.25), { maxZoom: 17, duration: 0.4 });
  }

  /** Recompute colours and readouts after the range or the occupied sites changed (e.g. a server answer). */
  refresh() {
    this.render(true);
  }

  // ---- history ----

  private snapshot(): Snapshot {
    return { verts: this.verts.map((p) => ({ ...p })), closed: this.closed, point: this.point ? { ...this.point } : null };
  }

  private push() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  private restore(s: Snapshot, clear = true) {
    this.verts = s.verts.map((p) => ({ ...p }));
    this.closed = s.closed;
    this.point = s.point ? { ...s.point } : null;
    if (!clear) this.redoStack = [];
    this.map.getContainer().classList.toggle('stw-drawing', this.mode === 'draw' && !this.closed);
    this.render(true);
  }

  // ---- whole-footprint drag: rigid, from the body or the symbol; the map does not pan meanwhile ----

  private startBodyDrag(ev: PointerEvent) {
    if ((!this.closed && !this.point) || this.o.paused()) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.map.dragging.disable();
    this.push();
    const base = this.point ?? centroid(this.verts);
    const offs = this.point ? null : offsetsOf(this.verts, base);
    const grab = this.map.mouseEventToLatLng(ev);
    let pending: L.LatLng | null = null;
    let frame = 0;
    document.body.classList.add('stw-dragging');
    const move = (e: PointerEvent | MouseEvent) => {
      pending = this.map.mouseEventToLatLng(e as MouseEvent);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pending) return;
        const d = distanceM(grab, pending);
        const anchor = d < 0.01 ? base : destination(base, bearing(grab, pending), d);
        if (offs) this.verts = rebuild(offs, anchor);
        else this.point = anchor;
        this.render(false);
      });
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (frame) cancelAnimationFrame(frame);
      document.body.classList.remove('stw-dragging');
      this.map.dragging.enable();
      this.render(true);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  // ---- rendering: the preview layer is mutated in place, never rebuilt ----

  private live(): FootprintLive {
    const ring = this.closed && this.verts.length >= 3 ? this.verts : null;
    const anchor = this.point ?? (ring ? centroid(ring) : null);
    const dist = anchor ? distanceM(this.o.origin, anchor) : 0;
    const r = this.o.range();
    const inRange = !anchor || !r || (dist >= r.min && (r.max == null || dist <= r.max));
    const overlaps = ring
      ? this.o.busy().filter((b) => b.rings.some((x) => ringsIntersect(ring, x))).map((b) => b.name)
      : this.point
        ? this.o.busy().filter((b) => b.rings.some((x) => pointInRing(this.point!, x))).map((b) => b.name)
        : [];
    return {
      mode: this.mode,
      ring: ring ? ring.map((p) => ({ ...p })) : null,
      verts: this.verts.map((p) => ({ ...p })),
      point: this.point ? { ...this.point } : null,
      anchor,
      vertices: this.verts.length,
      target: this.target,
      closed: this.closed,
      dist,
      inRange,
      kinks: ring ? kinks(ring) : 0,
      overlaps,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  private render(final: boolean) {
    const l = this.live();
    const valid = !!l.anchor && l.inRange && l.kinks === 0 && l.overlaps.length === 0;
    const open = this.mode === 'draw' && !this.closed;
    this.line.setLatLngs(open ? this.verts.map((p) => [p.lat, p.lng] as L.LatLngTuple) : []);
    this.poly.setLatLngs(l.ring ? l.ring.map((p) => [p.lat, p.lng] as L.LatLngTuple) : []);
    this.poly.setStyle({ color: valid ? '#1f9d55' : '#c0392b', fillColor: valid ? '#2bb36a' : '#e74c3c', dashArray: valid ? undefined : '7 5' });
    this.syncVertices();
    this.syncEdges(l.ring ?? (open ? this.verts : null), !!l.ring);
    if (l.anchor) {
      if (!this.group.hasLayer(this.symbol)) this.group.addLayer(this.symbol);
      this.symbol.setLatLng([l.anchor.lat, l.anchor.lng]);
      this.symbol.getElement()?.querySelector('.stw-prop-sym')?.classList.toggle('bad', !valid);
      this.connector.setLatLngs([[this.o.origin.lat, this.o.origin.lng], [l.anchor.lat, l.anchor.lng]]);
      if (!this.group.hasLayer(this.chip)) this.group.addLayer(this.chip);
      this.chip.setLatLng([(this.o.origin.lat + l.anchor.lat) / 2, (this.o.origin.lng + l.anchor.lng) / 2]);
      const span = this.chip.getElement()?.querySelector('span');
      const t = formatMeters(l.dist) + (l.overlaps.length ? ' · تداخل محجوز' : !l.inRange ? ' · خارج النطاق' : l.kinks ? ' · شكل غير صالح' : '');
      if (span && span.textContent !== t) span.textContent = t;
      this.chip.getElement()?.classList.toggle('bad', !valid);
    } else {
      this.group.removeLayer(this.symbol);
      this.group.removeLayer(this.chip);
      this.connector.setLatLngs([]);
    }
    this.o.onLive(l, final);
  }

  /** Numbered, draggable vertex handles (always while drawing; on request while moving). */
  private syncVertices() {
    const show = this.mode === 'draw' || this.editVertices;
    const n = show ? this.verts.length : 0;
    while (this.vertexMarkers.length > n) this.group.removeLayer(this.vertexMarkers.pop()!);
    for (let i = 0; i < n; i++) {
      const v = this.verts[i];
      let m = this.vertexMarkers[i];
      if (!m) {
        m = L.marker([v.lat, v.lng], {
          draggable: true,
          zIndexOffset: 1400,
          title: 'الرأس ' + (i + 1),
          icon: L.divIcon({ className: 'stw-vtx-wrap', html: '<span class="stw-vtx">' + (i + 1) + '</span>', iconSize: [0, 0] }),
        }).addTo(this.group);
        let frame = 0;
        const idx = i;
        m.on('dragstart', () => this.push());
        m.on('drag', () => {
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            const p = this.vertexMarkers[idx]?.getLatLng();
            if (p) this.verts[idx] = { lat: p.lat, lng: p.lng };
            this.render(false);
          });
        });
        m.on('dragend', () => {
          if (frame) cancelAnimationFrame(frame);
          const p = this.vertexMarkers[idx]?.getLatLng();
          if (p) this.verts[idx] = { lat: p.lat, lng: p.lng };
          this.render(true);
        });
        this.vertexMarkers[i] = m;
      } else {
        const cur = m.getLatLng();
        if (cur.lat !== v.lat || cur.lng !== v.lng) m.setLatLng([v.lat, v.lng]);
      }
    }
  }

  /** Edge lengths at each edge's midpoint (while drawing or editing vertices). */
  private syncEdges(ring: Ring | null, closedRing: boolean) {
    const show = !!ring && (this.mode === 'draw' || this.editVertices);
    const lengths = show ? edgeLengths(ring!) : [];
    const n = show ? (closedRing ? ring!.length : Math.max(0, ring!.length - 1)) : 0;
    while (this.edgeLabels.length > n) this.group.removeLayer(this.edgeLabels.pop()!);
    for (let i = 0; i < n; i++) {
      const a = ring![i];
      const b = ring![(i + 1) % ring!.length];
      const mid: L.LatLngTuple = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
      let m = this.edgeLabels[i];
      if (!m) {
        m = L.marker(mid, { interactive: false, zIndexOffset: 700, icon: L.divIcon({ className: 'stw-edge-wrap', html: '<span class="stw-edge"></span>', iconSize: [0, 0] }) }).addTo(this.group);
        this.edgeLabels[i] = m;
      } else m.setLatLng(mid);
      const s = m.getElement()?.querySelector('.stw-edge');
      const t = formatMeters(lengths[i]);
      if (s && s.textContent !== t) s.textContent = t;
    }
  }
}
