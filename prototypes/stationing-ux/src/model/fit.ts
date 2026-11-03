import type L from '../../../../frontend/src/lib/leaflet';

/**
 * Map padding that keeps every drawn shape and its name clear of the card: the card's measured size plus room for a
 * name centred on a shape at the edge (start side on desktop, bottom sheet on narrow screens).
 */
export function fitPadding(narrow: boolean) {
  const dock = document.querySelector('.md-dock')?.getBoundingClientRect();
  const label = 120;
  return narrow
    ? // bottom: the sheet plus the zoom and scale controls stacked just above it
      { paddingTopLeft: [100, 56] as L.PointTuple, paddingBottomRight: [100, Math.round((dock?.height ?? 0) + 130)] as L.PointTuple }
    : // bottom: room for the zoom and scale controls (bottom-left), so no name sits under the scale bar
      { paddingTopLeft: [label, 48] as L.PointTuple, paddingBottomRight: [Math.round((dock?.width ?? 0) + 24 + label), 112] as L.PointTuple };
}
