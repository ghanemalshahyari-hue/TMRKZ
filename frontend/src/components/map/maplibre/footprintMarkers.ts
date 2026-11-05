import { Marker, type Map as MlMap } from 'maplibre-gl';
import type { LatLng } from '../../../lib/geo';

/**
 * DOM overlays of the footprint editor on the MapLibre map, built exactly like the retired Leaflet editor's zero-size
 * divIcons (owner, 5 Nov 2026: the accepted Stationing map interaction is the target): a zero-size box anchored at the
 * point, its child placed by the same CSS classes (`stw-vtx`, `stw-edge`, `stw-prop-sym`, `stw-dist`, `stw-orig-sym`).
 */
export function overlay(html: string, className: string): { marker: Marker; el: HTMLElement } {
  const el = document.createElement('div');
  el.className = 'stw-ml ' + className;
  el.innerHTML = html;
  const marker = new Marker({ element: el, anchor: 'center' }).setLngLat([0, 0]);
  return { marker, el };
}

/** A pool of overlays of one kind (vertices, edge lengths): created on demand, moved in place, removed when not needed. */
export class OverlayPool {
  private readonly items: { marker: Marker; el: HTMLElement; on: boolean }[] = [];

  constructor(
    private readonly map: MlMap,
    private readonly make: (i: number) => { html: string; className: string; setup?: (el: HTMLElement, i: number) => void },
  ) {}

  /** {@code n} overlays, the i-th at {@code at(i)}; {@code update} changes its content or state without rebuilding it. */
  sync(n: number, at: (i: number) => LatLng, update?: (el: HTMLElement, i: number) => void) {
    for (let i = 0; i < n; i++) {
      let it = this.items[i];
      if (!it) {
        const spec = this.make(i);
        const o = overlay(spec.html, spec.className);
        spec.setup?.(o.el, i);
        it = { ...o, on: false };
        this.items[i] = it;
      }
      const p = at(i);
      it.marker.setLngLat([p.lng, p.lat]);
      if (!it.on) {
        it.marker.addTo(this.map);
        it.on = true;
      }
      update?.(it.el, i);
    }
    for (let i = n; i < this.items.length; i++) {
      if (this.items[i].on) {
        this.items[i].marker.remove();
        this.items[i].on = false;
      }
    }
  }

  clear() {
    this.sync(0, () => ({ lat: 0, lng: 0 }));
  }

  destroy() {
    for (const it of this.items) it.marker.remove();
    this.items.length = 0;
  }
}

/** Keeps a press on an overlay from reaching the map (no pan, no map click), as the Leaflet editor's capture handler did. */
export function ownPointer(el: HTMLElement, onDown: (e: PointerEvent) => void) {
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onDown(e);
  });
  for (const t of ['mousedown', 'touchstart', 'dblclick'] as const) el.addEventListener(t, (e) => e.stopPropagation());
}
