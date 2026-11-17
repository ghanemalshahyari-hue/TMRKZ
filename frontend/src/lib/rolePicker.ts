import type { RoleDef } from '../api/types';

/**
 * Which roles a person may choose to give or to ask for (owner, 17 Nov 2026; ADR-078). The role catalogue keeps every role,
 * emptied ones too — they are the history of earlier grants — but a role with no permissions is never offered in a picker:
 * the server refuses to give it («دور بلا صلاحيات لا يُمنح»). The protected system role is never picked unless a page lists it.
 */
export const EMPTY_ROLE = 'بلا صلاحيات';

export const isEmptyRole = (r: Pick<RoleDef, 'permissions'>): boolean => !r.permissions?.length;

export function pickableRoles<T extends Pick<RoleDef, 'permissions' | 'system'>>(roles: readonly T[], opts: { system?: boolean } = {}): T[] {
  return roles.filter((r) => !isEmptyRole(r) && (opts.system || !r.system));
}

/** The codes of the catalogue's roles with no permissions; empty when the catalogue could not be read (the server filters then). */
export function emptyRoleCodes(catalogue: readonly Pick<RoleDef, 'code' | 'permissions'>[] | null | undefined): Set<string> {
  return new Set((catalogue ?? []).filter(isEmptyRole).map((r) => r.code));
}

/** A list of roles to choose from (offered, extras, requestable) without those the catalogue knows to have no permissions. */
export function withoutEmptyRoles<T extends { code: string }>(items: readonly T[], catalogue: readonly Pick<RoleDef, 'code' | 'permissions'>[] | null | undefined): T[] {
  const empty = emptyRoleCodes(catalogue);
  return items.filter((i) => !empty.has(i.code));
}
