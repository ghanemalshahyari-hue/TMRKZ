# TMRKZ — MOVER: منصة إدارة المرافق والحجوزات والموافقات الإدارية

منصة مؤسسية عربية (RTL) لإدارة المواقع والمرافق، وطلبات الخدمات الإدارية، ومسارات المراجعة والاعتماد، والحجوزات
غير المتعارضة، مع سجل تدقيق إنتاجي، وتعمل بالكامل داخل بيئة معزولة باستخدام Docker. بُنيت وفق حزمة التسليم في
[`handoff/`](handoff/START_HERE.md) وواجهتها مطابقة للتصور المعتمد ([`dist/prototype.html`](dist/prototype.html)، ومصدره `unified/`).

> النطاق إداري للمرافق فقط. لا يتضمن تخطيط انتشار أو تمركز أو توصيات تكتيكية. جميع الجهات والأشخاص والمرافق
> والطلبات في بيانات العرض افتراضية، والخلفية الجغرافية نسخة توضيحية من بيانات OpenStreetMap المفتوحة.

## التشغيل السريع

```sh
sh ops/test-env/up.sh            # بيئة الاختبار: TMRKZ + Keycloak + دليل LDAP افتراضي + بيانات افتراضية
cat ops/test-env/.generated/user-password
# افتح http://localhost:8088 واختر «الدخول بالحساب المؤسسي»
```

لا يوجد في النظام وضع عرض ولا تبديل مستخدمين ولا دخول محلي بكلمة مرور: الدخول عبر Keycloak الذي يتحقق من كلمة المرور
في الدليل المؤسسي (LDAP)، ثم يُربط الحساب بسجل الموارد البشرية. حسابات بيئة الاختبار الافتراضية (كلمة مرور واحدة مولدة
محلياً) مدرجة في [`ops/test-env/README.md`](ops/test-env/README.md): ‎`t.requester`، ‎`t.facilities`، ‎`t.manager`،
‎`t.approver`، ‎`t.admin`، ‎`t.limited`، ‎`t.auditor`… وفي بيئة الإنتاج تُضبط بيانات الدليل في ‎`.env`
(انظر [`docs/OPERATIONS.md`](docs/OPERATIONS.md)).

رحلة مقترحة: من الخريطة اختر «مركز الخدمات» ← «طلب على هذا المرفق» ← أكمل الطلب وأرسله (يظهر برتقالياً دون حجز)
← `t.facilities` يوافق ← `t.manager` يرجع بسبب ← `t.requester` يعدل ويعيد التقديم ← `t.manager` يوافق ← `t.approver` يعتمد
مع التوثيق الداخلي ← يُثبت الحجز ذرياً ← مهام التسليم والاستلام ← إغلاق الملف مع بقاء الحجز والسجل.

## ما الذي بُني

| المجال | التنفيذ |
|---|---|
| الواجهة | React 19 + TypeScript + Vite، عربية RTL مطابقة للتصور، Leaflet وخط Noto Sans Arabic محلياً، دون أي طلب خارجي |
| الخادم | Spring Boot 4.0.9 (Java 25 LTS) كتطبيق وحدات واحد، JDBC + Flyway |
| الإجراءات | Flowable 8.0.0 مضمّن في معاملة قاعدة البيانات نفسها؛ الاستوديو ينتج BPMN من تعريف مضبوط الأنواع |
| البيانات | PostgreSQL 17 مع قيود استبعاد (`btree_gist`) تمنع تداخل الحجوزات الحصرية وقفل النطاق بين المورد الأب والفرعي |
| الهوية والصلاحيات | دخول محلي بجلسات خادم، عضويات وتفويضات مؤرخة تُقيَّم في كل طلب، نطاق جهة/موقع، عرض مختصر، فصل المهام |
| الاعتماد | توثيق داخلي بإعادة التحقق من الهوية وبصمة SHA-256 للمراجعة — **ليس توقيعاً رقمياً بشهادة** (D-02 مفتوح) |
| التشغيل | Docker Compose، نسخ احتياطي واستعادة مع تحقق آلي، حزمة تركيب معزولة، مقاييس Prometheus محلية |

