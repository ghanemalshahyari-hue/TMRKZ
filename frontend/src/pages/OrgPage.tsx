import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Delegation, Member, OrgDetail, RoleDef } from '../api/types';
import { PersonPicker } from '../components/access/pickers';
import { OrgSymbol, SymbolAssignment, SymbolLegend } from '../components/UnitSymbol';
import { Dialog, DialogHead, Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { addDays, dubaiISO, fullDate, todayDubai } from '../lib/dates';

type MembershipForm = { personId: string; roleCode: string; positionTitle: string; validFrom: string; validTo: string };
type DelegationForm = { membership: Member; delegateId: string; validFrom: string; validTo: string; reason: string };

export function OrgPage() {
  const app = useApp();
  const { orgs, revision } = app;
  const canConfigure = app.can('MANAGE_ACCESS');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [membershipForm, setMembershipForm] = useState<MembershipForm | null>(null);
  const [delegationForm, setDelegationForm] = useState<DelegationForm | null>(null);
  const [formError, setFormError] = useState('');
  const current = selected ?? orgs[0]?.id ?? null;

  useEffect(() => {
    if (!current) return;
    api
      .org(current)
      .then(setDetail)
      .catch((e: Error) => app.toast(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, revision]);

  useEffect(() => {
    api
      .delegations()
      .then(setDelegations)
      .catch(() => setDelegations([]));
    if (canConfigure)
      api
        .roles()
        .then(setRoles)
        .catch(() => setRoles([]));
  }, [revision, canConfigure]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setFormError('');
    try {
      await fn();
      app.toast(ok);
      app.bump();
      return true;
    } catch (e) {
      setFormError((e as Error).message);
      app.toast((e as Error).message);
      return false;
    }
  };

  const endMembership = async (m: Member) => {
    const reason = window.prompt('سبب إنهاء العضوية (يسجل في سجل التدقيق):', 'نقل إلى جهة أخرى');
    if (!reason) return;
    await run(() => api.endMembership(m.membershipId, reason), 'انتهت العضوية؛ تُسحب صلاحيات الجهة فوراً وتبقى القرارات السابقة بصفتها التاريخية');
  };

  const saveMembership = async () => {
    if (!membershipForm || !current) return;
    const f = membershipForm;
    if (!f.personId || !f.roleCode || !f.validFrom) return setFormError('أكمل الشخص والدور وتاريخ البداية.');
    const ok = await run(
      () =>
        api.createMembership({
          personId: f.personId,
          organizationId: current,
          roleCode: f.roleCode,
          positionTitle: f.positionTitle || undefined,
          validFrom: dubaiISO(f.validFrom),
          validTo: f.validTo ? dubaiISO(f.validTo) : null,
        }),
      'أُضيفت العضوية المؤرخة',
    );
    if (ok) setMembershipForm(null);
  };

  const saveDelegation = async () => {
    if (!delegationForm) return;
    const f = delegationForm;
    if (!f.delegateId || !f.validFrom || !f.validTo || f.reason.trim().length < 5) return setFormError('أكمل المفوَّض إليه والفترة وسبب التفويض.');
    const ok = await run(
      () =>
        api.createDelegation({
          delegateId: f.delegateId,
          membershipId: f.membership.membershipId,
          validFrom: dubaiISO(f.validFrom),
          validTo: dubaiISO(f.validTo),
          reason: f.reason.trim(),
        }),
      'سُجل التفويض؛ لا يتجاوز نطاق العضوية الأصلية',
    );
    if (ok) setDelegationForm(null);
  };

  const revoke = async (d: Delegation) => {
    const reason = window.prompt('سبب إلغاء التفويض:', 'انتهاء الحاجة');
    if (!reason) return;
    await run(() => api.revokeDelegation(d.id, reason), 'أُلغي التفويض؛ تتوقف الإجراءات المفوضة فوراً');
  };

  const root = orgs.find((o) => o.depth === 0);
  const name = detail?.org.name ?? root?.name ?? 'المؤسسة';

  return (
    <>
      <Heading
        en="ORGANIZATION / MEMBERSHIP & SCOPE"
        title="الهيكل التنظيمي"
        description="الجهة والموقع سجّلان مستقلان، ويرتبطان بالحجوزات والطلبات."
        actions={<span className="pill">{orgs.length} جهة ضمن نطاقك</span>}
      />
      <div className="org-layout">
        <aside className="card org-tree">
          <h3>شجرة الجهات</h3>
          <div className="org-nodes">
            {orgs.map((o) => (
              <button
                key={o.id}
                className={'org-node ' + (o.depth > 0 ? 'child ' : '') + (current === o.id ? 'active' : '')}
                style={o.depth > 1 ? { marginRight: (o.depth - 1) * 14 } : undefined}
                onClick={() => setSelected(o.id)}
              >
                <OrgSymbol orgId={o.id} size={20} />
                {o.name}
                <small>{String(o.depth === 0 ? o.children.length : o.siteCount).padStart(2, '0')}</small>
              </button>
            ))}
          </div>
        </aside>
        <div className="stack">
          <section className="card org-summary">
            <span className="eyebrow">ORGANIZATION / {detail?.org.code ?? 'PROFILE'}</span>
            <div className="org-identity">
              <OrgSymbol orgId={current} size={44} withText />
              <h2>{name}</h2>
            </div>
            <SymbolLegend />
            {app.can('CONFIGURE') && current && <SymbolAssignment key={current} orgId={current} orgName={name} />}
            <p className="micro muted" style={{ marginTop: 7 }}>
              العضويات مؤرخة؛ انتهاء العضوية يسحب صلاحية الجهة فوراً في الخادم.
            </p>
            <div className="org-members">
              {(detail?.members ?? [])
                .filter((m) => m.active)
                .slice(0, 8)
                .map((m, i) => (
                  <div key={m.membershipId} className="member">
                    <span className="avatar">{String(i + 1).padStart(2, '0')}</span>
                    <span>
                      <b>{m.person.displayName}</b>
                      <small>{m.positionTitle || m.role.name}</small>
                    </span>
                  </div>
                ))}
              {detail && !detail.members.some((m) => m.active) && <p className="micro muted">لا توجد عضويات نشطة في هذه الجهة.</p>}
            </div>
          </section>
          <section className="card">
            <div className="column-heading flex spread">
              <h3>العضويات المؤرخة</h3>
              {canConfigure && current && (
                <button
                  className="button compact primary"
                  onClick={() => {
                    setFormError('');
                    setMembershipForm({ personId: '', roleCode: roles[0]?.code ?? '', positionTitle: '', validFrom: todayDubai(), validTo: '' });
                  }}
                >
                  ＋ عضوية
                </button>
              )}
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>الشخص</th>
                    <th>الدور</th>
                    <th>النطاق</th>
                    <th>من</th>
                    <th>إلى</th>
                    <th>الحالة</th>
                    <th>إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail?.members ?? []).map((m) => (
                    <tr key={m.membershipId}>
                      <td>
                        {m.person.displayName}
                        <br />
                        <span className="latin tiny muted">{m.person.employeeNo}</span>
                      </td>
                      <td>{m.role.name}</td>
                      <td>{m.site?.name ?? 'الجهة'}</td>
                      <td>{fullDate(m.validFrom)}</td>
                      <td>{m.validTo ? fullDate(m.validTo) : 'مستمرة'}</td>
                      <td>
                        <span className={'pill ' + (m.active ? 'green' : '')}>{m.active ? 'نشطة' : 'منتهية'}</span>
                      </td>
                      <td>
                        {m.active && canConfigure && (
                          <button className="button compact danger" onClick={() => endMembership(m)}>
                            إنهاء
                          </button>
                        )}
                        {m.active && m.person.id === app.me.id && (
                          <button
                            className="button compact"
                            style={{ marginInlineStart: 6 }}
                            onClick={() => {
                              setFormError('');
                              setDelegationForm({ membership: m, delegateId: '', validFrom: todayDubai(), validTo: addDays(todayDubai(), 7), reason: '' });
                            }}
                          >
                            تفويض
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {detail && !detail.members.length && (
                    <tr>
                      <td colSpan={7} className="empty">
                        لا توجد عضويات
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <div className="column-heading">
              <h3>المرافق المرتبطة</h3>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>المرفق</th>
                    <th>التصنيف</th>
                    <th>السعة</th>
                    <th>إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail?.sites ?? []).map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>{s.kind}</td>
                      <td>{s.capacity ?? '—'}</td>
                      <td>
                        <button
                          className="button compact"
                          onClick={() => {
                            app.setSelectedSiteId(s.id);
                            app.navigate('map');
                          }}
                        >
                          على الخريطة
                        </button>
                      </td>
                    </tr>
                  ))}
                  {detail && !detail.sites.length && (
                    <tr>
                      <td colSpan={4} className="empty">
                        لا توجد مرافق مسؤولة عنها هذه الجهة
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <div className="column-heading">
              <h3>التفويضات</h3>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>المفوِّض</th>
                    <th>المفوَّض إليه</th>
                    <th>الدور والجهة</th>
                    <th>الفترة</th>
                    <th>الحالة</th>
                    <th>إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {delegations.map((d) => (
                    <tr key={d.id}>
                      <td>{d.delegator.name}</td>
                      <td>{d.delegate.name}</td>
                      <td>
                        {d.role.name} · {d.organization.name}
                      </td>
                      <td>
                        {fullDate(d.validFrom)} ← {fullDate(d.validTo)}
                      </td>
                      <td>
                        <span className={'pill ' + (d.active ? 'green' : d.revokedAt ? 'red' : '')}>{d.active ? 'نشط' : d.revokedAt ? 'ملغى' : 'منتهٍ'}</span>
                      </td>
                      <td>
                        {d.active && (canConfigure || d.delegator.id === app.me.id) && (
                          <button className="button compact danger" onClick={() => revoke(d)}>
                            إلغاء
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!delegations.length && (
                    <tr>
                      <td colSpan={6} className="empty">
                        لا توجد تفويضات ضمن نطاقك
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <div className="note">
            تغيير تبعية الشخص يعيد تحديد نطاقه فوراً. تبقى الطلبات مرتبطة بالجهة، وتُحفظ هوية المعتمد وصفته وقت القرار، وتعود المهام المفتوحة إلى شاغلي الدور.
          </div>
        </div>
      </div>

      <Dialog open={!!membershipForm} onClose={() => setMembershipForm(null)} className="small-dialog">
        {membershipForm && (
          <>
            <DialogHead eyebrow="MEMBERSHIP / NEW" title={'عضوية في ' + name} onClose={() => setMembershipForm(null)} />
            <div className="dialog-content">
              <label className="field">
                <span>الشخص</span>
                <PersonPicker value={membershipForm.personId} onChange={(personId) => setMembershipForm({ ...membershipForm, personId })} />
              </label>
              <label className="field">
                <span>الدور</span>
                <select value={membershipForm.roleCode} onChange={(e) => setMembershipForm({ ...membershipForm, roleCode: e.target.value })}>
                  {roles.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>المسمى — اختياري</span>
                <input value={membershipForm.positionTitle} onChange={(e) => setMembershipForm({ ...membershipForm, positionTitle: e.target.value })} />
              </label>
              <div className="row">
                <label className="field">
                  <span>من</span>
                  <input type="date" value={membershipForm.validFrom} onChange={(e) => setMembershipForm({ ...membershipForm, validFrom: e.target.value })} />
                </label>
                <label className="field">
                  <span>إلى — غير مشمول، اختياري</span>
                  <input type="date" value={membershipForm.validTo} onChange={(e) => setMembershipForm({ ...membershipForm, validTo: e.target.value })} />
                </label>
              </div>
              <div className="error-text" role="alert">
                {formError}
              </div>
            </div>
            <div className="dialog-actions">
              <button className="button primary" onClick={saveMembership}>
                حفظ العضوية
              </button>
              <button className="button" onClick={() => setMembershipForm(null)}>
                إلغاء
              </button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog open={!!delegationForm} onClose={() => setDelegationForm(null)} className="small-dialog">
        {delegationForm && (
          <>
            <DialogHead
              eyebrow="DELEGATION / NEW"
              title={'تفويض دور ' + delegationForm.membership.role.name}
              small="لا يمنح التفويض صلاحية أوسع من العضوية الأصلية"
              onClose={() => setDelegationForm(null)}
            />
            <div className="dialog-content">
              <label className="field">
                <span>المفوَّض إليه</span>
                <PersonPicker value={delegationForm.delegateId} onChange={(delegateId) => setDelegationForm({ ...delegationForm, delegateId })} />
              </label>
              <div className="row">
                <label className="field">
                  <span>من</span>
                  <input type="date" value={delegationForm.validFrom} onChange={(e) => setDelegationForm({ ...delegationForm, validFrom: e.target.value })} />
                </label>
                <label className="field">
                  <span>إلى — غير مشمول</span>
                  <input type="date" value={delegationForm.validTo} onChange={(e) => setDelegationForm({ ...delegationForm, validTo: e.target.value })} />
                </label>
              </div>
              <label className="field">
                <span>سبب التفويض</span>
                <textarea value={delegationForm.reason} onChange={(e) => setDelegationForm({ ...delegationForm, reason: e.target.value })} />
              </label>
              <div className="error-text" role="alert">
                {formError}
              </div>
            </div>
            <div className="dialog-actions">
              <button className="button primary" onClick={saveDelegation}>
                تسجيل التفويض
              </button>
              <button className="button" onClick={() => setDelegationForm(null)}>
                إلغاء
              </button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
