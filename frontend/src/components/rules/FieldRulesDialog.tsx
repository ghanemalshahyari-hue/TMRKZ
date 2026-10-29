import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { FormField, FormSchema, Rule } from '../../api/types';
import { useApp } from '../../lib/app';
import { CHANGE_POLICIES } from '../../lib/labels';
import { FACT_SUBJECTS, type RuleSubject } from '../../lib/rules';
import { Dialog, DialogHead } from '../ui';
import { RuleEditor } from './RuleEditor';

type StageRef = { key: string; name: string };
type FieldState = { id: string; label: string; visible: boolean; required: boolean };

/** Subjects a form rule can test: the other fields of the form and the facts of the request. */
export function formSubjects(fields: FormField[], requestTypes: { code: string; name: string }[], exclude?: string): RuleSubject[] {
  const out: RuleSubject[] = fields
    .filter((f) => f.id !== exclude)
    .map((f) => ({
      key: 'field:' + f.id,
      label: f.label,
      kind: f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : f.kind === 'select' ? 'select' : f.kind === 'files' ? 'files' : 'text',
      options: f.kind === 'select' ? (f.options ?? []).map((o) => ({ value: o, label: o })) : undefined,
    }));
  return [
    ...out,
    ...FACT_SUBJECTS.map((s) => (s.kind === 'requestType' ? { ...s, options: requestTypes.map((t) => ({ value: t.code, label: t.name })) } : s)),
  ];
}

/**
 * Rules of one form field: when it is shown, when it is required, and which review stages restart when it changes
 * after a return. "Try it" evaluates the unsaved form on the server with sample values.
 */