## الاختبارات

| المجموعة | الأمر | النتيجة الحالية |
|---|---|---|
| اختبارات القبول في الخادم (PostgreSQL + PostGIS حقيقي + HTTP) | `ops/test-backend.sh` | 70/70 ناجحة — AT-01…AT-36 ومعايير الخريطة وقياس 10,000 موقع |
| رحلة القبول الكاملة عبر nginx | `node tests/acceptance/journey.mjs` | 40/40 فحصاً ناجحاً، بما فيها AT-29 (دون اعتماد خارجي) |
| رحلة الخريطة في المتصفح (MAP-01…MAP-18) | `sh ops/test-env/up-offline.sh && node tests/acceptance/map-workspace.mjs` | 21/21 فحصاً ناجحاً في Edge دون اتصال بالإنترنت — [`docs/evidence/map/`](docs/evidence/map/) |
| الاستعادة إلى بيئة نظيفة (AT-30) | `sh ops/verify-restore.sh` | ناجحة: 20 جدولاً متطابقاً والمرفقات مطابقة للبصمة |
| الواجهة (أنواع + وحدات) | `cd frontend && npm test && npm run build` | 17/17 ناجحة |
| قياس حمل استكشافي (D-03 مفتوح) | `ops/load/load-test.mjs` | انظر [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) |

## الوثائق

- [`docs/STATUS.md`](docs/STATUS.md) — المنفذ، القيود، التكاملات غير المربوطة، القرارات المفتوحة
- [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) — تتبع R-01…R-40 وAT-01…AT-36 إلى الكود والاختبارات
- [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md) — قرارات المعمارية وأسباب أي اختلاف عن المقترح
- [`docs/api/API_V1.md`](docs/api/API_V1.md) و[`docs/api/openapi.json`](docs/api/openapi.json) — عقد الواجهات
- [`docs/INSTALL_AIRGAPPED.md`](docs/INSTALL_AIRGAPPED.md) — التركيب المعزول
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — النسخ والاستعادة والترقية والعودة والمراقبة وتدوير المفاتيح
- [`docs/LICENSES.md`](docs/LICENSES.md) — سجل المكونات والتراخيص
- [`docs/FRONTEND.md`](docs/FRONTEND.md) — بنية الواجهة

---

## English summary

MOVER is an Arabic (RTL) enterprise platform for administrative facilities: permanent sites and reservable
resources, configurable request forms and approval workflows, conflict-free reservations, delegated and dated
authority, a production audit trail, and air-gapped Docker deployment. It implements the handoff package in
`handoff/` and reproduces the approved prototype (`dist/prototype.html`) exactly.

**Run (fictional test environment):** `sh ops/test-env/up.sh`, then open `http://localhost:8088` and sign in through Keycloak with a user from `ops/test-env/README.md`. Production: `sh ops/init-env.sh`, fill in the directory settings (`docs/OPERATIONS.md`), then `docker compose up -d --build`.

**Key guarantees (all covered by automated tests against real PostgreSQL):**
- A pending request never blocks a facility; the reservation is created only by the final approval, atomically with
  the decision, approval document, audit row and outbox event (Flowable shares the same transaction).
- Overlapping exclusive reservations are impossible: PostgreSQL exclusion constraints on scope locks make two
  concurrent approvals for the same resource/period resolve to exactly one success and one `409 RESERVATION_CONFLICT`,
  with no partial reservations for multi-resource requests and parent/child scope conflicts detected.
- Requests pin the form, workflow and policy versions at submission; publishing new versions never changes them.
- Every API call is authorised on the server from dated memberships/delegations evaluated per request; out-of-scope
  objects return 404; summary-only users never receive occupant, values or attachment fields.
- Approval "signature" is internal attestation (re-authentication + SHA-256 of the revision + HMAC evidence) and is
  never presented as a certificate-based digital signature; PKI mode fails closed until a provider is connected.

