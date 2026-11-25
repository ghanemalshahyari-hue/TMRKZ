import { useEffect, useState } from 'react';
import {
  api,
  type AccessRightDef,
  type AccountCard,
  type DutyPermit,
  type GrantBody,
  type ProvidingDepartment,
  type WorkspaceColumn,
  type WorkspaceMatrix,
  type WorkspacePerson,
  type WorkspaceUnit,
} from '../../api/client';
import type { GrantView } from '../../api/types';
import { useApp } from '../../lib/app';
import { dubaiISO, fullDate, todayDubai } from '../../lib/dates';
import { Dialog, DialogHead, Icon } from '../ui';
import { AVAILABILITY_LABEL, PERMIT_STATE, accountAction, availabilityState, canActivate, defaultRights, departmentName, rightsText } from './adminText';
import { existingUnits } from './assign';
import { UnitsDialog, type UnitChoice } from './UnitsDialog';

type Unit = { id: string; name: string };

/** The catalogue of the ten rights, loaded once. */
export function useRightsCatalogue(): AccessRightDef[] {
  const [list, setList] = useState<AccessRightDef[]>([]);
  useEffect(() => {
    api.rightsCatalogue().then(setList).catch(() => setList([]));
  }, []);
  return list;
}

// ---- «مسؤول إدارة الوصول والصلاحيات» ------------------------------------------------------------------------------

/**
 * A grant of a role that manages access, as TNQL's access administration (ADR-059): this unit only or with its subordinate
 * units, the separate rights it carries, and an optional end. A manager who is not global delegates: never wider than
 * their own grant, never past its end; only the issuer or a global manager edits or withdraws it. The server checks it all.
 */
