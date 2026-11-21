import type { Me } from '../api/types';
import { fullTime } from './dates';

/** The HR line of «بياناتي» (ADR-094): matched and when, pending, stale, or none. */
export function hrState(me: Pick<Me, 'hrMatch' | 'hrFetchedAt' | 'hrStale'>): string {
  if (me.hrMatch === 'PENDING') return 'بانتظار تحديث HR';
  if (me.hrMatch !== 'MATCHED') return '—';
  const when = me.hrFetchedAt ? ' · آخر تحديث ' + fullTime(me.hrFetchedAt) : '';
  return (me.hrStale ? 'مطابق — بيانات قديمة، تُحدَّث عند الحاجة' : 'مطابق') + when;
}

/**
 * The ancestors of a unit in a depth-ordered flat list (root first, the unit itself last), for the tree to open and reveal
 * the person's own unit; empty when the unit is not in the list.
 */
export function unitTrail(units: readonly { id: string; depth?: number }[], current: string | null): string[] {
  if (!current) return [];
  const stack: { id: string; depth: number }[] = [];
  for (const u of units) {
    const depth = u.depth ?? 0;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    stack.push({ id: u.id, depth });
    if (u.id === current) return stack.map((s) => s.id);
  }
  return [];
}
