import type { SiteGeometry } from '../api/types';
import { formatIn, parseInFormat, type FormatKey } from './coordFormats';
import { partsOf, validateSite } from './siteGeometry';

/**
 * «موقع جديد» in «تهيئة المواقع والتمركز», as in MOVER's «المواقع» drawer (owner, 10 Nov 2026): three steps — the data, the
 * shape, review and save — one question per card. These are its pure parts; the page draws them.
 */
export type Step = 1 | 2 | 3;

/** The quick choices of «ما نوعه؟», as in MOVER; any other type is typed under «نوع آخر». */
export const MAIN_KINDS = ['معسكر', 'موقع قيادة', 'منطقة داخلية', 'بوابة'];

export type WizardState = {
  name: string;
  kind: string;
  inside: boolean;
  parentId: string;
  shape: 'POLYGON' | 'POINT';
  point: { lat: number; lng: number } | null;
  geometry: SiteGeometry | null;
  drawing: boolean;
};

/** Why the wizard may not go on to `to` yet ('' when it may). Going back is always allowed. */
export function stepProblem(s: WizardState, to: Step): string {
  if (to >= 2) {
    if (!s.name.trim()) return 'اكتب اسم الموقع.';
    if (!s.kind.trim()) return 'اختر نوع الموقع أو اكتبه.';
    if (s.inside && !s.parentId) return 'اختر الموقع الذي يقع داخله، أو اجعله موقعاً رئيسياً.';
  }
  if (to >= 3) {
    if (s.drawing) return 'أكمل الرسم أولاً: انقر على أول نقطة، أو «إنهاء الرسم».';
    if (s.shape === 'POINT' ? !s.point : !s.geometry) return s.shape === 'POINT' ? 'حدّد مكان الموقع على الخريطة أولاً.' : 'ارسم حدود الموقع على الخريطة أولاً.';
  }
  return '';
}

/** «الشكل» in the review: a point, an area of n corners, or n parts. */
export function shapeText(shape: 'POLYGON' | 'POINT', geometry: SiteGeometry | null): string {
  if (shape === 'POINT') return 'نقطة واحدة';
  if (!geometry) return '—';
  const parts = partsOf(geometry);
  return parts.length > 1 ? `${parts.length} أجزاء تتحرك معاً` : `منطقة بـ${parts[0][0].length} زوايا`;
}

// ---- «جدول الإحداثيات»: one point per row, any format, joined in order (owner, 10 Nov 2026) ---------------------------------
export type PointRow = { text: string; point: { lat: number; lng: number } | null; error: string };

/** A row as typed: read in the chosen format (or any format, «تلقائي»); an empty row is neither a point nor an error. */
export function readRow(text: string, fmt: FormatKey): PointRow {
  if (!text.trim()) return { text, point: null, error: '' };
  const r = parseInFormat(text, fmt);
  return r.ok ? { text, point: { lat: r.lat, lng: r.lon }, error: '' } : { text, point: null, error: r.error };
}

/** The rows of a list of points, written in a format; the points themselves are kept exactly (no drift between formats). */
export const rowsOf = (points: { lat: number; lng: number }[], fmt: FormatKey): PointRow[] =>
  points.map((p) => ({ text: formatIn(fmt, p.lat, p.lng), point: { ...p }, error: '' }));

/** The same rows in another format: each point written again, the typed-but-wrong rows left as typed. */
export const reformat = (rows: PointRow[], fmt: FormatKey): PointRow[] =>
  rows.map((r) => (r.point ? { text: formatIn(fmt, r.point.lat, r.point.lng), point: r.point, error: '' } : readRow(r.text, fmt)));

/** The outline joining the rows' points in order (rows without a point are skipped), or why it cannot be one yet. */
export function outlineOf(rows: PointRow[]): { geometry: SiteGeometry | null; error: string } {
  const pts = rows.map((r) => r.point).filter((p): p is { lat: number; lng: number } => !!p);
  if (pts.length < 3) return { geometry: null, error: pts.length ? `${pts.length} من 3 نقاط على الأقل.` : '' };
  const geometry = { type: 'Polygon', coordinates: [[...pts, pts[0]].map((p) => [p.lng, p.lat])] } as unknown as SiteGeometry;
  const v = validateSite(partsOf(geometry));
  return v.ok ? { geometry, error: '' } : { geometry: null, error: v.problems[0] ?? 'الحدود غير صالحة.' };
}

/** The corners of a one-part outline, for the table; null for several parts (edited on the map). */
export function cornersOf(geometry: SiteGeometry | null): { lat: number; lng: number }[] | null {
  if (!geometry) return [];
  const parts = partsOf(geometry);
  return parts.length === 1 ? parts[0][0].map((p) => ({ lat: p.lat, lng: p.lng })) : null;
}
