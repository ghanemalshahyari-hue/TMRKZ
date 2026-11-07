import type {
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
  RETURNED: ['معاد للتصحيح', 'orange'],
  APPROVED: ['معتمد — بانتظار الإنجاز الإداري', 'green'],
  REJECTED: ['مرفوض نهائياً', 'red'],
  CLOSED: ['مغلق', 'blue'],
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
  'CLOSE',
  'CORRECT_STATIONING',
  'MANAGE_SITE_LINKS',
  'REPLAY_STATIONING_EVENTS',
  'CREATE_RESTATIONING',
  'ACTIVATE_STATIONING',
  'APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION',
  'DECIDE_PRE_ACTIVATION_CANCELLATION',
  'ACTIVATE_TEMPORARY_EXTENSION',
  'DECIDE_EARLY_RETURN',
  'DECIDE_BEFORE_START_CANCELLATION',
  'CREATE_INITIAL_STATIONING',
  'CREATE_DEPLOYMENT_REQUEST',
  'REQUEST_SITE_REGISTRATION',
  'DECIDE_UNIT_OPERATIONS',
  'FINAL_APPROVE_STATIONING',
  'MANAGE_FYI_DISTRIBUTION',
  'VIEW_OPERATIONAL_POSTURE',
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
  CLOSE: 'الإنجاز الإداري والإغلاق',
  CORRECT_STATIONING: 'تصحيح التمركز',
  MANAGE_SITE_LINKS: 'إدارة روابط المواقع',
  REPLAY_STATIONING_EVENTS: 'إعادة إرسال أحداث التمركز',
  CREATE_RESTATIONING: 'طلب إعادة التمركز',
  CREATE_INITIAL_STATIONING: 'طلب تمركز أولي',
  CREATE_DEPLOYMENT_REQUEST: 'طلب منطقة انتشار',
  REQUEST_SITE_REGISTRATION: 'طلب اعتماد موقع',
  DECIDE_UNIT_OPERATIONS: 'اعتماد عمليات الوحدة',
  FINAL_APPROVE_STATIONING: 'الاعتماد النهائي للتمركز',
  MANAGE_FYI_DISTRIBUTION: 'تحديد وحدات العلم',
  VIEW_OPERATIONAL_POSTURE: 'متابعة الموقف العملياتي',
  ACTIVATE_STATIONING: 'تفعيل التمركز',
  APPROVE_DEPLOYMENT_DISTANCE_EXCEPTION: 'اعتماد استثناء مسافة الانتشار',
  DECIDE_PRE_ACTIVATION_CANCELLATION: 'قرار الإلغاء قبل التفعيل',
  ACTIVATE_TEMPORARY_EXTENSION: 'تفعيل تمديد التمركز المؤقت',
  DECIDE_EARLY_RETURN: 'قرار العودة المبكرة',
  DECIDE_BEFORE_START_CANCELLATION: 'قرار إلغاء المؤقت قبل بدء نفاذه',
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
  ACCESS: 'shield',
  NEW_RESERVATION: 'building',
  EXTENSION: 'clock',
  MODIFICATION: 'building',
  CANCELLATION: 'close',
  EVACUATION: 'building',
  RELOCATION: 'map',
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
