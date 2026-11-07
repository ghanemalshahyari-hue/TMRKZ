/** The four requests of one engine (ADR-045), and how the person reads them. The server decides who may ask and when. */
export type Purpose = 'RESTATIONING' | 'INITIAL_STATIONING' | 'DEPLOYMENT_AREAS' | 'SITE_REGISTRATION';

export const PURPOSE_TITLE: Record<Purpose, string> = {
  RESTATIONING: 'طلب إعادة تمركز',
  INITIAL_STATIONING: 'طلب تمركز أولي',
  DEPLOYMENT_AREAS: 'طلب منطقة انتشار',
  SITE_REGISTRATION: 'طلب اعتماد موقع',
};

export const PURPOSE_HINT: Record<Purpose, string> = {
  RESTATIONING: 'ينطلق من الموقع الحالي للوحدة إلى موقع جديد على الخريطة.',
  INITIAL_STATIONING: 'لوحدة ليس لها تمركز معتمد: تختار موقعاً مسجلاً.',
  DEPLOYMENT_AREAS: 'لوحدة متمركزة بلا منطقتي انتشار: الرئيسية والبديلة.',
  SITE_REGISTRATION: 'لتسجيل موقع جديد مرة واحدة بعد الاعتماد والتفعيل.',
};

export const isPurpose = (v: string | null | undefined): v is Purpose => !!v && v in PURPOSE_TITLE;

export const newRequestHashFor = (purpose: Purpose, unit?: string | null, site?: string | null) =>
  '#restationing/new?purpose=' + purpose + (unit ? '&unit=' + encodeURIComponent(unit) : '') + (site ? '&site=' + encodeURIComponent(site) : '');

/** Where a unit stands (the server's answer, never computed here). */
export const UNIT_STATE: Record<string, string> = {
  NO_STATIONING: 'بلا تمركز معتمد',
  DEPLOYMENT_MISSING: 'متمركزة بلا مناطق انتشار',
  DEPLOYMENT_REQUEST_PENDING: 'طلب منطقة انتشار جارٍ',
  DEPLOYMENT_COMPLETE: 'متمركزة ولها منطقتا انتشار',
  NOT_AUTHORISED: 'غير مخوّل',
};

/** What a request of these purposes writes on activation, in the request's summary. */
export const PURPOSE_WRITES: Record<Purpose, string> = {
  RESTATIONING: 'يسجل موقعاً جديداً وينقل الوحدات المحددة إليه.',
  INITIAL_STATIONING: 'يثبت تمركز الوحدات المحددة في الموقع المختار.',
  DEPLOYMENT_AREAS: 'يثبت منطقتي الانتشار لهذه الوحدة وحدها، ولا يغير تمركزها.',
  SITE_REGISTRATION: 'يسجل الموقع مرة واحدة ويربطه بالوحدة الطالبة؛ الربط ليس تمركزاً.',
};