export function AccessAdminDialog({
  unit,
  person,
  column,
  grant,
  catalogue,
  onClose,
  onSaved,
}: {
  unit: Unit;
  person: WorkspacePerson;
  column: WorkspaceColumn;
  grant?: GrantView;
  catalogue: AccessRightDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  // The initial scope comes from the existing grant through the same helper the ASSIGN cells use; a new grant starts
  // on the current unit with «هذه الوحدة وما دونها» (BRANCH), matching the prior default.
  const initial: UnitChoice[] = grant
    ? existingUnits(grant)
    : [{ id: unit.id, name: unit.name, mode: 'BRANCH', levels: [] }];
  const [units, setUnits] = useState<UnitChoice[]>(initial);
  const [picker, setPicker] = useState(false);
  const [rights, setRights] = useState<string[]>(() => (grant ? grant.rights ?? catalogue.map((r) => r.key) : defaultRights(catalogue)));
  const [until, setUntil] = useState(grant?.validTo ? grant.validTo.slice(0, 10) : '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!grant && rights.length === 0 && catalogue.length) setRights(defaultRights(catalogue));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogue]);
  const flip = (key: string) => setRights((r) => (r.includes(key) ? r.filter((x) => x !== key) : [...r, key]));
  const save = async () => {
    if (!units.length) {
      app.toast('اختر وحدة واحدة على الأقل.');
      return;
    }
    setBusy(true);
    const body: GrantBody = {
      personId: person.id,
      organizationId: unit.id,
      roleCode: column.code,
      validFrom: dubaiISO(todayDubai()),
      validTo: until ? dubaiISO(until) : null,
      scope: {
        mode: 'CUSTOM',
        all: false,
        targets: units.map((u) => ({
          kind: 'ORGANIZATION',
          id: u.id,
          includeDescendants: u.mode !== 'ONE',
          levels: u.mode === 'LEVELS' ? u.levels : undefined,
        })),
      },
      rights,
    };
    try {
      if (grant) await api.replaceGrant(grant.id, body, 'تعديل حقوق مسؤول الصلاحيات');
      else await api.createGrant(body);
      app.toast('حُفظ «' + column.name + '» لـ ' + person.displayName);
      onSaved();
      onClose();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    if (!grant) return;
    const reason = window.prompt('سبب سحب «' + column.name + '» من ' + person.displayName + '؟ ما فُوِّض منه يُسحب معه.');
    if (!reason || !reason.trim()) return;
    try {
      await api.endMembership(grant.id, reason.trim());
      app.toast('سُحبت المنحة');
      onSaved();
      onClose();
    } catch (e) {
      app.toast((e as Error).message);
    }
  };
  return (
    <Dialog open onClose={onClose} className="small-dialog">
      <DialogHead eyebrow={column.name} title={person.displayName} small={'مسؤول إدارة الوصول والصلاحيات في «' + unit.name + '»'} onClose={onClose} />
      <div className="dialog-content aa-form" data-testid="access-admin-dialog">
        <fieldset className="aa-scope">
          <legend>النطاق</legend>
          {units.length === 0 ? (
            <p className="aw-muted">لم تُحدد أي وحدة بعد.</p>
          ) : (
            <ul className="scope-targets" aria-label="الوحدات المحددة">
              {units.map((u) => (
                <li key={u.id}>
                  <b>{u.name}</b>
                  {' — '}
                  <span>
                    {u.mode === 'ONE' ? 'هذه الوحدة فقط' : u.mode === 'BRANCH' ? 'هذه الوحدة وما دونها' : 'مستويات محددة'}
                  </span>
                  {u.mode === 'LEVELS' && u.levels.length > 0 && <small> ({u.levels.join('، ')})</small>}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="button compact" onClick={() => setPicker(true)} data-testid="aa-pick-units">
            <Icon name="tree" /> اختر الوحدات والمستويات
          </button>
        </fieldset>
        <fieldset className="aa-rights">
          <legend>الحقوق ({rightsText(rights, catalogue.length)})</legend>
          {catalogue.map((r) => (
            <label key={r.key}>
              <input type="checkbox" checked={rights.includes(r.key)} onChange={() => flip(r.key)} data-right={r.key} /> {r.label}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>حتى (اختياري)</span>
          <input type="date" value={until} min={todayDubai()} onChange={(e) => setUntil(e.target.value)} aria-label="نهاية المنحة" />
        </label>
        <p className="aw-muted">التفويض لا يتجاوز منحتك: الحقوق نفسها أو أقل، وحتى نهايتها. «اعتماد نهائي لطلبات الصلاحيات» يمنح أيضاً الخطوة الأخيرة لطلبات الصلاحية في النطاق نفسه.</p>
      </div>
      <div className="dialog-actions">
        <button className="button primary" disabled={busy} onClick={save} data-testid="aa-save">حفظ</button>
        {grant && <button className="button danger" onClick={withdraw}>سحب المنحة</button>}
        <button className="button" onClick={onClose}>إلغاء</button>
      </div>
      {picker && (
        <UnitsDialog
          roleName={column.name}
          home={unit}
          person={person.displayName}
          finalApprover={false}
          everything={false}
          value={units}
          onSave={(next) => {
            setUnits(next);
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </Dialog>
  );
}

// ---- «معتمد التوفر» chips --------------------------------------------------------------------------------------------

/** One person's departments in one cell, each chip saved at once, as TNQL's. */
export function AvailabilityChips({
  unit,
  person,
  columns,
  providers,
  onChanged,
}: {
  unit: Unit;
  person: WorkspacePerson;
  columns: WorkspaceColumn[];
  providers: string[];
  onChanged: () => void;
}) {
  const app = useApp();
  const flip = async (c: WorkspaceColumn) => {
    const why = person.lock ?? c.lock;
    const held = person.grants.find((g) => g.role.code === c.code && g.active);
    if (why && !held) return app.toast('🔒 ' + why);
    try {
      if (held) {
        if (!window.confirm('سحب «' + departmentName(c.name) + '» من ' + person.displayName + '؟')) return;
        await api.endMembership(held.id, 'سحب من «معتمد التوفر»');
      } else {
        await api.createGrant({ personId: person.id, organizationId: unit.id, roleCode: c.code, validFrom: dubaiISO(todayDubai()), scope: { mode: 'ROLE' } });
      }
      onChanged();
    } catch (e) {
      app.toast((e as Error).message);
    }
  };
  return (
    <span className="aa-chips">
      {columns.map((c) => {
        const state = availabilityState(!!person.cells[c.code]?.direct, providers.includes(c.code));
        return (
          <button key={c.code} className={'aa-chip ' + state.toLowerCase()} data-avail={c.code} onClick={() => flip(c)}
            title={departmentName(c.name) + ': ' + AVAILABILITY_LABEL[state] + (c.lock && state === 'NONE' ? ' — ' + c.lock : '')}>
            {departmentName(c.name)} · {AVAILABILITY_LABEL[state]}
          </button>
        );
      })}
    </span>
  );
}

// ---- «تصاريح المناوبة» ---------------------------------------------------------------------------------------------

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

/** A unit's duty permits: issue one to a person of the unit for one window, end one early. */
export function PermitsTab({ unit, matrix, onChanged }: { unit: Unit; matrix: WorkspaceMatrix; onChanged: () => void }) {
  const app = useApp();
  const [list, setList] = useState<DutyPermit[] | null>(null);
  const [form, setForm] = useState<{ personId: string; roleCode: string; length: number; reason: string } | null>(null);
  const load = () => api.unitPermits(unit.id).then(setList).catch((e: Error) => (setList([]), app.toast(e.message)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit.id]);
  const roles = matrix.columns.filter((c) => c.mode !== 'ADMIN' && !c.finalOnly);
  const issue = async () => {
    if (!form) return;
    try {
      await api.issuePermit({ personId: form.personId, organizationId: unit.id, roleCode: form.roleCode, validTo: hours(form.length), reason: form.reason });
      app.toast('صدر التصريح؛ يفعّله صاحبه عند بدء المناوبة');
      setForm(null);
      void load();
      onChanged();
    } catch (e) {
      app.toast((e as Error).message);
    }
  };
  const end = async (p: DutyPermit) => {
    const reason = window.prompt('سبب إنهاء تصريح ' + p.person.displayName + '؟');
    if (!reason || !reason.trim()) return;
    try {
      await api.endPermit(p.id, reason.trim());
      void load();
      onChanged();
    } catch (e) {
      app.toast((e as Error).message);
    }
  };
  return (
    <div className="aa-permits" data-testid="aw-permits">
      <p className="aw-muted">تصريح المناوبة يمنح صلاحية في هذه الوحدة لمدة مناوبة واحدة (حتى سبعة أيام)، ولا يسري حتى يفعّله صاحبه عند بدايتها. يضاف إلى معتمدي الوحدة ولا يحل محلهم.</p>
      {form ? (
        <div className="aa-permit-form">
          <select aria-label="المستخدم" value={form.personId} onChange={(e) => setForm({ ...form, personId: e.target.value })}>
            <option value="">اختر المستخدم…</option>
            {matrix.people.filter((p) => !p.lock).map((p) => (
              <option key={p.id} value={p.id}>{p.displayName} · {p.employeeNo}</option>
            ))}
          </select>
          <select aria-label="الصلاحية" value={form.roleCode} onChange={(e) => setForm({ ...form, roleCode: e.target.value })}>
            <option value="">اختر الصلاحية…</option>
            {roles.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </select>
          <div className="aw-seg" role="radiogroup" aria-label="مدة المناوبة">
            {[8, 12, 24, 72, 168].map((h) => (
              <button key={h} role="radio" aria-checked={form.length === h} className={form.length === h ? 'on' : ''} onClick={() => setForm({ ...form, length: h })}>
                {h < 24 ? h + ' ساعات' : h === 24 ? 'يوم' : h === 72 ? '3 أيام' : 'أسبوع'}
              </button>
            ))}
          </div>
          <input aria-label="سبب التصريح" placeholder="سبب التصريح (مثال: مناوبة ليلية)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <button className="button compact primary" disabled={!form.personId || !form.roleCode || form.reason.trim().length < 3} onClick={issue}>إصدار التصريح</button>
          <button className="button compact" onClick={() => setForm(null)}>إلغاء</button>
        </div>
      ) : (
        <button className="button compact primary" onClick={() => setForm({ personId: '', roleCode: '', length: 12, reason: '' })}>
          <Icon name="plus" /> تصريح مناوبة جديد
        </button>
      )}
      <div className="aw-table">
        <table className="aw-matrix">
          <thead>
            <tr>
              <th>المستخدم</th>
              <th>الصلاحية</th>
              <th>من</th>
              <th>إلى</th>
              <th>الحالة</th>
              <th>السبب</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list?.length === 0 && (
              <tr>
                <td colSpan={7} className="aw-muted">لا تصاريح لهذه الوحدة.</td>
              </tr>
            )}
            {list?.map((p) => (
              <tr key={p.id}>
                <td>{p.person.displayName}</td>
                <td>{p.role.name}</td>
                <td className="latin">{fullDate(p.validFrom)}</td>
                <td className="latin">{fullDate(p.validTo)}</td>
                <td><span className={'aa-state ' + p.state.toLowerCase()}>{PERMIT_STATE[p.state]}</span></td>
                <td>{p.endReason ?? p.reason}</td>
                <td>{(p.state === 'ISSUED' || p.state === 'ACTIVE' || p.state === 'ACTIVATED') && <button className="button compact" onClick={() => end(p)}>إنهاء</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The holder's own permits on «صلاحياتي»: activate at the start of the duty, end it when done. */
export function MyPermits() {
  const app = useApp();
  const [list, setList] = useState<DutyPermit[]>([]);
  const load = () => api.myPermits().then(setList).catch(() => setList([]));
  useEffect(() => {
    void load();
  }, [app.revision]);
  if (!list.length) return null;
  const act = (work: Promise<unknown>, done: string) =>
    work.then(() => (app.toast(done), load(), app.bump())).catch((e: Error) => app.toast(e.message));
  return (
    <section className="card padding" data-testid="my-permits">
      <h3>تصاريح المناوبة</h3>
      <ul className="aa-mine">
        {list.map((p) => (
          <li key={p.id}>
            <b>{p.role.name}</b> في «{p.organization.name}» · <span className="latin">{fullDate(p.validFrom)} — {fullDate(p.validTo)}</span>
            <span className={'aa-state ' + p.state.toLowerCase()}>{PERMIT_STATE[p.state]}</span>
            {canActivate(p) && <button className="button compact primary" onClick={() => act(api.activatePermit(p.id), 'بدأت المناوبة: التصريح ساري')}>تفعيل</button>}
            {p.state === 'ISSUED' && !canActivate(p) && <small className="aw-muted">يُفعَّل عند بدء المناوبة</small>}
            {(p.state === 'ACTIVE' || p.state === 'ACTIVATED') && <button className="button compact" onClick={() => act(api.endMyPermit(p.id), 'انتهت المناوبة')}>إنهاء المناوبة</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- «بطاقة الحساب» ------------------------------------------------------------------------------------------------

export function AccountCardDialog({ personId, catalogue, onClose, onChanged }: { personId: string; catalogue: AccessRightDef[]; onClose: () => void; onChanged: () => void }) {
  const app = useApp();
  const [card, setCard] = useState<AccountCard | null>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    api.accountCard(personId).then((c) => (setCard(c), setName(c.displayName))).catch((e: Error) => (app.toast(e.message), onClose()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);
  if (!card) return null;
  const run = (work: Promise<AccountCard>, done: string) =>
    work.then((c) => (setCard(c), app.toast(done), onChanged())).catch((e: Error) => app.toast(e.message));
  const toggle = () => {
    if (card.accessDisabled) return run(api.setAccountActive(card.id, true), 'أُعيد تفعيل الحساب');
    const reason = window.prompt('سبب إيقاف حساب ' + card.displayName + '؟ صلاحياته تبقى وتعود عند التفعيل.');
    if (reason && reason.trim()) void run(api.setAccountActive(card.id, false, reason.trim()), 'أُوقف الحساب');
  };
  const retire = () => {
    const reason = window.prompt('حذف الحساب المحلي ' + card.displayName + '؟ تُنهى كل صلاحياته ووحداته وتصاريحه ويُوقف. اكتب السبب:');
    if (reason && reason.trim()) void run(api.retireAccount(card.id, reason.trim()), 'حُذف الحساب (يبقى في سجل التدقيق)');
  };
  const reinstate = () => {
    const reason = window.prompt('إعادة الحساب ' + card.displayName + '؟ يعود الحساب نشطاً بلا صلاحيات ولا وحدات؛ تُمنح من جديد. اكتب السبب:');
    if (reason && reason.trim()) void run(api.reinstateAccount(card.id, reason.trim()), 'أُعيد الحساب بلا صلاحيات (مسجل في التدقيق)');
  };
  const systemRole = (code: string, held?: { id: string }) => {
    const unit = card.units[0];
    if (held) {
      const reason = window.prompt('سبب سحب دور النظام؟');
      if (reason && reason.trim()) api.endMembership(held.id, reason.trim()).then(() => api.accountCard(card.id).then(setCard)).catch((e: Error) => app.toast(e.message));
      return;
    }
    if (!unit) return app.toast('أضف الشخص إلى وحدة أولاً.');
    api
      .createGrant({ personId: card.id, organizationId: unit.id, roleCode: code, validFrom: dubaiISO(todayDubai()), scope: { mode: 'ROLE' } })
      .then(() => api.accountCard(card.id).then(setCard))
      .catch((e: Error) => app.toast(e.message));
  };
  return (
    <Dialog open onClose={onClose} className="detail-dialog">
      <DialogHead eyebrow="بطاقة الحساب" title={card.displayName} small={card.employeeNo + (card.username ? ' · ' + card.username : '')} onClose={onClose} />
      <div className="dialog-content ac-card" data-testid="account-card">
        <div className="ac-flags">
          <span className={'aa-state ' + (card.accessDisabled ? 'ended' : 'active')}>{card.accessDisabled ? 'موقوف' : 'حساب نشط'}</span>
          <span className="aa-state">{card.source === 'HR' ? 'من الموارد البشرية' : 'حساب محلي'}</span>
          {card.hrUnavailable && <span className="aa-state issued">غائب حسب الموارد البشرية: {card.hrUnavailable}</span>}
          <span className="aa-state">{card.linked ? 'سجّل الدخول من قبل' : 'لم يسجّل الدخول بعد'}</span>
          {card.system && <span className="aa-state">حساب نظام</span>}
        </div>
        {card.accessDisabledReason && <p className="aw-muted">سبب الإيقاف: {card.accessDisabledReason}</p>}
        <h4>الوحدات</h4>
        <p>{card.units.map((u) => u.name + (u.how === 'HR' ? '' : u.how === 'ACTING' ? ' (بالإنابة)' : ' (مضاف)')).join('، ') || '—'}</p>
        <h4>الصلاحيات السارية</h4>
        <ul className="ac-list">
          {card.grants.filter((g) => !g.system).map((g) => (
            <li key={g.id}>
              {g.role.name} · {g.organization}
              {g.rights !== null && <small className="aw-muted"> · {rightsText(g.rights, catalogue.length || 10)}</small>}
              {g.delegated && <small className="aw-muted"> · مفوَّضة</small>}
              {g.validTo && <small className="aw-muted"> · حتى {fullDate(g.validTo)}</small>}
            </li>
          ))}
          {card.grants.filter((g) => !g.system).length === 0 && <li className="aw-muted">لا شيء ممنوح باسمه.</li>}
        </ul>
        {card.systemRoles.length > 0 && (
          <>
            <h4>دور النظام</h4>
            <ul className="ac-list">
              {card.systemRoles.map((r) => {
                const held = card.grants.find((g) => g.role.code === r.code);
                return (
                  <li key={r.code}>
                    <label>
                      <input type="checkbox" checked={!!held} disabled={card.system} onChange={() => systemRole(r.code, held)} /> {r.name}
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {card.permits.length > 0 && (
          <>
            <h4>تصاريح المناوبة</h4>
            <ul className="ac-list">
              {card.permits.map((p) => (
                <li key={p.id}>{p.role.name} · {fullDate(p.validFrom)} — {fullDate(p.validTo)} · {PERMIT_STATE[p.state]}</li>
              ))}
            </ul>
          </>
        )}
        {card.canEditProfile && (
          <label className="field">
            <span>الاسم</span>
            <span className="flex">
              <input aria-label="الاسم" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="button compact" disabled={name.trim() === card.displayName} onClick={() => run(api.setAccountProfile(card.id, name), 'حُفظ الاسم')}>حفظ</button>
            </span>
          </label>
        )}
        <h4>سجل الحساب</h4>
        <ul className="ac-list ac-history">
          {card.history.map((h, i) => (
            <li key={i}><span className="latin">{fullDate(h.at)}</span> · {accountAction(h.action)}{h.by ? ' · ' + h.by : ''}{h.reason ? ' — ' + h.reason : ''}</li>
          ))}
          {card.history.length === 0 && <li className="aw-muted">لا أحداث.</li>}
        </ul>
      </div>
      <div className="dialog-actions">
        {card.canEdit && (
          <button className={'button ' + (card.accessDisabled ? 'primary' : '')} onClick={toggle} data-testid="ac-toggle">
            {card.accessDisabled ? 'تفعيل الحساب' : 'إيقاف الحساب'}
          </button>
        )}
        {card.canRetire && <button className="button danger" onClick={retire}>حذف الحساب</button>}
        {card.canReinstate && <button className="button" onClick={reinstate}>إعادة الحساب</button>}
        <button className="button" onClick={onClose}>إغلاق</button>
      </div>
    </Dialog>
  );
}

// ---- providing departments of a unit -------------------------------------------------------------------------------

export function ProvidersSection({ file, global, onChanged }: { file: WorkspaceUnit; global: boolean; onChanged: () => void }) {
  const app = useApp();
  const [departments, setDepartments] = useState<ProvidingDepartment[]>([]);
  const [adding, setAdding] = useState<{ code: string; name: string } | null>(null);
  useEffect(() => {
    api.departments().then(setDepartments).catch(() => setDepartments([]));
  }, [file.id]);
  const may = file.myRights.includes('ATTACH');
  const flip = (code: string, on: boolean) =>
    api.setProvider(file.id, code, on).then(() => (onChanged(), app.toast(on ? 'الوحدة مزوّدة لهذه الإدارة' : 'لم تعد الوحدة مزوّدة لها'))).catch((e: Error) => app.toast(e.message));
  const add = () =>
    adding &&
    api
      .addDepartment(adding.code, adding.name)
      .then((d) => (setDepartments(d), setAdding(null), app.toast('أُضيفت الإدارة ونُشرت سياسة أدوار جديدة'), app.bump()))
      .catch((e: Error) => app.toast(e.message));
  if (!departments.length && !global) return null;
  return (
    <>
      <h3>إدارات التوفير التي تزوّدها الوحدة</h3>
      <ul className="aw-unit-roles">
        {departments.map((d) => (
          <li key={d.code}>
            <label title={may ? undefined : 'يحتاج حق «إلحاق الوحدات وتعيين مهام التوفير»'}>
              <input type="checkbox" checked={file.providers.includes(d.code)} disabled={!may} onChange={() => flip(d.code, !file.providers.includes(d.code))} />
              {!may && <Icon name="lock" />} {departmentName(d.name)}
            </label>
          </li>
        ))}
        {!departments.length && <li className="aw-muted">لا إدارات توفير بعد.</li>}
      </ul>
      {global &&
        (adding ? (
          <div className="aa-add-dept">
            <input aria-label="رمز الإدارة" placeholder="الرمز (لاتيني)" value={adding.code} onChange={(e) => setAdding({ ...adding, code: e.target.value.toUpperCase() })} />
            <input aria-label="اسم الإدارة" placeholder="الاسم" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
            <button className="button compact primary" disabled={!adding.code || !adding.name} onClick={add}>إضافة</button>
            <button className="button compact" onClick={() => setAdding(null)}>إلغاء</button>
          </div>
        ) : (
          <button className="button compact" onClick={() => setAdding({ code: '', name: '' })}><Icon name="plus" /> إدارة توفير جديدة</button>
        ))}
    </>
  );
}
