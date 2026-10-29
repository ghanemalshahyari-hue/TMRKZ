import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Permission, RoleDef, Scope } from '../api/types';
import { Heading, Icon } from '../components/ui';
import { IdentityIssues } from '../components/IdentityIssues';
import { useApp } from '../lib/app';
import { PERMISSIONS, PERMISSION_NAMES, SCOPES } from '../lib/labels';

export function PermissionsPage() {
  const app = useApp();
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    api.roles().then(setRoles).catch((e: Error) => app.toast(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);

  const save = async (role: RoleDef, patch: Partial<Pick<RoleDef, 'permissions' | 'scope' | 'summaryOnly'>>) => {
    const next = { permissions: role.permissions, scope: role.scope, summaryOnly: role.summaryOnly, ...patch };
    setSaving(role.code);
    try {
      const updated = await api.updateRole(role.code, next);
      setRoles((rs) => rs.map((r) => (r.code === role.code ? updated : r)));
      app.toast('حُفظت صلاحيات «' + role.name + '» وسُجل التغيير في سجل التدقيق');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const toggle = (role: RoleDef, p: Permission, on: boolean) =>
    save(role, { permissions: on ? [...new Set([...role.permissions, p])] : role.permissions.filter((x) => x !== p) });

  const limited = roles.find((r) => r.summaryOnly);

  return (
    <>
      <Heading
        en="ACCESS / ROLE & RESOURCE SCOPE"
        title="مركز الصلاحيات"
        description="الإجراء المسموح ونطاق البيانات يُحددان بصورة مستقلة."
        actions={<span className="pill">يُفرض كل إجراء في الخادم عند كل طلب</span>}
      />
      <section className="card">
        <div className="column-heading">
          <h3>مصفوفة الأدوار والإجراءات</h3>
        </div>
        <div className="table-scroll">
          <table className="data-table matrix-table">
            <thead>
              <tr>
                <th>الدور</th>
                {PERMISSIONS.map((p) => (
                  <th key={p}>{PERMISSION_NAMES[p]}</th>
                ))}
                <th>نطاق البيانات</th>
                <th>عرض مختصر</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.code} className={role.system ? 'disabled' : ''}>
                  <td>
                    {role.name}
                    <br />
                    <span className="latin tiny muted">{role.code}</span>
                  </td>
                  {PERMISSIONS.map((p) => (
                    <td key={p}>
                      <input
                        type="checkbox"
                        aria-label={role.name + ' ' + PERMISSION_NAMES[p]}
                        checked={role.permissions.includes(p)}
                        disabled={role.system || saving === role.code}
                        onChange={(e) => toggle(role, p, e.target.checked)}
                      />
                    </td>
                  ))}
                  <td>
                    <select
                      aria-label={'نطاق ' + role.name}
                      value={role.scope}
                      disabled={role.system || saving === role.code}
                      onChange={(e) => save(role, { scope: e.target.value as Scope })}
                    >
                      {SCOPES.map(([id, n]) => (
                        <option key={id} value={id}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={'عرض مختصر ' + role.name}
                      checked={role.summaryOnly}
                      disabled={role.system || saving === role.code}
                      onChange={(e) => save(role, { summaryOnly: e.target.checked })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="legend-note">
          نطاق «حسب الجهة» يشمل الجهة وفروعها في عضوية الشخص؛ «حسب الموقع» يشمل الموقع ومرافقه الفرعية. ظهور الشاشة لا يمنح حق القراءة أو التعديل عبر API.
        </div>
      </section>
      <div className="settings-grid" style={{ marginTop: 18 }}>
        <section className="card padding">
          <h3>معاينة البيانات المختصرة</h3>
          <p className="micro muted" style={{ margin: '10px 0 15px' }}>
            دور «{limited?.name ?? 'اطلاع محدود'}» يعرض المرافق دون الجهة الشاغلة أو المرفقات؛ تُحذف الحقول من استجابة الخادم أصلاً.
          </p>
          <span className="micro muted">تُعاين البيانات المختصرة بالدخول بحساب يحمل هذا الدور؛ لا يوجد تبديل مستخدمين في النظام.</span>
        </section>
        <section className="card padding">
          <h3>سياسة تغيير التبعية</h3>
          <ul className="test-list">
            <li>
              <Icon name="check" />
              عضوية الشخص مؤرخة وقابلة للانتهاء؛ الانتهاء يسحب الصلاحية فوراً.
            </li>
            <li>
              <Icon name="check" />
              المهام تتبع الدور الإداري والجهة، وتعود إلى شاغلي الدور عند النقل.
            </li>
            <li>
              <Icon name="check" />
              القرارات والتوقيعات السابقة تحتفظ بصفة المعتمد وقت القرار.
            </li>
            <li>
              <Icon name="check" />
              التفويض محدد بفترة ولا يتجاوز نطاق العضوية الأصلية.
            </li>
          </ul>
          <p className="micro muted">تُقيّم الصلاحيات من قاعدة البيانات عند كل طلب، ولا تعتمد على رمز جلسة قديم.</p>
        </section>
        {app.can('MANAGE_ACCESS') && <IdentityIssues />}
      </div>
    </>
  );
}
