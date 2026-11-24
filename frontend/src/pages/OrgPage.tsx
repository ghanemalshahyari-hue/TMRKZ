import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Delegation, Member, OrgDetail, RoleDef } from '../api/types';
import { pickableRoles } from '../lib/rolePicker';
import { PersonPicker } from '../components/access/pickers';
import { OrgSymbol, SymbolAssignment, SymbolLegend } from '../components/UnitSymbol';
import { Icon } from '../components/ui';
import { rememberReturn } from '../lib/returnContext';
import { flatSource } from '../components/tree/tree';
import { UnitTree } from '../components/tree/UnitTree';
import { Dialog, DialogHead, Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { addDays, dubaiISO, fullDate, todayDubai } from '../lib/dates';
import { stationingSiteHash } from '../lib/stationingLink';

type MembershipForm = { personId: string; roleCode: string; positionTitle: string; validFrom: string; validTo: string };
type DelegationForm = { membership: Member; delegateId: string; validFrom: string; validTo: string; reason: string };
type UnitForm = { code: string; name: string; parentId: string };
type UnitEditForm = { name: string; parentId: string };
type LevelItem = { level: number; name: string; unitCount: number };

export function OrgPage() {
  const app = useApp();
  const { orgs, revision } = app;
  const canConfigure = app.can('MANAGE_ACCESS');
  const canAdmin = app.can('CONFIGURE');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [membershipForm, setMembershipForm] = useState<MembershipForm | null>(null);
  const [delegationForm, setDelegationForm] = useState<DelegationForm | null>(null);
  const [createUnitForm, setCreateUnitForm] = useState<UnitForm | null>(null);
  const [editUnitForm, setEditUnitForm] = useState<UnitEditForm | null>(null);
  const [levels, setLevels] = useState<LevelItem[]>([]);
  const [levelName, setLevelName] = useState('');
  const [levelNum, setLevelNum] = useState(1);
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
    if (canAdmin)
      api.levels().then(setLevels).catch(() => setLevels([]));
  }, [revision, canConfigure, canAdmin]);

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

  const saveUnit = async () => {
    if (!createUnitForm) return;
    const f = createUnitForm;
    if (!f.code.trim() || !f.name.trim()) return setFormError('أكمل رمز الوحدة واسمها.');
    const ok = await run(() => api.createUnit({ code: f.code.trim(), name: f.name.trim(), parentId: f.parentId || undefined }), 'أُنشئت الوحدة');
    if (ok) setCreateUnitForm(null);
  };

  const saveUnitEdit = async () => {
    if (!editUnitForm || !current) return;
    if (!editUnitForm.name.trim()) return setFormError('اسم الوحدة مطلوب.');
    const ok = await run(() => api.updateUnit(current, { name: editUnitForm.name.trim(), parentId: editUnitForm.parentId || null }), 'حُدثت بيانات الوحدة');
    if (ok) setEditUnitForm(null);
  };

  const retireUnit = async () => {
    if (!current) return;
    const reason = window.prompt('سبب إيقاف الوحدة (يسجل في سجل التدقيق):', '');
    if (!reason) return;
    await run(() => api.retireUnit(current, reason), 'أُوقفت الوحدة');
  };

  const setEmployeeNo = async (personId: string, displayName: string) => {
    const newNo = window.prompt('الرقم الوظيفي الجديد لـ ' + displayName + ':', '');
    if (!newNo) return;
    await run(() => api.setEmployeeNo(personId, newNo.trim()), 'حُدث الرقم الوظيفي');
  };

  const saveLevel = async () => {
    if (!levelName.trim()) return setFormError('اسم المستوى مطلوب.');
    const ok = await run(() => api.setLevel(levelNum, levelName.trim()), 'حُفظ المستوى');
    if (ok) { setLevelName(''); setLevelNum(Math.max(...levels.map((l) => l.level), 0) + 1); }
  };

  const removeLevel = async (l: LevelItem) => {
    if (!window.confirm('حذف المستوى ' + l.level + ' (' + l.name + ')؟')) return;
    await run(() => api.deleteLevel(l.level), 'حُذف المستوى');
  };

  const root = orgs.find((o) => o.depth === 0);
  const tree = useMemo(() => flatSource(orgs), [orgs]);
  const name = detail?.org.name ?? root?.name ?? 'المؤسسة';

  return (
    <>
      <Heading
        en="ORGANIZATION / MEMBERSHIP & SCOPE"
        title="الهيكل التنظيمي"
        description="الجهة والموقع سجّلان مستقلان، ويرتبطان بالحجوزات والطلبات."
        actions={<>
          <span className="pill">{orgs.length} جهة ضمن نطاقك</span>
          {canAdmin && <button className="button compact primary" onClick={() => { setFormError(''); setCreateUnitForm({ code: '', name: '', parentId: current ?? '' }); }}>＋ وحدة جديدة</button>}
        </>}
      />
      <div className="org-layout">
        <aside className="card org-tree">
          <h3>شجرة الجهات</h3>
          {/* the one units tree of the application (owner, 16 Nov 2026), not a page-made list of nested cards */}
          <UnitTree
            source={tree}
            label="شجرة الجهات"
            searchLabel="البحث في شجرة الجهات"
            search="ابحث عن جهة بالاسم…"
            selected={current}
            trail={tree.trail(current)}
            openSingleRoot
            onSelect={(o) => setSelected(o.id)}
            icon={(o) => <OrgSymbol orgId={o.id} size={18} />}
            meta={(o) => (o.siteCount ? o.siteCount + ' موقع' : null)}
            testId="org-page-tree"
          />
        </aside>
        <div className="stack">
          <section className="card org-summary">
            <span className="eyebrow">ORGANIZATION / {detail?.org.code ?? 'PROFILE'}</span>
            <div className="org-identity">
              <OrgSymbol orgId={current} size={44} withText />
              <h2>{name}</h2>
            </div>
            {app.can('CREATE_RESTATIONING') && current && (
              <div className="flex" style={{ gap: 8, margin: '8px 0 6px' }}>
                {/* Owner UX consolidation §5 (20 Nov 2026): the unit → مساحة التمركز path, with the unit preselected. */}
                <a
                  className="button compact primary"
                  data-testid="org-start-restation"
                  href={'#restationing/new?unit=' + current + '&purpose=RESTATIONING'}
                  onClick={() => rememberReturn('#org')}
                >
                  <Icon name="map" /> طلب إعادة تمركز لهذه الوحدة
                </a>
              </div>
            )}
            <SymbolLegend />
            {app.can('CONFIGURE') && current && <SymbolAssignment key={current} orgId={current} orgName={name} />}
            {canAdmin && detail && (
              <div className="flex" style={{ gap: 8, margin: '8px 0 0' }}>
                <button className="button compact" onClick={() => { setFormError(''); setEditUnitForm({ name: detail.org.name, parentId: detail.org.parentId ?? '' }); }}>تعديل الوحدة</button>
                {detail.org.status === 'ACTIVE' && <button className="button compact danger" onClick={retireUnit}>إيقاف الوحدة</button>}
              </div>
            )}
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
                    setMembershipForm({ personId: '', roleCode: pickableRoles(roles, { system: true })[0]?.code ?? '', positionTitle: '', validFrom: todayDubai(), validTo: '' });
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
                        {canAdmin && m.person.id && <button className="text-link" style={{ marginInlineStart: 6 }} onClick={() => setEmployeeNo(m.person.id, m.person.displayName)}>تغيير الرقم</button>}
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
                            // opens «مساحة التمركز» on this site with this organisation selected (V-09)
                            app.setSelectedSiteId(s.id);
                            location.hash = stationingSiteHash(s.id, current);
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
                  {pickableRoles(roles, { system: true }).map((r) => (
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

      {/* Create Unit Dialog */}
      <Dialog open={!!createUnitForm} onClose={() => setCreateUnitForm(null)} className="small-dialog">
        {createUnitForm && (
          <>
            <DialogHead eyebrow="ORGANIZATION / NEW" title="وحدة جديدة" onClose={() => setCreateUnitForm(null)} />
            <div className="dialog-content">
              <label className="field"><span>رمز الوحدة</span><input dir="ltr" value={createUnitForm.code} onChange={(e) => setCreateUnitForm({ ...createUnitForm, code: e.target.value })} /></label>
              <label className="field"><span>اسم الوحدة</span><input value={createUnitForm.name} onChange={(e) => setCreateUnitForm({ ...createUnitForm, name: e.target.value })} /></label>
              <label className="field"><span>الوحدة الأم — اختياري</span>
                <select value={createUnitForm.parentId} onChange={(e) => setCreateUnitForm({ ...createUnitForm, parentId: e.target.value })}>
                  <option value="">بلا (جذر)</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{'—'.repeat(o.depth)} {o.name}</option>)}
                </select>
              </label>
              <div className="error-text" role="alert">{formError}</div>
            </div>
            <div className="dialog-actions">
              <button className="button primary" onClick={saveUnit}>إنشاء</button>
              <button className="button" onClick={() => setCreateUnitForm(null)}>إلغاء</button>
            </div>
          </>
        )}
      </Dialog>

      {/* Edit Unit Dialog */}
      <Dialog open={!!editUnitForm} onClose={() => setEditUnitForm(null)} className="small-dialog">
        {editUnitForm && (
          <>
            <DialogHead eyebrow="ORGANIZATION / EDIT" title={'تعديل ' + name} onClose={() => setEditUnitForm(null)} />
            <div className="dialog-content">
              <label className="field"><span>اسم الوحدة</span><input value={editUnitForm.name} onChange={(e) => setEditUnitForm({ ...editUnitForm, name: e.target.value })} /></label>
              <label className="field"><span>الوحدة الأم</span>
                <select value={editUnitForm.parentId} onChange={(e) => setEditUnitForm({ ...editUnitForm, parentId: e.target.value })}>
                  <option value="">بلا (جذر)</option>
                  {orgs.filter((o) => o.id !== current).map((o) => <option key={o.id} value={o.id}>{'—'.repeat(o.depth)} {o.name}</option>)}
                </select>
              </label>
              <div className="error-text" role="alert">{formError}</div>
            </div>
            <div className="dialog-actions">
              <button className="button primary" onClick={saveUnitEdit}>حفظ</button>
              <button className="button" onClick={() => setEditUnitForm(null)}>إلغاء</button>
            </div>
          </>
        )}
      </Dialog>

      {/* Level Management — shown below the main layout for CONFIGURE holders */}
      {canAdmin && (
        <section className="card" style={{ marginTop: 18 }}>
          <div className="column-heading flex spread">
            <h3>المستويات التنظيمية</h3>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>المستوى</th><th>الاسم</th><th>الوحدات</th><th>إجراء</th></tr></thead>
              <tbody>
                {levels.map((l) => (
                  <tr key={l.level}>
                    <td className="latin">{l.level}</td>
                    <td>{l.name}</td>
                    <td>{l.unitCount}</td>
                    <td>{l.unitCount === 0 && <button className="button compact danger" onClick={() => removeLevel(l)}>حذف</button>}</td>
                  </tr>
                ))}
                {!levels.length && <tr><td colSpan={4} className="empty">لا توجد مستويات معرّفة</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex" style={{ gap: 8, padding: '12px 16px' }}>
            <label className="field" style={{ marginBottom: 0, flex: '0 0 80px' }}><span>رقم</span><input type="number" min={1} max={20} value={levelNum} onChange={(e) => setLevelNum(Number(e.target.value))} /></label>
            <label className="field" style={{ marginBottom: 0, flex: 1 }}><span>اسم المستوى</span><input value={levelName} onChange={(e) => setLevelName(e.target.value)} placeholder="مثال: فرع، قسم، إدارة" /></label>
            <button className="button primary" style={{ alignSelf: 'flex-end', minHeight: 42 }} onClick={saveLevel}>＋ حفظ المستوى</button>
          </div>
          {formError && <p className="error-text" style={{ padding: '0 16px 10px' }}>{formError}</p>}
        </section>
      )}
    </>
  );
}
