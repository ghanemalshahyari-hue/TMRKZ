// The owner's review scenarios (3 Nov 2026). 1–25 as approved, with 6 and 7 rewritten for ONE proposed site; 26–40 are the
// owner's fifteen coverage items of the correction of 3 Nov 2026 in their order, and 41 the later registration of
// deployment areas. Each opens the same fictional world in a defined view as a defined simulated person; the interactive
// ones are then performed on the page through the same guarded actions a user would click.
import { DAY, type Action, type World } from './domain';
import { NOW } from './fixtures';

const HOUR = 3_600_000;
const startCancel: [string, Action] = ['p-req', { t: 'REQUEST_START_CANCEL', req: 'r-hr-rec', reason: 'تأجل مشروع التوظيف إلى إشعار آخر' }];
const required: [string, Action] = ['p-sys', { t: 'SET_POLICY', key: 'stationing_areas_requirement', value: 'REQUIRED', effectiveFrom: NOW, reason: 'منطقتا الانتشار شرط لإرسال طلبات إعادة التمركز' }];
const activateFin: [string, Action] = ['p-act', { t: 'ACTIVATE', req: 'r-ga-fin', reason: 'تفعيل بعد جاهزية الموقع الجديد' }];

export type Sel =
  | { k: 'org'; id: string }
  | { k: 'req'; id: string }
  | { k: 'site'; id: string }
  | { k: 'edit'; id: string }
  | { k: 'res'; id: string }
  | { k: 'policy' }
  /** The later registration of the deployment areas of the stationing `id`. */
  | { k: 'areas'; id: string }
  | null;

/**
 * `setup`: guarded actions applied on load, as [simulated person, action]. `draft`: an edit of a draft as its requester
 * makes it in the editor (drafts have no guarded action; the server validates them at submission).
 */
export type Scenario = { n: number; title: string; actor: string; sel: Sel; step?: number; showAreas?: boolean; expandTemps?: boolean; hint: string; setup?: [string, Action][]; draft?: (w: World) => void };

