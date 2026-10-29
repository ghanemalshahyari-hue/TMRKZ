import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ChangePolicy, FieldKind, FormField, FormSchema, FormVersion, StudioItem } from '../api/types';
import { FieldRulesDialog, formSubjects } from '../components/rules/FieldRulesDialog';
import { Heading } from '../components/ui';
import { useApp } from '../lib/app';
import { CHANGE_POLICIES, FIELD_KINDS } from '../lib/labels';
import { describeRule } from '../lib/rules';

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

function PreviewField({ f }: { f: FormField }) {
  const star = f.required ? <span style={{ color: '#c99758' }}> *</span> : null;
  let control;
  if (f.kind === 'textarea') control = <textarea disabled placeholder={f.label} />;
  else if (f.kind === 'files')
    control = (
      <>
        <input type="file" multiple disabled />
        <small>تُرفع الملفات إلى الخادم وتُفحص قبل إتاحتها.</small>
      </>
    );
  else if (f.kind === 'select')
    control = (
      <select disabled>
        <option>اختر…</option>
        {(f.options ?? []).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  else control = <input disabled type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'} />;
  return (
    <label className="field">
      <span>
        {f.label}
        {star}
      </span>
      {control}
    </label>
  );
}

export function FormStudio() {
  const app = useApp();
  const [items, setItems] = useState<StudioItem[]>([]);
  const [typeCode, setTypeCode] = useState<string | null>(null);
  const [published, setPublished] = useState<FormVersion | null>(null);
  const [draft, setDraft] = useState<FormSchema | null>(null);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<FieldKind>('text');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [rulesFor, setRulesFor] = useState<number | null>(null);
  const [stages, setStages] = useState<{ key: string; name: string }[]>([]);
  const item = items.find((i) => i.requestType.code === typeCode) ?? items[0];

  // review stages of the same request type, for "restart the affected stages"
  useEffect(() => {
    const code = item?.requestType.code;
    if (!code) return setStages([]);
    api
      .workflows()
      .then(async (ws) => {
        const w = ws.find((x) => x.requestType.code === code);
        const v = w?.published ? await api.workflowVersion(w.published.id) : null;
        setStages((v?.definition.stages ?? []).map((s) => ({ key: s.key, name: s.name })));
      })
      .catch(() => setStages([]));
  }, [item?.requestType.code]);

  useEffect(() => {
    api.forms().then(setItems).catch((e: Error) => app.toast(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);

  const load = async (it: StudioItem | undefined, preferDraft = true) => {
    setErrors([]);
    if (!it) return;
    try {
      const pub = it.published ? await api.formVersion(it.published.id) : null;
      setPublished(pub);
      const source = preferDraft && it.draft ? await api.formVersion(it.draft.id) : pub;
      setDraft(source ? clone(source.schema) : { fields: [] });
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  useEffect(() => {
    void load(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.published?.id, item?.draft?.id]);

  const setField = (i: number, patch: Partial<FormField>) => {
    if (!draft) return;
    const next = clone(draft);
    Object.assign(next.fields[i], patch);
    setDraft(next);
  };

  const addField = () => {
    if (!draft) return;
    const label = newName.trim();
    if (!label) return app.toast('اكتب اسم الحقل');
    setDraft({
      fields: [
        ...draft.fields,
        {
          id: 'field_' + Date.now().toString(36),
          label,
          kind: newKind,
          required: false,
          visible: true,
          options: newKind === 'select' ? ['خيار أ', 'خيار ب'] : undefined,
          changePolicy: 'FULL_REAPPROVAL',
        },
      ],
    });
    setNewName('');
  };

  const removeField = (i: number) => {
    if (!draft) return;
    if (draft.fields[i].id === 'reason') return app.toast('المبرر حقل أساسي لا يُحذف');
    setDraft({ fields: draft.fields.filter((_, j) => j !== i) });
  };

  const publish = async () => {
    if (!item || !draft) return;
    if (draft.fields.some((f) => !f.label.trim())) return app.toast('أكمل أسماء الحقول');
    if (new Set(draft.fields.map((f) => f.id)).size !== draft.fields.length) return app.toast('توجد معرفات حقول مكررة');
    setBusy(true);
    setErrors([]);
    try {
      const v = await api.saveFormDraft(item.id, draft);
      const check = await api.validateForm(v.id);
      if (!check.valid) {
        setErrors(check.errors.map((e) => (e.path ? e.path + ': ' : '') + e.message));
        app.toast('لم يُنشر النموذج: يوجد أخطاء في التحقق');
        return;
      }
      const p = await api.publishForm(v.id);
      app.toast('نُشر الإصدار ' + p.version + ' للطلبات الجديدة؛ الطلبات القائمة تحتفظ بإصدارها');
      app.bump();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Heading
        en="STUDIO / FORM BUILDER"
        title="استوديو النماذج"
        description="خصص الحقول والإلزامية، ثم انشر نسخة تُستخدم في الطلبات الجديدة."
        actions={
          <>
            <button className="button" onClick={() => load(item, false)} disabled={busy}>
              إلغاء التغييرات
            </button>
            <button className="button primary" onClick={publish} disabled={busy}>
              نشر النموذج
            </button>
          </>
        }
      />
      <div className="card filterbar">
        <label>
          نوع الطلب
          <select value={item?.requestType.code ?? ''} onChange={(e) => setTypeCode(e.target.value)}>
            {items.map((t) => (
              <option key={t.id} value={t.requestType.code}>
                {t.requestType.name}
              </option>
            ))}
          </select>
        </label>
        <span className="pill green">الإصدار المنشور {published?.version ?? '—'}</span>
        {item?.draft && <span className="pill orange">مسودة v{item.draft.version}</span>}
        <span className="micro muted">معرفات الحقول ثابتة بين الإصدارات</span>
      </div>
      {errors.length > 0 && (
        <div className="note red" style={{ marginBottom: 15 }}>
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
      <div className="forms-layout">
        <section className="card">
          <div className="table-scroll">
            <table className="data-table field-table">
              <thead>
                <tr>
                  <th>الحقل</th>
                  <th>النوع</th>
                  <th>ظاهر</th>
                  <th>مطلوب</th>
                  <th>أثر التعديل</th>
                  <th>القواعد</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {(draft?.fields ?? []).map((f, i) => (
                  <tr key={f.id}>
                    <td>
                      <input type="text" aria-label={'اسم الحقل ' + (i + 1)} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                      <br />
                      <span className="latin tiny muted">{f.id}</span>
                    </td>
                    <td>
                      <select aria-label={'نوع الحقل ' + (i + 1)} value={f.kind} onChange={(e) => setField(i, { kind: e.target.value as FieldKind })}>
                        {FIELD_KINDS.map(([id, n]) => (
                          <option key={id} value={id}>
                            {n}
                          </option>
                        ))}
                      </select>
                      {f.kind === 'select' && (
                        <input
                          type="text"
                          aria-label={'خيارات الحقل ' + (i + 1)}
                          style={{ marginTop: 6 }}
                          value={(f.options ?? []).join(',')}
                          onChange={(e) => setField(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
                        />
                      )}
                    </td>
                    <td>
                      <input type="checkbox" aria-label={'إظهار الحقل ' + (i + 1)} checked={f.visible} onChange={(e) => setField(i, { visible: e.target.checked })} />
                    </td>
                    <td>
                      <input type="checkbox" aria-label={'إلزام الحقل ' + (i + 1)} checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                    </td>
                    <td>
                      <select aria-label={'سياسة تعديل الحقل ' + (i + 1)} value={f.changePolicy} onChange={(e) => setField(i, { changePolicy: e.target.value as ChangePolicy })}>
                        {CHANGE_POLICIES.map(([id, n]) => (
                          <option key={id} value={id}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="rule-cell">
                      <button className="button compact" onClick={() => setRulesFor(i)} aria-label={'قواعد الحقل ' + f.label}>
                        {f.visibleWhen || f.requiredWhen ? 'تعديل القواعد' : 'إضافة قاعدة'}
                      </button>
                      {f.visibleWhen && (
                        <div className="micro muted">يظهر عندما: {describeRule(f.visibleWhen, formSubjects(draft?.fields ?? [], app.requestTypes, f.id))}</div>
                      )}
                      {f.requiredWhen && (
                        <div className="micro muted">مطلوب عندما: {describeRule(f.requiredWhen, formSubjects(draft?.fields ?? [], app.requestTypes, f.id))}</div>
                      )}
                    </td>
                    <td>
                      <button className="icon-button" onClick={() => removeField(i)} aria-label={'حذف الحقل ' + (i + 1)}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="field-add">
            <input placeholder="اسم حقل جديد…" aria-label="اسم الحقل الجديد" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <select aria-label="نوع الحقل الجديد" value={newKind} onChange={(e) => setNewKind(e.target.value as FieldKind)}>
              {FIELD_KINDS.map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </select>
            <button className="button primary compact" onClick={addField}>
              ＋ إضافة
            </button>
          </div>
          <div className="legend-note">
            قواعد الظهور والإلزامية تُبنى من القوائم بلغة قواعد محددة الأنواع ويُتحقق منها في الخادم؛ لا يُقبل كود أو استعلام حر. سياسة أثر التعديل تحدد أي الموافقات تُعاد عند تعديل الحقل بعد الإرجاع (القرار D-06).
          </div>
        </section>
        <aside className="card field-preview">
          <span className="preview-stamp">FORM / LIVE PREVIEW</span>
          <h3>{item?.requestType.name ?? ''}</h3>
          {(draft?.fields ?? [])
            .filter((f) => f.visible)
            .map((f) => (
              <PreviewField key={f.id} f={f} />
            ))}
        </aside>
      </div>
      {rulesFor !== null && draft && draft.fields[rulesFor] && (
        <FieldRulesDialog
          schema={draft}
          index={rulesFor}
          stages={stages}
          onApply={(patch) => setField(rulesFor, patch)}
          onClose={() => setRulesFor(null)}
        />
      )}
    </>
  );
}
