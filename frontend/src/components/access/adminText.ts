import type { AccessRightDef, DutyPermit } from '../../api/client';

/** «معتمد التوفر» chips (TNQL): granted at a providing unit, granted where the unit does not provide it yet, or not granted. */
export type AvailabilityState = 'ACTIVE' | 'STANDBY' | 'NONE';

export function availabilityState(held: boolean, provider: boolean): AvailabilityState {
  if (!held) return 'NONE';
  return provider ? 'ACTIVE' : 'STANDBY';
}

export const AVAILABILITY_LABEL: Record<AvailabilityState, string> = { ACTIVE: 'فعالة', STANDBY: 'احتياطية', NONE: 'غير ممنوحة' };

/** A department's own name, from its role «معتمد التوفر — المرافق». */
export function departmentName(roleName: string): string {
  return roleName.replace(/^معتمد التوفر\s*[—-]\s*/, '');
}

/** How many rights a grant carries, as the cell reads it; no list means every right. */
export function rightsText(rights: string[] | null | undefined, total: number): string {
  if (rights == null || rights.length >= total) return 'كل الحقوق';
  const n = rights.length;
  if (n === 0) return 'بلا حقوق';
  if (n === 1) return 'حق واحد';
  if (n === 2) return 'حقان';
  if (n <= 10) return n + ' حقوق';
  return n + ' حقاً';
}

/** The rights a new access manager starts with, as TNQL's (duty and routing on). */
export function defaultRights(catalogue: AccessRightDef[]): string[] {
  return catalogue.filter((r) => r.byDefault).map((r) => r.key);
}

export const PERMIT_STATE: Record<DutyPermit['state'], string> = {
  ISSUED: 'بانتظار التفعيل',
  ACTIVATED: 'مفعّل — يبدأ في موعده',
  ACTIVE: 'ساري',
  ENDED: 'منتهٍ',
  EXPIRED: 'انتهت مدته',
};

/** Whether the holder may activate it now: issued, and its duty starts within a quarter of an hour. */
export function canActivate(p: DutyPermit, now = Date.now()): boolean {
  return p.state === 'ISSUED' && Date.parse(p.validFrom) <= now + 15 * 60 * 1000 && Date.parse(p.validTo) > now;
}

const ACCOUNT_ACTIONS: Record<string, string> = {
  MEMBERSHIP_CREATED: 'منح صلاحية',
  MEMBERSHIP_ENDED: 'سحب صلاحية',
  UNIT_MEMBER_ADDED: 'إضافة إلى وحدة',
  UNIT_MEMBER_ENDED: 'إزالة من وحدة',
  DUTY_PERMIT_ISSUED: 'إصدار تصريح مناوبة',
  DUTY_PERMIT_ACTIVATED: 'تفعيل تصريح مناوبة',
  DUTY_PERMIT_ENDED: 'إنهاء تصريح مناوبة',
  PERSON_ACCESS_DISABLED: 'إيقاف الحساب',
  PERSON_ACCESS_ENABLED: 'تفعيل الحساب',
  PERSON_PROFILE_CHANGED: 'تعديل البيانات',
  PERSON_RETIRED: 'حذف الحساب',
  LOCAL_USER_CREATED: 'إنشاء حساب محلي',
};

export function accountAction(code: string): string {
  return ACCOUNT_ACTIONS[code] ?? code;
}
