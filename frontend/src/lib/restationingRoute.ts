/**
 * Addresses of «إعادة التمركز» (owner decisions of 5 Nov 2026): the list (#restationing), one request
 * (#restationing/<id>), or a NEW request opened from a site (#restationing/new?site=<siteId>: that site is the current
 * site) or from a unit (#restationing/new?unit=<orgId>: its site is located for the person to confirm). Identifiers
 * only; the editor and the server check everything.
 */
export type RestationingRoute = { kind: 'list' } | { kind: 'request'; id: string } | { kind: 'new'; unit: string | null; site: string | null; purpose: string | null };

const ID = /^[0-9A-Za-z-]{1,64}$/;

export function parseRestationingHash(hash: string): RestationingRoute {
  const path = hash.replace(/^#/, '');
  const slash = path.indexOf('/');
  const head = slash < 0 ? path : path.slice(0, slash);
  const rest = slash < 0 ? '' : path.slice(slash + 1);
  if (head !== 'restationing' || !rest) return { kind: 'list' };
  if (rest === 'new' || rest.startsWith('new?')) {
    const q = new URLSearchParams(rest.slice(4));
    const id = (k: string) => {
      const v = q.get(k);
      return v && ID.test(v) ? v : null;
    };
    return { kind: 'new', unit: id('unit'), site: id('site'), purpose: q.get('purpose') };
  }
  return ID.test(rest) ? { kind: 'request', id: rest } : { kind: 'list' };
}

export const newRequestHash = (unitId: string) => '#restationing/new?unit=' + encodeURIComponent(unitId);
export const newRequestFromSiteHash = (siteId: string) => '#restationing/new?site=' + encodeURIComponent(siteId);
