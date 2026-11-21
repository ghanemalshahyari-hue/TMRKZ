import { describe, expect, it } from 'vitest';
import { homeEmpty } from './homeEmpty';

describe('the empty system (ADR-094)', () => {
  it('is empty only when nothing real exists and the lists have answered', () => {
    expect(homeEmpty({ orgs: 0, sites: 0, stationed: [], requests: [], cards: 0 })).toBe(true);
    expect(homeEmpty({ orgs: 0, sites: 0, stationed: null, requests: [], cards: 0 })).toBe(false);
    expect(homeEmpty({ orgs: 0, sites: 0, stationed: [], requests: null, cards: 0 })).toBe(false);
  });
  it('one unit, site, stationing, request or waiting card makes the home a dashboard again', () => {
    expect(homeEmpty({ orgs: 1, sites: 0, stationed: [], requests: [], cards: 0 })).toBe(false);
    expect(homeEmpty({ orgs: 0, sites: 1, stationed: [], requests: [], cards: 0 })).toBe(false);
    expect(homeEmpty({ orgs: 0, sites: 0, stationed: [{}], requests: [], cards: 0 })).toBe(false);
    expect(homeEmpty({ orgs: 0, sites: 0, stationed: [], requests: [{}], cards: 0 })).toBe(false);
    expect(homeEmpty({ orgs: 0, sites: 0, stationed: [], requests: [], cards: 1 })).toBe(false);
  });
});
