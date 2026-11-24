# عملية نقل التحديث إلى الخادم — TMRKZ ADR-102

**التاريخ:** 24 تشرين الثاني 2026  
**الالتزام:** `a3832f5` (main)  
**المحتوى:** ADR-099 → ADR-102 (الخادم الخفيف، دخول الدليل بلا حساب خدمة، إدارة الوحدات والمستويات، مركز الإدارة، المساعد الذكي، تصحيح مؤشر الخريطة، إدارة المديرين، أصول التضمين، محرك الاسترداد، دورة حياة المدير، وثائق عربية)

---

## 1. المجلد المطلوب نقله

**المجلد الكامل:** `~/Desktop/TMRKZ/`

هذا المجلد يحتوي على كل ما يلزم — لا حاجة لملف `tmrkz-images.tar` جديد لأن الصور لم تتغير.

### الملفات الجديدة والمعدّلة في هذا التحديث

```
backend/src/main/java/ae/mover/assistant/AssistantController.java    (معدّل)
backend/src/main/java/ae/mover/assistant/AssistantService.java       (معدّل)
backend/src/main/java/ae/mover/org/OrgController.java               (معدّل)
backend/src/main/java/ae/mover/org/OrganizationService.java         (معدّل)
backend/src/main/java/ae/mover/security/SessionFilter.java          (معدّل)
backend/src/main/java/ae/mover/system/SystemController.java         (معدّل)
backend/src/main/resources/db/migration/V68__system_setting.sql     (جديد)
frontend/src/api/client.ts                                          (معدّل)
frontend/src/api/types.ts                                           (معدّل)
frontend/src/components/AdminLifecycle.tsx                           (جديد)
frontend/src/components/ManagementCenter.tsx                         (جديد)
frontend/src/components/assist/FloatingAssist.tsx                    (معدّل)
frontend/src/pages/SettingsPage.tsx                                  (معدّل)
frontend/src/styles/map.css                                         (معدّل)
ops/tmrkzctl.sh                                                     (جديد)
ops/local/workspace/gen-csp-embedding.sh                            (جديد)
docs/ADMIN_UI_QUICK_START_AR.md                                     (جديد)
docs/VM_BOOTSTRAP_AR.md                                             (جديد)
docs/VM_QUICK_START_AR.md                                           (جديد)
docs/VM_RUNBOOK.md                                                  (جديد)
docs/STATUS.md                                                      (معدّل)
docs/TRACEABILITY.md                                                (معدّل)
docs/ARCHITECTURE_DECISIONS.md                                      (معدّل)
```

---

## 2. خطوات النقل

### من جهاز التطوير (Mac)

```bash
# 1. ضغط المجلد (بدون data/ و backups/ و .git/)
cd ~/Desktop
tar czf TMRKZ-update-20261124.tar.gz \
  --exclude='TMRKZ/data' \
  --exclude='TMRKZ/backups' \
  --exclude='TMRKZ/.git' \
  --exclude='TMRKZ/node_modules' \
  --exclude='TMRKZ/frontend/node_modules' \
  TMRKZ/

# 2. نقل إلى الخادم عبر PAM (المنفذ 4422)
scp -P 4422 TMRKZ-update-20261124.tar.gz user@server:/tmp/
```

### على الخادم (VM)

```bash
# 1. نسخة احتياطية أولاً
cd /opt/tmrkz   # أو أينما كان المجلد
sh ops/tmrkzctl.sh backup

# 2. إيقاف الخدمات
docker compose stop

# 3. فك الضغط فوق المجلد الحالي
cd /opt
tar xzf /tmp/TMRKZ-update-20261124.tar.gz

# 4. إعادة التشغيل
cd /opt/TMRKZ   # أو المسار الموجود
sh start.sh

# 5. التحقق
sh ops/tmrkzctl.sh doctor
sh ops/tmrkzctl.sh verify
```

---

## 3. ما سيحدث تلقائياً عند التشغيل

1. **V68 migration:** Flyway سيطبّق `V68__system_setting.sql` تلقائياً — ينشئ جدول `system_setting`.
2. **Backend rebuild:** البناء يعيد الترجمة تلقائياً عند أول تشغيل (أو يستخدم البناء المحفوظ إذا لم يتغير المصدر — ADR-099).
3. **Frontend rebuild:** حاوية الويب تبني الواجهة من المصادر المحدّثة.

---

## 4. التحقق بعد التحديث

| الفحص | الأمر أو الطريقة |
|-------|-------------------|
| صحة الخدمات | `sh ops/tmrkzctl.sh doctor` |
| التحقق الكامل | `sh ops/tmrkzctl.sh verify` |
| مركز الإدارة | ادخل ← إعدادات النظام ← مرِّر إلى «مركز إدارة النظام» |
| مديرو النظام | في إعدادات النظام ← «مديرو النظام» |
| المساعد الذكي | افتح المساعد واسأل سؤالين متتاليين — يجب أن يتذكر السياق |
| مؤشر الخريطة | افتح الخريطة واضغط على موقع — يجب أن تظهر القائمة في مكان الضغط بالضبط |
| إدارة الوحدات | في الدليل ← أضف وحدة جديدة أو أعد تسمية وحدة |

---

## 5. ملاحظات مهمة

- **لا حاجة لصور جديدة:** كل الصور الحالية تعمل كما هي (لم تتغير التبعيات).
- **لا حاجة لإعادة بناء يدوي:** `start.sh` يفعل كل شيء.
- **البيانات محفوظة:** الترحيل V68 يضيف جدولاً فقط ولا يعدّل البيانات الموجودة.
- **التراجع:** إذا حصلت مشكلة:
  ```bash
  sh ops/tmrkzctl.sh rollback <backup-dir>
  ```
