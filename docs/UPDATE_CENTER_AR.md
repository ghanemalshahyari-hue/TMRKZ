# مركز التحديث ومجلد TMRKZ الواحد (ADR-104، ADR-105)

## 1. المبدأ

مجلد TMRKZ واحد، ومصدر واحد، ومستودع واحد، وفرع main فقط، والصور والمكتبات وطريقة البناء وسكربتات التشغيل والتركيبات (mounts)
نفسها على جهاز التطوير وعلى الـVM في `/data/TMRKZ`. الفرق الوحيد المسموح: إعدادات الجهاز والعناوين وكلمات المرور والشهادات
والبيانات. لا يوجد «مجلد نشر» منفصل.

القاعدة التي تقرر أي ملف يُنقل في التحديث: `ops/update/managed-paths.conf`.

| الصنف | المعنى | أمثلة |
|---|---|---|
| `protected` | لا يقرؤه التحديث ولا يكتبه أبداً | `.env`، `certs/`، `data/`، `backups/`، `map-data/`، `map-runtime/`، `ops/local/.generated/`، `docker-compose.dc-hosts.yml` وأي `docker-compose.*.yml` آخر، `tmrkz-images.tar` |
| `config` | إعداد الحاويات: يُعرض الفرق ولا يُكتب إلا باختيار صريح، ويحتاج إعادة تشغيل الحاويات مرة واحدة | `docker-compose.yml`، `docker-compose.override.yml` |
| `app` | التطبيق: يُقارن ويُرفع المختلف فقط | `backend/pom.xml`، `backend/src/main/**`، `frontend/**`، `ops/**`، `assets/**`، `map-packages/**`، `start.sh`، `RUN.md`، `README.md` |
| `docs` | التوثيق المنشور داخل التطبيق | `docs/**` (عدا `docs/audit` و`docs/evidence`)، `handoff/**` |
| `dev` | للتطوير فقط، لا يُنقل | `tests/**`، `backend/src/test/**`، `prototypes/**`، `docs/audit/**`، `docs/evidence/**`، `.github/`، `.vscode/` |

## 2. التهيئة الأولى — مرة واحدة فقط (عبر PAM)

الـVM الحالية لا تحتوي مركز التحديث بعد، لذلك تُنقل «حزمة التهيئة» مرة واحدة يدوياً. بعدها تصبح كل التحديثات من المتصفح.
الحزمة صغيرة (الملفات التي تغيرت منذ نسخة الـVM فقط، نحو 3 MB) وتتحقق من نفسها قبل أن تكتب شيئاً (ADR-105).

### على جهاز Windows (موجه الأوامر CMD، داخل مجلد TMRKZ)

```
cd %USERPROFILE%\Desktop\TMRKZ
"C:\Program Files\Git\bin\sh.exe" ops/update/make-release.sh --init-key
"C:\Program Files\Git\bin\sh.exe" ops/update/make-release.sh --bootstrap e30c1c1
```

