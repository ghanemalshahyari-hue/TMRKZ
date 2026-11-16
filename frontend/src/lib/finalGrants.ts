import type { AccessGrantSpec, AccessScope, AccessScopeTree } from '../api/client';
import type { UnitChoice } from '../components/access/UnitsDialog';

/**
 * The final approval of a permission request, role by role (owner, LDAP first login §14–15; ADR-069). Each role the final
 * approver activates carries its own scope — the role's default reach at the person's unit, or chosen units, each alone, with
 * its descendants or with chosen levels under it; chosen sites — and its own validity. The server's preview is the authority on
 * what will be written; this file only builds what is sent and what a choice covers locally while choosing.
 */
export type RoleChoice = {
  role: string;
  name: string;
  /** a responsibility of the unit (a seat its current holder occupies), not a personal permission */
  seat: boolean;
  /** the role's default reach at the person's unit (no explicit scope) */
  byDefault: boolean;
  units: UnitChoice[];
  sites: { id: string; name: string }[];
  /** YYYY-MM-DD, empty: from the activation */
  validFrom: string;
  /** YYYY-MM-DD, empty: open-ended */
  validTo: string;
};

/** The final-approval roles: given only by a global access manager, a whole unit with its levels or every unit (ADR-058). */
export const FINAL_ROLES = ['FINAL_APPROVER', 'ACCESS_FINAL_APPROVER', 'STATIONING_FINAL_APPROVER'];

/** The starting choice for a role: the scope advised (or asked) for the request, at the person's unit. */
export function initialChoice(
  role: { code: string; name: string },
  seat: boolean,
  scope: AccessScope | null | undefined,
  unit: { id: string; name: string },
  names: Map<string, string>,
  sites: { id: string; name: string }[],
): RoleChoice {
  const base: RoleChoice = { role: role.code, name: role.name, seat, byDefault: false, units: [], sites: [], validFrom: '', validTo: '' };
  if (!scope) return { ...base, byDefault: true };
  switch (scope.mode) {
    case 'UNIT':
      return { ...base, units: [{ id: unit.id, name: unit.name, mode: 'ONE', levels: [] }] };
    case 'UNIT_TREE':
      return { ...base, units: [{ id: unit.id, name: unit.name, mode: 'BRANCH', levels: [] }] };
    case 'UNITS':
      return { ...base, units: scope.ids.map((id) => ({ id, name: names.get(id) ?? id, mode: 'ONE' as const, levels: [] })) };
    case 'SITES':
      return { ...base, sites: scope.ids.map((id) => ({ id, name: sites.find((s) => s.id === id)?.name ?? id })) };
    default:
      return { ...base, byDefault: true };
  }
}

/** A calendar day in the browser's zone: its first second (start) or its last (end), as an instant. */
export function dayInstant(day: string, end: boolean): string {
  return new Date(day + (end ? 'T23:59:59' : 'T00:00:00')).toISOString();
}

/** Today in the browser's zone, YYYY-MM-DD. */
export function today(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
}

/** What is sent for one role: exactly the grant/target/levels model the server writes. */
export function toSpec(c: RoleChoice, now: Date = new Date()): AccessGrantSpec {
  const spec: AccessGrantSpec = { role: c.role };
  if (!c.byDefault) {
    spec.scope = {
      mode: 'CUSTOM',
      targets: [
        ...c.units.map((u) => ({
          kind: 'ORGANIZATION' as const,
          id: u.id,
          includeDescendants: u.mode !== 'ONE',
          levels: u.mode === 'LEVELS' ? [...u.levels].sort((a, b) => a - b) : null,
        })),
        ...c.sites.map((s) => ({ kind: 'SITE' as const, id: s.id, includeDescendants: false })),
      ],
    };
  }
  // a start today is «from the activation»: an instant earlier today would be in the past when the approval runs
  if (c.validFrom && c.validFrom > today(now)) spec.validFrom = dayInstant(c.validFrom, false);
  if (c.validTo) spec.validTo = dayInstant(c.validTo, true);
  return spec;
}

/** A choice that cannot be previewed yet, in words, or null. */
export function incomplete(c: RoleChoice): string | null {
  if (!c.byDefault && !c.units.length && !c.sites.length) return 'اختر وحدة واحدة على الأقل لـ«' + c.name + '» أو النطاق الافتراضي للدور.';
  if (c.units.some((u) => u.mode === 'LEVELS' && !u.levels.length)) return 'اختر مستوى واحداً على الأقل لـ«' + c.name + '».';
  if (c.validFrom && c.validTo && c.validTo < c.validFrom) return 'نهاية صلاحية «' + c.name + '» قبل بدايتها.';
  return null;
}

/** The scope tree's local counts: a unit alone, with its descendants, or the units at chosen levels under it. */
export function counter(tree: AccessScopeTree): (id: string, mode: UnitChoice['mode'], levels: number[]) => number | undefined {
  const kids = new Map<string, string[]>();
  const level = new Map<string, number | null>();
  for (const u of tree.units) {
    level.set(u.id, u.level);
    if (u.parentId) kids.set(u.parentId, [...(kids.get(u.parentId) ?? []), u.id]);
  }
  const below = (id: string): string[] => {
    const out = [id];
    for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) ?? []));
    return out;
  };
  return (id, mode, levels) => {
    if (!level.has(id)) return undefined;
    if (mode === 'ONE') return 1;
    const all = below(id);
    return mode === 'BRANCH' ? all.length : all.filter((u) => levels.includes(level.get(u) ?? -1)).length;
  };
}

/** The levels the branch holds, for «مستويات محددة», in the shape the units dialog takes. */
export function branchLevels(tree: AccessScopeTree): { level: number; units: number; examples: string[] }[] {
  const by = new Map<number, string[]>();
  for (const u of tree.units) if (u.level != null) by.set(u.level, [...(by.get(u.level) ?? []), u.name]);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([level, names]) => ({ level, units: names.length, examples: names.slice(0, 3) }));
}
