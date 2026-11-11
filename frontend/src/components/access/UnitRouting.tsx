import { useEffect, useState } from 'react';
import { api, type UnitOpsRoute } from '../../api/client';
import { useApp } from '../../lib/app';
import { Icon } from '../ui';
import { OrgPick } from './pickers';

/** «الجهات الرئيسية للعلم»: chosen explicitly. Holders of «للعلم» covering one read every finally approved request. */
export function FyiMains() {
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
export function UnitOpsRoutes({ command }: { command: { id: string; name: string } }) {
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