export const SCENARIOS: Scenario[] = [
  { n: 1, title: 'التمركز الحالي العادي', actor: 'p-req', sel: { k: 'org', id: 'o-ss' }, hint: 'الجهة المختارة: تمركزها الدائم ومقرها الرئيسي فقط.' },
  { n: 2, title: 'التمركز الحالي ومنطقتا الانتشار', actor: 'p-req', sel: { k: 'org', id: 'o-ss' }, showAreas: true, hint: 'كشف منطقتي الانتشار بزر، مع مصدر اعتماد كل منهما.' },
  { n: 3, title: 'إعادة تمركز دائمة — الجهة كاملة', actor: 'p-req', sel: { k: 'edit', id: 'r-pm-bld' }, step: 4, hint: 'موقع مقترح واحد؛ المسافة من الحالي للمعلومة فقط، والسياسة اختيارية.' },
  { n: 4, title: 'إعادة تمركز مؤقتة — الجهة كاملة', actor: 'p-req', sel: { k: 'edit', id: 'r-hr-trn' }, step: 4, hint: 'مؤقت ببداية ونهاية إلزاميتين.' },
  { n: 5, title: 'إعادة تمركز مؤقتة — جزء من الجهة', actor: 'p-req', sel: { k: 'edit', id: 'r-ss-mt-s' }, step: 1, hint: 'اختيار الوحدات المشمولة من الهيكل المسموح.' },
  { n: 6, title: 'التمركز الحالي والموقع المقترح ومنطقتا الانتشار', actor: 'p-rev', sel: { k: 'req', id: 'r-ga' }, hint: 'لوحة مقارنة لموقع مقترح واحد؛ المسافة من الحالي للمعلومة، والقيم المهيأة لمنطقتي الانتشار.' },
  {
    n: 7,
    title: 'إرجاع ثم إعادة إرسال بموقع معدّل',
    actor: 'p-req',
    sel: { k: 'edit', id: 'r-ss-gen' },
    step: 3,
    hint: 'أُرجع عند القرار النهائي؛ تعديل الموقع ثم إعادة الإرسال تُبطل قرارات الموقع وتحمل مراجعة النطاق (D18).',
    setup: [['p-apr', { t: 'RETURN', req: 'r-ss-gen', reason: 'يلزم موقع لا يتعارض مع أعمال الصيانة المقررة' }]],
  },
  { n: 8, title: 'معتمد — لم يُفعَّل', actor: 'p-apr', sel: { k: 'req', id: 'r-ga-fin' }, hint: 'صاحب الاعتماد يملك صلاحية التفعيل لكن فصل المهام يمنعه؛ مسؤول التفعيل المستقل يستطيع.' },
  { n: 9, title: 'مؤقت مُفعَّل لم يبدأ', actor: 'p-req', sel: { k: 'req', id: 'r-hr-rec' }, hint: 'التمركز الفعلي ما زال الأصلي حتى بلوغ البداية.' },
  { n: 10, title: 'مؤقت ساري', actor: 'p-req', sel: { k: 'org', id: 'o-it' }, hint: 'التمركز الأصلي والتمركز الفعلي المؤقت معاً، دون فقد الأصلي.' },
  { n: 11, title: 'تمديد معتمد — لم يُفعَّل', actor: 'p-apr', sel: { k: 'req', id: 'r-it-temp' }, hint: 'النهاية الفعالة لم تتغير؛ من اعتمد التمديد لا يفعّله.' },
  { n: 12, title: 'طلب عودة مبكرة وقرارها', actor: 'p-req-dir', sel: { k: 'req', id: 'r-ga-adm' }, hint: 'الطالب (بأي حساب) لا يقرر؛ صاحب DECIDE_EARLY_RETURN يقرر.' },
  { n: 13, title: 'دائم معتمد أثناء مؤقت ساري', actor: 'p-act', sel: { k: 'req', id: 'r-it-perm' }, hint: 'الاعتماد عرض المؤقت الذي سينتهي بالتفعيل.' },
  { n: 14, title: 'انتقال ذري من المؤقت إلى الدائم', actor: 'p-act', sel: { k: 'req', id: 'r-it-perm' }, hint: 'عملية واحدة: إنهاء المؤقت وتفعيل الدائم؛ التمديد يسقط، والتاريخ باقٍ.' },
  { n: 15, title: 'طلب إلغاء معلق يمنع التفعيل', actor: 'p-req', sel: { k: 'req', id: 'r-ga-fin' }, hint: 'الحالة «طلب إلغاء قيد القرار»، والتفعيل ممنوع في الانتقال نفسه.' },
  {
    n: 16,
    title: 'رفض الإلغاء يعيد إتاحة التفعيل',
    actor: 'p-dec',
    sel: { k: 'req', id: 'r-ga-fin' },
    hint: 'قرار مستقل؛ يعود الطلب «معتمد — لم يُفعَّل».',
    setup: [['p-req', { t: 'REQUEST_CANCEL', req: 'r-ga-fin', reason: 'تغيرت حاجة القسم إلى النقل' }]],
  },
  { n: 17, title: 'جهة أخرى تريد المقر الدائم أثناء الغياب', actor: 'p-other', sel: { k: 'site', id: 'site-E-04' }, hint: 'الغياب لا يتيح الموقع؛ الاستعمال طلب استخدام مرفق مستقل.' },
  { n: 18, title: 'جهة أم بعض وحداتها في تمركز مؤقت', actor: 'p-req', sel: { k: 'org', id: 'o-ss' }, expandTemps: false, hint: 'شارة واحدة للوحدات المؤقتة؛ تُكشف مواقعها عند الطلب.' },
  { n: 19, title: 'إلغاء تمركز مؤقت مُفعَّل قبل بدء نفاذه', actor: 'p-req', sel: { k: 'req', id: 'r-hr-rec' }, hint: 'إجراء مستقل عن العودة المبكرة؛ لا يصبح المؤقت نافذاً أبداً، ومهمة البدء لا تفعّله.' },
  { n: 20, title: 'منطقة انتشار + حجز وحدة مشمولة صراحةً', actor: 'p-req', sel: { k: 'res', id: 'rs-covered' }, hint: 'الوحدة ضمن النطاق المغطى للمنطقة: لا تعارض ذاتي، والفحوص الأخرى مستمرة.' },
  { n: 21, title: 'المنطقة نفسها + وحدة غير مشمولة', actor: 'p-req', sel: { k: 'res', id: 'rs-uncovered' }, hint: 'وحدة تابعة غير مدرجة صراحةً في النطاق: تعارض عادي ومنع.' },
  { n: 22, title: 'تعارض فعلي مع جهة أخرى ومسار الاستثناء', actor: 'p-other', sel: { k: 'res', id: 'rs-outside' }, hint: 'تداخل في المكان والزمن ← منع ← طلب استثناء بمرجع سياسة ← اعتماد مستقل ← حدث تدقيق.' },
  {
    n: 23,
    title: 'البدء موقوف ← رفض الإلغاء بعد البداية',
    actor: 'p-dec',
    sel: { k: 'req', id: 'r-hr-rec' },
    hint: 'بلغ البداية وطلب الإلغاء معلق فلم يبدأ النفاذ؛ رفضه الآن يبدأ النفاذ من وقت القرار دون أثر رجعي، والنهاية باقية.',
    setup: [startCancel, ['system', { t: 'TICK', to: NOW + 7 * DAY + 3 * HOUR }]],
  },
  {
    n: 24,
    title: 'البدء موقوف حتى انقضاء النافذة',
    actor: 'p-dec',
    sel: { k: 'req', id: 'r-hr-rec' },
    hint: 'لم يُقرر الإلغاء حتى تجاوزت النهاية: لا يبدأ أبداً، يُغلق «انقضت النافذة دون بدء»، وطلب الإلغاء لم يعد قابلاً للقرار؛ السجلان باقيان.',
    setup: [startCancel, ['system', { t: 'TICK', to: NOW + 64 * DAY }]],
  },
  { n: 25, title: 'رفض الإلغاء قبل البداية', actor: 'p-dec', sel: { k: 'req', id: 'r-hr-rec' }, hint: 'يعود «مُفعَّل — لم يبدأ» وينفذ عند بدايته المعتمدة الأصلية.', setup: [startCancel] },
  // owner correction of 3 Nov 2026 — the fifteen coverage items, in order
  { n: 26, title: 'جهة فرعية تطلب إعادة تمركز دائمة', actor: 'p-req-sv', sel: { k: 'edit', id: 'r-pm-sv-n' }, step: 4, hint: 'المسار مشتق من الهيكل فوق الجهة: ثلاثة مستويات، ثم المراجعات المهيأة، ثم القرار النهائي، والجهات المشاركة ظاهرة.' },
  { n: 27, title: 'جهة فرعية تطلب إعادة تمركز مؤقتة', actor: 'p-req-mt', sel: { k: 'edit', id: 'r-mt-s-t' }, step: 4, hint: 'للمؤقت يُعتمد نهائياً على مستوى الإدارة العليا للجهة؛ قبله الجهة الأم.' },
  { n: 28, title: 'إلزامية: الموقع ومنطقتا الانتشار', actor: 'p-req', sel: { k: 'edit', id: 'r-hr-trn' }, step: 3, hint: 'الموقع المقترح ← منطقة الانتشار الرئيسية ← منطقة الانتشار البديلة، بأقصر مسافة بين الشكلين.', setup: [required] },
  { n: 29, title: 'اختيارية: الموقع وحده', actor: 'p-req', sel: { k: 'edit', id: 'r-pm-bld' }, step: 4, hint: 'يُرسل دون منطقتي انتشار؛ تُسجَّلان لاحقاً إن لزم.' },
  { n: 30, title: 'اختيارية: الموقع مع حزمة انتشار كاملة', actor: 'p-req', sel: { k: 'edit', id: 'r-hr-trn' }, step: 4, hint: 'اختار مقدم الطلب إدراج المنطقتين: تُفحصان بالملف كاملتين.' },
  {
    n: 31,
    title: 'اختيارية: منطقة الانتشار الرئيسية وحدها ← ممنوع',
    actor: 'p-req',
    sel: { k: 'edit', id: 'r-hr-trn' },
    step: 4,
    hint: 'حزمة واحدة: لا تُقبل إحدى المنطقتين وحدها حتى مع السياسة الاختيارية.',
    draft: (w) => void delete w.requests.find((r) => r.id === 'r-hr-trn')!.proposal.areas!.ALTERNATIVE_AREA,
  },
  { n: 32, title: 'مسؤول النظام يغيّر الإلزامية والاختيارية', actor: 'p-sys', sel: { k: 'policy' }, hint: 'إصدار جديد بسبب وتاريخ سريان؛ يُسجَّل السابق والجديد، والطلبات المرسلة على إصدارها.' },
  {
    n: 33,
    title: 'إصدار السياسة يبقى مثبتاً بعد الإرسال',
    actor: 'p-req',
    sel: { k: 'req', id: 'r-hr-trn' },
    hint: 'أُرسل والسياسة إلزامية (الإصدار 2) ثم صارت اختيارية (الإصدار 3): يبقى الطلب على الإصدار 2.',
    setup: [required, ['p-req', { t: 'SUBMIT', req: 'r-hr-trn' }], ['p-sys', { t: 'SET_POLICY', key: 'stationing_areas_requirement', value: 'OPTIONAL', effectiveFrom: NOW, reason: 'تخفيف الشرط بعد مراجعة إدارية' }]],
  },
  {
    n: 34,
    title: 'مساحة الموقع المقترح تتجاوز حد مسؤول النظام',
    actor: 'p-req',
    sel: { k: 'edit', id: 'r-pm-bld' },
    step: 3,
    hint: 'المساحة والحد والإصدار ظاهرة، والإرسال ممنوع؛ لا تصغير تلقائي.',
    setup: [['p-sys', { t: 'SET_POLICY', key: 'max_restationing_footprint_area', value: 15000, effectiveFrom: NOW, reason: 'حد مساحة أصغر لمواقع إعادة التمركز' }]],
  },
  { n: 35, title: 'اعتماد هرمي بمعتمد وسيط واحد', actor: 'p-h-pm', sel: { k: 'req', id: 'r-pm-bld' }, hint: 'قسم مشاريع المباني ← إدارة المشاريع ← المراجعات ← القرار النهائي.', setup: [['p-req', { t: 'SUBMIT', req: 'r-pm-bld' }]] },
  { n: 36, title: 'اعتماد هرمي بعدة معتمدين مهيئين', actor: 'p-h-sv', sel: { k: 'req', id: 'r-pm-sv-n' }, hint: 'ثلاثة مستويات في الهيكل بالترتيب، كل منها لمعتمد جهته فقط، وتغيير مسار مخوّل ومُدقَّق.', setup: [['p-req-sv', { t: 'SUBMIT', req: 'r-pm-sv-n' }]] },
  { n: 37, title: 'انتهاء المؤقت ← عودة تلقائية إلى التمركز الأصلي', actor: 'p-req', sel: { k: 'org', id: 'o-it' }, hint: 'انتقال نظام عند النهاية؛ منطقتا انتشار المؤقت تنتهيان معه ولا تصيران للأصلي.', setup: [['system', { t: 'TICK', to: NOW + 13 * DAY }]] },
  {
    n: 38,
    title: 'تمديد المؤقت',
    actor: 'p-req',
    sel: { k: 'req', id: 'r-it-temp' },
    hint: 'تمديد معتمد ومُفعَّل: تبدأ فترته عند النهاية الأصلية، ومنطقتا انتشار المؤقت تمتدان معه.',
    setup: [['p-act', { t: 'ACTIVATE_EXTENSION', ext: 'ext-it', reason: 'استمرار أعمال التجهيز' }], ['system', { t: 'TICK', to: NOW + 13 * DAY }]],
  },
  { n: 39, title: 'تفعيل دائم ← الموقع الجديد هو التمركز الحالي', actor: 'p-req', sel: { k: 'org', id: 'o-ga-fin' }, hint: 'الموقع الجديد تمركز حالي، والسابق في التاريخ، ولا عودة تلقائية.', setup: [activateFin] },
  { n: 40, title: 'نقل دائم لاحق يحتاج طلباً جديداً', actor: 'p-req', sel: { k: 'req', id: 'r-ga-fin' }, hint: 'انتهى أثر الطلب المفعَّل؛ النقل التالي طلب جديد يبدأ من التمركز الحالي الجديد.', setup: [activateFin] },
  { n: 41, title: 'تسجيل منطقتي الانتشار لاحقاً', actor: 'p-stn', sel: { k: 'org', id: 'o-ga-fin' }, hint: 'فُعّل دون منطقتي انتشار فلم يُنشأ سجل فارغ؛ مسؤول سجلات التمركز يسجلهما بقرار خارجي.', setup: [activateFin] },
];
