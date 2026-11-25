# TMRKZ — تعليمات الاسترداد (25 نوفمبر 2026، ADR-106)

كل الأوامر على الـVM عبر PAM بحساب الصيانة، داخل `/data/TMRKZ` ما لم يُذكر غير ذلك. لا تحذف `data/` ولا `certs/` ولا `.env` ولا
`map-runtime/` ولا `backups/` في أي حالة.

## 1. التراجع عن الإعداد لأول مرة (bootstrap)

```
sh /data/tmrkz-bootstrap-<release>/bootstrap.sh restore /data/TMRKZ/backups/bootstrap/<time printed by apply>
cd /data/TMRKZ && sh start.sh
```

يعيد كل ملف كتبه `apply` أو حذفه كما كان بالضبط، ويعيد خط الأساس السابق، ويزيل المفتاح العام إن كان الإعداد هو الذي ثبته.
الأوقات المتاحة: `ls -1 /data/TMRKZ/backups/bootstrap/`.

## 2. تحديث من المتصفح

- من المتصفح: «إدارة النظام ← مركز التحديث ← الرجوع إلى الإصدار السابق». يحدث الرجوع تلقائياً إذا فشل التحقق بعد التطبيق.
- إن لم يفتح المتصفح:

```
cd /data/TMRKZ
ls -1 backups/updates | grep -E '^[0-9]{8}T' | tail -n 3          # آخر التحديثات
U=backups/updates/<id>
(cd "$U/before" && find . -type f) | head                          # ما كان قبل التحديث
cp -r "$U/before/." .                                              # يعيد الملفات المستبدلة
while read -r f; do [ -n "$f" ] && rm -f "$f"; done < "$U/added.txt"   # يحذف ما أضافه التحديث فقط
[ -f "$U/baseline-before.tsv" ] && cp "$U/baseline-before.tsv" backups/updates/installed-MANIFEST.tsv
sh start.sh
```

الخادم وواجهة الويب يعيدان البناء من المجلد بنفسيهما؛ `sh start.sh` يكفي إن توقفت خدمة.

## 3. شهادة https

- من المتصفح: «إدارة النظام ← الشهادات ← استعادة الشهادات السابقة».
- دونه: انسخ `server.crt` و`server.key` و`ca-chain.pem` من `backups/certificates/<id>/` إلى مجلد `TMRKZ_TLS_DIR` (المذكور في
  `.env`). يعيد `proxy` تحميلها خلال ثوانٍ بعد `nginx -t`؛ شهادة مرفوضة تترك الشهادة العاملة كما هي.

## 4. إعداد تكامل مستورد

«إدارة النظام ← إعدادات التكامل»: عدّل القسم أو امسحه. القيم السابقة في تفاصيل حدث التدقيق. ملف `.env` لا يُكتب أبداً.

## 5. الخدمات

```
cd /data/TMRKZ
docker compose ps
docker compose logs --tail 80 backend web web-build maintenance proxy
sh start.sh
sh ops/diagnose.sh > /tmp/tmrkz-diagnose.txt                      # للقراءة فقط؛ أرسل الناتج
```

لا تشغّل `docker compose down -v` (يحذف المجلدات المسماة). لا تحمّل صوراً غير المعتمدة في `tmrkz-images.tar`.
