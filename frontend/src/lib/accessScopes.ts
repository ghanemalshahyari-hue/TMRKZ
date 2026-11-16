import type { OfferedRole, ScopeMode } from '../api/client';

/** The four scopes a role may be asked with (ADR-045); the whole system is never one of them. */
export const SCOPE_MODES: readonly (readonly [ScopeMode, string])[] = [['UNIT', 'وحدتي فقط'], ['UNIT_TREE', 'وحدتي والوحدات التابعة'], ['UNITS', 'وحدات محددة'], ['SITES', 'مواقع محددة']];

/**
 * The scopes the chosen roles may all be asked with — their lists from «الصلاحيات المتاحة للطلب» intersected; a role with none
 * set allows all four — and the one to start from: the first chosen role's default when still allowed, else the first allowed.
 */
export function scopesFor(chosen: OfferedRole[]): { modes: ScopeMode[]; start: ScopeMode | null } {
  let modes: ScopeMode[] = SCOPE_MODES.map(([m]) => m);
  for (const r of chosen) {
    if (r.scopeModes?.length) modes = modes.filter((m) => r.scopeModes!.includes(m));
  }
  const wanted = chosen.find((r) => r.defaultScope)?.defaultScope ?? null;
  return { modes, start: wanted && modes.includes(wanted) ? wanted : modes[0] ?? null };
}
