import { useState } from 'react';
import { api } from '../../api/client';
import type { AccessExplain, ExplainVerdict, Site } from '../../api/types';
import { useApp } from '../../lib/app';
import { fullDate } from '../../lib/dates';
import { PERMISSION_NAMES } from '../../lib/labels';
import { OrgPick, PersonPicker, SitePick } from './pickers';

function Verdict({ v }: { v: ExplainVerdict | null }) {
  if (!v) return <span className="micro muted">—</span>;
  return (
    <div>
      <b className={v.allowed ? 'good' : 'bad'}>{v.allowed ? '✓ مسموح' : '✗ غير مسموح'}</b>
      {v.reasons.map((r, i) => (
        <div key={i} className="micro explain-reason">
          «{r.role}» في «{r.organization}» — {r.scope}
          {r.validTo ? ' · حتى ' + fullDate(r.validTo) : ''}
          {r.via ? ' · ' + r.via : ''}
        </div>
      ))}
    </div>
  );
}

/**
 * "What can this person see or do, and why?" for the published policy (and the draft, if one is open), optionally for
 * an organisation, a site or a resource. Each answer lists the grants behind it; the decision service's own answer
 * for the published policy is shown beside it.
 */
export function ExplainPanel() {
  const app = useApp();
  const [personId, setPersonId] = useState('');
  const [org, setOrg] = useState<{ id: string; name: string } | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [resourceId, setResourceId] = useState('');
  const [result, setResult] = useState<AccessExplain | null>(null);
  const [busy, setBusy] = useState(false);

  const explain = async () => {
    if (!personId) return app.toast('اختر الشخص أولاً');
    setBusy(true);
    try {
      setResult(
        await api.explainAccess({
          personId,
          organizationId: org?.id,
          siteId: resourceId ? undefined : site?.id,
          resourceId: resourceId || undefined,
        }),
      );
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="access-grid">
      <section className="card padding browse-panel">
        <h3>المعاينة والاختبار</h3>
        <label className="field">
          <span>الشخص</span>
          <PersonPicker value={personId} onChange={setPersonId} />
        </label>
        <h4>الجهة — اختياري</h4>
        <OrgPick selected={org} withBranches={false} onPick={setOrg} onWithBranches={() => undefined} revision={app.revision} branchOption={false} />
        <h4>الموقع أو المورد — اختياري</h4>
        <SitePick selectedId={site?.id ?? null} onPick={(s) => (setSite(s), setResourceId(''))} revision={app.revision} />
        {site && site.resources.length > 0 && (
          <label className="field">
            <span>المورد</span>
            <select value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              <option value="">الموقع كله</option>
              {site.resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="button primary" disabled={busy} onClick={explain}>
            اعرض الصلاحيات وأسبابها
          </button>
          {(org || site) && (
            <button className="button" onClick={() => (setOrg(null), setSite(null), setResourceId(''))}>
              مسح الهدف
            </button>
          )}
        </div>
      </section>
      <section className="card">
        {!result ? (
          <div className="empty">
            اختر شخصاً، وإن شئت جهة أو موقعاً أو مورداً، لتعرف ما يستطيعه وفق السياسة المنشورة — ووفق المسودة قبل نشرها.
          </div>
        ) : (
          <>
            <div className="column-heading">
              <h3>
                {result.person.displayName} <span className="latin tiny muted">{result.person.employeeNo}</span>
              </h3>
              <span className="pill">{result.target.meaning}</span>
            </div>
            <p className="micro muted" style={{ padding: '0 18px' }}>
              {[result.target.organization?.name, result.target.site?.name, result.target.resource?.name].filter(Boolean).join(' · ') ||
                'دون هدف محدد'}
              {result.person.status !== 'ACTIVE' && ' · الشخص غير نشط: لا تُمنح له أي صلاحية'}
              {!result.openfgaAvailable && ' · خدمة القرار غير متاحة الآن'}
            </p>
            <div className="table-scroll">
              <table className="data-table explain-table">
                <thead>
                  <tr>
                    <th>الإجراء</th>
                    <th>السياسة المنشورة</th>
                    {result.draftVersion != null && <th>المسودة {result.draftVersion}</th>}
                    <th>خدمة القرار</th>
                  </tr>
                </thead>
                <tbody>
                  {result.actions.map((a) => (
                    <tr key={a.action} className={a.changed ? 'row-changed' : ''}>
                      <td>{PERMISSION_NAMES[a.action]}</td>
                      <td>
                        <Verdict v={a.published} />
                      </td>
                      {result.draftVersion != null && (
                        <td>
                          <Verdict v={a.draft} />
                        </td>
                      )}
                      <td>
                        {a.openfga == null ? (
                          <span className="micro muted">لا جواب</span>
                        ) : a.openfga === a.published.allowed ? (
                          <span className="micro good">{a.openfga ? 'يوافق: مسموح' : 'يوافق: مرفوض'}</span>
                        ) : (
                          <span className="micro bad">يختلف — يُرفض الإجراء</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="legend-note">
              مع موقع أو مورد يُقرأ السؤال: هل يستطيع الإجراء على طلب يخص هذا الموقع أو المورد{result.target.organization ? ' مقدم من الجهة المختارة' : ''}؟
              ومع جهة وحدها: هل يعمل باسمها (إنشاء طلباتها أو إدارة صلاحياتها أو مرافقها)؟ أي إجراء لا توافق عليه خدمة القرار يُرفض.
            </div>
          </>
        )}
      </section>
    </div>
  );
}
