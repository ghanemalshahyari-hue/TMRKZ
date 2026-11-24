# إعداد الخادم لأول مرة — تمركز

## المتطلبات

| المتطلب | الحد الأدنى |
|---------|------------|
| نظام التشغيل | Ubuntu 22.04 أو 24.04 LTS (amd64) |
| Docker Engine | 24.0 أو أحدث |
| Docker Compose | V2 (مدمج مع Docker Engine) |
| الذاكرة (RAM) | 4 جيجابايت |
| القرص | 20 جيجابايت متاح |
| المعالج | 2 أنوية على الأقل |

> لا يحتاج الخادم اتصالاً بالإنترنت بعد تحميل الصور.

---

## خطوات الإعداد

### 1. نقل المجلد إلى الخادم

انقل مجلد TMRKZ بالكامل إلى الخادم بالطريقة المعتمدة (SCP، محرك مشترك، أو أرشيف):

```bash
# مثال عبر SCP
scp -r TMRKZ/ user@server:/opt/tmrkz/
```

تأكد من وجود هذه الملفات في المجلد:
- `start.sh`
- `docker-compose.yml`
- `docker-compose.override.yml`
- `tmrkz-images.tar` و `tmrkz-images.tar.sha256`
- `backend/` و `frontend/`
- `ops/`

### 2. تحميل الصور

```bash
cd /opt/tmrkz    # أو المسار الذي نقلت إليه المجلد
docker load -i tmrkz-images.tar
```

### 3. التشغيل الأول

```bash
sh start.sh
```

سيسألك عن:
- **عنوان IP** للجهاز (يعرض العناوين المتاحة).
- **المنفذ** (الافتراضي: 8088).

ثم ينشئ `.env` بالأسرار اللازمة ويشغّل جميع الخدمات.

### 4. أول دخول

1. افتح `http://IP:PORT` في المتصفح.
2. سجّل الدخول بحساب `admin` وكلمة المرور من `.env` (المفتاح `TMRKZ_PLATFORM_ADMIN_PASSWORD`):
   ```bash
   grep TMRKZ_PLATFORM_ADMIN_PASSWORD .env
   ```
3. ستظهر لوحة التحكم الرئيسية.

### 5. تهيئة الدليل المؤسسي

1. انتقل إلى **إعدادات النظام** ← **إعدادات التكامل — الدليل المؤسسي (LDAP)**.
2. اكتب بيانات خادم LDAP المؤسسي (العنوان، المنفذ، قاعدة البحث).
3. الصق شهادة CA إن كانت من جهة داخلية.
4. اختبر الاتصال ثم احفظ.

### 6. التحقق

```bash
sh ops/tmrkzctl.sh doctor
```

يجب أن تكون جميع الفحوصات PASS (ما عدا TLS إن لم يُهيَّأ بعد).

---

## أوامر الإعداد

```bash
# الإعداد الموجّه (ينشئ .env ويتحقق من الصور)
sh ops/tmrkzctl.sh setup

# تشخيص كامل
sh ops/tmrkzctl.sh doctor

# جرد التثبيت (للمشاركة بدون أسرار)
sh ops/tmrkzctl.sh inventory > diagnostic.txt
```

---

## استكشاف الأخطاء

### الصور غير موجودة

```
[tmrkzctl] FAIL  image tmrkz/folder-backend:1 missing
```

**الحل:** حمّل الصور:
```bash
docker load -i tmrkz-images.tar
```

### المنفذ مشغول

```
port 8088 is already used by the container X
```

**الحل:** اختر منفذاً آخر أو أوقف الحاوية المتعارضة:
```bash
TMRKZ_PORT=9090 sh start.sh
```

### قاعدة البيانات لا تستجيب

```
[tmrkzctl] WARN  database not reachable
```

**الحل:** تحقق من تشغيل الخدمات:
```bash
docker compose -p tmrkz ps
docker compose -p tmrkz logs db
```

### مجلد البيانات فارغ

```
note: data/db is empty
```

**الحل:** هذا طبيعي في التشغيل الأول؛ قاعدة البيانات تُنشأ تلقائياً. إذا كنت تنقل من تثبيت سابق، راجع RUN.md القسم 7.
