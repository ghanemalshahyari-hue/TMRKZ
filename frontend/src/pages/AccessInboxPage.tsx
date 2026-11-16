import { useEffect, useMemo, useState } from 'react';
import { api, type AccessInboxItem, type AccessPreview, type AccessScope, type AccessScopeTree, type RoleName } from '../api/client';
import { UnitsDialog, type LocalUnits } from '../components/access/UnitsDialog';
import { flatSource } from '../components/tree/tree';
import { Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { branchLevels, counter, FINAL_ROLES, incomplete, initialChoice, toSpec, today, type RoleChoice } from '../lib/finalGrants';
import { ROLE_MEANING, ScopeChoice } from './AccessRequestPage';

const SCOPE_WORD: Record<string, string> = { UNIT: 'وحدتي فقط', UNIT_TREE: 'وحدتي والوحدات التابعة', UNITS: 'وحدات محددة', SITES: 'مواقع محددة', ALL: 'النظام بالكامل' };

/** What a chosen unit reaches, in words. */
function reach(u: RoleChoice['units'][number]): string {
  return u.mode === 'ONE' ? 'الوحدة فقط' : u.mode === 'BRANCH' ? 'مع جميع الوحدات التابعة' : 'المستوى ' + [...u.levels].sort((a, b) => a - b).join(' و');
}

/**
 * The final approval, role by role (owner, LDAP first login §14–15; ADR-069): each role activated carries its own anchor units,
 * reach (the unit alone, with its descendants, or chosen levels under it) and validity, in the same grant/target/levels model as
 * every grant. «الصلاحيات التي ستصبح فعالة» is the server's own plan of exactly what will be written; any change after it asks
 * for a new preview, and only an unchanged, problem-free preview can be approved.
 */
function FinalGrants({ item, onReady }: { item: AccessInboxItem; onReady: (grants: ReturnType<typeof toSpec>[] | null, fingerprint: string | null) => void }) {
  const app = useApp();
  const [tree, setTree] = useState<AccessScopeTree | null>(null);
  useEffect(() => {
    api.accessScopeTree(item.requestId).then(setTree).catch(() => setTree(null));
  }, [item.requestId]);
  const unit = { id: item.unitId ?? '', name: item.unit };
  const names = useMemo(() => {
    const m = new Map<string, string>();
    (item.scopeUnits ?? []).forEach((u) => m.set(u.id, u.name));
    tree?.units.forEach((u) => m.set(u.id, u.name));
    return m;
  }, [item.scopeUnits, tree]);
  const seats = useMemo(() => new Set(item.seats ?? []), [item.seats]);
  const all: RoleName[] = [...item.offered, ...item.extras];
  const start = item.proposedScope ?? item.scope;
  const [choices, setChoices] = useState<RoleChoice[]>(() =>
    (item.recommended ?? item.requested).map((r) => initialChoice(r, seats.has(r.code), start, unit, names, item.scopeSites ?? [])),
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const specs = useMemo(() => choices.map((c) => toSpec(c)), [choices]);
  const key = JSON.stringify(specs);
  const stale = preview != null && previewed !== key;
  const blocked = choices.map(incomplete).find((x) => x) ?? null;
  useEffect(() => {
    onReady(preview && !stale && !preview.problems.length && !blocked ? specs : null, preview && !stale ? preview.fingerprint : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, stale, blocked, key]);

  const local = useMemo<LocalUnits | undefined>(() => {
    if (!tree) return undefined;
    return {
      source: flatSource(tree.units),
      levels: branchLevels(tree),
      mainIds: new Set(tree.units.filter((u) => u.main).map((u) => u.id)),
      count: counter(tree),
    };
  }, [tree]);
  const patch = (role: string, p: Partial<RoleChoice>) => setChoices((cs) => cs.map((c) => (c.role === role ? { ...c, ...p } : c)));
  const toggle = (r: RoleName, on: boolean) =>
    setChoices((cs) => (on ? [...cs, initialChoice(r, seats.has(r.code), start, unit, names, item.scopeSites ?? [])] : cs.filter((c) => c.role !== r.code)));
  const run = async () => {
    setBusy(true);
    try {
      const p = await api.accessPreview(item.requestId, { taskId: item.taskId, grants: specs });
      setPreview(p);
      setPreviewed(key);
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const editingChoice = choices.find((c) => c.role === editing) ?? null;
  return (
    <div data-testid="final-grants">
      <h4>ما يُفعَّل — لكل صلاحية نطاقها</h4>
      <p className="micro muted">الاعتماد النهائي يقرر الصلاحيات فعلاً: لا يلزم أن يطابق ما طُلب أو ما أوصي به. لكل صلاحية وحداتها ومستوياتها ومدتها.</p>
      {all.map((r) => {
        const c = choices.find((x) => x.role === r.code);
        return (
          <div key={r.code} className="final-role" data-final-role={r.code} data-chosen={!!c}>
            <label className="check-label" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <input type="checkbox" data-role={r.code} checked={!!c} onChange={(e) => toggle(r, e.target.checked)} />
              <span>
                <b>{r.name}</b> <span className={'pill' + (seats.has(r.code) ? ' seat' : '')} data-testid="role-kind">{seats.has(r.code) ? 'مسؤولية/مقعد الوحدة' : 'صلاحية شخصية'}</span>
                <br />
                <small className="muted">{ROLE_MEANING[r.code]}</small>
              </span>
            </label>
            {c && (
              <div className="final-role-body">
                <label className="field compact">
                  <span>النطاق</span>
                  <select aria-label={'نطاق ' + r.name} data-scope-kind={r.code} value={c.byDefault ? 'ROLE' : 'CUSTOM'}
                    onChange={(e) => patch(r.code, e.target.value === 'ROLE' ? { byDefault: true } : { byDefault: false, units: c.units.length ? c.units : [{ id: unit.id, name: unit.name, mode: 'ONE', levels: [] }] })}>
                    <option value="ROLE">النطاق الافتراضي للدور في «{item.unit}»</option>
                    <option value="CUSTOM">وحدات ومستويات محددة</option>
                  </select>
                </label>
                {!c.byDefault && (
                  <div className="final-anchors">
                    {c.units.map((u) => (
                      <span key={u.id} className="pill" data-anchor={u.id}>«{u.name}» — {reach(u)}</span>
                    ))}
                    {c.sites.map((s) => (
                      <span key={s.id} className="pill">الموقع «{s.name}»</span>
                    ))}
                    <button type="button" className="button compact" data-edit-units={r.code} disabled={!local} onClick={() => setEditing(r.code)}>
                      تحديد الوحدات والمستويات
                    </button>
                  </div>
                )}
                <div className="flex" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <label className="field compact">
                    <span>من</span>
                    <input type="date" data-valid-from={r.code} min={today()} value={c.validFrom} onChange={(e) => patch(r.code, { validFrom: e.target.value })} />
                  </label>
                  <label className="field compact">
                    <span>إلى (اختياري)</span>
                    <input type="date" data-valid-to={r.code} min={c.validFrom || today()} value={c.validTo} onChange={(e) => patch(r.code, { validTo: e.target.value })} />
                  </label>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {editingChoice && local && (
        <UnitsDialog
          roleName={editingChoice.name}
          home={unit}
          person={item.person}
          value={editingChoice.units}
          everything={false}
          allowEverything={false}
          finalApprover={FINAL_ROLES.includes(editingChoice.role)}
          chain={editingChoice.role === 'CHAIN_APPROVER'}
          local={local}
          onClose={() => setEditing(null)}
          onSave={(units) => {
            patch(editingChoice.role, { units, byDefault: false });
            setEditing(null);
          }}
        />
      )}
      {blocked && <p className="error-text">{blocked}</p>}
      <button type="button" className="button" data-testid="access-preview-run" disabled={busy || !choices.length || !!blocked} onClick={run}>
        معاينة الصلاحيات التي ستصبح فعالة
      </button>
      {preview && (
        <section className="card padding access-preview" data-testid="access-preview" data-stale={stale} style={{ marginTop: 10 }}>
          <h4 style={{ marginTop: 0 }}>الصلاحيات التي ستصبح فعالة</h4>
          <p className="micro muted">{preview.person} — منحة في «{preview.unit}». هذا ما سيُكتب بالضبط عند «اعتماد وتفعيل».</p>
          {stale && <p className="error-text" data-testid="access-preview-stale">تغير الاختيار بعد المعاينة؛ أعد المعاينة قبل الاعتماد.</p>}
          {preview.problems.length > 0 && (
            <ul className="error-text" data-testid="access-preview-problems">
              {preview.problems.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>الصلاحية</th>
                  <th>النوع</th>
                  <th>الوحدة المرتكز</th>
                  <th>النطاق</th>
                  <th>الفروع</th>
                  <th>المستويات</th>
                  <th>الوحدات المشمولة</th>
                  <th>المدة</th>
                  <th>ملاحظات وتعارضات</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={l.role} data-preview-role={l.role}>
                    <td><b>{l.roleName}</b></td>
                    <td>{l.kind}</td>
                    <td>{l.anchors.length ? l.anchors.map((a) => a.name).join('، ') : l.home.name}</td>
                    <td data-testid="preview-scope">{l.scopeText}</td>
                    <td>{l.all ? 'كل الوحدات' : l.anchors.some((a) => a.includeDescendants) ? 'تشمل التابعة' : 'الوحدة وحدها'}</td>
                    <td data-testid="preview-levels">{l.anchors.flatMap((a) => a.levels).length ? [...new Set(l.anchors.flatMap((a) => a.levels))].join('، ') : '—'}</td>
                    <td className="latin">{l.units < 0 ? 'الكل' : l.units.toLocaleString('en-US')}</td>
                    <td>{l.validFrom ? fullDate(l.validFrom) : 'من الاعتماد'} ← {l.validTo ? fullDate(l.validTo) : 'دون نهاية'}</td>
                    <td>
                      {[...l.problems, ...l.notes].length ? (
                        <ul className="micro" style={{ margin: 0, paddingInlineStart: 16 }}>
                          {l.problems.map((p, i) => <li key={'p' + i} className="error-text">{p}</li>)}
                          {l.notes.map((n, i) => <li key={'n' + i}>{n}</li>)}
                        </ul>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Item({ item, onDone }: { item: AccessInboxItem; onDone: () => void }) {
  const app = useApp();
  const [roles, setRoles] = useState<string[]>((item.recommended ?? item.requested).map((r) => r.code));
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<AccessScope>(item.proposedScope ?? item.scope ?? { mode: 'UNIT', ids: [] });
  const [advice, setAdvice] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<{ grants: ReturnType<typeof toSpec>[] | null; fingerprint: string | null }>({ grants: null, fingerprint: null });
  const act = async (decision: 'APPROVE' | 'REJECT' | 'RETURN' | 'REROUTE') => {
    setBusy(true);
    try {
      const body =
        decision === 'APPROVE' && item.final
          ? { taskId: item.taskId, decision, note: note || undefined, grants: ready.grants ?? [], fingerprint: ready.fingerprint ?? undefined }
          : { taskId: item.taskId, decision, roles, note: note || undefined, scope, recommendReject: !item.final && advice === 'REJECT' };
      const r = await api.decideAccessRequest(item.requestId, body);
      app.toast(r.rerouted ? r.message ?? 'أعيد توجيه الطلب' : decision === 'REJECT' ? 'رُفض الطلب' : decision === 'RETURN' ? 'أُعيد الطلب للتعديل' : item.final ? 'فُعّلت الصلاحيات' : 'أُرسلت التوصية');
      onDone();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="card padding" data-testid="access-item" data-final={item.final} data-request={item.number} style={{ marginBottom: 14 }}>
      <div className="flex spread">
        <h3>{item.person} <span className="latin tiny muted">{item.employeeNo}</span></h3>
        <span className="pill">{item.stage}</span>
      </div>
      <p className="micro muted">{item.unit} · {fullDate(item.submittedAt)} · {item.number}</p>
      {item.movedTo && (
        <p className="error-text" data-testid="access-moved">
          نُقل إلى «{item.movedTo}» بعد تقديم الطلب. لا يُمنح نطاق وحدته السابقة: أعد توجيه الطلب نفسه إلى وحدته الحالية لتراجعه جهتها.
        </p>
      )}
      <p><b>السبب:</b> {item.reason}</p>
      <p className="micro"><b>طلب:</b> {item.requested.map((r) => r.name).join('، ')}</p>
      <p className="micro" data-testid="access-scope-asked"><b>النطاق المطلوب:</b> {item.scope ? SCOPE_WORD[item.scope.mode] : 'النطاق الافتراضي للدور'}{item.scopeNames?.length ? ' — ' + item.scopeNames.join('، ') : ''}</p>
      {item.final && <p className="micro" data-testid="access-person"><b>الشخص الآن:</b> {item.personActive ? 'نشط في الموارد البشرية' : 'غير نشط'} · {item.movedTo ? 'نُقل' : 'في وحدته نفسها'}</p>}
      {item.final && (
        <p className="micro" data-testid="access-advice">
          <b>توصية المراجع:</b> {item.recommended ? item.recommended.map((r) => r.name).join('، ') + ' — ' + item.reviewedBy : item.reviewSkipped ?? 'تم التجاوز تلقائياً: لا يوجد مراجع مؤهل لهذه الوحدة'}
        </p>
      )}
      {item.final && item.recommendReject && <p className="error-text" data-testid="access-advice-reject">موصى بالرفض{item.reviewNote ? ': ' + item.reviewNote : ''}</p>}
      {!item.movedTo && !item.final && (
        <>
          <fieldset data-testid="access-advice-choice">
            <legend>توصيتك</legend>
            <label className="check-label" style={{ marginInlineEnd: 12 }}><input type="radio" name={'adv' + item.taskId} checked={advice === 'APPROVE'} onChange={() => setAdvice('APPROVE')} /> موافقة</label>
            <label className="check-label"><input type="radio" name={'adv' + item.taskId} data-advice="REJECT" checked={advice === 'REJECT'} onChange={() => setAdvice('REJECT')} /> رفض</label>
          </fieldset>
          <h4>ما توصي به</h4>
          <p className="micro muted">توصيتك لا تفعّل شيئاً؛ يقرر المعتمد النهائي ما يُمنح فعلاً.</p>
          {item.offered.map((r) => (
            <label key={r.code} className="check-label" style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' }}>
              <input type="checkbox" data-role={r.code} checked={roles.includes(r.code)} onChange={(e) => setRoles(e.target.checked ? [...roles, r.code] : roles.filter((x) => x !== r.code))} />
              <span><b>{r.name}</b> {item.seats?.includes(r.code) && <span className="pill seat">مسؤولية/مقعد الوحدة</span>} <small className="muted">{ROLE_MEANING[r.code]}</small></span>
            </label>
          ))}
          {item.extras.length > 0 && (
            <div data-testid="access-extras">
              <h4>صلاحيات إضافية</h4>
              <p className="micro muted">لا يطلبها مقدم الطلب بنفسه. تضيفها أنت إذا احتاجها عمله.</p>
              {item.extras.map((r) => (
                <label key={r.code} className="check-label" style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' }}>
                  <input type="checkbox" data-role={r.code} checked={roles.includes(r.code)} onChange={(e) => setRoles(e.target.checked ? [...roles, r.code] : roles.filter((x) => x !== r.code))} />
                  <span><b>{r.name}</b> <small className="muted">{ROLE_MEANING[r.code]}</small></span>
                </label>
              ))}
            </div>
          )}
          <ScopeChoice scope={scope} setScope={setScope} units={item.scopeUnits ?? []} sites={item.scopeSites ?? []} />
        </>
      )}
      {!item.movedTo && item.final && <FinalGrants item={item} onReady={(grants, fingerprint) => setReady({ grants, fingerprint })} />}
      <label className="field">
        <span>ملاحظة (مطلوبة عند الرفض أو الإرجاع)</span>
        <textarea aria-label="ملاحظة" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="flex" style={{ gap: 8 }}>
        {item.movedTo ? (
          <button className="button primary" data-testid="access-reroute" disabled={busy} onClick={() => act('REROUTE')}>إعادة التوجيه إلى الوحدة الحالية</button>
        ) : item.final ? (
          <button className="button primary" data-testid="access-activate" disabled={busy || !ready.grants || !ready.fingerprint} onClick={() => act('APPROVE')}>اعتماد وتفعيل</button>
        ) : (
          <button className="button primary" disabled={busy || (!roles.length && advice === 'APPROVE') || (advice === 'REJECT' && note.trim().length < 5)} onClick={() => act('APPROVE')}>إرسال التوصية</button>
        )}
        <button className="button" disabled={busy || note.trim().length < 5} onClick={() => act('RETURN')}>إرجاع للتعديل</button>
        <button className="button danger" disabled={busy || note.trim().length < 5} onClick={() => act('REJECT')}>رفض</button>
      </div>
      {item.final && !item.movedTo && !ready.grants && <p className="micro muted" style={{ marginTop: 6 }}>«اعتماد وتفعيل» بعد معاينة الصلاحيات التي ستصبح فعالة، وبلا تعارض.</p>}
    </article>
  );
}

/** The permission requests waiting for this person (ADR-044): a reviewer advises, the final approver grants. */
export function AccessInboxPage() {
  const app = useApp();
  const [items, setItems] = useState<AccessInboxItem[] | null>(null);
  const load = () => api.accessInbox().then(setItems).catch((e: Error) => (setItems([]), app.toast(e.message)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);
  return (
    <section data-testid="access-inbox">
      <Heading title="طلبات الصلاحية" description="الطلبات التي تنتظر قرارك. لا يمنح المراجع شيئاً؛ الاعتماد النهائي وحده يفعّل الصلاحية." />
      {items && !items.length && <div className="empty">لا توجد طلبات تنتظرك.</div>}
      {items?.map((i) => <Item key={i.taskId} item={i} onDone={load} />)}
    </section>
  );
}
