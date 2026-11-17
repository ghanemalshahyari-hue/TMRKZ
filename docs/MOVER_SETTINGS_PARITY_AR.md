# إعدادات TMRKZ كما في MOVER — الهوية والدليل وOracle والمستخدمون

**ACCEPTANCE ONLY — OWNER DECISION PENDING.** طلب المالك في 17 نوفمبر 2026: «نفس إعدادات MOVER — Oracle وLDAP وKeycloak والزرّان وطريقة الدخول وإضافة الأشخاص بالرقم — والفرق هو طريقة عمل التطبيق فقط». القرار: ADR-079.

- **قراءة MOVER:** للقراءة فقط، من `C:\Users\EngCoder\Desktop\mover` عند `703cf1ec`. لم يتغير فيه شيء.
- **لا أسرار ولا عناوين حقيقية هنا:** المستودع عام. القيم الحقيقية تُنقل يدوياً من إعدادات MOVER على الخادم المعزول.

## 1. اتصال Oracle — الحقول نفسها

في MOVER: «إعدادات النظام ← Oracle» (`oracle_unit_source_v1`). في TMRKZ: «إعدادات النظام ← مصدر الموارد البشرية» (`PUT /hr/source`).

| MOVER | TMRKZ | على الخادم المعزول |
|---|---|---|
| `host_or_url` | عنوان الخادم `hostOrUrl` | قيمة MOVER نفسها |
| `port` (1521) | المنفذ `port` | قيمة MOVER نفسها |
| `server_name` + `name_type` (`service_name` أو `sid`) | `serverName` + `nameType` (`service_name` أو `sid`) | قيمة MOVER نفسها |
| `username` / كلمة المرور (مشفرة) | `username` / `password` (مشفرة بـ`TMRKZ_HR_SETTINGS_KEY`) | الحساب نفسه، للقراءة فقط |
| مصدر الجهات `unit_source` | `unitView` | الجدول/العرض نفسه |
| مصدر الأشخاص `employee_source` | `personView` | الجدول/العرض نفسه |
| `driver_mode` (thick افتراضياً، Instant Client 19.28) | JDBC thin دائماً | **فرق:** لا خيار thick في TMRKZ. يُختبر بزر «اختبار الاتصال» على Oracle الخادم |
| حد الانخفاض 10% أو 3 | `dropPercent=10` و`dropMinimum=3` | القيم نفسها |
| مزامنة كل 3 ساعات (1–24) | كل ساعة (`TMRKZ_HR_SYNC_INTERVAL_SECONDS`) | **فرق مقصود:** قرار المالك لـTMRKZ «مزامنة كل ساعة» |

## 2. تعيين الأعمدة — تعيين MOVER

| الحقل | عمود MOVER (الإصدار 1) | ملاحظة |
|---|---|---|
| معرف الجهة | `ID` | |
| الاسم / بالإنجليزية / الرمز / المستوى | `NAME` / `NAME_E` / `CODE` / `UNT_LEVEL` | |
| الجهة الأم | مسار المعرفات `SORT_ORDER` | يُعيَّن في TMRKZ بالتحويل `path_parent` |
| الوحدة الرئيسية | `MAIN_UNIT_ID` = `ID` | القاعدة نفسها (ADR-064). `UTP_ID` و`MAIN_UNIT_FLAG` لا يُعتمد عليهما |
| الجهة النشطة | `STATUS = 1` | |
| معرف الشخص | `PRS_ID` | |
| الرقم العسكري | `NEW_MILITARY_NO`، وإلا `MILITARY_NUMBER` | `first_non_empty`، والقديم في «الرقم الوظيفي السابق» |
| حساب النطاق | `PERSON_USER_ID` | به يُربط الدخول (`TMRKZ_OIDC_LINK_KEY=DOMAIN_ACCOUNT`) |
| الاسم / الرتبة / المنصب / الوظيفة | `FULL_NAME` / `FULL_GRADE_NAME` وإلا `GRADE_NAME` / `EMP_POSITION_DESC` وإلا `JOB_NAME` / `JOB_NAME` | |
| الجهة / حالة الخدمة | `ORG_UNIT_ID` / `EMP_STATUS_DESC = «في الخدمة»` | |

**صندوق Oracle على هذا الجهاز** (`mover-oracle-hr`، FREEPDB1):

- **`HR_AI` (المستخدم هنا):** 74 وحدة و100,000 شخص اصطناعيون من TNQL، لكنه بالشكل الأقدم:
  - الأب هو `MAIN_UNIT_ID`، ولا مسار معرفات ولا وحدة رئيسية.
  - لذلك عُيّن الأب من `MAIN_UNIT_ID` وتُرك حقل الوحدة الرئيسية.
- **`HRPROD`:** 76,783 وحدة، فيها `SORT_ORDER` و331 وحدة رئيسية، لكن لا `PERSON_USER_ID` لأي شخص فيه.
- **الأعمدة:** في الصندوقين اسماها `NEW_MIL_NO`/`MIL_NUMBER`، بينما تعيين MOVER المنشور يذكر `NEW_MILITARY_NO`/`MILITARY_NUMBER`. على الخادم تُختار الأعمدة كما يكشفها «اكتشاف الأعمدة».

## 3. الوحدات والأشخاص

