import type { GrantView } from '../../api/types';
import { type UnitChoice } from './UnitsDialog';

/**
 * How a «تعيين» cell reads (owner, 21 Nov 2026): the scope meaning, not just a unit count. For one explicit target the
 * cell names the anchor and the mode (UNIT / UNIT_TREE / LEVELS). For several targets it says how many were chosen.
 * Without targets the grant covers the person's own unit through the role's default scope. The precise unit count is
 * still available on hover through {@code scopeText}.
 */
export function cellText(g: GrantView | undefined): { anchor: string; mode: string | null } {
  if (!g) return { anchor: 'تعيين', mode: null };
  if (g.all) return { anchor: 'كل الوحدات', mode: null };
  const orgTargets = g.targets.filter((t) => t.kind === 'ORGANIZATION');
  if (orgTargets.length === 0) return { anchor: 'وحدته', mode: null };
  if (orgTargets.length === 1) {
    const t = orgTargets[0];
    const mode = t.levels && t.levels.length ? 'مستويات محددة' : t.includeDescendants ? 'الوحدة وما دونها' : 'هذه الوحدة فقط';
    return { anchor: t.name, mode };
  }
  return { anchor: orgTargets.length.toLocaleString('en-US') + ' وحدات محددة', mode: null };
}

/** The units a grant already covers, as the «تعيين» dialog lists them. */
export function existingUnits(g: GrantView | undefined): UnitChoice[] {
  if (!g) return [];
  const named = g.targets.filter((t) => t.kind === 'ORGANIZATION');
  if (named.length) return named.map((t) => ({ id: t.id, name: t.name, mode: t.levels?.length ? 'LEVELS' : t.includeDescendants ? 'BRANCH' : 'ONE', levels: t.levels ?? [] }));
  return g.all || !g.organization ? [] : [{ id: g.organization.id, name: g.organization.name, mode: 'BRANCH', levels: [] }];
}