**Layout:** `backend/` (Spring Boot + Flowable), `frontend/` (React + Vite + nginx), `map-packages/` (local licensed
basemap), `ops/` (env, backup/restore/verify, air-gap bundle, load test), `tests/acceptance/` (end-to-end journey),
`docs/` (status, traceability, ADRs, API, install, operations, licences). The concept workspace
(`handoff/`, `dist/`, `unified/`, `assets/`, build scripts) is preserved unchanged — see the section below.

---

## Concept workspace, prototype and handoff (original repository README)

Initial concept and implementation handoff for an Arabic RTL enterprise **administrative facilities, reservations, and approvals** platform. The interface prototypes retain their working name **MOVER**.

This repository contains the full prototype source, five earlier HTML design concepts, a unified interactive demo, map assets, research references, requirements, decisions, architecture, API behavior, data model, acceptance criteria, and a Claude implementation brief.

### Start with Claude

Ask Claude Code to read `CLAUDE.md`, then `handoff/START_HERE.md` and `handoff/CLAUDE_BUILD_PROMPT.md`, followed by all specification files under `handoff/`. Begin implementation from the recorded assumptions and open decisions; do not ask the original 30 questions again.

The prototype uses browser-local data and simulated roles/signatures. A production backend, real authentication and authorization, database concurrency protection, and production signing are still to be implemented.

### Preview

Open `dist/prototype.html` directly in a modern browser, or serve `dist` locally:

```sh
python3 -m http.server 8080 --directory dist
```

Then open http://localhost:8080. Map, font, and Leaflet assets are embedded for offline preview. `DecompressionStream` is needed for the embedded basemap. All named facilities, people, requests, and facility bounds are fictional.

- `dist/index.html`, `dist/prototype.html`, `dist/06-unified.html`: unified prototype.
- `dist/concepts.html`: gallery of the five earlier concepts.
- `dist/01-atlas.html` through `dist/05-calendar.html`: individual concepts.
- `dist/questions.html`: original administrative discovery questionnaire.
- `dist/mover-claude-handoff.zip`: prior packaged handoff.
- `handoff/`: authoritative requirements and implementation documentation.
- `unified/`: editable unified HTML, CSS, and JavaScript sources.
- `assets/`, `basemap.svg`, `basemap.geojson`: local third-party assets and illustrative public geographic extract.
- `docs/previews/`: screenshots of the concept.
- `MANIFEST.sha256`: import checksums for the initial handoff files; regenerate when sources change.

### Rebuild

Requires Python 3 with only its standard library; no dependency installation is needed.

```sh
python3 build_concepts.py
python3 build_unified.py
```

Run the unified builder last so `dist/index.html` remains the unified prototype. The original five-concept gallery is retained in `dist/concepts.html`.

### Implementation direction

Proposed architecture: React + TypeScript + Vite, Spring Boot with embedded Flowable Open Source, Keycloak, OpenFGA, PostgreSQL and optional PostGIS, local attachment storage, transactional outbox, and isolated Docker deployment. **Status:** the production modules now live in `backend/`, `frontend/`, `ops/` and `docs/` (sections above). Keycloak (ADR-015) and PostGIS (ADR-017) are now in use; OpenFGA is still replaced, for recorded reasons, by in-process authorisation until step 3 — see `docs/ARCHITECTURE_DECISIONS.md` (ADR-004, ADR-008 superseded by ADR-017, ADR-003 superseded by ADR-015).

Target record counts are approximately 7,000 organizational entities and 200,000 people; concurrent usage and performance objectives remain to be established.

### Scope and licenses

The implementation scope is administrative facility and reservation management. It excludes military deployment planning, tactical positioning, and operational recommendations. Public geographic data is illustrative and is not a navigation product.

Preserve third-party licenses and map attribution. See `FONT-LICENSE.txt`, `assets/leaflet-license.txt`, `handoff/SOURCES.md`, and the basemap metadata. No license for original project code has been selected yet; do not assume it is open source.

The original private Site preview is available to its authorized owner at https://mover-map-concepts-ghanem.ghanemalshahyari.chatgpt.site . No Site credentials or hosting identity are required to use this repository.
