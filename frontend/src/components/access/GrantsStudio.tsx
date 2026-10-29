import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { GrantTargetKind, GrantView, RoleDef, Site } from '../../api/types';
import { useApp } from '../../lib/app';
import { dubaiISO, fullDate, todayDubai } from '../../lib/dates';
import { SCOPES } from '../../lib/labels';
import { Dialog, DialogHead, Icon } from '../ui';
import { OrgPick, PersonPicker, SitePick } from './pickers';

type Target = { kind: GrantTargetKind; id: string; name: string; includeDescendants: boolean };
type Form = {
  personId: string;
  personName: string;
  roleCode: string;
  positionTitle: string;
  validFrom: string;
  validTo: string;
  mode: 'ROLE' | 'CUSTOM';
  all: boolean;
  combine: 'AND' | 'OR';
  targets: Target[];
};

/** Plain-language description of a scope being built (the server returns its own wording once saved). */
export function describeScope(f: Pick<Form, 'mode' | 'all' | 'combine' | 'targets'>, role: RoleDef | undefined, homeName: string): string {
  if (f.mode === 'ROLE') {
    const s = SCOPES.find(([id]) => id === role?.scope)?.[1] ?? '';
    if (role?.scope === 'ALL') return 'نطاق الدور: جميع البيانات';
    if (role?.scope === 'ORGANIZATION') return 'نطاق الدور: الجهة «' + homeName + '» وفروعها';
    return 'نطاق الدور: ' + s + ' (يُحدد الموقع في نموذج الجهة)';
  }
  if (f.all) return 'نطاق شامل: جميع الجهات والمواقع (ممنوح صراحة)';
  const orgs = f.targets.filter((t) => t.kind === 'ORGANIZATION').map((t) => '«' + t.name + '»' + (t.includeDescendants ? ' وفروعها' : ' وحدها'));
  const sites = f.targets
    .filter((t) => t.kind !== 'ORGANIZATION')
    .map((t) => (t.kind === 'RESOURCE' ? 'المورد «' + t.name + '»' : '«' + t.name + '»' + (t.includeDescendants ? ' ومرافقه الفرعية' : ' وحده')));
  const org = orgs.length ? (orgs.length === 1 ? 'الجهة ' : 'الجهات: ') + orgs.join('، ') : '';
  const site = sites.join('، ');
  if (org && site) return f.combine === 'AND' ? org + ' — بشرط أن يكون الموقع أو المورد ضمن: ' + site : org + '، أو ' + site + ' (سياسة «أو» صريحة)';
  if (org) return org;
  if (site) return site + ' (يعمل باسم الجهة «' + homeName + '»)';
  return 'اختر هدفاً واحداً على الأقل';
}

const KIND_NAMES: Record<GrantTargetKind, string> = { ORGANIZATION: 'جهة', SITE: 'موقع', RESOURCE: 'مورد' };

/**
 * Grants of one organisation: who holds which role, over what scope (in words), for which period, granted by whom.
 * New grants are built with an explicit scope; the server refuses anything beyond the granter's own authority.
 */
