# MOVER — المصادر والملاحظات الفنية

تمت مراجعة المصادر الرسمية التالية في 28 أكتوبر 2026. المعمارية وترتيب التنفيذ توصيات لهذه الحزمة، ولا تعني أن المصدر يضمن توافق المكونات أو تحمل حجم المؤسسة تلقائياً.

| المصدر | ما يدعمه في التصور |
|---|---|
| [Leaflet API](https://leafletjs.com/reference.html) | الخرائط التفاعلية والطبقات والعلامات والأشكال؛ مستخدم في نموذج HTML |
| [OpenFreeMap Quick Start](https://openfreemap.org/quick_start/) | مصادر خرائط مفتوحة وخيارات العميل والاستضافة الذاتية والتنزيل المحدود دون اتصال |
| [OpenFreeMap](https://openfreemap.org/) | مصدر البيانات والاستضافة العامة؛ المصدر العام لا يقدم SLA مؤسسياً معلناً |
| [OpenFGA — Parent-Child](https://openfga.dev/docs/modeling/parent-child) | نمذجة الوصول المبني على العلاقات بين الأصل والفرع |
| [OpenFGA — Docker](https://openfga.dev/docs/getting-started/setup-openfga/docker) | تشغيل خدمة التفويض محلياً داخل حاويات |
| [Flowable — Getting Started](https://www.flowable.com/open-source/docs/bpmn/ch02-GettingStarted/) | محرك BPMN مكتوب بـJava، وإمكان تضمينه أو استخدام REST |
| [Flowable — BPMN Constructs](https://www.flowable.com/open-source/docs/bpmn/ch07b-BPMN-Constructs/) | مهام المستخدمين والتوازي والشروط ومكونات الإجراءات |
| [Flowable Open Source](https://www.flowable.com/open-source-code) | المحركات المفتوحة وترخيص Apache 2 للمصدر المشار إليه |
| [PostgreSQL — Range Types](https://www.postgresql.org/docs/current/rangetypes.html) | الفترات الزمنية وقيود استبعاد التداخل للمورد نفسه |
| [PostGIS Data Management](https://postgis.net/docs/using_postgis_dbmanagement.html) | أنواع البيانات المكانية والمراجع والفهارس |
| [Keycloak — Containers](https://www.keycloak.org/server/containers) | صورة الحاوية وتهيئة التشغيل للهوية المحلية |
| [React Quick Start](https://react.dev/learn) | نموذج بناء الواجهة بالمكونات والحالة |
| [Vite Guide](https://vite.dev/guide/) | بناء حزم واجهة ثابتة؛ ليس مزود استضافة مطلوباً |
| [bpmn.io License](https://bpmn.io/license/) | شروط استخدام المحرر ووجوب إبقاء العلامة المطلوبة ظاهرة |
| [Docker Bridge Networks](https://docs.docker.com/engine/network/drivers/bridge/) | نطاق شبكات الحاويات والاتصال الخارجي الافتراضي ونشر المنافذ |
| [GeoNode](https://geonode.org/) | مرجع لمفهوم إدارة ونشر طبقات الخرائط ومشاركتها، وليس نظام طلبات جاهزاً |

## الملفات المضمّنة

- Leaflet 1.9.4 وملف ترخيصه، والخط Noto Sans Arabic مع OFL.
- خلفية إقليمية توضيحية مشتقة من بيانات OpenFreeMap / OpenMapTiles / OpenStreetMap، مع ملف مصدر GeoJSON وبيانات مصدره، وترخيص بيانات OpenStreetMap المرجعي.
- مصادر البيانات والتواريخ والتحويلات مذكورة في ملفات الخلفية. هذه ليست خريطة ملاحة ولا بيانات حدود معتمدة للمؤسسة.

## عند اختيار إصدارات الإنتاج

تحقق من تراخيص الإصدارات المثبتة فعلياً، ومتطلبات نسب المصدر، والتوافق بين JDK وSpring Boot وFlowable، ومخططات قواعد البيانات. لا تنقل ملفات إعداد تجريبية تتضمن كلمات مرور أو شهادات اختبار إلى إنتاج.

المكتبات توفر لبنات بناء. واجهات التهيئة، وقواعد الأعمال، واختبارات التفويض والتزامن والاستعادة تبقى مسؤولية المشروع.
