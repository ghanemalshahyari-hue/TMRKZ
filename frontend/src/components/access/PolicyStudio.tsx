import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { AccessPolicyVersion, Permission, PolicyImpact, PolicyRole, RoleDef, Scope } from '../../api/types';
import { useApp } from '../../lib/app';
import { fullTime } from '../../lib/dates';
import { PERMISSIONS, PERMISSION_NAMES, SCOPES } from '../../lib/labels';
import { Dialog, DialogHead, Icon } from '../ui';

const STATUS_NAMES: Record<AccessPolicyVersion['status'], [string, string]> = {
  DRAFT: ['مسودة', 'orange'],
  PUBLISHED: ['منشور', 'green'],
  SUPERSEDED: ['سابق', ''],
  DISCARDED: ['متجاهَل', ''],
};

const CHANGE_NAMES = { ADDED: 'دور جديد', CHANGED: 'تغير', UNCHANGED: 'دون تغيير' } as const;

function fromLive(r: RoleDef, i: number): PolicyRole {
  return { ...r, grantableRoles: r.grantableRoles ?? [], sortOrder: i };
}

/**
 * Role catalogue as a versioned policy: the published version is read-only; changes go into one draft, are checked
 * and their impact shown, then published with a note. Any earlier version can be restored as a new recorded version.
 */
