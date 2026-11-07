import { useEffect, useMemo, useState } from 'react';
import { api, type GrantBody, type UnitOpsRoute } from '../../api/client';
import type { GrantView, RoleDef } from '../../api/types';
import { useApp } from '../../lib/app';
import { dubaiISO, todayDubai } from '../../lib/dates';
import { Icon } from '../ui';
import { chosenByUnits } from './GrantsStudio';
import { OrgPick } from './pickers';
import { UnitsDialog, unitCount, type UnitChoice } from './UnitsDialog';
import './unitsDialog.css';

/** The roles of a request's journey come first, in its order. */
const FIRST = ['REQUESTER', 'CHAIN_APPROVER', 'UNIT_OPERATIONS_APPROVER', 'FINAL_APPROVER', 'FYI_RECEIVER'];

type Person = { id: string; displayName: string; employeeNo: string; grants: GrantView[] };

/** How the grant reads in its cell. */
export function cellText(g: GrantView | undefined): string {
  if (!g) return 'تعيين';
  if (g.all) return 'كل الوحدات';
  const units = g.targets.filter((t) => t.kind === 'ORGANIZATION').length;
  return units ? unitCount(units) : 'وحدته';
}

/**
 * The permission matrix of one unit, as in the movement programme (ADR-042): the unit's people in rows, the roles in columns. A
 * role given over chosen units has a «تعيين» button that reads how many it covers; any other is a tick. Each change is saved at
 * once, and the server refuses what the granter may not give. A different scope is a new grant, so history stays.
 */