export function FieldRulesDialog({
  schema,
  index,
  stages,
  onApply,
  onClose,
}: {
  schema: FormSchema;
  index: number;
  stages: StageRef[];
  onApply: (patch: Partial<FormField>) => void;
  onClose: () => void;
}) {
  const app = useApp();
  const field = schema.fields[index];
  const [visibleWhen, setVisibleWhen] = useState<Rule | null>(field.visibleWhen ?? null);
  const [requiredWhen, setRequiredWhen] = useState<Rule | null>(field.requiredWhen ?? null);
  const [affects, setAffects] = useState<string[]>(field.affectsStages ?? []);
  const [values, setValues] = useState<Record<string, string>>({});
  const [facts, setFacts] = useState<Record<string, string>>({ durationDays: '3', durationHours: '72', resourceCount: '1', participantCount: '0', requestType: '' });
  const [result, setResult] = useState<{ state?: FieldState; errors: string[] } | null>(null);
  const subjects = useMemo(() => formSubjects(schema.fields, app.requestTypes, field.id), [schema, app.requestTypes, field.id]);

  const edited: FormSchema = useMemo(
    () => ({
      fields: schema.fields.map((f, i) =>
        i === index ? { ...f, visibleWhen, requiredWhen, affectsStages: f.changePolicy === 'RESTART_STAGES' ? affects : undefined } : f,
      ),
    }),
    [schema, index, visibleWhen, requiredWhen, affects],
  );

  useEffect(() => {
    const t = window.setTimeout(() => {
      const numeric = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? v : Number(v));
      const vals: Record<string, unknown> = {};
      for (const f of schema.fields) {
        const v = values[f.id];
        if (v !== undefined && v !== '') vals[f.id] = f.kind === 'number' || f.kind === 'files' ? numeric(v) : v;
      }
      const fs: Record<string, unknown> = {};
      Object.entries(facts).forEach(([k, v]) => (fs[k] = k === 'requestType' ? v : numeric(v)));
      api
        .evaluateForm(edited, vals, fs)
        .then((r) =>
          setResult(
            r.valid
              ? { state: r.fields.find((f) => f.id === field.id), errors: [] }
              : { errors: r.errors.map((e) => (e.path ? e.path + ': ' : '') + e.message) },
          ),
        )
        .catch((e: Error) => setResult({ errors: [e.message] }));
    }, 300);
    return () => window.clearTimeout(t);
  }, [edited, values, facts, schema.fields, field.id]);

  const referenced = useMemo(() => {
    const keys = new Set<string>();
    const walk = (r: Rule | null | undefined) => {
      if (!r) return;
      if ('all' in r) r.all.forEach(walk);
      else if ('any' in r) r.any.forEach(walk);
      else if ('not' in r) walk(r.not);
      else if ('field' in r) keys.add(r.field);
    };
    walk(visibleWhen);
    walk(requiredWhen);
    return schema.fields.filter((f) => keys.has(f.id));
  }, [visibleWhen, requiredWhen, schema.fields]);

  return (
    <Dialog open onClose={onClose} className="large-dialog">
      <DialogHead eyebrow="FORM / FIELD RULES" title={'قواعد الحقل «' + field.label + '»'} small={'المعرف ' + field.id + ' — ثابت بين الإصدارات'} onClose={onClose} />
      <div className="dialog-content rules-layout">
        <div>
          {!field.visible && <p className="note orange micro">الحقل مخفي دائماً (عمود «ظاهر»)؛ قاعدة الظهور لا أثر لها حتى يُظهر.</p>}
          <RuleEditor title="يظهر الحقل عندما" empty="يظهر دائماً" value={visibleWhen} subjects={subjects} onChange={setVisibleWhen} />
          {field.required ? (
            <p className="note micro">الحقل مطلوب دائماً (عمود «مطلوب»)؛ ألغِ ذلك لتجعله مطلوباً بشرط.</p>
          ) : (
            <RuleEditor title="يصبح الحقل مطلوباً عندما" empty="اختياري دائماً" value={requiredWhen} subjects={subjects} onChange={setRequiredWhen} />
          )}
          <section className="rule-editor">
            <div className="rule-editor-head">
              <h4>أثر تعديل الحقل بعد الإرجاع</h4>
              <span className="pill">{CHANGE_POLICIES.find(([p]) => p === field.changePolicy)?.[1]}</span>
            </div>
            {field.changePolicy === 'RESTART_STAGES' ? (
              stages.length ? (
                <div className="rule-values" role="group" aria-label="المراحل التي تعاد">
                  {stages.map((s) => (
                    <label key={s.key} className="check-label">
                      <input
                        type="checkbox"
                        checked={affects.includes(s.key)}
                        onChange={(e) => setAffects(e.target.checked ? [...affects, s.key] : affects.filter((x) => x !== s.key))}
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
              ) : (
                <p className="micro muted">لا مراحل منشورة لهذا النوع بعد.</p>
              )
            ) : (
              <p className="micro muted">
                {field.changePolicy === 'DESCRIPTIVE'
                  ? 'تعديل وصفي: تبقى الموافقات السابقة.'
                  : 'يعاد الاعتماد كاملاً عند تعديل الحقل. اختر «يعيد المراحل المتأثرة» في الجدول لتحديد المراحل.'}
              </p>
            )}
          </section>
        </div>
        <aside className="rules-try card padding">
          <h4>جرّب القواعد</h4>
          <p className="micro muted">تُقيّم القواعد في الخادم بنفس منطق الإرسال، دون حفظ.</p>
          {referenced.map((f) => (
            <label className="field" key={f.id}>
              <span>{f.label}</span>
              {f.kind === 'select' ? (
                <select value={values[f.id] ?? ''} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}>
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.kind === 'number' || f.kind === 'files' ? 'number' : f.kind === 'date' ? 'date' : 'text'}
                  value={values[f.id] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                />
              )}
            </label>
          ))}
          {FACT_SUBJECTS.map((s) => {
            const k = s.key.slice(5);
            return (
              <label className="field" key={k}>
                <span>{s.label}</span>
                {s.kind === 'requestType' ? (
                  <select value={facts[k]} onChange={(e) => setFacts({ ...facts, [k]: e.target.value })}>
                    <option value="">—</option>
                    {app.requestTypes.map((t) => (
                      <option key={t.code} value={t.code}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input type="number" value={facts[k]} onChange={(e) => setFacts({ ...facts, [k]: e.target.value })} />
                )}
              </label>
            );
          })}
          <div className="rules-result" aria-live="polite">
            {result?.state && (
              <>
                <b className={result.state.visible ? 'good' : 'bad'}>{result.state.visible ? 'يظهر' : 'لا يظهر'}</b>
                {result.state.visible && <b className={result.state.required ? 'bad' : ''}> · {result.state.required ? 'مطلوب' : 'اختياري'}</b>}
              </>
            )}
            {result?.errors.map((e) => (
              <div key={e} className="micro bad">
                {e}
              </div>
            ))}
          </div>
        </aside>
      </div>
      <div className="dialog-actions">
        <button
          className="button primary"
          onClick={() => {
            onApply({ visibleWhen, requiredWhen: field.required ? null : requiredWhen, affectsStages: field.changePolicy === 'RESTART_STAGES' ? affects : undefined });
            onClose();
          }}
        >
          تطبيق على المسودة
        </button>
        <button className="button" onClick={onClose}>
          إلغاء
        </button>
      </div>
    </Dialog>
  );
}
