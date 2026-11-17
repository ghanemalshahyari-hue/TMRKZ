import { describe, expect, it } from 'vitest';
import { CREATABLE_PURPOSES, PURPOSE_TITLE, isCreatablePurpose, isPurpose } from './requestPurpose';

describe('request purposes after ADR-078', () => {
  it('initial stationing is no longer started: it is set up with its site in «تهيئة المواقع»', () => {
    expect(CREATABLE_PURPOSES).toEqual(['SITE_REGISTRATION', 'DEPLOYMENT_AREAS', 'RESTATIONING']);
    expect(isCreatablePurpose('INITIAL_STATIONING')).toBe(false);
    expect(isCreatablePurpose('DEPLOYMENT_AREAS')).toBe(true);
    expect(isCreatablePurpose(null)).toBe(false);
    expect(isCreatablePurpose('NOT_A_TYPE')).toBe(false);
  });

  it('a request of that purpose made before is still read with its title', () => {
    expect(isPurpose('INITIAL_STATIONING')).toBe(true);
    expect(PURPOSE_TITLE.INITIAL_STATIONING).toBe('طلب تمركز أولي');
  });
});
