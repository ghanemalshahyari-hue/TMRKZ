import { useEffect, useState } from 'react';
import { api, type HubAction, type RequestHub } from '../api/client';
import { Heading, Icon } from '../components/ui';
import { useApp } from '../lib/app';
import { PURPOSE_HINT, PURPOSE_TITLE, UNIT_STATE, isPurpose, newRequestHashFor } from '../lib/requestPurpose';

const ACCESS = 'ACCESS_REQUEST';

/**
 * «طلب جديد»: one entry for every request (ADR-045). The server answers which cards this person has and, per unit, what may be
 * asked now and why not. A right the person lacks has no card at all; nothing here is decided in the browser.
 */
export function NewRequestPage() {
  const app = useApp();
  const [hub, setHub] = useState<RequestHub | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    api.requestHub().then(setHub).catch((e: Error) => app.toast(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);
  const title = (a: string) => (a === ACCESS ? 'طلب صلاحية' : isPurpose(a) ? PURPOSE_TITLE[a] : a);
  const hint = (a: string) => (a === ACCESS ? 'لطلب ما يلزم عملك، بنطاق محدد.' : isPurpose(a) ? PURPOSE_HINT[a] : '');
  const open = (c: HubAction) => {
    if (c.action === ACCESS) location.hash = '#requestAccess';
    else document.getElementById('hub-units')?.scrollIntoView({ behavior: 'smooth' });
  };
  const units = (hub?.units ?? []).filter((u) => !q.trim() || u.name.includes(q.trim()));
  return (
    <section data-testid="new-request">
      <Heading title="طلب جديد" description="تظهر هنا الطلبات التي تملكها فقط. يقرر الخادم ما هو متاح لكل وحدة الآن." />
      <div className="hub-cards">
        {hub?.actions.map((c) => (
          <article key={c.action} className={'card padding hub-card' + (c.allowed ? '' : ' off')} data-action={c.action} data-allowed={c.allowed}>
            <h3>{title(c.action)}</h3>
            <p className="micro muted">{hint(c.action)}</p>
            {c.allowed ? (
              c.action === 'SITE_REGISTRATION' ? (
                <a className="button primary" href={newRequestHashFor('SITE_REGISTRATION', hub.units.find((u) => u.actions.some((a) => a.action === 'SITE_REGISTRATION' && a.allowed))?.id)}>بدء الطلب</a>
              ) : (
                <button className="button primary" onClick={() => open(c)}>{c.action === ACCESS ? 'فتح الطلب' : 'اختر الوحدة'}</button>
              )
            ) : (
              <p className="micro" data-testid="hub-reason">{c.reason}</p>
            )}
          </article>
        ))}
      </div>
      {!!hub?.units.length && (
        <div className="card padding" id="hub-units" style={{ marginTop: 14 }}>
          <div className="flex spread">
            <h3>الوحدات ضمن صلاحيتك</h3>
            <label className="field inline-search"><span className="sr-only">بحث</span><input type="search" placeholder="بحث باسم الوحدة" aria-label="بحث في الوحدات" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          </div>
          <table className="table" data-testid="hub-units">
            <thead><tr><th>الوحدة</th><th>الحالة</th><th>الموقع الحالي</th><th>المتاح الآن</th></tr></thead>
            <tbody>
              {units.map((u) => (
                <tr key={u.id} data-unit={u.id} data-state={u.state}>
                  <td style={{ paddingInlineStart: 8 + u.depth * 14 }}>{u.name}</td>
                  <td>{UNIT_STATE[u.state] ?? u.state}</td>
                  <td>{u.site?.name ?? '—'}</td>
                  <td>
                    <span className="hub-actions">
                      {u.actions.filter((a) => a.action !== 'SITE_REGISTRATION').map((a) =>
                        a.allowed && isPurpose(a.action) ? (
                          <a key={a.action} className="button compact" data-go={a.action} href={newRequestHashFor(a.action, u.id, u.site?.id)}>{PURPOSE_TITLE[a.action]}</a>
                        ) : null,
                      )}
                      {u.actions.some((a) => a.openRequest) && <small className="muted">طلب مفتوح: {u.actions.find((a) => a.openRequest)?.openRequest}</small>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hub.unitsTotal > hub.units.length && <p className="micro muted">تُعرض أول {hub.units.length} وحدة من {hub.unitsTotal}.</p>}
        </div>
      )}
      {hub && hub.actions.length === 1 && !hub.units.length && (
        <p className="micro muted" style={{ marginTop: 10 }}><Icon name="shield" /> لا تملك صلاحية إنشاء طلبات تمركز؛ يمكنك طلبها من «طلب صلاحية».</p>
      )}
    </section>
  );
}
