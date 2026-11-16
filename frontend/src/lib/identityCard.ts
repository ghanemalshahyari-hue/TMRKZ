import type { AccessIdentity } from '../api/client';

/** The owner's words for a verified person whose unit TMRKZ does not hold yet (LDAP specification §5). */
export const UNIT_NOT_CONFIGURED = 'تم التحقق من هويتك، لكن وحدتك التنظيمية غير مهيأة في النظام';

/**
 * The rows of the zero-access identity card and its one notice (ADR-068). A unit the source states but TMRKZ does not hold is
 * shown as received — its Unit ID and name — marked «غير مهيأة في النظام»; when the person has no unit at all because of it,
 * the notice explains that the access request waits until the unit exists. Empty values are left out.
 */
export function identityCard(who: AccessIdentity): { rows: [string, string][]; notice: string | null } {
  const notConfigured = who.unitConfigured === false;
  const stated = notConfigured ? [who.statedUnitName, who.statedUnitId ? `رقم الوحدة ${who.statedUnitId}` : null].filter(Boolean).join(' — ') : '';
  const unit = who.unit ?? (notConfigured && stated ? `${stated} (غير مهيأة في النظام)` : null);
  const rows: [string, string | null][] = [
    ['الاسم', who.name],
    ['الرقم', who.employeeNo],
    ['الرتبة', who.rank],
    ['المنصب', who.position],
    ['الوحدة', unit],
    ['الوحدة الرئيسية', who.mainUnit],
    ['رقم المستخدم', who.userId],
    ['مصدر البيانات', who.source],
  ];
  if (notConfigured && who.unit && stated) rows.splice(5, 0, ['الوحدة في الدليل', `${stated} (غير مهيأة في النظام)`]);
  const notice = notConfigured && !who.unit ? `${UNIT_NOT_CONFIGURED}. يُقدَّم طلب الصلاحية بعد أن يهيئها مسؤول الصلاحيات.` : null;
  return { rows: rows.filter((r): r is [string, string] => !!r[1]), notice };
}
