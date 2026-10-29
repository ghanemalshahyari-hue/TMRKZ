import type {
  Administrative,
  Availability,
  ChangePolicy,
  FieldKind,
  OrgFrom,
  Permission,
  ReasonCode,
  RequestKind,
  RequestStatus,
  Scope,
  TaskState,
} from '../api/types';

export const STATUS: Record<RequestStatus, [string, string]> = {
  DRAFT: ['مسودة', ''],
  SUBMITTED: ['قيد المراجعة', 'orange'],
  RETURNED: ['معاد للتعديل', 'orange'],
  APPROVED: ['معتمد', 'green'],
  REJECTED: ['مرفوض', 'red'],
  CLOSED: ['مغلق', 'blue'],
};

export const COLORS = { free: '#439b7e', pending: '#d4a04d', busy: '#c77770', none: '#9daea3' };

export const AVAILABILITY: Record<Availability, { label: string; color: string; pill: string }> = {
  FREE: { label: 'متاح', color: COLORS.free, pill: 'green' },
  PENDING: { label: 'طلب قيد المراجعة', color: COLORS.pending, pill: 'orange' },
  BUSY: { label: 'محجوز', color: COLORS.busy, pill: 'red' },
};

export const ADMINISTRATIVE: Record<Administrative, { label: string; color: string }> = {
  APPROVED: { label: 'حجز معتمد', color: COLORS.free },
  PENDING: { label: 'طلب قيد المراجعة', color: COLORS.pending },
  NONE: { label: 'دون طلب قائم', color: COLORS.none },
};

export const PERMISSIONS: Permission[] = [
  'VIEW',
  'VIEW_SUMMARY',
  'CREATE',
  'EDIT',
  'REVIEW',
  'APPROVE',
  'EXPORT',
  'EXECUTE',
  'MANAGE_FACILITIES',
  'MANAGE_ACCESS',
  'CONFIGURE',
  'AUDIT',
  'VIEW_SOURCE_IDENTIFIERS',
];
export const PERMISSION_NAMES: Record<Permission, string> = {
  VIEW: 'عرض',
  VIEW_SUMMARY: 'عرض مختصر',
  CREATE: 'إنشاء',
  EDIT: 'تعديل',
  REVIEW: 'مراجعة',
  APPROVE: 'اعتماد نهائي',
  EXPORT: 'تصدير',
  EXECUTE: 'تنفيذ واستلام',
  MANAGE_FACILITIES: 'إدارة المرافق',
  MANAGE_ACCESS: 'إدارة الصلاحيات',
  CONFIGURE: 'تهيئة',
  AUDIT: 'تدقيق',
  VIEW_SOURCE_IDENTIFIERS: 'معرفات المصدر',
};

export const SCOPES: [Scope, string][] = [
  ['ALL', 'جميع البيانات'],
  ['ORGANIZATION', 'حسب الجهة'],
  ['SITE', 'حسب الموقع'],
  ['ORGANIZATION_AND_SITE', 'الجهة والموقع'],
];

export const TASK_STATE: Record<TaskState, string> = {
  PENDING: '',
  OPEN: 'مفتوحة',
  APPROVED: 'موافقة',
  RETURNED: 'إرجاع',
  REJECTED: 'رفض',
  CLOSED_BY_POLICY: 'أغلقت وفق السياسة',
  CANCELLED: 'ملغاة',
};

export const KIND_ICON: Record<RequestKind, string> = {
  NEW_RESERVATION: 'building',
  EXTENSION: 'clock',
  MODIFICATION: 'building',
  CANCELLATION: 'close',
  EVACUATION: 'building',
};

export const REASON_CODES: [ReasonCode, string][] = [
  ['INCOMPLETE_DATA', 'بيانات غير مكتملة'],
  ['PERIOD_CONFLICT', 'تعارض في الفترة'],
  ['WRONG_FACILITY', 'المرفق غير مناسب'],
  ['MISSING_ATTACHMENT', 'مرفق ناقص'],
  ['OTHER', 'سبب آخر'],
];

export const CHANGE_POLICIES: [ChangePolicy, string][] = [
  ['DESCRIPTIVE', 'وصفي'],
  ['RESTART_STAGES', 'يعيد المراحل المتأثرة'],
  ['FULL_REAPPROVAL', 'يعيد الاعتماد كاملاً'],
];

export const ORG_FROM: [OrgFrom, string][] = [
  ['RESOURCE_ORG', 'جهة المرفق'],
  ['REQUEST_ORG', 'الجهة الطالبة'],
  ['ANY', 'أي جهة ضمن النطاق'],
];

export const FIELD_KINDS: [FieldKind, string][] = [
  ['text', 'نص'],
  ['textarea', 'نص طويل'],
  ['number', 'رقم'],
  ['date', 'تاريخ'],
  ['select', 'قائمة'],
  ['files', 'مرفقات'],
];

export const RESERVATION_STATUS: Record<string, [string, string]> = {
  ACTIVE: ['معتمد', 'green'],
  CANCELLED: ['ملغى', 'red'],
  RELEASED: ['مُخلى', 'blue'],
};

export const INTEGRATION_STATUS: Record<string, [string, string]> = {
  NOT_CONNECTED: ['غير مربوط', 'orange'],
  FILE_IMPORT: ['استيراد ملف', 'blue'],
  BUILT_IN: ['مدمج', 'green'],
  CONFIGURED: ['مهيأ — لم يُختبر بنجاح', 'orange'],
  CONNECTED: ['مربوط ومُزامَن', 'green'],
};

export const SIGNATURE_DISCLAIMER = 'توثيق داخلي — ليس توقيعاً رقمياً بشهادة';
