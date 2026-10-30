import { useEffect, useRef, useState } from 'react';
import L from '../../lib/leaflet';
import { api } from '../../api/client';
import type { MapFeature, Ref } from '../../api/types';
import { renderSymbol } from '../../lib/unitSymbols';
import { featureAnchor, type SiteHit } from './MapCanvas';

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

type Rendered = { url: string; title: string };
/** Rendered symbol images cached for the session, keyed by SIDC + standard, so panning never re-renders the same mark. */
const urlCache = new Map<string, Rendered | null>();

/**
 * Informational layer (ADR-021, refined 2026-10-30 after the owner's review): the identity symbol of the organisation
 * responsible for a site — and of every organisation using it in the period — shown as a small strip of clickable
 * symbols beside the site's marker, never instead of the facility marker or its geometry. Each symbol is one
 * organisation's mark; every visible, assigned organisation is shown (none is silently dropped). The symbol keeps its
 * standard colours and is independent of availability and request state. Only organisations the actor may see and that
 * have an approved assignment appear; a location is never invented and selecting a symbol never writes anything.
 * Clicking (or Enter/Space on) one symbol selects both that organisation — applying it as the map's organisation
 * filter — and the site, opening the site's existing actions. So the symbol is a working tool, not only a picture.
 */
export function OrgSymbolLayer({
  map,
  features,
  enabled,
  hiddenSiteId,
  onSelect,
  onSelectOrg,
}: {
  map: L.Map | null;
  features: MapFeature[];
  enabled: boolean;
  hiddenSiteId?: string | null;
  onSelect: (siteId: string, hit: SiteHit) => void;
  /** Apply one organisation as the map's filter (the owner's review: a symbol click selects its organisation too). */
  onSelectOrg: (org: Ref) => void;
}) {
  const layerRef = useRef<L.LayerGroup | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onSelectOrgRef = useRef(onSelectOrg);
  onSelectOrgRef.current = onSelectOrg;
  // orgId -> rendered symbol (or null when the actor may not see it / it has no assignment)
  const [symbols, setSymbols] = useState<Map<string, Rendered | null>>(new Map());

  // the organisations referenced by the visible sites (responsible + occupants), only where the actor sees the name
  const orgRefs = new Map<string, Ref>();
  if (enabled) {
    for (const f of features) {
      if (f.responsibleOrg) orgRefs.set(f.responsibleOrg.id, f.responsibleOrg);
      for (const o of f.occupants ?? []) orgRefs.set(o.id, o);
    }
  }
  const idKey = [...orgRefs.keys()].sort().join(',');

  // fetch assignments for the referenced organisations and render each symbol's SVG once (cached by SIDC + standard)
  useEffect(() => {
    if (!enabled || orgRefs.size === 0) {
      setSymbols(new Map());
      return;
    }
    let live = true;
    const ids = [...orgRefs.keys()];
    api
      .unitSymbols(ids)
      .then(async (lookup) => {
        const out = new Map<string, Rendered | null>();
        await Promise.all(
          ids.map(async (id) => {
            const s = lookup.symbols[id];
            if (!s) {
              out.set(id, null);
              return;
            }
            const key = s.standard + ':' + s.sidc;
            if (!urlCache.has(key)) {
              try {
                const r = await renderSymbol(s.sidc, s.standard, 28);
                urlCache.set(key, r.valid ? { url: r.url, title: s.description } : null);
              } catch {
                urlCache.set(key, null);
              }
            }
            const cached = urlCache.get(key) ?? null;
            out.set(id, cached ? { url: cached.url, title: s.description } : null);
          }),
        );
        if (live) setSymbols(out);
      })
      .catch(() => live && setSymbols(new Map()));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, idKey]);

  // dedicated pane under the site markers so a site marker click always wins where they overlap
  useEffect(() => {
    if (!map) return;
    if (!map.getPane('orgSymbols')) {
      map.createPane('orgSymbols');
      const pane = map.getPane('orgSymbols');
      if (pane) pane.style.zIndex = '405';
    }
    const group = L.layerGroup().addTo(map);
    layerRef.current = group;
    return () => {
      group.remove();
      layerRef.current = null;
    };
  }, [map]);

  // draw one clickable strip of symbols per visible site that has at least one visible, assigned organisation
  useEffect(() => {
    const group = layerRef.current;
    if (!group) return;
    group.clearLayers();
    if (!enabled) return;
    for (const f of features) {
      if (f.siteId === hiddenSiteId) continue;
      const anchor = featureAnchor(f);
      if (!anchor) continue;
      const refs: Ref[] = [];
      if (f.responsibleOrg) refs.push(f.responsibleOrg);
      for (const o of f.occupants ?? []) if (!refs.some((r) => r.id === o.id)) refs.push(o);
      // every visible organisation with an approved symbol is shown — nothing is silently dropped
      const imgs = refs.map((r) => ({ r, sym: symbols.get(r.id) })).filter((x): x is { r: Ref; sym: Rendered } => !!x.sym);
      if (imgs.length === 0) continue;
      const html =
        '<span class="org-symbol-wrap" role="group" aria-label="رموز جهات ' + escapeHtml(f.name) + '">' +
        imgs
          .map(
            ({ r, sym }, i) =>
              '<button type="button" class="map-org-symbol-btn" data-i="' + i + '" ' +
              'title="' + escapeHtml(r.name + ' — ' + sym.title) + '" ' +
              'aria-label="' + escapeHtml('اختيار جهة ' + r.name + ' والموقع ' + f.name) + '">' +
              '<img class="map-org-symbol" src="' + sym.url + '" alt="' + escapeHtml(r.name) + '" />' +
              '</button>',
          )
          .join('') +
        '</span>';
      const marker = L.marker(anchor, {
        pane: 'orgSymbols',
        interactive: true,
        keyboard: false,
        icon: L.divIcon({ className: 'map-org-symbols', html, iconSize: [0, 0], iconAnchor: [0, 0] }),
      }).addTo(group);
      // one symbol click selects that organisation (filter) and the site; keyboard activation of the real <button>
      // produces the same click with detail 0. Marker clicks do not bubble to the map's background-click handler.
      const fire = (ref: Ref, keyboard: boolean) => {
        onSelectOrgRef.current(ref);
        onSelectRef.current(f.siteId, { latlng: anchor, keyboard, element: marker.getElement() ?? null });
      };
      marker.on('click', (e: L.LeafletMouseEvent) => {
        const target = (e.originalEvent as MouseEvent | undefined)?.target as HTMLElement | null;
        const btn = target?.closest('.map-org-symbol-btn') as HTMLElement | null;
        const ref = imgs[btn ? Number(btn.dataset.i) : 0]?.r ?? imgs[0].r;
        fire(ref, (e.originalEvent as MouseEvent | undefined)?.detail === 0);
      });
    }
  }, [features, symbols, enabled, hiddenSiteId]);

  return null;
}
