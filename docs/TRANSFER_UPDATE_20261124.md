# تحديث TMRKZ — 24 تشرين الثاني 2026

**الالتزام:** `24ee01b` (main)  
**النطاق:** ADR-099 → ADR-102 + تصحيح التضمين وشريط العنوان  
**الحجم:** ~1.6 ميغابايت (46 ملفاً فقط — ليس المجلد كاملاً)

---

## 1. الملفات المطلوب نقلها بالضبط

### الخلفية (backend)
```
backend/src/main/java/ae/mover/assistant/AssistantController.java
backend/src/main/java/ae/mover/assistant/AssistantService.java
backend/src/main/java/ae/mover/org/OrgController.java
backend/src/main/java/ae/mover/org/OrganizationService.java
backend/src/main/java/ae/mover/security/DirectoryAuthenticator.java
backend/src/main/java/ae/mover/security/IntegrationSettingsService.java
backend/src/main/java/ae/mover/security/LdapProperties.java
backend/src/main/java/ae/mover/security/SessionFilter.java
backend/src/main/java/ae/mover/system/SystemController.java
backend/src/main/resources/application.yml
backend/src/main/resources/db/migration/V67__unit_management_and_levels.sql
backend/src/main/resources/db/migration/V68__system_setting.sql
backend/src/test/java/ae/mover/ActiveDirectoryDirectBindTest.java
backend/src/test/java/ae/mover/DirectorySignInIT.java
backend/src/test/java/ae/mover/OracleAbsenceIT.java
```

### الواجهة (frontend)
```
frontend/nginx.conf
frontend/src/App.tsx
frontend/src/api/client.ts
frontend/src/api/types.ts
frontend/src/components/AdminLifecycle.tsx
frontend/src/components/IntegrationSettings.tsx
frontend/src/components/ManagementCenter.tsx
frontend/src/components/assist/FloatingAssist.tsx
frontend/src/components/shell/TopNavigation.tsx
frontend/src/lib/integrationSettings.test.ts
frontend/src/lib/integrationSettings.ts
frontend/src/pages/OrgPage.tsx
frontend/src/pages/SettingsPage.tsx
frontend/src/styles/app.css
frontend/src/styles/map.css
frontend/src/styles/shell.css
```

### العمليات (ops)
```
ops/init-env.sh
ops/local/map-worker.sh
ops/local/workspace/gen-csp-embedding.sh
ops/tmrkzctl.sh
start.sh
```

### البنية التحتية
```
docker-compose.yml
RUN.md
```

### الوثائق (docs)
```
docs/ADMIN_UI_QUICK_START_AR.md
docs/ARCHITECTURE_DECISIONS.md
docs/FULL_PROCESS_ADR102.md
docs/STATUS.md
docs/TRACEABILITY.md
docs/VM_BOOTSTRAP_AR.md
docs/VM_QUICK_START_AR.md
docs/VM_RUNBOOK.md
docs/VM_TRANSFER_PROCESS.md
```

---

## 2. أمر الضغط (على Mac)

