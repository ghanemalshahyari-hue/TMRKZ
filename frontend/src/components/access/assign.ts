import type { GrantView } from '../../api/types';
import { unitCount, type UnitChoice } from './UnitsDialog';

/** How a «تعيين» cell reads: how many units its grant covers (ADR-042). */
export function cellText(g: GrantView | undefined): string {
  if (!g) return 'تعيين';
  if (g.all) return 'كل الوحدات';
  const units = g.targets.filter((t) => t.kind === 'ORGANIZATION').length;
  return units ? unitCount(units) : 'وحدته';
}

/** The units a grant already covers, as the «تعيين» dialog lists them. */
export function existingUnits(g: GrantView | undefined): UnitChoice[] {
  if (!g) return [];
  const named = g.targets.filter((t) => t.kind === 'ORGANIZATION');
  if (named.length) return named.map((t) => ({ id: t.id, name: t.name, mode: t.levels?.length ? 'LEVELS' : t.includeDescendants ? 'BRANCH' : 'ONE', levels: t.levels ?? [] }));
  return g.all || !g.organization ? [] : [{ id: g.organization.id, name: g.organization.name, mode: 'BRANCH', levels: [] }];
}
