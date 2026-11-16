/**
 * The widths of the access workspace's side panels (owner, 16 Nov 2026: «make the ability to modify the width»): the unit
 * tree (02) and the unit file (04), dragged on the dividers beside the middle panel, kept per viewer in this browser only.
 */
export type PanelWidths = { tree: number; file: number };
export type Panel = keyof PanelWidths;

export const DEFAULT_WIDTHS: PanelWidths = { tree: 330, file: 300 };
const LIMITS: Record<Panel, [number, number]> = { tree: [220, 760], file: [220, 680] };
/** The middle panel never gets narrower than this while a side panel is dragged. */
export const MIN_MAIN = 420;
/** Both dividers together. */
export const DIVIDERS = 28;
const KEY = 'tmrkz-aw-widths';

const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(Math.max(v, lo), Math.max(lo, hi)));

/** One panel set to `px`, within its limits and leaving the middle panel at least MIN_MAIN of `total`. */
export function resize(w: PanelWidths, panel: Panel, px: number, total: number): PanelWidths {
  const other = panel === 'tree' ? w.file : w.tree;
  const [lo, hi] = LIMITS[panel];
  return { ...w, [panel]: clamp(px, lo, Math.min(hi, total - DIVIDERS - MIN_MAIN - other)) };
}

/**
 * Where the pointer puts a panel's inner edge. The tree is the first column and the file the last, so in a right-to-left
 * page the tree hugs the right edge and the file the left one.
 */
export function widthAt(panel: Panel, x: number, box: { left: number; right: number }, rtl: boolean): number {
  const half = DIVIDERS / 4;
  const fromStart = rtl ? box.right - x : x - box.left;
  const fromEnd = rtl ? x - box.left : box.right - x;
  return (panel === 'tree' ? fromStart : fromEnd) - half;
}

export function loadWidths(): PanelWidths {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PanelWidths> | null;
    if (v && Number.isFinite(v.tree) && Number.isFinite(v.file)) {
      return { tree: clamp(v.tree!, ...LIMITS.tree), file: clamp(v.file!, ...LIMITS.file) };
    }
  } catch {
    /* storage blocked or unreadable: the defaults */
  }
  return { ...DEFAULT_WIDTHS };
}

export function saveWidths(w: PanelWidths) {
  try {
    localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    /* not kept: the page still works */
  }
}