```bash
cd ~/Desktop/TMRKZ
tar czf ~/Desktop/tmrkz-update-20261124.tar.gz \
  backend/src/main/java/ae/mover/assistant/AssistantController.java \
  backend/src/main/java/ae/mover/assistant/AssistantService.java \
  backend/src/main/java/ae/mover/org/OrgController.java \
  backend/src/main/java/ae/mover/org/OrganizationService.java \
  backend/src/main/java/ae/mover/security/DirectoryAuthenticator.java \
  backend/src/main/java/ae/mover/security/IntegrationSettingsService.java \
  backend/src/main/java/ae/mover/security/LdapProperties.java \
  backend/src/main/java/ae/mover/security/SessionFilter.java \
  backend/src/main/java/ae/mover/system/SystemController.java \
  backend/src/main/resources/application.yml \
  backend/src/main/resources/db/migration/V67__unit_management_and_levels.sql \
  backend/src/main/resources/db/migration/V68__system_setting.sql \
  backend/src/test/java/ae/mover/ActiveDirectoryDirectBindTest.java \
  backend/src/test/java/ae/mover/DirectorySignInIT.java \
  backend/src/test/java/ae/mover/OracleAbsenceIT.java \
  frontend/nginx.conf \
  frontend/src/App.tsx \
  frontend/src/api/client.ts \
  frontend/src/api/types.ts \
  frontend/src/components/AdminLifecycle.tsx \
  frontend/src/components/IntegrationSettings.tsx \
  frontend/src/components/ManagementCenter.tsx \
  frontend/src/components/assist/FloatingAssist.tsx \
  frontend/src/components/shell/TopNavigation.tsx \
  frontend/src/lib/integrationSettings.test.ts \
  frontend/src/lib/integrationSettings.ts \
  frontend/src/pages/OrgPage.tsx \
  frontend/src/pages/SettingsPage.tsx \
  frontend/src/styles/app.css \
  frontend/src/styles/map.css \
  frontend/src/styles/shell.css \
  ops/init-env.sh \
  ops/local/map-worker.sh \
  ops/local/workspace/gen-csp-embedding.sh \
  ops/tmrkzctl.sh \
  start.sh \
  docker-compose.yml \
  RUN.md \
  docs/ADMIN_UI_QUICK_START_AR.md \
  docs/ARCHITECTURE_DECISIONS.md \
  docs/FULL_PROCESS_ADR102.md \
  docs/STATUS.md \
  docs/TRACEABILITY.md \
  docs/TRANSFER_UPDATE_20261124.md \
  docs/VM_BOOTSTRAP_AR.md \
  docs/VM_QUICK_START_AR.md \
  docs/VM_RUNBOOK.md \
  docs/VM_TRANSFER_PROCESS.md
```

---

## 3. النقل والتطبيق

```bash
# نقل إلى الخادم (PAM، المنفذ 4422)
scp -P 4422 ~/Desktop/tmrkz-update-20261124.tar.gz user@server:/tmp/

# على الخادم
cd /opt/tmrkz                         # أو المسار الفعلي
sh ops/tmrkzctl.sh backup             # نسخة احتياطية أولاً
docker compose stop                   # إيقاف
tar xzf /tmp/tmrkz-update-20261124.tar.gz   # فك فوق المجلد الحالي
sh start.sh                           # إعادة تشغيل
sh ops/tmrkzctl.sh doctor             # تحقق
sh ops/tmrkzctl.sh verify             # تحقق كامل
```

---

## 4. ما يحصل تلقائياً عند التشغيل

1. **V67 + V68 migrations:** Flyway يطبقهما تلقائياً (جدول المستويات وجدول الإعدادات)
2. **Backend rebuild:** البناء يعيد الترجمة عند أول تشغيل (ADR-099)
3. **Frontend rebuild:** `web-build` يبني الواجهة من المصادر المحدثة
4. **Embedding poller:** `map-worker.sh` ينشئ `embedding.conf` الافتراضي ويبدأ المراقبة

---

## 5. ما لا تحتاج نقله

| لا تنقل | السبب |
|---------|-------|
| `data/` | البيانات موجودة على الخادم |
| `backups/` | النسخ الاحتياطية على الخادم |
| `.git/` | ليس مطلوباً للتشغيل |
| `node_modules/` | موجود داخل الصورة |
| `frontend/node_modules/` | موجود داخل الصورة |
| `tmrkz-images.tar` | الصور لم تتغير |
| `map-runtime/` | حزم الخرائط لم تتغير |
| `frontend/dist/` | يُبنى تلقائياً |

---

## 6. التحقق بعد التحديث

- [ ] `sh ops/tmrkzctl.sh doctor` — الكل PASS
- [ ] تسجيل الدخول يعمل
- [ ] إعدادات ← «مركز إدارة النظام» يظهر حالة النظام
- [ ] إعدادات ← «مديرو النظام» يظهر المديرين
- [ ] إعدادات ← «إعدادات التكامل» → «المساعد الذكي» يظهر إعدادات الذكاء الاصطناعي
- [ ] المساعد الذكي يتذكر السياق
- [ ] ضغط على الخريطة يظهر القائمة في مكان الضغط
- [ ] شريط العنوان العلوي: الأيقونات متباعدة بشكل صحيح
- [ ] التضمين: أضف أصل في «التضمين» واحفظ ← بعد 30 ثانية يعمل iframe من ذلك الأصل
