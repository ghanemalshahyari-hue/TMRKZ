import { describe, expect, it } from 'vitest';
import { identityCard, UNIT_NOT_CONFIGURED } from './identityCard';

const base = { name: 'موظف تجريبي', employeeNo: '70001', userId: 'user.test', rank: null, position: null, unit: null, mainUnit: null, source: 'الدليل المؤسسي' };

describe('zero-access identity card (ADR-068)', () => {
  it('shows the unit the directory resolved, and leaves empty values out', () => {
    const c = identityCard({ ...base, unit: 'إدارة تجريبية', rank: 'نقيب', unitConfigured: true, sourceCode: 'LDAP' });
    expect(c.notice).toBeNull();
    expect(c.rows).toContainEqual(['الوحدة', 'إدارة تجريبية']);
    expect(c.rows).toContainEqual(['الرتبة', 'نقيب']);
    expect(c.rows.map(([k]) => k)).not.toContain('المنصب');
  });

  it('a Unit ID TMRKZ does not hold: shown as received, marked not configured, with the owner’s notice', () => {
    const c = identityCard({ ...base, unitConfigured: false, statedUnitId: 'U-404', statedUnitName: 'وحدة غير مسجلة' });
    expect(c.rows).toContainEqual(['الوحدة', 'وحدة غير مسجلة — رقم الوحدة U-404 (غير مهيأة في النظام)']);
    expect(c.notice).toContain(UNIT_NOT_CONFIGURED);
  });

  it('not configured but added to a unit by an access manager: that unit, the directory’s shown apart, no notice', () => {
    const c = identityCard({ ...base, unit: 'وحدة الإضافة', unitConfigured: false, statedUnitId: 'U-404', statedUnitName: null, unitOrigin: 'ADDED' });
    expect(c.rows).toContainEqual(['الوحدة', 'وحدة الإضافة']);
    expect(c.rows).toContainEqual(['الوحدة في الدليل', 'رقم الوحدة U-404 (غير مهيأة في النظام)']);
    expect(c.notice).toBeNull();
  });
});