export function GrantsStudio() {
  const app = useApp();
  const [org, setOrg] = useState<{ id: string; name: string } | null>(null);
  const [grants, setGrants] = useState<GrantView[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickOrg, setPickOrg] = useState<{ id: string; name: string } | null>(null);
  const [pickOrgBranches, setPickOrgBranches] = useState(true);
  const [pickSite, setPickSite] = useState<Site | null>(null);

  useEffect(() => {
    api.roles().then(setRoles).catch(() => setRoles([]));
  }, [app.revision]);

  const load = () => {
    if (!org) return setGrants([]);
    api
      .accessGrants(org.id, includeEnded)
      .then((g) => (setGrants(g), setError(null)))
      .catch((e: Error) => (setGrants([]), setError(e.message)));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [org?.id, includeEnded, app.revision]);

  const role = useMemo(() => roles.find((r) => r.code === form?.roleCode), [roles, form?.roleCode]);

  const open = () => {
    setForm({
      personId: '',
      personName: '',
      roleCode: roles.find((r) => !r.system)?.code ?? '',
      positionTitle: '',
      validFrom: todayDubai(),
      validTo: '',
      mode: 'ROLE',
      all: false,
      combine: 'AND',
      targets: [],
    });
    setPickOrg(null);
    setPickSite(null);
    setError(null);
  };

  const add = (t: Target) => {
    if (!form) return;
    if (form.targets.some((x) => x.kind === t.kind && x.id === t.id)) return;
    setForm({ ...form, targets: [...form.targets, t] });
  };

  const save = async () => {
    if (!form || !org) return;
    if (!form.personId || !form.roleCode) return setError('اختر الشخص والدور.');
    if (form.mode === 'CUSTOM' && !form.all && form.targets.length === 0) return setError('أضف هدفاً للنطاق أو اختر النطاق الشامل.');
    setBusy(true);
    try {
      const r = await api.createGrant({
        personId: form.personId,
        organizationId: org.id,
        roleCode: form.roleCode,
        positionTitle: form.positionTitle || undefined,
        validFrom: dubaiISO(form.validFrom),
        validTo: form.validTo ? dubaiISO(form.validTo) : null,
        scope:
          form.mode === 'ROLE'
            ? { mode: 'ROLE' }
            : {
                mode: 'CUSTOM',
                all: form.all,
                combine: form.combine,
                targets: form.targets.map(({ kind, id, includeDescendants }) => ({ kind, id, includeDescendants })),
              },
      });
      app.toast('أُضيفت المنحة: ' + r.scopeText);
      setForm(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const end = async (g: GrantView) => {
    const reason = prompt('سبب إنهاء منحة «' + g.role.name + '» لـ ' + g.person.displayName + ':');
    if (!reason) return;
    try {
      await api.endMembership(g.id, reason);
      app.toast('انتهت المنحة؛ يُمنع الإجراء التالي فوراً ويُحدث محرك القرار');
      load();
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  const hasOrg = form?.targets.some((t) => t.kind === 'ORGANIZATION');
  const hasSite = form?.targets.some((t) => t.kind !== 'ORGANIZATION');

  return (
    <div className="access-grid">
      <section className="card padding browse-panel">
        <h3>الجهة</h3>
        <p className="micro muted">ابحث أو افتح الشجرة تدريجياً؛ تظهر الجهات التي تملك إدارة صلاحياتها.</p>
        <OrgPick selected={org} withBranches={false} onPick={setOrg} onWithBranches={() => undefined} revision={app.revision} branchOption={false} />
      </section>
      <section className="card">
        <div className="column-heading flex spread">
          <h3>{org ? 'منح «' + org.name + '»' : 'اختر جهة لعرض منحها'}</h3>
          <div className="heading-actions">
            <label className="check-label">
              <input type="checkbox" checked={includeEnded} onChange={(e) => setIncludeEnded(e.target.checked)} /> تشمل المنتهية
            </label>
            {org && (
              <button className="button compact primary" onClick={open}>
                <Icon name="plus" /> منحة جديدة
              </button>
            )}
          </div>
        </div>
        {error && !form && <div className="error-text" role="alert">{error}</div>}
        {org && grants.length === 0 && !error && <div className="empty">لا منح في هذه الجهة.</div>}
        {grants.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>الشخص</th>
                  <th>الدور</th>
                  <th>النطاق</th>
                  <th>المدة</th>
                  <th>منحها</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.id} className={g.active ? '' : 'disabled'}>
                    <td>
                      {g.person.displayName}
                      <br />
                      <span className="latin tiny muted">{g.person.employeeNo}</span>
                    </td>
                    <td>
                      {g.role.name}
                      {g.positionTitle && <div className="micro muted">{g.positionTitle}</div>}
                    </td>
                    <td className="scope-text">
                      {g.scopeText}
                      {g.scopeMode === 'CUSTOM' && <span className="pill" style={{ marginInlineStart: 6 }}>{g.combine === 'OR' ? 'أو' : 'نطاق مخصص'}</span>}
                    </td>
                    <td className="micro">
                      {fullDate(g.validFrom)} ← {g.validTo ? fullDate(g.validTo) : 'مفتوحة'}
                      {g.endedReason && <div className="muted">{g.endedReason}</div>}
                    </td>
                    <td className="micro muted">{g.grantedBy?.name ?? '—'}</td>
                    <td>
                      {g.active && (
                        <button className="button compact danger" onClick={() => end(g)}>
                          إنهاء
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog open={!!form} onClose={() => setForm(null)} className="large-dialog">
        {form && org && (
          <>
            <DialogHead eyebrow="GRANT / NEW" title={'منحة جديدة في «' + org.name + '»'} small="المنحة مؤرخة وثابتة النطاق؛ تغيير النطاق منحة جديدة" onClose={() => setForm(null)} />
            <div className={'dialog-content grant-form' + (form.mode === 'CUSTOM' && !form.all ? ' with-pickers' : '')}>
              <div className="grant-form-main">
                <label className="field">
                  <span>الشخص</span>
                  <PersonPicker value={form.personId} onChange={(personId, p) => setForm({ ...form, personId, personName: p?.displayName ?? '' })} />
                </label>
                <label className="field">
                  <span>الدور</span>
                  <select value={form.roleCode} onChange={(e) => setForm({ ...form, roleCode: e.target.value })}>
                    {roles
                      .filter((r) => !r.system)
                      .map((r) => (
                        <option key={r.code} value={r.code}>
                          {r.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field">
                  <span>المسمى — اختياري</span>
                  <input value={form.positionTitle} onChange={(e) => setForm({ ...form, positionTitle: e.target.value })} />
                </label>
                <div className="row">
                  <label className="field">
                    <span>من</span>
                    <input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>إلى — غير مشمول، فارغ = مفتوحة</span>
                    <input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
                  </label>
                </div>
                <fieldset className="scope-mode">
                  <legend>النطاق</legend>
                  <label className="check-label">
                    <input type="radio" name="mode" checked={form.mode === 'ROLE'} onChange={() => setForm({ ...form, mode: 'ROLE' })} />
                    نطاق الدور الافتراضي
                  </label>
                  <label className="check-label">
                    <input type="radio" name="mode" checked={form.mode === 'CUSTOM'} onChange={() => setForm({ ...form, mode: 'CUSTOM' })} />
                    نطاق مخصص: جهات أو مواقع أو موارد محددة
                  </label>
                </fieldset>
                {form.mode === 'CUSTOM' && (
                  <>
                    <label className="check-label">
                      <input type="checkbox" checked={form.all} onChange={(e) => setForm({ ...form, all: e.target.checked })} />
                      نطاق شامل صريح لجميع الجهات والمواقع (لمدير صلاحيات عام فقط)
                    </label>
                    {!form.all && (
                      <>
                        <ul className="scope-targets" aria-label="أهداف النطاق">
                          {form.targets.map((t) => (
                            <li key={t.kind + t.id}>
                              <span className="pill">{KIND_NAMES[t.kind]}</span> {t.name}
                              {t.kind !== 'RESOURCE' && (
                                <label className="check-label">
                                  <input
                                    type="checkbox"
                                    checked={t.includeDescendants}
                                    onChange={(e) =>
                                      setForm({
                                        ...form,
                                        targets: form.targets.map((x) => (x === t ? { ...x, includeDescendants: e.target.checked } : x)),
                                      })
                                    }
                                  />
                                  {t.kind === 'ORGANIZATION' ? 'وفروعها' : 'ومرافقه الفرعية'}
                                </label>
                              )}
                              <button
                                className="button compact"
                                aria-label={'إزالة ' + t.name}
                                onClick={() => setForm({ ...form, targets: form.targets.filter((x) => x !== t) })}
                              >
                                <Icon name="close" />
                              </button>
                            </li>
                          ))}
                          {form.targets.length === 0 && <li className="muted micro">لم يُضف هدف بعد.</li>}
                        </ul>
                        {hasOrg && hasSite && (
                          <fieldset className="scope-mode">
                            <legend>الجمع بين الجهات والمواقع</legend>
                            <label className="check-label">
                              <input type="radio" name="combine" checked={form.combine === 'AND'} onChange={() => setForm({ ...form, combine: 'AND' })} />
                              تقاطع (افتراضي): طلبات الجهة التي تقع في المواقع المختارة فقط
                            </label>
                            <label className="check-label">
                              <input type="radio" name="combine" checked={form.combine === 'OR'} onChange={() => setForm({ ...form, combine: 'OR' })} />
                              «أو» صريحة: كل طلبات الجهة، وكل طلبات المواقع المختارة — نطاق أوسع
                            </label>
                          </fieldset>
                        )}
                      </>
                    )}
                  </>
                )}
                <div className="scope-preview" aria-live="polite">
                  <b>الصياغة:</b> {describeScope(form, role, org.name)}
                </div>
              </div>
              {form.mode === 'CUSTOM' && !form.all && (
                <div className="grant-form-pickers">
                  <h4>إضافة جهة</h4>
                  <OrgPick selected={pickOrg} withBranches={pickOrgBranches} onPick={setPickOrg} onWithBranches={setPickOrgBranches} revision={app.revision} />
                  <button
                    className="button compact"
                    disabled={!pickOrg}
                    onClick={() => pickOrg && add({ kind: 'ORGANIZATION', id: pickOrg.id, name: pickOrg.name, includeDescendants: pickOrgBranches })}
                  >
                    <Icon name="plus" /> أضف الجهة {pickOrg ? '«' + pickOrg.name + '»' : ''}
                  </button>
                  <h4>إضافة موقع أو مورد</h4>
                  <SitePick selectedId={pickSite?.id ?? null} onPick={setPickSite} revision={app.revision} />
                  {pickSite && (
                    <div className="picked-site">
                      <button className="button compact" onClick={() => add({ kind: 'SITE', id: pickSite.id, name: pickSite.name, includeDescendants: true })}>
                        <Icon name="plus" /> أضف الموقع «{pickSite.name}»
                      </button>
                      {pickSite.resources.length > 0 && (
                        <ul className="test-list">
                          {pickSite.resources.map((r) => (
                            <li key={r.id}>
                              <button className="link-button" onClick={() => add({ kind: 'RESOURCE', id: r.id, name: r.name, includeDescendants: false })}>
                                + المورد «{r.name}» وحده
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="dialog-actions">
              {error && (
                <div className="error-text grant-error" role="alert">
                  {error}
                </div>
              )}
              <button className="button primary" disabled={busy} onClick={save}>
                حفظ المنحة
              </button>
              <button className="button" onClick={() => setForm(null)}>
                إلغاء
              </button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
