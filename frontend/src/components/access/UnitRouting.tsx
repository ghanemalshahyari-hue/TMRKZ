import { useEffect, useState } from 'react';
import { api, type UnitOpsRoute } from '../../api/client';
import { useApp } from '../../lib/app';
import { Icon } from '../ui';
import { OrgPick } from './pickers';

/**
 * «الجهات الرئيسية للعلم»: chosen explicitly, one list for every final approval (V69). For requests, holders of «للعلم»
 * covering one read it; for re-stationing, deployment areas and site registration, the members of the unit are informed.
 * Each addition, change and removal is audited with its reason.
 */
export function FyiMains() {
  const app = useApp();
  const [mains, setMains] = useState<{ id: string; name: string; includeDescendants: boolean }[] | null>(null);
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const [below, setBelow] = useState(false);
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const load = () => api.fyiMains().then(setMains).catch(() => setMains(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);
  if (!mains) return null;
  const why = reason.trim();
  const act = (work: Promise<unknown>) =>
    work.then(() => (setReason(''), load())).catch((e: Error) => {
      app.toast(e.message);
      throw e;
    });
  const needReason = why ? undefined : 'اكتب السبب أولاً؛ يُسجَّل مع التغيير';
  return (
    <div className="padding" data-testid="fyi-mains">
      <h4>الجهات الرئيسية للعلم</h4>
      <p className="micro muted">
        قائمة واحدة لكل اعتماد نهائي. في الطلبات يراها من يحمل «للعلم» ويشمل نطاقه إحدى هذه الجهات، وفي طلبات التمركز ومناطق الانتشار وتسجيل
        المواقع يُبلَّغ أفراد الجهة نفسها. وخارجها يصل للعلم حسب الوحدة والمكان.
      </p>
      <ul className="scope-targets">
        {mains.map((m) => (
          <li key={m.id}>
            {m.name}
            {m.includeDescendants && <span className="micro muted"> — وما دونها</span>}
            <button
              className="button compact"
              aria-label={'إزالة ' + m.name}
              title={needReason}
              disabled={!why}
              onClick={() => act(api.removeFyiMain(m.id, why)).catch(() => undefined)}
            >
              <Icon name="close" />
            </button>
          </li>
        ))}
        {mains.length === 0 && <li className="muted micro">لم تُحدد جهة بعد.</li>}
      </ul>
      <label className="field">
        <span>السبب (يُسجَّل مع كل إضافة أو إزالة)</span>
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-testid="fyi-mains-reason" />
      </label>
      {adding ? (
        <>
          <OrgPick selected={pick} withBranches={below} onPick={setPick} onWithBranches={setBelow} revision={app.revision} />
          <button
            className="button compact"
            disabled={!pick || !why}
            title={needReason}
            onClick={() =>
              pick &&
              act(api.addFyiMain(pick.id, below, why))
                .then(() => (setAdding(false), setPick(null), setBelow(false)))
                .catch(() => undefined)
            }
          >
            <Icon name="plus" /> أضف {pick ? '«' + pick.name + '»' + (below ? ' وما دونها' : '') : ''}
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
