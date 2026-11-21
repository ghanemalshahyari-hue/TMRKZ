/**
 * The requests of one engine (ADR-045), and how the person reads them. The server decides who may ask and when. Initial
 * stationing is no longer asked for (ADR-078): it is set up with its site in «تهيئة المواقع»; a request of that purpose made
 * before is still read.
 */
export type Purpose = 'RESTATIONING' | 'INITIAL_STATIONING' | 'DEPLOYMENT_AREAS' | 'SITE_REGISTRATION';

/** The purposes a new request may have (ADR-078): «طلب إعادة التمركز ومناطق الانتشار» opens the first two. */
export const CREATABLE_PURPOSES: Purpose[] = ['SITE_REGISTRATION', 'DEPLOYMENT_AREAS', 'RESTATIONING'];

export const PURPOSE_TITLE: Record<Purpose, string> = {
  RESTATIONING: 'طلب إعادة تمركز',
  // Owner UX consolidation §9 (20 Nov 2026): legacy records never read «إعادة تمركز» inside the editor.
  INITIAL_STATIONING: 'طلب اعتماد موقع قديم',
  DEPLOYMENT_AREAS: 'طلب منطقة انتشار',
  SITE_REGISTRATION: 'طلب اعتماد موقع قديم',
};

export const PURPOSE_HINT: Record<Purpose, string> = {
  RESTATIONING: 'ينطلق من الموقع الحالي للوحدة إلى موقع جديد على الخريطة.',
  INITIAL_STATIONING: 'لم يعد يُطلب: يُسجَّل التمركز الأولي مع موقعه في «تهيئة المواقع».',
  DEPLOYMENT_AREAS: 'لوحدة متمركزة بلا منطقتي انتشار: الرئيسية والفرعية.',
  SITE_REGISTRATION: 'لتسجيل موقع جديد مرة واحدة بعد الاعتماد والتفعيل.',
};

export const isPurpose = (v: string | null | undefined): v is Purpose => !!v && v in PURPOSE_TITLE;

/** Whether a new request may be started with this purpose (an address naming initial stationing opens nothing, ADR-078). */
export const isCreatablePurpose = (v: string | null | undefined): v is Purpose => isPurpose(v) && CREATABLE_PURPOSES.includes(v);

export const newRequestHashFor = (purpose: Purpose, unit?: string | null, site?: string | null) =>
  '#restationing/new?purpose=' + purpose + (unit ? '&unit=' + encodeURIComponent(unit) : '') + (site ? '&site=' + encodeURIComponent(site) : '');

/** Where a unit stationed nowhere gets its first stationing (ADR-078): with its site, in «تهيئة المواقع», never by a request. */
export const INITIAL_IN_SETUP = 'يُسجَّل تمركزها الأولي مع موقعها في «تهيئة المواقع».';

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
