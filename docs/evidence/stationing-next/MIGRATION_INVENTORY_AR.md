# جرد الترحيلات V21 إلى V30

من الشجرة الحالية. الأرقام متصلة بلا فراغ، وكلها موجودة في المجلد `backend/src/main/resources/db/migration`.

| الإصدار | الملف | الغرض | الجداول والأعمدة | ترحيل بيانات | قابل للعكس؟ |
|---|---|---|---|---|---|
| V21 | `V21__platform_accounts.sql` | حسابا المنصة الدائمان | قيد `identity_link_method_check` | لا | نعم، بإعادة القيد |
| V22 | `V22__request_list_indexes.sql` | سرعة قائمة الطلبات | فهرسان على `request` | لا | نعم، بحذف الفهرسين |
| V23 | `V23__workflow_graph.sql` | مخطط المسارات والمسؤوليات | جداول `org_responsibility`، `org_responsibility_rule`، `request_flow_end`، وعمود `task_assignment.strict_place` | لا | نعم ما دامت الجداول فارغة |
| V24 | `V24__hr_main_unit.sql` | علم الوحدة الرئيسية من الموارد البشرية | عمود `hr_unit.is_main` | لا، يملؤه التحديث من المصدر | نعم، بحذف العمود |
| V25 | `V25__scope_approvals_and_place_info.sql` | الموافقة حسب النطاق والمستويات | `membership_scope_target.levels`، و`task_assignment.by_scope` و`independent_of_earlier` | لا | نعم إن لم تُستخدم |
| V26 | `V26__fyi_recipients.sql` | «للعلم» لكل شخص | جدولا `request_fyi` و`fyi_main_command` | لا | نعم إن كانا فارغين |
| V27 | `V27__unit_operations_routes.sql` | عمليات الوحدة حسب الوقت | جدولا `unit_ops_route` و`unit_ops_route_target`، وعمود `task_assignment.scope_orgs` | لا | نعم إن كانا فارغين |
| V28 | `V28__access_requests.sql` | طلب الصلاحيات | نوع `ACCESS` في قيد `request_type`، وجدول `access_request` | لا | نعم إن لم توجد طلبات |
| V29 | `V29__access_request_offer.sql` | القائمة المعروضة للطلب | جدول `access_request_offer` | **يزرع أربع صلاحيات تظهر لكل شخص جديد** | نعم |
| V30 | `V30__stationing_next.sql` | أنواع الطلبات، والمراحل، ووحدات العلم، ومناطق الانتشار لكل وحدة، ونطاق طلب الصلاحية | انظر التفصيل | نعم، في `deployment_area` | انظر التفصيل |

## لماذا لا يوجد قفز من V21 إلى V30

لا يوجد قفز. `main` على GitHub كان ينتهي عند V21 لأن V22 وV23 كانا في commit غير مرفوع على `flow-studio`، وV24 إلى V30 لم تكن محفوظة في Git أصلاً. طُبق V21 إلى V29 على :8088 يوم 6 نوفمبر قبل هذه المرحلة، فلا يجوز تغيير أسمائها.

## تفصيل V30

- **`restationing_request`:** أعمدة `purpose` و`fyi_done_at` و`fyi_done_by` و`fyi_note`.
- **`restationing_stage`:** قيد النوع يضيف `UNIT_OPERATIONS` و`FINAL`، وقيد الوحدة يتغير لهما.
- **`restationing_fyi`:** جدول جديد، فيه `ended_at` و`ended_by` و`end_reason`.
- **`deployment_area`:** عمودا `organization_id` و`stationing_id`، وقيد فريد جديد، وفهرسان. الصفوف القديمة تُنسخ لكل وحدة في الطلب، والمنطقة التابعة لتمركز انتهى تُحال ولا تُحذف.
- **`access_request`:** `requested_scope` و`granted_scope` و`recommend_reject` و`review_note`.
- **`site`:** `notes`.

**العكس:** لا يوجد ترحيل عكسي مكتوب. الرجوع يكون بالنسخة الاحتياطية المأخوذة قبل التطبيق.
