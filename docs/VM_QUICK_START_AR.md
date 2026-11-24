# التشغيل اليومي — تمركز

## التشغيل

```bash
cd /path/to/tmrkz
sh start.sh
```

يسأل عن العنوان والمنفذ إن لم يُحدَّدا، ثم يشغّل الخدمات. لتجاوز السؤال:

```bash
TMRKZ_IP=10.1.2.3 TMRKZ_PORT=8088 sh start.sh
```

---

## الإيقاف

```bash
docker compose -p tmrkz stop
```

> البيانات محفوظة في `data/`؛ الإيقاف لا يحذف شيئاً.

---

## التحقق من الحالة

```bash
sh ops/tmrkzctl.sh doctor     # تشخيص شامل
sh ops/tmrkzctl.sh status     # الخدمات وإصدار المخطط
sh ops/tmrkzctl.sh verify     # اختبار المسارات الرئيسية
```

---

## النسخ الاحتياطي

```bash
sh ops/tmrkzctl.sh backup
# أو مباشرة:
sh ops/backup.sh
```

يُنشئ مجلداً في `backups/` يحوي:
- `db.dump` — قاعدة البيانات
- `keycloak.dump` — قاعدة بيانات الهوية
- `openfga.dump` — قاعدة بيانات الصلاحيات
- `files.tgz` — المرفقات
- `map-packages.tgz` — حزم الخرائط
- `manifest.json` — بصمات SHA-256

### التحقق من النسخة

```bash
sh ops/verify-restore.sh
```

### الاستعادة

```bash
sh ops/tmrkzctl.sh rollback backups/tmrkz-20261124T120000Z
```

> تحذير: الاستعادة تستبدل قاعدة البيانات الحالية. البيانات المضافة بعد النسخة تُفقد.

---

## التحديث

```bash
sh ops/tmrkzctl.sh update /path/to/TMRKZ_UPDATE.tar.gz
```

يقوم تلقائياً بـ:
1. التحقق من سلامة الحزمة (لا ملفات محظورة، لا مسارات خطرة).
2. إنشاء نسخة احتياطية قبل التحديث.
3. إيقاف مراقبي البناء.
4. نسخ الملفات المحدثة.
5. إعادة تشغيل الخدمات المتأثرة.
6. انتظار الجاهزية.

### التراجع عن التحديث

إذا فشل التحديث، استعد من النسخة الاحتياطية التي أُنشئت قبله:

```bash
ls backups/pre-update-*
sh ops/tmrkzctl.sh rollback backups/pre-update-20261124T120000Z
```

---

## سجلات الخدمات

```bash
docker compose -p tmrkz logs backend --tail=100     # آخر 100 سطر من الخلفية
docker compose -p tmrkz logs web --tail=50           # nginx
docker compose -p tmrkz logs keycloak --tail=50      # مزود الهوية
docker compose -p tmrkz logs db --tail=50            # قاعدة البيانات
```

---

## إعادة بناء الواجهة يدوياً

في حالة عدم ظهور تغييرات الواجهة بعد تحديث:

```bash
docker compose -p tmrkz restart web-build
docker compose -p tmrkz logs web-build --follow
# انتظر حتى ترى: build ready
```

---

## جرد التثبيت (للمشاركة)

```bash
sh ops/tmrkzctl.sh inventory > diagnostic.txt
```

ينتج ملفاً نصياً بمعلومات التثبيت بدون أسرار، يمكن إرساله للدعم.
