import { Heading, Icon } from '../components/ui';

/** Documents served by nginx from the repository `docs/` folder (offline, inside the image). */
const DOCS: [string, string, string][] = [
  ['STATUS.md', 'حالة التسليم والقيود', 'المنفذ، والقيود المعروفة، والتكاملات غير المربوطة، والقرارات المفتوحة.'],
  ['TRACEABILITY.md', 'تتبع المتطلبات والاختبارات', 'كل متطلب R واختبار AT: موضع التنفيذ والاختبار والحالة.'],
  ['ARCHITECTURE_DECISIONS.md', 'قرارات المعمارية', 'الإصدارات المثبتة وأسباب أي اختلاف عن المعمارية المقترحة.'],
  ['INSTALL_AIRGAPPED.md', 'التركيب المعزول', 'بناء حزمة التركيب ونقلها وتشغيلها والتحقق من عزل الشبكة.'],
  ['OPERATIONS.md', 'دليل التشغيل', 'النسخ والاستعادة والترقية والعودة والمراقبة وتدوير المفاتيح.'],
  ['PERFORMANCE.md', 'قياس الأداء الاستكشافي', 'قياسات معلنة على 7,000 جهة و200,000 شخص؛ ليست قبولاً للسعة.'],
  ['LICENSES.md', 'سجل المكونات والتراخيص', 'المكونات المثبتة وإصداراتها وتراخيصها.'],
  ['api/API_V1.md', 'عقد الواجهات المنفذ', 'مسارات الخادم والأخطاء والتزامن والصلاحيات كما نُفذت.'],
  ['api/openapi.json', 'وصف OpenAPI', 'مولد من الكود مباشرة؛ المسارات والمعاملات والأخطاء.'],
  ['handoff/START_HERE.md', 'ابدأ من هنا', 'ترتيب قراءة ملفات حزمة التسليم الأصلية.'],
  ['handoff/REQUIREMENTS.md', 'المتطلبات الوظيفية', 'متطلبات مرقمة وشاشات وقواعد أعمال.'],
  ['handoff/ARCHITECTURE.md', 'المعمارية والنشر', 'المكونات والبيئة المعزولة وحدود المسؤوليات.'],
  ['handoff/DATA_MODEL.md', 'نموذج البيانات', 'الموقع والحجز والطلب والقرار والإصدارات.'],
  ['handoff/API_CONTRACT.md', 'عقد الواجهات المبدئي', 'السلوك المطلوب من الخادم قبل التنفيذ.'],
  ['handoff/ACCEPTANCE_TESTS.md', 'اختبارات القبول', 'رحلات التحقق والحجز المتعارض والتفويض والإصدارات.'],
  ['handoff/DECISIONS.md', 'القرارات والافتراضات', 'ما اعتمده المستخدم وما يزال بحاجة إلى تحديد.'],
  ['handoff/SOURCES.md', 'المراجع والتراخيص', 'مصادر رسمية وملاحظات مكتبات الطرف الثالث.'],
];

export function DocsPage() {
  return (
    <>
      <Heading en="DOCUMENTATION / OPERATIONS" title="التوثيق والتشغيل" description="الوثائق محفوظة محلياً داخل البيئة المعزولة، دون اعتماد على خدمات خارجية." />
      <section className="handoff-hero">
        <div>
          <span className="eyebrow">MOVER / ADMINISTRATIVE FACILITIES</span>
          <h2>نظام مؤسسي، بتوثيق قابل للتحقق.</h2>
          <p>
            يخص النظام إدارة المرافق والحجوزات والموافقات الإدارية. تجد هنا عقد الواجهات المنفذ، وحزمة المتطلبات الأصلية، وأدلة التركيب المعزول والنسخ
            والاستعادة والترقية، وبيان القيود والقرارات المفتوحة.
          </p>
        </div>
        <aside>
          <a className="button primary full" href="/docs/">
            <Icon name="download" />
            تصفح جميع الوثائق
          </a>
          <a className="button ghost full" style={{ marginTop: 10 }} href="/docs/handoff/prototype.html">
            النموذج الأولي المعتمد
          </a>
        </aside>
      </section>
      <div className="handoff-files">
        {DOCS.map(([path, title, desc]) => (
          <article className="card file-card" key={path}>
            <span className="file-icon">
              <Icon name="file" />
            </span>
            <h3>{title}</h3>
            <p>{desc}</p>
            <a href={'/docs/' + path}>
              <span className="latin">{path.split('/').pop()}</span> ↓
            </a>
          </article>
        ))}
      </div>
      <div className="roadmap">
        {[
          ['01', 'الأساس', 'المشروع والهوية والهيكل وقواعد البيانات.'],
          ['02', 'رحلة مكتملة', 'طلب ومراجعة واعتماد وحجز ومنع تعارض ذري.'],
          ['03', 'التهيئة والتوسع', 'النماذج والتدفقات والصلاحيات والتفويض.'],
          ['04', 'الجاهزية للتشغيل', 'العزل والنسخ والاستعادة والأداء والتوثيق.'],
        ].map(([n, t, d]) => (
          <article className="card" key={n}>
            <b>{n}</b>
            <h3>{t}</h3>
            <p>{d}</p>
          </article>
        ))}
      </div>
      <div className="note orange">
        قرارات ما تزال مفتوحة: نوع التوقيع (D-02)، ومصدر الدخول المؤسسي (D-04)، ونظام الإحداثيات الفني (D-01)، وعدد المستخدمين المتزامنين (D-03)، وأهداف الاستعادة (D-05).
        لا تُخترع هذه القرارات داخل النظام.
      </div>
    </>
  );
}
