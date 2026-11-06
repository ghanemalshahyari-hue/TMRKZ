import { Marker, type Map as MlMap } from 'maplibre-gl';
import type { LatLng } from '../../lib/geo';
import type { ConnectorKind } from '../../lib/terrainAnalysis';

/**
 * The 3D view's information on the ground (owner brief «TRUE OFFLINE 3D TERRAIN», §8, §9, §27): one compact card per
 * request geometry (current site, re-stationing site, primary and alternative deployment areas), expanded when it is
 * the selected one, and one chip on each connector with its distance. They are MapLibre markers: each stands at the
 * terrain's height under its point and fades when a ridge hides that point, so a rotated view still shows which card
 * belongs to which shape. Positions and texts change in place (a drag never rebuilds them, nor the page).
 */
export type CardRole = 'CURRENT' | 'SITE' | 'PRIMARY' | 'ALTERNATIVE';
export type CardSpec = { role: CardRole; at: LatLng; title: string; sub?: string; compact: string; lines: [string, string][]; selected: boolean };
export type ChipSpec = { kind: ConnectorKind; at: LatLng; from: LatLng; to: LatLng; text: string; tone: 'ok' | 'warn' | 'bad' | 'none' | 'pending'; title: string };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const MARK = { ok: '✓', warn: '!', bad: '✕', none: '', pending: '…' } as const;
/** The card's stem, in pixels, from the ground point up to the card (terrain3d.css draws it the same length). */
const STEM = 58;

export class TerrainCards {
  private readonly cards = new Map<CardRole, { marker: Marker; el: HTMLElement; html: string; on: boolean }>();
  private readonly chips = new Map<ConnectorKind, { marker: Marker; el: HTMLElement; html: string; on: boolean; from?: LatLng; to?: LatLng }>();
  private visible = false;
  private readonly onMoveEnd = () => this.declutter();

  constructor(
    private readonly map: MlMap,
    private readonly onCard: (role: CardRole) => void,
    private readonly onChip: (kind: ConnectorKind) => void,
  ) {
    map.on('moveend', this.onMoveEnd);
  }

  /**
   * A chip never sits under a card or another chip: when its connector's middle is taken it slides along the connector
   * (40 %, 60 %, 30 %, 70 % …) to the first free place, after every camera move. Cards keep their places on their ground points.
   */
  declutter() {
    if (!this.visible) return;
    const pad = 4;
    const taken = [...this.cards.values()].filter((c) => c.on).map((c) => (c.el.firstElementChild as HTMLElement | null)?.getBoundingClientRect()).filter((r): r is DOMRect => !!r);
    const hits = (r: DOMRect) => taken.some((t) => r.left < t.right + pad && r.right > t.left - pad && r.top < t.bottom + pad && r.bottom > t.top - pad);
    for (const it of this.chips.values()) {
      if (!it.on || !it.from || !it.to) continue;
      const { from, to } = it;
      let placed: DOMRect | null = null;
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78, 0.15, 0.85]) {
        it.marker.setLngLat([from.lng + (to.lng - from.lng) * t, from.lat + (to.lat - from.lat) * t]);
        const r = (it.el.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
        if (r && !hits(r)) {
          placed = r;
          break;
        }
      }
      if (!placed) it.marker.setLngLat([(from.lng + to.lng) / 2, (from.lat + to.lat) / 2]);
      const r = placed ?? (it.el.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
      if (r) taken.push(r);
    }
  }

  private element(className: string, click: () => void): HTMLElement {
    const el = document.createElement('div');
    el.className = className;
    // a press on a card or chip selects it and never reaches the map (no pan, no placing click)
    for (const t of ['mousedown', 'pointerdown', 'touchstart', 'dblclick'] as const) el.addEventListener(t, (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      click();
    });
    return el;
  }

  setVisible(on: boolean) {
    this.visible = on;
    for (const m of [...this.cards.values(), ...this.chips.values()]) this.place(m, m.on);
    this.declutter();
  }

  private place(it: { marker: Marker; on: boolean }, on: boolean) {
    it.on = on;
    if (on && this.visible) it.marker.addTo(this.map);
    else it.marker.remove();
  }

