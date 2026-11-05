/**
 * Addresses inside «المواقع» (#stationing): a site, with the organisation it was opened for
 * (#stationing/site/<siteId>/org/<orgId>, e.g. from «على الخريطة» on the organisation page). The older draft form
 * (#stationing/<requestId>) belonged to the retired proposal workflow and opens nothing. Identifiers only — never names
 * or data; the page checks everything with the server.
 */
export type StationingLink = { draft?: string; site?: string; org?: string };

const ID = /^[0-9A-Za-z-]{1,64}$/;

export function parseStationingHash(hash: string): StationingLink {
  const parts = hash.replace(/^#/, '').split('/');
  if (parts[0] !== 'stationing' || !parts[1]) return {};
  if (parts[1] === 'site') {
    if (!ID.test(parts[2] ?? '')) return {};
    return parts[3] === 'org' && ID.test(parts[4] ?? '') ? { site: parts[2], org: parts[4] } : { site: parts[2] };
  }
  return ID.test(parts[1]) ? { draft: parts[1] } : {};
}

export function stationingSiteHash(siteId: string, orgId?: string | null): string {
  return '#stationing/site/' + siteId + (orgId ? '/org/' + orgId : '');
}
