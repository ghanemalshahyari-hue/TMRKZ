import type { RestationingState } from '../../api/types';

/** Request states of Model V3 §3 with the owner's wording and the workspace's status colours (§20). */
export const RS_STATE: Record<RestationingState, [string, string]> = {
  DRAFT: ['مسودة', ''],
  UNDER_REVIEW: ['قيد الاعتماد', 'orange'],
  RETURNED_FOR_CHANGES: ['معاد للتعديل', 'orange'],
  PAUSED_HIERARCHY_CHANGED: ['موقوف — تغيّر الهيكل', 'red'],
  REJECTED: ['مرفوض', 'red'],
  APPROVED_NOT_ACTIVATED: ['معتمد — بانتظار التفعيل', 'blue'],
  CANCELLATION_PENDING: ['بانتظار قرار الإلغاء', 'orange'],
  CANCELLED_BEFORE_ACTIVATION: ['أُلغي قبل التفعيل', ''],
  ACTIVATED_PERMANENT: ['مفعّل — دائم', 'green'],
  TEMPORARY_SCHEDULED: ['مؤقت مجدول', 'blue'],
  START_HELD_PENDING_CANCELLATION: ['البدء موقوف — بانتظار قرار الإلغاء', 'orange'],
  ACTIVE_TEMPORARY: ['مؤقت نافذ', 'green'],
  TEMPORARY_RETURNED: ['انتهى المؤقت — عادت الوحدات', ''],
  TEMPORARY_CANCELLED_BEFORE_START: ['أُلغي قبل البدء', ''],
  TEMPORARY_WINDOW_EXPIRED_WITHOUT_START: ['انقضت النافذة دون بدء', ''],
  EXTENSION_ACTIVATED: ['تمديد مفعّل', 'green'],
  LAPSED_NOT_ACTIVATED: ['سقط دون تفعيل', ''],
};

export function StatePill({ state }: { state: RestationingState }) {
  const [label, tone] = RS_STATE[state] ?? [state, ''];
  return (
    <span className={'pill ' + tone}>
      <i className="dot" />
      {label}
    </span>
  );
}
