import { describe, expect, it } from 'vitest';
import type { DutyPermit } from '../../api/client';
import { accountAction, availabilityState, canActivate, defaultRights, departmentName, rightsText } from './adminText';

const permit = (over: Partial<DutyPermit>): DutyPermit => ({
  id: 'p',
  person: { id: 'a', displayName: 'أ', employeeNo: '1' },
  organization: { id: 'o', name: 'و' },
  role: { code: 'R', name: 'ر' },
  validFrom: new Date(Date.now() - 60_000).toISOString(),
  validTo: new Date(Date.now() + 3_600_000).toISOString(),
  reason: 'مناوبة',
  issuedBy: null,
  issuedAt: new Date().toISOString(),
  activatedAt: null,
  endReason: null,
  state: 'ISSUED',
  ...over,
});

describe('the words of ADR-059', () => {
  it('reads an availability chip as TNQL does', () => {
    expect(availabilityState(true, true)).toBe('ACTIVE');
    expect(availabilityState(true, false)).toBe('STANDBY');
    expect(availabilityState(false, true)).toBe('NONE');
    expect(departmentName('معتمد التوفر — المرافق')).toBe('المرافق');
  });

  it('counts the rights of an access manager; no list is every right', () => {
    expect(rightsText(null, 10)).toBe('كل الحقوق');
    expect(rightsText(['A'], 10)).toBe('حق واحد');
    expect(rightsText(['A', 'B'], 10)).toBe('حقان');
    expect(rightsText(['A', 'B', 'C'], 10)).toBe('3 حقوق');
    expect(defaultRights([{ key: 'DUTY', label: '', byDefault: true }, { key: 'GRANT', label: '', byDefault: false }])).toEqual(['DUTY']);
  });

  it('lets a permit be activated only once its duty starts', () => {
    expect(canActivate(permit({}))).toBe(true);
    expect(canActivate(permit({ validFrom: new Date(Date.now() + 3 * 3_600_000).toISOString(), validTo: new Date(Date.now() + 5 * 3_600_000).toISOString() }))).toBe(false);
    expect(canActivate(permit({ state: 'ACTIVE' }))).toBe(false);
    expect(accountAction('PERSON_RETIRED')).toBe('حذف الحساب');
  });
});