  setCards(specs: CardSpec[]) {
    const seen = new Set<CardRole>();
    for (const s of specs) {
      seen.add(s.role);
      let it = this.cards.get(s.role);
      if (!it) {
        const el = this.element('tz3-card-wrap', () => this.onCard(s.role));
        // lifted on a stem so the edited shape's own handle («مقترح» and its symbol) stays free to grab
        const marker = new Marker({ element: el, anchor: 'bottom', offset: [0, -STEM], opacityWhenCovered: '0.35' }).setLngLat([s.at.lng, s.at.lat]);
        it = { marker, el, html: '', on: false };
        this.cards.set(s.role, it);
      }
      const html =
        `<div class="tz3-card r-${s.role}${s.selected ? ' sel' : ''}" data-role="${s.role}"><b>${esc(s.title)}</b>` +
        (s.sub ? `<small>${esc(s.sub)}</small>` : '') +
        (s.selected ? `<dl>${s.lines.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : `<span class="c">${esc(s.compact)}</span>`) +
        '</div>';
      if (html !== it.html) {
        it.el.innerHTML = html;
        it.html = html;
      }
      it.marker.setLngLat([s.at.lng, s.at.lat]);
      it.el.dataset.lng = String(s.at.lng);
      it.el.dataset.lat = String(s.at.lat);
      it.el.style.zIndex = s.selected ? '3' : '2';
      this.place(it, true);
    }
    for (const [role, it] of this.cards) if (!seen.has(role)) this.place(it, false);
  }

  setChips(specs: ChipSpec[]) {
    const seen = new Set<ConnectorKind>();
    for (const s of specs) {
      seen.add(s.kind);
      let it = this.chips.get(s.kind);
      if (!it) {
        const el = this.element('tz3-chip-wrap', () => this.onChip(s.kind));
        const marker = new Marker({ element: el, anchor: 'center', opacityWhenCovered: '0.45' }).setLngLat([s.at.lng, s.at.lat]);
        it = { marker, el, html: '', on: false };
        this.chips.set(s.kind, it);
      }
      const html = `<button class="tz3-chip k-${s.kind} t-${s.tone}" data-leg="${s.kind}" title="${esc(s.title)}"><span>${esc(s.text)}</span>${MARK[s.tone] ? `<i>${MARK[s.tone]}</i>` : ''}</button>`;
      if (html !== it.html) {
        it.el.innerHTML = html;
        it.html = html;
      }
      it.marker.setLngLat([s.at.lng, s.at.lat]);
      it.from = s.from;
      it.to = s.to;
      this.place(it, true);
    }
    for (const [kind, it] of this.chips) if (!seen.has(kind)) this.place(it, false);
    this.declutter();
  }

  /** One frame of a drag: the edited shape's card and the connectors touching it follow the pointer. */
  moveCard(role: CardRole, at: LatLng) {
    const it = this.cards.get(role);
    if (!it) return;
    it.marker.setLngLat([at.lng, at.lat]);
    it.el.dataset.lng = String(at.lng);
    it.el.dataset.lat = String(at.lat);
  }

  moveChip(kind: ConnectorKind, at: LatLng, text: string) {
    const it = this.chips.get(kind);
    if (!it) return;
    it.marker.setLngLat([at.lng, at.lat]);
    it.html = ''; // changed in place: the next setChips writes it again
    const b = it.el.querySelector('button');
    const span = b?.querySelector('span');
    if (span && span.textContent !== text) span.textContent = text;
    // the verdict waits for the drop and the server's analysis of the new ground
    if (b && !b.classList.contains('t-none')) b.className = b.className.replace(/t-(ok|warn|bad|pending)/, 't-pending');
    const i = b?.querySelector('i');
    if (i && b && !b.classList.contains('t-none')) i.textContent = MARK.pending;
  }

  destroy() {
    this.map.off('moveend', this.onMoveEnd);
    for (const it of [...this.cards.values(), ...this.chips.values()]) it.marker.remove();
    this.cards.clear();
    this.chips.clear();
  }
}
