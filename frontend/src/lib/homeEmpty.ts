/**
 * The empty system (owner, 20 Nov 2026; ADR-094): the home shows nothing in the middle — no tiles of zeros, no map, no sample
 * request — until real data exists locally. Empty means: no unit, no site, no current stationing, no request and no card
 * waiting; lists still loading (null) are not yet "none".
 */
export function homeEmpty(s: { orgs: number; sites: number; stationed: readonly unknown[] | null; requests: readonly unknown[] | null; cards: number }): boolean {
  if (s.orgs > 0 || s.sites > 0 || s.cards > 0) return false;
  if (s.stationed === null || s.requests === null) return false;
  return s.stationed.length === 0 && s.requests.length === 0;
}