export function UnitMatrix() {
  const app = useApp();
  const [org, setOrg] = useState<{ id: string; name: string } | null>(null);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ person: Person; role: RoleDef; grant?: GrantView } | null>(null);
  const shown = useMemo(() => {
    const rank = (r: RoleDef) => {
      const i = FIRST.indexOf(r.code);
      return i < 0 ? FIRST.length : i;
    };
    return roles.filter((r) => !r.system).sort((a, b) => rank(a) - rank(b));
  }, [roles]);

  useEffect(() => {
    api.roles().then(setRoles).catch(() => setRoles([]));
  }, [app.revision]);

  const load = () => {
    if (!org) return setPeople([]);
    api
      .unitMatrix(org.id, q || undefined, page)
      .then((m) => (setPeople(m.people), setTotal(m.total), setError(null)))
      .catch((e: Error) => (setPeople([]), setError(e.message)));
  };
  useEffect(() => {
    const t = window.setTimeout(load, q ? 250 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id, q, page, app.revision]);

  const body = (p: Person, role: RoleDef, scope: GrantBody['scope']): GrantBody => ({
    personId: p.id,
    organizationId: org!.id,
    roleCode: role.code,
    validFrom: dubaiISO(todayDubai()),
    scope,
  });
  const run = async (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await work();
      app.toast(done);
      load();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const toggle = (p: Person, role: RoleDef, grant: GrantView | undefined) =>
    run(
      p.id + role.code,
      () => (grant ? api.endMembership(grant.id, 'تحديث الصلاحيات من مصفوفة الوحدات') : api.createGrant(body(p, role, { mode: 'ROLE' }))),
      grant ? `سُحب «${role.name}» من ${p.displayName}` : `مُنح «${role.name}» لـ ${p.displayName}`,
    );
  const saveUnits = (units: UnitChoice[], everything: boolean) => {
    if (!editing) return;
    const { person, role, grant } = editing;
    setEditing(null);
    const scope = {
      mode: 'CUSTOM' as const,
      all: everything,
      targets: everything ? [] : units.map((u) => ({ kind: 'ORGANIZATION' as const, id: u.id, includeDescendants: u.mode !== 'ONE', levels: u.mode === 'LEVELS' ? u.levels : undefined })),
    };
    if (!everything && !units.length) {
      if (grant) void toggle(person, role, grant);
      return;
    }
    void run(
      person.id + role.code,
      () => (grant ? api.replaceGrant(grant.id, body(person, role, scope)) : api.createGrant(body(person, role, scope))),
      `حُفظ «${role.name}» لـ ${person.displayName}`,
    );
  };
  const existing = (g: GrantView | undefined): UnitChoice[] => {
    if (!g) return [];
    const named = g.targets.filter((t) => t.kind === 'ORGANIZATION');
    if (named.length) return named.map((t) => ({ id: t.id, name: t.name, mode: t.levels?.length ? 'LEVELS' : t.includeDescendants ? 'BRANCH' : 'ONE', levels: t.levels ?? [] }));
    return g.all || !g.organization ? [] : [{ id: g.organization.id, name: g.organization.name, mode: 'BRANCH', levels: [] }];
  };

  return (
    <div className="access-grid" data-testid="unit-matrix">
      <section className="card padding browse-panel">
        <h3>الوحدة</h3>
        <OrgPick selected={org} withBranches={false} onPick={(o) => (setOrg(o), setPage(0))} onWithBranches={() => undefined} revision={app.revision} branchOption={false} />
      </section>
      <section className="card">
        <div className="column-heading flex spread">
          <h3>{org ? 'صلاحيات «' + org.name + '»' : 'اختر وحدة لعرض أفرادها'}</h3>
          {org && <input type="search" aria-label="بحث في الأفراد" placeholder="بحث بالاسم أو الرقم…" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} />}
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
        {org && !people.length && !error && <div className="empty">لا يوجد أفراد في هذه الوحدة.</div>}
        {people.length > 0 && (
          <div className="table-scroll">
            <table className="data-table matrix-table unit-matrix">
              <thead>
                <tr>
                  <th>الشخص</th>
                  {shown.map((r) => <th key={r.code}>{r.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id} data-person={p.id}>
                    <td>
                      {p.displayName}
                      <br />
                      <span className="latin tiny muted">{p.employeeNo}</span>
                    </td>
                    {shown.map((role) => {
                      const grant = p.grants.find((g) => g.role.code === role.code && g.active);
                      return (
                        <td key={role.code} title={grant?.scopeText}>
                          {chosenByUnits(role) ? (
                            <button className={'button compact' + (grant ? ' primary' : '')} disabled={busy === p.id + role.code} data-cell={role.code} onClick={() => setEditing({ person: p, role, grant })}>
                              {cellText(grant)}
                            </button>
                          ) : (
                            <input type="checkbox" aria-label={role.name + ' — ' + p.displayName} data-cell={role.code} disabled={busy === p.id + role.code} checked={!!grant} onChange={() => toggle(p, role, grant)} />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > 25 && (
          <div className="flex spread padding">
            <button className="button compact" disabled={page === 0} onClick={() => setPage(page - 1)}>السابق</button>
            <span className="micro muted">{(page + 1).toLocaleString('en-US')} من {Math.ceil(total / 25).toLocaleString('en-US')} · {total.toLocaleString('en-US')} شخص</span>
            <button className="button compact" disabled={(page + 1) * 25 >= total} onClick={() => setPage(page + 1)}>التالي</button>
          </div>
        )}
        {org && <UnitOpsRoutes command={org} />}
        <FyiMains />
      </section>
      {editing && org && (
        <UnitsDialog
          roleName={editing.role.name}
          home={org}
          finalApprover={editing.role.permissions.includes('APPROVE')}
          everything={!!editing.grant?.all}
          value={existing(editing.grant)}
          onSave={saveUnits}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** «الجهات الرئيسية للعلم»: chosen explicitly. Holders of «للعلم» covering one read every finally approved request. */
function FyiMains() {
  const app = useApp();
  const [mains, setMains] = useState<{ id: string; name: string }[] | null>(null);
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api.fyiMains().then(setMains).catch(() => setMains(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);
  if (!mains) return null;
  const act = (work: Promise<unknown>) => work.then(load).catch((e: Error) => app.toast(e.message));
  return (
    <div className="padding" data-testid="fyi-mains">
      <h4>الجهات الرئيسية للعلم</h4>
      <p className="micro muted">من يحمل «للعلم» ويشمل نطاقه إحداها يرى كل طلب بعد اعتماده النهائي. وخارجها يصل للعلم حسب الوحدة والمكان.</p>
      <ul className="scope-targets">
        {mains.map((m) => (
          <li key={m.id}>
            {m.name}
            <button className="button compact" aria-label={'إزالة ' + m.name} onClick={() => act(api.removeFyiMain(m.id))}><Icon name="close" /></button>
          </li>
        ))}
        {mains.length === 0 && <li className="muted micro">لم تُحدد جهة بعد.</li>}
      </ul>
      {adding ? (
        <>
          <OrgPick selected={pick} withBranches={false} onPick={setPick} onWithBranches={() => undefined} revision={app.revision} branchOption={false} />
          <button className="button compact" disabled={!pick} onClick={() => pick && act(api.addFyiMain(pick.id)).then(() => (setAdding(false), setPick(null)))}>
            <Icon name="plus" /> أضف {pick ? '«' + pick.name + '»' : ''}
          </button>
        </>
      ) : (
        <button className="button compact" onClick={() => setAdding(true)}><Icon name="plus" /> إضافة جهة</button>
      )}
    </div>
  );
}

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

/**
 * «اعتماد عمليات الوحدة حسب الوقت», as in the movement programme (ADR-042): which units receive the step in which period. Its
 * people act; when a schedule exists and no period covers the time, a request is refused before it is sent. The periods of the
 * nearest command up to the main unit decide, and a later edit affects new requests only.
 */
function UnitOpsRoutes({ command }: { command: { id: string; name: string } }) {
  const app = useApp();
  const [routes, setRoutes] = useState<UnitOpsRoute[] | null>(null);
  const [form, setForm] = useState<{ name: string; from: string; to: string; days: number[]; targets: { id: string; name: string }[] } | null>(null);
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    setForm(null);
    api.unitOpsRoutes(command.id).then(setRoutes).catch(() => setRoutes(null));
  }, [command.id, app.revision]);
  if (!routes) return null;
  const save = (next: { name: string; from: string; to: string; days: number[]; active: boolean; targets: string[] }[]) =>
    api
      .saveUnitOpsRoutes(command.id, next)
      .then((r) => (setRoutes(r), setForm(null), app.toast('حُفظت الفترات؛ تسري على الطلبات الجديدة')))
      .catch((e: Error) => app.toast(e.message));
  const plain = routes.map((r) => ({ name: r.name, from: r.from, to: r.to, days: r.days, active: r.active, targets: r.targets.map((t) => t.id) }));
  return (
    <div className="padding" data-testid="unit-ops-routes">
      <h4>اعتماد عمليات الوحدة حسب الوقت</h4>
      <p className="micro muted">اختياري. عند وجود فترات يعتمد الخطوةَ أفرادُ الجهة المستلمة في تلك الفترة، وإذا كان الوقت خارج كل الفترات يُرفض إرسال الطلب.</p>
      <ul className="scope-targets">
        {routes.map((r, i) => (
          <li key={r.id}>
            <b>{r.name}</b> {r.from} ← {r.to} · {r.days.length === 7 ? 'كل الأيام' : r.days.map((d) => DAYS[d]).join('، ')} · {r.targets.map((t) => t.name).join('، ')}
            <button className="button compact" aria-label={'حذف ' + r.name} onClick={() => save(plain.filter((_, j) => j !== i))}><Icon name="close" /></button>
          </li>
        ))}
        {routes.length === 0 && <li className="muted micro">لا توجد فترات: تذهب الخطوة إلى أقرب معتمد يشمل نطاقه الوحدة.</li>}
      </ul>
      {form ? (
        <div className="grant-form-main">
          <label className="field"><span>اسم الفترة</span><input aria-label="اسم الفترة" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <div className="row">
            <label className="field"><span>من</span><input aria-label="من الساعة" type="time" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></label>
            <label className="field"><span>إلى</span><input aria-label="إلى الساعة" type="time" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></label>
          </div>
          <div className="ud-levels" role="group" aria-label="أيام الفترة">
            {DAYS.map((d, i) => (
              <label key={d}>
                <input type="checkbox" checked={form.days.includes(i)} onChange={(e) => setForm({ ...form, days: e.target.checked ? [...form.days, i] : form.days.filter((x) => x !== i) })} /> {d}
              </label>
            ))}
          </div>
          <h4>الجهات المستلمة</h4>
          <OrgPick selected={pick} withBranches={false} onPick={setPick} onWithBranches={() => undefined} revision={app.revision} branchOption={false} />
          <button className="button compact" disabled={!pick} onClick={() => pick && !form.targets.some((t) => t.id === pick.id) && setForm({ ...form, targets: [...form.targets, pick] })}>
            <Icon name="plus" /> أضف {pick ? '«' + pick.name + '»' : ''}
          </button>
          <ul className="scope-targets">
            {form.targets.map((t) => (
              <li key={t.id}>{t.name}<button className="button compact" aria-label={'إزالة ' + t.name} onClick={() => setForm({ ...form, targets: form.targets.filter((x) => x.id !== t.id) })}><Icon name="close" /></button></li>
            ))}
          </ul>
          <button className="button compact primary" disabled={!form.name.trim() || !form.days.length || !form.targets.length} onClick={() => save([...plain, { name: form.name, from: form.from, to: form.to, days: form.days, active: true, targets: form.targets.map((t) => t.id) }])}>حفظ الفترة</button>
          <button className="button compact" onClick={() => setForm(null)}>إلغاء</button>
        </div>
      ) : (
        <button className="button compact" onClick={() => setForm({ name: '', from: '07:00', to: '15:00', days: [0, 1, 2, 3, 4], targets: [] })}><Icon name="plus" /> إضافة فترة</button>
      )}
    </div>
  );
}
