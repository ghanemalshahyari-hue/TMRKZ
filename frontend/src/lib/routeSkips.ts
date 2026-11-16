import type { StageView } from '../api/types';

/**
 * Hierarchy units skipped in a request's climbing steps (owner decision of 16 Nov 2026, ADR-062): what the route recorded,
 * never recomputed here. A skipped unit is not an approval: it is never counted as approved nor drawn with a check mark.
 */
export type SkipLine = { stage: string; name: string; reason: string };

export function skippedUnits(stages: StageView[]): SkipLine[] {
  return stages.flatMap((s) =>
    (s.skipped ?? []).slice().sort((a, b) => a.order - b.order).map((k) => ({ stage: s.name, name: k.organizationName ?? 'جهة', reason: k.reason })),
  );
}

/** «تم تجاوز 3 جهات في السلسلة الهرمية لعدم وجود معتمد», or null when nothing was skipped. */
export function skippedSummary(stages: StageView[]): string | null {
  const n = skippedUnits(stages).length;
  if (!n) return null;
  const units = n === 1 ? 'جهة واحدة' : n === 2 ? 'جهتين' : n <= 10 ? `${n} جهات` : `${n} جهة`;
  return `تم تجاوز ${units} في السلسلة الهرمية لعدم وجود معتمد`;
}

/** A step all of whose units were skipped ended without anyone approving: it shows as passed, not approved. */
export const onlySkipped = (s: StageView) => !!s.skipped?.length && s.tasks.length === 0;
