// The owner's review scenarios (3 Nov 2026: 1–18, then 19–22 and 23–25 for the corrections). Each opens the same fictional world in a defined view as a defined
// simulated person; the interactive ones (switch, activation, cancellation, early return, atomic transition) are then
// performed on the page through the same guarded actions a user would click.
import { DAY, type Action } from './domain';
import { NOW } from './fixtures';

const HOUR = 3_600_000;
const startCancel: [string, Action] = ['p-req', { t: 'REQUEST_START_CANCEL', req: 'r-hr-rec', reason: 'تأجل مشروع التوظيف إلى إشعار آخر' }];

export type Sel = { k: 'org'; id: string } | { k: 'req'; id: string } | { k: 'site'; id: string } | { k: 'edit'; id: string } | { k: 'res'; id: string } | null;

/** `setup`: guarded actions applied on load, as [simulated person, action]. */
export type Scenario = { n: number; title: string; actor: string; sel: Sel; step?: number; showAreas?: boolean; expandTemps?: boolean; hint: string; setup?: [string, Action][] };

export const SCENARIOS: Scenario[] = [
  { n: 1, title: 'التمركز الحالي العادي', actor: 'p-req', sel: { k: 'org', id: 'o-ss' }, hint: 'الجهة المختارة: تمركزها الدائم ومقرها الرئيسي فقط.' },
  { n: 2, title: 'التمركز الحالي ومنطقتاه المرتبطتان', actor: 'p-req', sel: { k: 'org', id: 'o-ss' }, showAreas: true, hint: 'كشف المنطقتين بزر، مع مصدر اعتماد كل منهما.' },
  { n: 3, title: 'إعادة تمركز دائمة — الجهة كاملة', actor: 'p-req', sel: { k: 'edit', id: 'r-pm-bld' }, step: 5, hint: 'الحالي ← الرئيسي المقترح ← البديل المقترح، بقيم ملف السياسة.' },
  { n: 4, title: 'إعادة تمركز مؤقتة — الجهة كاملة', actor: 'p-req', sel: { k: 'edit', id: 'r-hr-trn' }, step: 5, hint: 'مؤقت ببداية ونهاية إلزاميتين.' },
  { n: 5, title: 'إعادة تمركز مؤقتة — جزء من الجهة', actor: 'p-req', sel: { k: 'edit', id: 'r-ss-mt-s' }, step: 1, hint: 'اختيار الوحدات المشمولة من الهيكل المسموح.' },
  { n: 6, title: 'مقارنة الحالي والرئيسي والبديل', actor: 'p-rev', sel: { k: 'req', id: 'r-ga' }, hint: 'لوحة مقارنة واحدة، والمسافة الثانية من الرئيسي لا من الحالي.' },
  { n: 7, title: 'الرئيسي لم يُقبل ← مراجعة البديل', actor: 'p-dec', sel: { k: 'req', id: 'r-ss-gen' }, hint: 'تبديل صريح بصلاحية مستقلة؛ الاستئناف من مرحلة الموقع، وما لا يعتمد على الموقع يُحمل.' },
  { n: 8, title: 'معتمد — لم يُفعَّل', actor: 'p-apr', sel: { k: 'req', id: 'r-ga-fin' }, hint: 'صاحب الاعتماد يملك صلاحية التفعيل لكن فصل المهام يمنعه؛ مسؤول التفعيل المستقل يستطيع.' },
  { n: 9, title: 'مؤقت مُفعَّل لم يبدأ', actor: 'p-req', sel: { k: 'req', id: 'r-hr-rec' }, hint: 'التمركز الفعلي ما زال الدائم حتى بلوغ البداية.' },
  { n: 10, title: 'مؤقت ساري', actor: 'p-req', sel: { k: 'org', id: 'o-it' }, hint: 'التمركز الدائم والتمركز الفعلي المؤقت معاً، دون فقد الدائم.' },
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
  { n: 20, title: 'منطقة الأم + حجز وحدة مشمولة صراحةً', actor: 'p-req', sel: { k: 'res', id: 'rs-covered' }, hint: 'الوحدة ضمن النطاق المغطى للمنطقة: لا تعارض ذاتي، والفحوص الأخرى مستمرة.' },
  { n: 21, title: 'المنطقة نفسها + وحدة غير مشمولة', actor: 'p-req', sel: { k: 'res', id: 'rs-uncovered' }, hint: 'وحدة تابعة غير مدرجة صراحةً في النطاق: تعارض عادي ومنع.' },
  { n: 22, title: 'تعارض فعلي مع جهة أخرى ومسار الاستثناء', actor: 'p-other', sel: { k: 'res', id: 'rs-outside' }, hint: 'تداخل في المكان والزمن ← منع ← طلب استثناء بمرجع سياسة ← اعتماد مستقل ← حدث تدقيق.' },
  // owner correction of 3 Nov 2026: a start cancellation still pending at the planned start holds the start
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
  {
    n: 25,
    title: 'رفض الإلغاء قبل البداية',
    actor: 'p-dec',
    sel: { k: 'req', id: 'r-hr-rec' },
    hint: 'يعود «مُفعَّل — لم يبدأ» وينفذ عند بدايته المعتمدة الأصلية.',
    setup: [startCancel],
  },
];