- الأمر الأول ينشئ مفتاح التوقيع مرة واحدة في `ops\local\.generated\release-signing.key` (يبقى على هذا الجهاز ولا يُنسخ أبداً).
- الأمر الثاني يكتب المجلد `release\bootstrap\` لـVM تعمل بنسخة `e30c1c1` (تحديث 24 نوفمبر): ملف `TMRKZ-bootstrap-<الإصدار>.tar`
  (الملفات المتغيرة فقط)، وقائمة الملفات الموقعة `MANIFEST.tsv` و`RELEASE.json` و`RELEASE.sig`، و`config\` (ملفا Compose
  للمراجعة)، و`release-trust.pub` (المفتاح العام فقط)، و`bootstrap.sh`، و`INSTALL.txt`، و`BASE.tsv` و`KNOWN.tsv` و`BASE-COMMIT.txt`
  (لمقارنة ملفات الـVM)، و`SHA256SUMS`.

انقل عبر PAM **المجلد `release\bootstrap\` كله** إلى `/data/tmrkz-bootstrap/` على الـVM. لا شيء غيره.

### على الـVM (Ubuntu، داخل PAM)

```
cd /data/tmrkz-bootstrap
sh bootstrap.sh check /data/TMRKZ                  # للقراءة فقط: المجاميع، التوقيع، الملفات، فرق ملفي Compose
sh bootstrap.sh apply /data/TMRKZ --with-config    # بعد قراءة فرق Compose؛ بدون --with-config يبقى ملفا Compose كما هما
cd /data/TMRKZ && sh start.sh                       # الصور نفسها؛ لا يلزم tmrkz-images.tar
sh ops/diagnose.sh > /tmp/tmrkz-diagnose.txt        # فحص للقراءة فقط
```

- `check` لا يغير شيئاً: يتحقق من `SHA256SUMS` ومن توقيع الإصدار بالمفتاح العام، ويعرض الملفات التي ستُستبدل أو تُضاف، وفرق
  ملفي Compose سطراً بسطر.
- **توافق الـVM (ADR-106):** لا يُفترض أن ملفات الـVM تطابق `e30c1c1`. يضع `check` كل ملف مختلف في واحدة من ثلاث، بمعرّف git
  لبايتاته (يحسبه دون git) مقابل `BASE.tsv` و`KNOWN.tsv` في الحزمة: «as at that commit» (كما في ذلك الإيداع، ولو نُسخ من Windows
  بنهايات CRLF)، أو «an earlier committed version» (نسخة أقدم مودعة، يُذكر إيداعها)، أو «CHANGED ON THIS MACHINE» (تعديل يدوي على
  الـVM). إن كان تعديل يدوي سيُستبدل أو يُحذف يتوقف `apply` ولا يغير شيئاً، حتى تختار صراحة: `--keep-local` (يبقى كما هو، ويعرضه
  مركز التحديث «معدّل على هذا الجهاز» ولا يختاره تلقائياً) أو `--overwrite-local` (يُستبدل، ونسخة الـVM في النسخة الاحتياطية).
  للمقارنة قبل القرار: `tar -xOf TMRKZ-bootstrap-*.tar <المسار> | diff -u /data/TMRKZ/<المسار> -`
- `apply` يرفض أي مسار محمي أو ملف ليس في القائمة الموقعة أو ملف تغير بعد التوقيع، ثم يحفظ نسخة من كل ملف سيكتبه في
  `backups/bootstrap/<الوقت>/`، ويكتب الملفات، ويثبت المفتاح العام `ops/local/.generated/release-trust.pub` (إن كان مفتاح آخر
  مثبتاً يتوقف)، ويكتب خط الأساس `backups/updates/installed-MANIFEST.tsv` ليُعرف لاحقاً أي ملف عُدل على الـVM يدوياً.
- إن أظهر فرق Compose تعديلات خاصة بالـVM غير إضافات مركز التحديث (الخدمة `maintenance` والحجم `update-staging` وسطر
  `update-staging:/update` في `backend` ومراقب الشهادة في `proxy`) فلا تستخدم `--with-config`، وأضف هذه الأجزاء يدوياً.
- `docker-compose.dc-hosts.yml` لا يُمس. لكي لا يُهمل، أضف إلى `.env` (مرة واحدة) السطرين:

```
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.dc-hosts.yml
```

  للتأكد من الملفات التي تعمل بها الحاويات الآن:
  `docker inspect tmrkz-backend-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`

- التراجع عن التهيئة: `sh /data/tmrkz-bootstrap/bootstrap.sh restore /data/TMRKZ/backups/bootstrap/<الوقت>` ثم `sh start.sh`.
  يعيد كل ملف كما كان بالضبط، ويزيل المفتاح العام إن كانت التهيئة هي التي ثبتته.

## 3. التحديث المعتاد — من المتصفح، بلا PAM

1. على جهاز Windows بعد التطوير والاختبار:
   `"C:\Program Files\Git\bin\sh.exe" ops/update/make-release.sh`
2. انسخ مجلد TMRKZ إلى الجهاز الذي يفتح صفحة الـVM (مثلاً USB)، ثم افتح TMRKZ ← «إدارة النظام» ← «مركز التحديث» ←
   «اختيار مجلد TMRKZ».
3. تعرض الصفحة: التوقيع، والملفات المضافة والمعدلة والمحذوفة والممنوعة، وما تغير على الـVM منذ آخر تحديث. ملفا Compose والملفات
   المعدلة محلياً لا تُختار إلا يدوياً.
4. «رفع الملفات المختلفة» يرفع المختلف فقط (لا تُنقل المكتبات ولا الصور).
5. اكتب السبب ثم «اعتماد وتطبيق». يعمل عامل الصيانة: يبني الخادم بالمكتبات الموجودة دون إنترنت، ثم ينسخ احتياطياً، ثم يطبق، ثم
   يتحقق من إعادة تشغيل الخادم بالبناء الجديد ونشر الواجهة. إن فشل التحقق يعيد الإصدار السابق تلقائياً.
6. «الرجوع إلى الإصدار السابق» يلغي تحديثاً مكتملاً.

لا يُعاد تشغيل إلا المتأثر: الخادم إن تغير مصدره، والواجهة إن تغيرت، ويعيد nginx تحميل إعداده إن تغير ونجح `nginx -t`.

## 4. ما يُنقل وما لا يُمس وما لا يلزم

- **يُنقل:** ملفات app وdocs التي اختلفت فقط، وملفا Compose فقط عند اختيارهما صراحة. في التهيئة الأولى: المجلد
  `release/bootstrap/` وحده (القسم 2).
- **الشهادات وإعدادات التكامل:** لا تُنقل بالتحديث أبداً. تُدار من «إدارة النظام ← الشهادات» و«استيراد ملف إعدادات» (ADR-105)
  بتحقق ومعاينة واعتماد صريح ونسخة احتياطية واستعادة.
- **لا يُمس أبداً على الـVM:** `.env`، `certs/`، `data/`، `backups/`، `map-data/`، `map-runtime/`، `docker-compose.dc-hosts.yml`،
  `ops/local/.generated/` (ومنه مفتاح الثقة)، `tmrkz-images.tar`.
- **غير لازم للتشغيل:** `tests/`، `backend/src/test/`، `prototypes/`، `docs/audit/`، `docs/evidence/`، `.github/`، `.vscode/`،
  `.zcode/`، `AGENTS.md`، `CLAUDE.md`. وجودها على الـVM لا يضر، والتحديث لا يرسلها.

## 5. الاسترجاع في الطوارئ (PAM)

- كل تحديث يحفظ الملفات قبل استبدالها في `backups/updates/<رقم التحديث>/before/`، وقائمة المضاف في `added.txt`.
- إن تعذر فتح المتصفح:
  ```
  cd /data/TMRKZ/backups/updates/<رقم التحديث>
  (cd before && find . -type f) | while read f; do cp "before/$f" "/data/TMRKZ/$f"; done
  while read f; do [ -n "$f" ] && rm -f "/data/TMRKZ/$f"; done < added.txt
  ```
  يعيد الخادم والواجهة البناء تلقائياً بعد الاستعادة.
- نسخة التهيئة الأولى: `backups/bootstrap/<الوقت>/` وتُعاد بـ`sh bootstrap.sh restore` (القسم 2).
- شهادة https: كل تثبيت من «الشهادات» يحفظ الشهادة والمفتاح السابقين في `backups/certificates/<رقم الطلب>/` (المفتاح بصلاحية
  المالك وحده). إن تعذر فتح المتصفح: انسخ `server.crt` و`server.key` و`ca-chain.pem` منها إلى مجلد `TMRKZ_TLS_DIR`، وتعيد نقطة
  https تحميلها وحدها خلال ثوانٍ.

## 6. التحقق للقراءة فقط

`sh ops/diagnose.sh` (أو من CMD: `"C:\Program Files\Git\bin\sh.exe" ops/diagnose.sh`) — لا يغير شيئاً، وجلسة قاعدة البيانات للقراءة
فقط، والمخرجات محجوبة (بلا كلمات مرور أو مفاتيح أو أسماء أو عناوين IP أو أرقام وظيفية). يفحص: ملفات Compose المستخدمة فعلاً،
الخدمات، المجلدات الناقصة، الصور والمكتبات، التركيبات، الشهادات، الخرائط، قاعدة البيانات، اتساق الصلاحيات والهويات، مزامنة الموارد
البشرية، الأخطاء الأخيرة، وما إن كان تعديل محلي في المصدر قد بُني. لحالة أسماء دخول بعينها: `sh ops/diagnose.sh --logins u123456`.