export function PolicyStudio({ global }: { global: boolean }) {
  const app = useApp();
  const [versions, setVersions] = useState<AccessPolicyVersion[]>([]);
  const [live, setLive] = useState<PolicyRole[]>([]);
  const [draft, setDraft] = useState<AccessPolicyVersion | null>(null);
  const [impact, setImpact] = useState<PolicyImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [note, setNote] = useState('');
  const [grantableFor, setGrantableFor] = useState<string | null>(null);
  const [newRole, setNewRole] = useState({ code: '', name: '' });

  const load = useCallback(async () => {
    try {
      const [vs, roles] = await Promise.all([api.policyVersions(), api.roles()]);
      setVersions(vs);
      setLive(roles.map(fromLive));
      const d = vs.find((v) => v.status === 'DRAFT');
      setDraft(d ? await api.policyVersion(d.id) : null);
      setImpact(null);
    } catch (e) {
      app.toast((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load, app.revision]);

  const published = versions.find((v) => v.status === 'PUBLISHED');
  const roles = draft ? draft.roles : live;
  const editable = global && !!draft;
  const liveByCode = useMemo(() => new Map(live.map((r) => [r.code, r])), [live]);

  const run = async <T,>(f: () => Promise<T>, done?: string) => {
    setBusy(true);
    try {
      const out = await f();
      if (done) app.toast(done);
      return out;
    } catch (e) {
      app.toast((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const save = async (role: PolicyRole, patch: Partial<PolicyRole>) => {
    const next = { ...role, ...patch };
    const v = await run(() =>
      api.policySaveRole({
        code: next.code,
        name: next.name,
        permissions: next.permissions,
        scope: next.scope,
        summaryOnly: next.summaryOnly,
        grantableRoles: next.grantableRoles,
      }),
    );
    if (v) {
      setDraft(v);
      setImpact(null);
    }
  };

  const toggle = (role: PolicyRole, p: Permission, on: boolean) =>
    save(role, { permissions: on ? [...new Set([...role.permissions, p])] : role.permissions.filter((x) => x !== p) });

  const createDraft = async () => {
    const v = await run(() => api.policyDraft(), 'أُنشئت مسودة من السياسة المنشورة؛ لا يتغير شيء قبل النشر');
    if (v) {
      setDraft(v);
      setVersions(await api.policyVersions());
    }
  };

  const checkImpact = async () => {
    const i = await run(() => api.policyImpact());
    if (i) setImpact(i);
  };

  const publish = async () => {
    const v = await run(() => api.policyPublish(note), 'نُشر الإصدار وسُجل في سجل التدقيق؛ تُطبق الصلاحيات من الطلب التالي');
    if (v) {
      setPublishing(false);
      setNote('');
      await load();
      app.bump();
    }
  };

  const discard = async () => {
    const reason = prompt('سبب تجاهل المسودة:');
    if (!reason) return;
    await run(() => api.policyDiscard(reason), 'تم تجاهل المسودة؛ السياسة المنشورة دون تغيير');
    await load();
  };

  const restore = async (v: AccessPolicyVersion) => {
    const reason = prompt('سبب الرجوع إلى الإصدار ' + v.version + ' (يُنشر كإصدار جديد مسجل):');
    if (!reason) return;
    const out = await run(() => api.policyRestore(v.id, reason), 'نُشر إصدار جديد مطابق للإصدار ' + v.version);
    if (out) {
      await load();
      app.bump();
    }
  };

  const addRole = async () => {
    const code = newRole.code.trim().toUpperCase();
    if (!code || !newRole.name.trim()) return app.toast('اكتب رمز الدور واسمه');
    const v = await run(() =>
      api.policySaveRole({ code, name: newRole.name.trim(), permissions: [], scope: 'ORGANIZATION', summaryOnly: false, grantableRoles: [] }),
    );
    if (v) {
      setDraft(v);
      setNewRole({ code: '', name: '' });
    }
  };

  const changed = (r: PolicyRole) => {
    const was = liveByCode.get(r.code);
    if (!was) return true;
    return (
      was.name !== r.name ||
      was.scope !== r.scope ||
      was.summaryOnly !== r.summaryOnly ||
      [...was.permissions].sort().join() !== [...r.permissions].sort().join() ||
      [...was.grantableRoles].sort().join() !== [...r.grantableRoles].sort().join()
    );
  };

  const grantableRole = roles.find((r) => r.code === grantableFor) ?? null;

  return (
    <>
      <section className="card padding policy-banner">
        <div>
          <span className="eyebrow">POLICY / PUBLISHED</span>
          <h3>
            {published ? 'الإصدار المنشور ' + published.version : 'لا يوجد إصدار منشور'}
            {draft && <span className="pill orange" style={{ marginInlineStart: 8 }}>مسودة الإصدار {draft.version} مفتوحة</span>}
          </h3>
          {published && (
            <p className="micro muted">
              {published.publishedAt ? 'نُشر ' + fullTime(published.publishedAt) : ''}
              {published.publishedBy ? ' · بواسطة ' + published.publishedBy.name : ''}
              {published.fgaModelId ? ' · نموذج القرار ' + published.fgaModelId.slice(-8) : ''}
              {published.note ? ' · ' + published.note : ''}
            </p>
          )}
        </div>
        <div className="heading-actions">
          {global && !draft && (
            <button className="button primary" disabled={busy} onClick={createDraft}>
              <Icon name="plus" /> إنشاء مسودة
            </button>
          )}
          {global && draft && (
            <>
              <button className="button" disabled={busy} onClick={checkImpact}>
                التحقق والأثر
              </button>
              <button className="button primary" disabled={busy} onClick={async () => (await checkImpact(), setPublishing(true))}>
                نشر…
              </button>
              <button className="button danger" disabled={busy} onClick={discard}>
                تجاهل المسودة
              </button>
            </>
          )}
          {!global && <span className="pill">عرض فقط: يعدل السياسة مدير صلاحيات عام</span>}
        </div>
      </section>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="column-heading">
          <h3>{draft ? 'مصفوفة الأدوار والإجراءات — المسودة' : 'مصفوفة الأدوار والإجراءات — المنشورة'}</h3>
          {draft && <span className="micro muted">الصفوف المعلّمة تختلف عن المنشور</span>}
        </div>
        <div className="table-scroll">
          <table className="data-table matrix-table">
            <thead>
              <tr>
                <th>الدور</th>
                {PERMISSIONS.map((p) => (
                  <th key={p}>{PERMISSION_NAMES[p]}</th>
                ))}
                <th>النطاق الافتراضي</th>
                <th>عرض مختصر</th>
                <th>يمنح الأدوار</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => {
                const locked = !editable || role.system || busy;
                return (
                  <tr key={role.code} className={(role.system ? 'disabled ' : '') + (draft && changed(role) ? 'row-changed' : '')}>
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
                          disabled={locked}
                          onChange={(e) => toggle(role, p, e.target.checked)}
                        />
                      </td>
                    ))}
                    <td>
                      <select
                        aria-label={'النطاق الافتراضي لـ ' + role.name}
                        value={role.scope}
                        disabled={locked}
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
                        disabled={locked}
                        onChange={(e) => save(role, { summaryOnly: e.target.checked })}
                      />
                    </td>
                    <td>
                      {role.permissions.includes('MANAGE_ACCESS') ? (
                        <button className="button compact" onClick={() => setGrantableFor(role.code)} disabled={role.system}>
                          {role.system ? 'جميع الأدوار' : role.grantableRoles.length + ' أدوار'}
                        </button>
                      ) : (
                        <span className="micro muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {editable && (
          <div className="policy-add">
            <input
              className="latin"
              placeholder="ROLE_CODE"
              aria-label="رمز الدور الجديد"
              value={newRole.code}
              onChange={(e) => setNewRole({ ...newRole, code: e.target.value })}
            />
            <input placeholder="اسم الدور" aria-label="اسم الدور الجديد" value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} />
            <button className="button" disabled={busy} onClick={addRole}>
              <Icon name="plus" /> إضافة دور إلى المسودة
            </button>
          </div>
        )}
        <div className="legend-note">
          النطاق الافتراضي يُطبق على المنح التي لا تحدد نطاقاً مخصصاً. الإجراءات مستقلة: لا يتضمن أي إجراء غيره، والتهيئة لا تعطي حق
          عرض الطلبات. كل إجراء يُفرض في الخادم وتؤكده خدمة قرارات الصلاحيات.
        </div>
      </section>

      {impact && <ImpactPanel impact={impact} />}

      <section className="card" style={{ marginTop: 14 }}>
        <div className="column-heading">
          <h3>سجل الإصدارات</h3>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>الإصدار</th>
                <th>الحالة</th>
                <th>الملاحظة</th>
                <th>النشر</th>
                <th>الأصل</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>{v.version}</td>
                  <td>
                    <span className={'pill ' + STATUS_NAMES[v.status][1]}>{STATUS_NAMES[v.status][0]}</span>
                  </td>
                  <td>{v.note ?? '—'}</td>
                  <td className="micro">
                    {v.publishedAt ? fullTime(v.publishedAt) : '—'}
                    {v.publishedBy ? ' · ' + v.publishedBy.name : ''}
                  </td>
                  <td className="micro muted">
                    {v.restoredFromVersion ? 'رجوع إلى ' + v.restoredFromVersion : v.basedOnVersion ? 'من ' + v.basedOnVersion : '—'}
                  </td>
                  <td>
                    {global && v.status === 'SUPERSEDED' && !draft && (
                      <button className="button compact" disabled={busy} onClick={() => restore(v)}>
                        الرجوع إلى هذا الإصدار
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={!!grantableRole} onClose={() => setGrantableFor(null)} className="small-dialog">
        {grantableRole && (
          <>
            <DialogHead eyebrow="GRANTABLE ROLES" title={'الأدوار التي يمنحها «' + grantableRole.name + '»'} onClose={() => setGrantableFor(null)} />
            <div className="dialog-content">
              <p className="micro muted">
                حامل هذا الدور يدير الصلاحيات داخل نطاق منحته فقط، ويمنح الأدوار المختارة هنا. النطاق الشامل والتهيئة ومعرفات المصدر يمنحها
                مدير صلاحيات عام وحده.
              </p>
              <ul className="test-list">
                {roles
                  .filter((r) => !r.system)
                  .map((r) => (
                    <li key={r.code}>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          disabled={!editable}
                          checked={grantableRole.grantableRoles.includes(r.code)}
                          onChange={(e) =>
                            save(grantableRole, {
                              grantableRoles: e.target.checked
                                ? [...grantableRole.grantableRoles, r.code]
                                : grantableRole.grantableRoles.filter((x) => x !== r.code),
                            })
                          }
                        />
                        {r.name}
                      </label>
                    </li>
                  ))}
              </ul>
              {!editable && <p className="micro muted">أنشئ مسودة لتعديل هذه القائمة.</p>}
            </div>
          </>
        )}
      </Dialog>

      <Dialog open={publishing} onClose={() => setPublishing(false)} className="small-dialog">
        <DialogHead eyebrow="POLICY / PUBLISH" title={'نشر الإصدار ' + (draft?.version ?? '')} onClose={() => setPublishing(false)} />
        <div className="dialog-content">
          {impact && (
            <ul className="test-list">
              {impact.roles
                .filter((r) => r.change !== 'UNCHANGED')
                .map((r) => (
                  <li key={r.code}>
                    <Icon name="check" />
                    {r.name}: {CHANGE_NAMES[r.change]} — يمس {r.persons} شخصاً
                  </li>
                ))}
              {impact.problems
                .filter((p) => p.level === 'ERROR')
                .map((p, i) => (
                  <li key={i} className="bad">
                    {p.role}: {p.message}
                  </li>
                ))}
            </ul>
          )}
          <label className="field">
            <span>ملاحظة النشر (ما الذي تغير ولماذا)</span>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <div className="dialog-actions">
          <button className="button" onClick={() => setPublishing(false)}>
            إلغاء
          </button>
          <button className="button primary" disabled={busy || !note.trim() || !impact?.publishable} onClick={publish}>
            نشر الإصدار
          </button>
        </div>
      </Dialog>
    </>
  );
}

function ImpactPanel({ impact }: { impact: PolicyImpact }) {
  const rows = impact.roles.filter((r) => r.change !== 'UNCHANGED');
  return (
    <section className="card" style={{ marginTop: 14 }}>
      <div className="column-heading">
        <h3>
          أثر المسودة {impact.draftVersion} مقارنة بالإصدار {impact.publishedVersion}
        </h3>
        <span className={'pill ' + (impact.publishable ? 'green' : 'red')}>{impact.publishable ? 'قابلة للنشر' : 'غير قابلة للنشر'}</span>
      </div>
      {impact.problems.length > 0 && (
        <ul className="test-list" style={{ padding: '0 18px' }}>
          {impact.problems.map((p, i) => (
            <li key={i} className={p.level === 'ERROR' ? 'bad' : 'warn'}>
              <b>{p.level === 'ERROR' ? 'خطأ' : 'تنبيه'}</b> · <span className="latin">{p.role}</span>: {p.message}
            </li>
          ))}
        </ul>
      )}
      {rows.length === 0 ? (
        <div className="empty">لا تغيير عن الإصدار المنشور.</div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>الدور</th>
                <th>التغيير</th>
                <th>إجراءات مضافة</th>
                <th>إجراءات مسحوبة</th>
                <th>النطاق الافتراضي</th>
                <th>الحاملون الآن</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code}>
                  <td>{r.name}</td>
                  <td>{CHANGE_NAMES[r.change]}</td>
                  <td className="good">{r.added.map((p) => PERMISSION_NAMES[p]).join('، ') || '—'}</td>
                  <td className="bad">{r.removed.map((p) => PERMISSION_NAMES[p]).join('، ') || '—'}</td>
                  <td>
                    {r.scopeFrom && r.scopeFrom !== r.scopeTo
                      ? SCOPES.find(([s]) => s === r.scopeFrom)?.[1] + ' ← ' + SCOPES.find(([s]) => s === r.scopeTo)?.[1]
                      : SCOPES.find(([s]) => s === r.scopeTo)?.[1]}
                  </td>
                  <td className="micro">
                    {r.persons} شخصاً · {r.memberships} منحة · {r.delegations} تفويضاً · {r.seats} مقعداً
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
