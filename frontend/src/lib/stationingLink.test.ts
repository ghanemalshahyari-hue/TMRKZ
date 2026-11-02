import { describe, expect, it } from 'vitest';
import { parseStationingHash, stationingSiteHash } from './stationingLink';

const SITE = '2b4f1c1e-0a51-4a8e-9a63-0d2f6f0b9a11';
const ORG = '7c3d2a90-55b1-4e0f-8d0e-1f2a3b4c5d6e';

describe('stationing addresses', () => {
  it('reads a saved draft', () => {
    expect(parseStationingHash('#stationing/' + SITE)).toEqual({ draft: SITE });
  });

  it('reads a site with its organisation, and a site alone (V-09 deep link)', () => {
    expect(parseStationingHash(stationingSiteHash(SITE, ORG))).toEqual({ site: SITE, org: ORG });
    expect(parseStationingHash(stationingSiteHash(SITE))).toEqual({ site: SITE });
    expect(stationingSiteHash(SITE, ORG)).toBe('#stationing/site/' + SITE + '/org/' + ORG);
  });

  it('never treats the site address as a draft, and ignores anything else', () => {
    expect(parseStationingHash('#stationing/site')).toEqual({});
    expect(parseStationingHash('#stationing')).toEqual({});
    expect(parseStationingHash('#requests/' + SITE)).toEqual({});
    expect(parseStationingHash('#stationing/site/<script>')).toEqual({});
  });
});
