# مركز التحديث ومجلد TMRKZ الواحد (ADR-104)

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

الـVM الحالية لا تحتوي مركز التحديث بعد، لذلك يُنقل أول إصدار مرة واحدة يدوياً. بعدها تصبح كل التحديثات من المتصفح.

### على جهاز Windows (موجه الأوامر CMD، داخل مجلد TMRKZ)

```
cd %USERPROFILE%\Desktop\TMRKZ
"C:\Program Files\Git\bin\sh.exe" ops/update/make-release.sh --init-key
"C:\Program Files\Git\bin\sh.exe" ops/update/make-release.sh --package
```

- الأمر الأول ينشئ مفتاح التوقيع مرة واحدة في `ops\local\.generated\release-signing.key` (يبقى على هذا الجهاز ولا يُنسخ أبداً).
- الأمر الثاني يكتب في `release\`: `TMRKZ-app-<الإصدار>.tar` (ملفات app وdocs فقط، بلا أي ملف محمي)، و`config\` (ملفا Compose
  للمقارنة فقط)، و`SHA256SUMS`.

انقل عبر PAM هذه الملفات فقط إلى `/tmp/tmrkz-transfer/` على الـVM:

- `release\TMRKZ-app-<الإصدار>.tar`
- `release\SHA256SUMS`
- `release\config\docker-compose.yml` و`release\config\docker-compose.override.yml`
- `ops\local\.generated\release-signing.pub` (المفتاح العام فقط)

### على الـVM (Ubuntu، داخل PAM)

```
cd /tmp/tmrkz-transfer && sha256sum -c SHA256SUMS
cd /data/TMRKZ
# 1) نسخة احتياطية لملفات التطبيق الحالية (لا تشمل البيانات)
mkdir -p backups/pre-update-center
tar -cf backups/pre-update-center/app-$(date +%Y%m%d%H%M).tar backend frontend ops assets map-packages start.sh RUN.md README.md docker-compose.yml docker-compose.override.yml $(ls -d docs handoff 2>/dev/null)
# 2) ملفات التطبيق والتوثيق فقط (لا تحتوي .env ولا data ولا certs ولا الخرائط)
tar -xf /tmp/tmrkz-transfer/TMRKZ-app-*.tar -C /data/TMRKZ
# 3) مفتاح الثقة
cp /tmp/tmrkz-transfer/release-signing.pub ops/local/.generated/release-trust.pub
# 4) قارن ملفي Compose ولا تستبدل شيئاً قبل المراجعة
diff -u docker-compose.yml /tmp/tmrkz-transfer/docker-compose.yml
diff -u docker-compose.override.yml /tmp/tmrkz-transfer/docker-compose.override.yml
```

- إن لم يُظهر `diff` إلا إضافات مركز التحديث (الخدمة `maintenance` والحجم `update-staging` وسطر `update-staging:/update` في
  خدمة `backend`) انسخ الملف الجديد. إن ظهرت تعديلات خاصة بالـVM فأضف هذه الأجزاء الثلاثة يدوياً فقط.
- `docker-compose.dc-hosts.yml` لا يُمس. لكي لا يُهمل، أضف إلى `.env` (مرة واحدة) السطرين:

```
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.dc-hosts.yml
```

  للتأكد من الملفات التي تعمل بها الحاويات الآن:
  `docker inspect tmrkz-backend-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`

```
# 5) التشغيل (لا يحتاج tmrkz-images.tar إذا كانت الصور محمّلة)
sh start.sh
# 6) فحص للقراءة فقط
sh ops/diagnose.sh > /tmp/tmrkz-diagnose.txt
```

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

- **يُنقل:** ملفات app وdocs التي اختلفت فقط، وملفا Compose فقط عند اختيارهما صراحة.
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
- نسخة التهيئة الأولى: `backups/pre-update-center/app-*.tar`.

## 6. التحقق للقراءة فقط

`sh ops/diagnose.sh` (أو من CMD: `"C:\Program Files\Git\bin\sh.exe" ops/diagnose.sh`) — لا يغير شيئاً، وجلسة قاعدة البيانات للقراءة
فقط، والمخرجات محجوبة (بلا كلمات مرور أو مفاتيح أو أسماء أو عناوين IP أو أرقام وظيفية). يفحص: ملفات Compose المستخدمة فعلاً،
الخدمات، المجلدات الناقصة، الصور والمكتبات، التركيبات، الشهادات، الخرائط، قاعدة البيانات، اتساق الصلاحيات والهويات، مزامنة الموارد
البشرية، الأخطاء الأخيرة، وما إن كان تعديل محلي في المصدر قد بُني. لحالة أسماء دخول بعينها: `sh ops/diagnose.sh --logins u123456`.