| | MOVER | TMRKZ |
|---|---|---|
| الوحدات | تُستورد عند الحاجة: سلسلة وحدة الشخص وأسلافها، ومسار مراجعة للهيكل الكامل | **فرق مقصود (ADR-065):** المزامنة تقرأ شجرة الوحدات كاملة لتظهر كل وحدة للتمركز. القواعد نفسها: النشط، الرئيسية، الأب، حارس الانكماش |
| الأشخاص | لا نسخ جماعي. «إضافة مستخدم» بالرقم العسكري أو User ID ثم «حفظ»: شخص واحد بلا صلاحية | مثله (ADR-065) |
| البحث بالرقم | `NEW_MILITARY_NO = :n OR MILITARY_NUMBER = :n`، ثم `LIKE '%-n'` للأرقام | **أُضيف اليوم:** الرقم الجديد أو القديم. اللاحقة `-n` لم تُبنَ |
| أول دخول بلا إضافة | بحث حي بـ`PERSON_USER_ID`، فحساب بلا صلاحية وصفحة «طلب صلاحية» | مثله في وضع Oracle. قبل Oracle تأتي الوحدة من الدليل بمعرّف الوحدة (ADR-068) |

## 4. الدليل (LDAP)

| MOVER (`mover-state/config/.env`) | TMRKZ (`.env`) | على هذا الجهاز |
|---|---|---|
| `LDAP_SERVER` + `LDAP_PORT` + `LDAP_SECURITY_MODE=starttls` | `LDAP_URL=ldap://…:389` + `LDAP_START_TLS=true` | `mover-ldap:389` |
| `LDAP_CA_CERT_PATH` | ملف `.pem` في `TMRKZ_TRUSTSTORE_DIR` | «MOVER Dev LDAP CA» |
| `LDAP_BASE_DN` | `LDAP_USERS_DN` | `DC=mover,DC=local` |
| `LDAP_DOMAIN`: يربط المستخدم نفسه `user@domain` | `LDAP_DIRECT_BIND_PATTERN={username}@domain` | `{username}@mover.local` |
| لا حساب خدمة (`LDAP_BIND_DN` لاختبار الاتصال فقط) | `LDAP_BIND_DN`/`LDAP_BIND_CREDENTIAL`، حساب خدمة للقراءة لاتحاد Keycloak فقط | `svc_tmrkz_ro` |
| `MilNumber` (وإلا `employeeNumber`) | `LDAP_EMPLOYEE_NUMBER_ATTRIBUTE` | `employeeNumber` محلياً؛ على الخادم `MilNumber` |
| `MilRankName` / `MilOccupation` / `MilCurrentUnitName` | `LDAP_ATTR_RANK` / `LDAP_ATTR_POSITION` / `LDAP_ATTR_UNIT_NAME` | الأسماء نفسها، وغير موجودة في مخطط الدليل المحلي |
| الوحدة تُطابَق باسمها | `LDAP_ATTR_UNIT_ID`: **معرّف الوحدة فقط، لا الاسم** (قرار المالك) | `departmentNumber` للاختبار؛ على الخادم يُحدد الخاصية التي تحمل معرّف الوحدة |

## 5. Keycloak والزرّان

| | MOVER | TMRKZ |
|---|---|---|
| «الدخول الآلي برقم الــــ U» | Keycloak المؤسسة بـ«Authorization Code + PKCE» (`KEYCLOAK_SERVER_URL`، `_REALM`، `_CLIENT_ID`، `_CLIENT_SECRET`، `_CA_FILE`). معطّل على هذا الجهاز | Keycloak المحلي: يتحد مع الدليل نفسه، ويحمل خصائص الوظيفة. يعمل هنا مع `mover-ldap`. على الخادم: `TMRKZ_ENTERPRISE_OIDC_ISSUER/_INTERNAL_URL/_CLIENT_ID/_CLIENT_SECRET` (ADR-071)، **بعميل مسجّل لـTMRKZ، لا عميل MOVER** |
| «إدخال رقم الـــــ U وكلمة المرور يدويا» | ربط مباشر بالدليل | الشيء نفسه (ADR-070). و`admin`/`developer` عبر عميل Keycloak المحمي |

## 6. على هذا الجهاز — كيف شُغّل

1. `sh ops/local/use-mover-sources.sh`، ويفعل الآتي:
   - يربط `mover-oracle-hr` و`mover-ldap` بشبكة TMRKZ المعزولة
   - يضيف شهادة الدليل
   - ينشئ حساب Oracle `TMRKZ_HR` (قراءة العرضين فقط) وحساب الخدمة
   - يكتب مفاتيح `.env`
2. `TMRKZ_OFFLINE=1 sh ops/local/up.sh`
3. `CONFIRM=yes sh ops/keycloak/set-directory.sh tmrkz-mover`
4. `CONFIRM=yes sh ops/keycloak/set-employment-attributes.sh tmrkz-mover`
5. `node ops/local/mover-settings.mjs all`: الأدوار، ومصدر Oracle، وتعيين MOVER، والمزامنة الأولى.

**تنبيه:** ربط الحاويتين بالشبكة لا يبقى إذا أُعيد إنشاء الشبكة (`up.sh` دون `TMRKZ_OFFLINE=1`). عندها يُعاد تشغيل الخطوة 1.
