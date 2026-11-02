// Screen-space helpers for the prototype map: marker clustering and collision-aware label placement. Pure functions on
// pixel coordinates (the map projects sites to the current zoom first), so they can be tested without a map.

export type Pt = { id: string; x: number; y: number };
export type Cluster = { ids: string[]; x: number; y: number };

/**
 * Greedy distance clustering: a point joins the nearest cluster whose centre is within {@code radius} pixels, otherwise it
 * starts one. Centres are the mean of their members, so a cluster sits where its sites are.
 */
export function clusterPoints(points: Pt[], radius: number): Cluster[] {
  const out: Cluster[] = [];
  for (const p of [...points].sort((a, b) => a.x - b.x || a.y - b.y)) {
    let best: Cluster | null = null;
    let bd = radius;
    for (const c of out) {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d <= bd) {
        best = c;
        bd = d;
      }
    }
    if (best) {
      const n = best.ids.length;
      best.x = (best.x * n + p.x) / (n + 1);
      best.y = (best.y * n + p.y) / (n + 1);
      best.ids.push(p.id);
    } else out.push({ ids: [p.id], x: p.x, y: p.y });
  }
  return out;
}

export type Box = { x: number; y: number; w: number; h: number };
export type LabelCandidate = { id: string; x: number; y: number; w: number; h: number; priority: number };
/** Where a placed label sits relative to its marker. */
export type Placement = 'below' | 'above' | 'side-start' | 'side-end';

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The box of a label of size w × h for a marker at (x, y) in one of four positions (marker radius r). */
export function labelBox(x: number, y: number, w: number, h: number, where: Placement, r = 14): Box {
  if (where === 'below') return { x: x - w / 2, y: y + r + 2, w, h };
  if (where === 'above') return { x: x - w / 2, y: y - r - 2 - h, w, h };
  if (where === 'side-start') return { x: x + r + 4, y: y - h / 2, w, h };
  return { x: x - r - 4 - w, y: y - h / 2, w, h };
}

/**
 * Places labels by priority (highest first): each tries below, above, then beside its marker, and is dropped when every
 * position collides with an already placed label or a marker. Returns the chosen position per placed label.
 */
export function placeLabels(cands: LabelCandidate[], obstacles: Box[], view: Box): Map<string, Placement> {
  const placed: Box[] = [];
  const out = new Map<string, Placement>();
  for (const c of [...cands].sort((a, b) => b.priority - a.priority)) {
    for (const where of ['below', 'above', 'side-start', 'side-end'] as Placement[]) {
      const b = labelBox(c.x, c.y, c.w, c.h, where);
      const inside = b.x >= view.x && b.y >= view.y && b.x + b.w <= view.x + view.w && b.y + b.h <= view.y + view.h;
      if (!inside) continue;
      if (placed.some((p) => overlaps(p, b)) || obstacles.some((o) => overlaps(o, b))) continue;
      placed.push(b);
      out.set(c.id, where);
      break;
    }
  }
  return out;
}

/** Approximate label width for Arabic text at 12px with padding (measured once per name on the page). */
export const estimateWidth = (text: string) => Math.round(text.length * 6.6 + 18);
