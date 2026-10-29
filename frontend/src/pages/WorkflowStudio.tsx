import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, urls } from '../api/client';
import type { FormField, OrgFrom, RoleDef, Rule, SimulationResult, StudioItem, WfStage, WorkflowDefinition, WorkflowVersion } from '../api/types';
import { formSubjects } from '../components/rules/FieldRulesDialog';
import { RuleEditor } from '../components/rules/RuleEditor';
import { Dialog, DialogHead, Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';
import { ORG_FROM } from '../lib/labels';
import { describeRule, FACT_SUBJECTS } from '../lib/rules';

const EXCLUDED_ROLES = new Set(['SYSTEM_ADMIN', 'LIMITED_VIEWER', 'AUDITOR']);
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
const newKey = (prefix: string) => prefix + '_' + Date.now().toString(36);

/** Normalises the studio draft so the last stage is the single final (signed) approval stage. */
export function normaliseStages(def: WorkflowDefinition): WorkflowDefinition {
  const stages = def.stages.map((s, i) => {
    const last = i === def.stages.length - 1;
    return { ...s, final: last, requiresSignature: last ? s.requiresSignature !== false : false, condition: last ? null : s.condition ?? null };
  });
  return { ...def, stages };
}

export function WorkflowStudio() {
  const app = useApp();
  const [items, setItems] = useState<StudioItem[]>([]);
  const [typeCode, setTypeCode] = useState<string | null>(null);
  const [published, setPublished] = useState<WorkflowVersion | null>(null);
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [dragged, setDragged] = useState<number | null>(null);
  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [conditionFor, setConditionFor] = useState<number | null>(null);
  const [conditionDraft, setConditionDraft] = useState<Rule | null>(null);
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [sample, setSample] = useState<Record<string, string>>({ durationDays: '3', durationHours: '72', resourceCount: '1', participantCount: '0' });
  const item = items.find((i) => i.requestType.code === typeCode) ?? items[0];
  const subjects = useMemo(() => formSubjects(formFields, app.requestTypes), [formFields, app.requestTypes]);

  // fields of the request type's published form: the only fields a stage condition may test
  useEffect(() => {
    const code = item?.requestType.code;
    if (!code) return setFormFields([]);
    api
      .forms()
      .then(async (fs) => {
        const it = fs.find((x) => x.requestType.code === code);
        const v = it?.published ? await api.formVersion(it.published.id) : null;
        setFormFields(v?.schema.fields ?? []);
      })
      .catch(() => setFormFields([]));
  }, [item?.requestType.code]);
  const reviewerRoles = useMemo(() => roles.filter((r) => !EXCLUDED_ROLES.has(r.code)), [roles]);
  const roleName = (code: string) => roles.find((r) => r.code === code)?.name ?? code;

  useEffect(() => {
    api.workflows().then(setItems).catch((e: Error) => app.toast(e.message));
    api.roles().then(setRoles).catch(() => setRoles([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);

  const load = async (it: StudioItem | undefined, preferDraft = true) => {
    setSim(null);
    if (!it) return;
    try {
      const pub = it.published ? await api.workflowVersion(it.published.id) : null;
      setPublished(pub);
      const source = preferDraft && it.draft ? await api.workflowVersion(it.draft.id) : pub;
      setDraft(source ? clone(source.definition) : { name: 'مراجعة إدارية', stages: [], execution: [] });
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  useEffect(() => {
    void load(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.published?.id, item?.draft?.id]);

  const update = (fn: (d: WorkflowDefinition) => void) => {
    if (!draft) return;
    const next = clone(draft);
    fn(next);
    setDraft(next);
    setSim(null);
  };
  const setStage = (i: number, patch: Partial<WfStage>) => update((d) => Object.assign(d.stages[i], patch));
  const toggleRole = (i: number, role: string, on: boolean) =>
    update((d) => {
      const a = d.stages[i].assignees;
      d.stages[i].assignees = on
        ? [...a.filter((x) => x.role !== role), { role, orgFrom: role === 'ORG_MANAGER' || role === 'REQUESTER' ? 'REQUEST_ORG' : role === 'FACILITIES_REVIEWER' ? 'RESOURCE_ORG' : 'ANY' }]
        : a.filter((x) => x.role !== role);
    });
  const setOrgFrom = (i: number, role: string, orgFrom: OrgFrom) =>
    update((d) => {
      d.stages[i].assignees = d.stages[i].assignees.map((x) => (x.role === role ? { ...x, orgFrom } : x));
    });
  const move = (i: number, delta: number) =>
    update((d) => {
      const j = i + delta;
      if (j < 0 || j >= d.stages.length) return;
      [d.stages[i], d.stages[j]] = [d.stages[j], d.stages[i]];
    });
  const drop = (i: number) => {
    if (dragged === null || dragged === i) return;
    update((d) => {
      const [s] = d.stages.splice(dragged, 1);
      d.stages.splice(i, 0, s);
    });
    setDragged(null);
  };
  const addStage = () =>
    update((d) =>
      d.stages.splice(Math.max(0, d.stages.length - 1), 0, {
        key: newKey('stage'),
        name: 'مراجعة إضافية',
        mode: 'ALL',
        slaDays: 2,
        assignees: [{ role: reviewerRoles.find((r) => r.code === 'FACILITIES_REVIEWER')?.code ?? reviewerRoles[0]?.code ?? 'FACILITIES_REVIEWER', orgFrom: 'RESOURCE_ORG' }],
        condition: null,
      }),
    );
  const removeStage = (i: number) => {
    if (!draft || draft.stages.length <= 1) return app.toast('يجب أن يبقى مسار اعتماد واحد على الأقل');
    update((d) => d.stages.splice(i, 1));
  };

  const localCheck = (): string => {
    if (!draft || !draft.stages.length) return 'أضف مرحلة واحدة على الأقل';
    if (draft.stages.some((s) => !s.name.trim() || !s.assignees.length)) return 'أكمل أسماء المراحل والمراجعين';
    const last = draft.stages[draft.stages.length - 1];
    if (!last.assignees.some((a) => roles.find((r) => r.code === a.role)?.permissions.includes('APPROVE')))
      return 'المرحلة الأخيرة يجب أن تُسند إلى دور يملك صلاحية الاعتماد النهائي';
    return '';
  };

  const saveDraft = async () => {
    if (!item || !draft) throw new Error('لا يوجد تدفق محدد');
    return api.saveWorkflowDraft(item.id, normaliseStages(draft));
  };

  const simulate = async () => {
    const err = localCheck();
    if (err) return app.toast(err);
    setBusy(true);
    try {
      const v = await saveDraft();
      const facts: Record<string, unknown> = {};
      Object.entries(sample).forEach(([k, val]) => {
        if (k.startsWith('value:')) {
          if (val !== '') (facts.values = { ...((facts.values as Record<string, unknown>) ?? {}), [k.slice(6)]: Number.isNaN(Number(val)) ? val : Number(val) });
        } else if (val !== '') facts[k] = k === 'requestType' ? val : Number(val);
      });
      setSim(await api.simulateWorkflow(v.id, facts));
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    const err = localCheck();
    if (err) return app.toast(err);
    setBusy(true);
    try {
      const v = await saveDraft();
      const p = await api.publishWorkflow(v.id);
      app.toast('نُشر الإصدار ' + p.version + ' للطلبات الجديدة؛ الطلبات السابقة تحتفظ بإصدارها');
      app.bump();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const f = draft;
  return (
    <>
      <Heading
        en="STUDIO / WORKFLOW DESIGNER"
        title="استوديو التدفقات"
        description="رتّب المراحل، وحدد المراجعين، ثم انشر إصداراً جديداً."
        actions={
          <>
            <button className="button" onClick={() => load(item, false)} disabled={busy}>
              إلغاء التغييرات
            </button>
            <button className="button" onClick={simulate} disabled={busy}>
              محاكاة الأثر
            </button>
            <button className="button primary" onClick={publish} disabled={busy}>
              نشر إصدار جديد
            </button>
          </>
        }
      />
      <div className="studio-layout">
        <section className="card studio-canvas">
          {f ? (
            <>
              <div className="studio-flow">
                <span className="flow-cap">تقديم الطلب</span>
                <span className="flow-connector" />
                {f.stages.map((s, i) => {
                  const last = i === f.stages.length - 1;
                  return (
                    <Fragment key={s.key}>
                      <article
                        className="flow-node"
                        draggable
                        onDragStart={() => setDragged(i)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          drop(i);
                        }}
                      >
                        <div className="flex">
                          <i className="node-order">{i + 1}</i>
                          <input aria-label={'اسم المرحلة ' + (i + 1)} value={s.name} onChange={(e) => setStage(i, { name: e.target.value })} />
                          <div className="node-tools">
                            <button onClick={() => move(i, -1)} aria-label={'رفع المرحلة ' + (i + 1)}>
                              ↑
                            </button>
                            <button onClick={() => move(i, 1)} aria-label={'خفض المرحلة ' + (i + 1)}>
                              ↓
                            </button>
                            <button onClick={() => removeStage(i)} aria-label={'حذف المرحلة ' + (i + 1)}>
                              ×
                            </button>
                          </div>
                        </div>
                        <div className="stage-options">
                          {reviewerRoles.map((role) => {
                            const a = s.assignees.find((x) => x.role === role.code);
                            return (
                              <span key={role.code} className="assignee-choice">
                                <label className="role-choice">
                                  <input type="checkbox" checked={!!a} onChange={(e) => toggleRole(i, role.code, e.target.checked)} />
                                  {role.name}
                                </label>
                                {a && (
                                  <select aria-label={'جهة ' + role.name} value={a.orgFrom} onChange={(e) => setOrgFrom(i, role.code, e.target.value as OrgFrom)}>
                                    {ORG_FROM.map(([v, l]) => (
                                      <option key={v} value={v}>
                                        {l}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </span>
                            );
                          })}
                        </div>
                        <div className="stage-options">
                          <span>إتمام المرحلة</span>
                          <select value={s.mode} onChange={(e) => setStage(i, { mode: e.target.value as 'ALL' | 'ANY' })}>
                            <option value="ALL">موافقة الجميع</option>
                            <option value="ANY">موافقة أحدهم</option>
                          </select>
                          <span>المهلة</span>
                          <input
                            aria-label={'مهلة المرحلة ' + (i + 1)}
                            type="number"
                            min={1}
                            value={s.slaDays}
                            style={{ width: 45, borderColor: 'var(--line)' }}
                            onChange={(e) => setStage(i, { slaDays: Math.max(1, Number(e.target.value) || 1) })}
                          />
                          <span>يوم</span>
                          {last && (
                            <label className="role-choice">
                              <input type="checkbox" checked={s.requiresSignature !== false} onChange={(e) => setStage(i, { requiresSignature: e.target.checked })} />
                              اعتماد نهائي مع توقيع
                            </label>
                          )}
                          {!last && (
                            <button
                              className="button compact"
                              onClick={() => {
                                setConditionDraft(s.condition ?? null);
                                setConditionFor(i);
                              }}
                            >
                              {s.condition ? 'تعديل شرط المرحلة' : 'جعل المرحلة شرطية'}
                            </button>
                          )}
                        </div>
                        {!last && s.condition && (
                          <div className="stage-condition">
                            <span className="pill orange">مشروطة</span> تُنفذ عندما: {describeRule(s.condition, subjects)}
                          </div>
                        )}
                      </article>
                      <span className="flow-connector" />
                    </Fragment>
                  );
                })}
                <span className="flow-cap">تثبيت القرار والحجز</span>
              </div>
              <div style={{ textAlign: 'center', marginTop: 25 }}>
                <button className="button" onClick={addStage}>
                  ＋ إضافة مراجعة
                </button>
              </div>
              {f.execution.length > 0 && (
                <div style={{ marginTop: 25 }}>
                  <h3 style={{ marginBottom: 10 }}>مهام التنفيذ والاستلام بعد الاعتماد</h3>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>المهمة</th>
                          <th>الدور</th>
                          <th>الجهة</th>
                          <th>المهلة (يوم)</th>
                          <th>دليل مطلوب</th>
                        </tr>
                      </thead>
                      <tbody>
                        {f.execution.map((x, i) => (
                          <tr key={x.key}>
                            <td>
                              <input value={x.name} onChange={(e) => update((d) => (d.execution[i].name = e.target.value))} aria-label="اسم المهمة" />
                            </td>
                            <td>{roleName(x.role)}</td>
                            <td>{ORG_FROM.find(([v]) => v === x.orgFrom)?.[1]}</td>
                            <td>
                              <input
                                type="number"
                                min={1}
                                style={{ width: 60 }}
                                value={x.dueDays}
                                onChange={(e) => update((d) => (d.execution[i].dueDays = Math.max(1, Number(e.target.value) || 1)))}
                                aria-label="مهلة المهمة"
                              />
                            </td>
                            <td>
                              <input type="checkbox" checked={x.evidenceRequired} onChange={(e) => update((d) => (d.execution[i].evidenceRequired = e.target.checked))} aria-label="دليل مطلوب" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="empty">جارٍ التحميل…</div>
          )}
        </section>
        <aside className="card studio-side">
          <div className="version-card">
            <b>v{published?.version ?? 0}</b>
            <span>
              <strong>الإصدار المنشور</strong>
              <small>
                الطلبات الجديدة تستخدم هذا الإصدار
                {published ? ' · ' + published.activeRequests + ' طلب قائم عليه' : ''}
              </small>
            </span>
          </div>
          <label className="field">
            <span>نوع الطلب المرتبط</span>
            <select value={item?.requestType.code ?? ''} onChange={(e) => setTypeCode(e.target.value)}>
              {items.map((t) => (
                <option key={t.id} value={t.requestType.code}>
                  {t.requestType.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>اسم التدفق</span>
            <input value={f?.name ?? ''} onChange={(e) => update((d) => (d.name = e.target.value))} />
          </label>
          {item?.draft && <p className="micro muted">توجد مسودة غير منشورة (v{item.draft.version}) محفوظة في الخادم.</p>}
          {published?.publishedAt && (
            <p className="micro muted">
              نُشر {fullTime(published.publishedAt)}
              {published.publishedBy ? ' · ' + published.publishedBy : ''} ·{' '}
              <a className="text-link" href={urls.bpmn(published.id)}>
                تنزيل BPMN
              </a>
            </p>
          )}
          <div className="rule" />
          <h3>قيم المحاكاة</h3>
          <p className="micro muted">تُقيّم شروط المراحل في الخادم بهذه القيم عند «محاكاة الأثر».</p>
          <div className="sim-inputs">
            {FACT_SUBJECTS.filter((x) => x.kind !== 'requestType').map((x) => {
              const k = x.key.slice(5);
              return (
                <label className="field" key={k}>
                  <span>{x.label}</span>
                  <input type="number" value={sample[k] ?? ''} onChange={(e) => setSample({ ...sample, [k]: e.target.value })} />
                </label>
              );
            })}
            {formFields
              .filter((ff) => f?.stages.some((st) => JSON.stringify(st.condition ?? null).includes('"field":"' + ff.id + '"')))
              .map((ff) => (
                <label className="field" key={ff.id}>
                  <span>{ff.label}</span>
                  {ff.kind === 'select' ? (
                    <select value={sample['value:' + ff.id] ?? ''} onChange={(e) => setSample({ ...sample, ['value:' + ff.id]: e.target.value })}>
                      <option value="">—</option>
                      {(ff.options ?? []).map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={sample['value:' + ff.id] ?? ''} onChange={(e) => setSample({ ...sample, ['value:' + ff.id]: e.target.value })} />
                  )}
                </label>
              ))}
          </div>
          {sim && (
            <>
              <div className="rule" />
              <h3>نتيجة المحاكاة</h3>
              {sim.errors.length > 0 && (
                <div className="note red" style={{ marginTop: 10 }}>
                  {sim.errors.map((e) => (
                    <div key={e.path + e.message}>{e.message}</div>
                  ))}
                </div>
              )}
              <ul className="test-list">
                {sim.path.map((p) => (
                  <li key={p.key}>
                    {p.runs ? '✓' : '—'} {p.name}
                    {p.runs ? '' : ' (تُتخطى للحالة الافتراضية)'}
                  </li>
                ))}
              </ul>
              <div className={'note ' + (sim.valid ? '' : 'orange')}>{sim.impact.message}</div>
            </>
          )}
          <div className="rule" />
          <h3>كيف تعمل المراجعات؟</h3>
          <p className="publish-info" style={{ marginTop: 10 }}>
            المراحل تُنفذ بالتسلسل. إذا احتوت مرحلة على أكثر من مراجع تُفتح لهم مهام متوازية، ويحدد اختيار «الجميع» أو «أحدهم» شرط انتقالها.
          </p>
          <div className="note" style={{ marginTop: 18 }}>
            السحب يعيد ترتيب المراحل. تتوفر الأسهم للاستخدام باللمس ولوحة المفاتيح.
          </div>
          <p className="publish-info" style={{ marginTop: 14 }}>
            يُترجم الإصدار المنشور إلى تعريف BPMN يُنفذه محرك Flowable في الخادم. لا تُقبل شروط بكود حر؛ الشروط بلغة قواعد محددة الأنواع.
          </p>
        </aside>
      </div>
      <Dialog open={conditionFor !== null} onClose={() => setConditionFor(null)} className="large-dialog">
        {conditionFor !== null && f?.stages[conditionFor] && (
          <>
            <DialogHead
              eyebrow="WORKFLOW / STAGE CONDITION"
              title={'شرط المرحلة «' + f.stages[conditionFor].name + '»'}
              small="المرحلة تُنفذ عندما يتحقق الشرط، وتُتخطى خلاف ذلك. مرحلة الاعتماد النهائي لا تكون شرطية."
              onClose={() => setConditionFor(null)}
            />
            <div className="dialog-content">
              <RuleEditor title="تُنفذ المرحلة عندما" empty="تُنفذ دائماً" value={conditionDraft} subjects={subjects} onChange={setConditionDraft} />
              {!formFields.length && <p className="micro muted">لا نموذج منشور لهذا النوع بعد: الشروط على معطيات الطلب فقط.</p>}
            </div>
            <div className="dialog-actions">
              <button
                className="button primary"
                onClick={() => {
                  setStage(conditionFor, { condition: conditionDraft });
                  setConditionFor(null);
                }}
              >
                تطبيق على المسودة
              </button>
              <button className="button" onClick={() => setConditionFor(null)}>
                إلغاء
              </button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
