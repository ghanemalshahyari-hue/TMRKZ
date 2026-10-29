import { useEffect, useRef, useState } from 'react';
import type { Rule, RuleOp, RuleValue } from '../../api/types';
import { describeRule, fromTree, incomplete, OP_LABELS, opsFor, toTree, type Cond, type Group, type Node, type RuleSubject } from '../../lib/rules';
import { Icon } from '../ui';

const MAX_DEPTH = 2;

function newCond(subjects: RuleSubject[]): Cond {
  const s = subjects[0];
  return { type: 'cond', subject: s?.key ?? '', op: s ? opsFor(s.kind)[0] : 'eq', value: undefined };
}

function ValueInput({ cond, subject, onChange }: { cond: Cond; subject: RuleSubject | undefined; onChange: (v: RuleValue | undefined) => void }) {
  if (cond.op === 'empty' || cond.op === 'notEmpty') return <span className="micro muted">—</span>;
  const label = 'قيمة الشرط';
  if (cond.op === 'in') {
    if (subject?.options?.length) {
      const chosen = Array.isArray(cond.value) ? cond.value.map(String) : [];
      return (
        <div className="rule-values" role="group" aria-label={label}>
          {subject.options.map((o) => (
            <label key={o.value} className="check-label">
              <input
                type="checkbox"
                checked={chosen.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...chosen, o.value] : chosen.filter((x) => x !== o.value))}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    return (
      <input
        aria-label={label}
        placeholder="قيم مفصولة بفاصلة"
        value={Array.isArray(cond.value) ? cond.value.join('، ') : ''}
        onChange={(e) => onChange(e.target.value.split(/[،,]/).map((x) => x.trim()).filter(Boolean))}
      />
    );
  }
  if (subject?.options?.length) {
    return (
      <select aria-label={label} value={cond.value === undefined ? '' : String(cond.value)} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">اختر…</option>
        {subject.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (subject?.kind === 'number' || subject?.kind === 'files') {
    return (
      <input
        aria-label={label}
        type="number"
        value={cond.value === undefined ? '' : String(cond.value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  }
  return (
    <input
      aria-label={label}
      type={subject?.kind === 'date' ? 'date' : 'text'}
      value={cond.value === undefined ? '' : String(cond.value)}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    />
  );
}

function GroupView({
  group,
  subjects,
  depth,
  onChange,
  onRemove,
}: {
  group: Group;
  subjects: RuleSubject[];
  depth: number;
  onChange: (g: Group) => void;
  onRemove?: () => void;
}) {
  const byKey = new Map(subjects.map((s) => [s.key, s]));
  const set = (i: number, n: Node | null) => {
    const items = [...group.items];
    if (n) items[i] = n;
    else items.splice(i, 1);
    onChange({ ...group, items });
  };
  return (
    <div className={'rule-group depth-' + depth}>
      <div className="rule-group-head">
        <select aria-label="طريقة الجمع" value={group.mode} onChange={(e) => onChange({ ...group, mode: e.target.value as 'all' | 'any' })}>
          <option value="all">تتحقق كل الشروط التالية (و)</option>
          <option value="any">يتحقق أي شرط مما يلي (أو)</option>
        </select>
        <label className="check-label">
          <input type="checkbox" checked={group.negate} onChange={(e) => onChange({ ...group, negate: e.target.checked })} />
          عكس النتيجة (ليس)
        </label>
        {onRemove && (
          <button className="button compact" onClick={onRemove} aria-label="حذف المجموعة">
            <Icon name="close" /> حذف المجموعة
          </button>
        )}
      </div>
      <ul className="rule-items">
        {group.items.map((n, i) =>
          n.type === 'group' ? (
            <li key={i}>
              <GroupView group={n} subjects={subjects} depth={depth + 1} onChange={(g) => set(i, g)} onRemove={() => set(i, null)} />
            </li>
          ) : (
            <li key={i} className="rule-cond">
              <select
                aria-label="موضوع الشرط"
                value={n.subject}
                onChange={(e) => {
                  const s = byKey.get(e.target.value);
                  const ops = s ? opsFor(s.kind) : [];
                  set(i, { ...n, subject: e.target.value, op: ops.includes(n.op) ? n.op : ops[0], value: undefined });
                }}
              >
                {!byKey.has(n.subject) && <option value={n.subject}>{n.subject} (غير معرف)</option>}
                <optgroup label="حقول النموذج">
                  {subjects
                    .filter((s) => s.key.startsWith('field:'))
                    .map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="معطيات الطلب">
                  {subjects
                    .filter((s) => s.key.startsWith('fact:'))
                    .map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                </optgroup>
              </select>
              <select aria-label="المعامل" value={n.op} onChange={(e) => set(i, { ...n, op: e.target.value as RuleOp, value: undefined })}>
                {opsFor(byKey.get(n.subject)?.kind ?? 'text').map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </select>
              <ValueInput cond={n} subject={byKey.get(n.subject)} onChange={(value) => set(i, { ...n, value })} />
              <button className="icon-button" onClick={() => set(i, null)} aria-label="حذف الشرط">
                ×
              </button>
            </li>
          ),
        )}
      </ul>
      <div className="rule-group-actions">
        <button className="button compact" onClick={() => onChange({ ...group, items: [...group.items, newCond(subjects)] })}>
          <Icon name="plus" /> شرط
        </button>
        {depth < MAX_DEPTH && (
          <button
            className="button compact"
            onClick={() => onChange({ ...group, items: [...group.items, { type: 'group', mode: 'any', negate: false, items: [newCond(subjects)] }] })}
          >
            <Icon name="plus" /> مجموعة شروط
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Visual editor of the restricted rule language (all / any / not, field or fact, typed operator, literal value).
 * Produces the same JSON the server validates and evaluates; nothing typed here is ever executed.
 */
export function RuleEditor({
  title,
  empty,
  value,
  subjects,
  onChange,
}: {
  title: string;
  empty: string;
  value: Rule | null | undefined;
  subjects: RuleSubject[];
  onChange: (r: Rule | null) => void;
}) {
  const [tree, setTree] = useState<Group | null>(() => toTree(value));
  const emitted = useRef<string>(JSON.stringify(value ?? null));
  // A new value from outside (another field, a reload) replaces the tree; our own echo does not, so a half-built
  // condition or a one-item "any" group is not normalised away while it is being edited.
  useEffect(() => {
    const incoming = JSON.stringify(value ?? null);
    if (incoming !== emitted.current) {
      emitted.current = incoming;
      setTree(toTree(value));
    }
  }, [value]);

  const update = (g: Group | null) => {
    setTree(g);
    const next = fromTree(g);
    emitted.current = JSON.stringify(next);
    onChange(next);
  };
  const missing = incomplete(tree);
  const rule = fromTree(tree);
  return (
    <section className="rule-editor" aria-label={title}>
      <div className="rule-editor-head">
        <h4>{title}</h4>
        {tree ? (
          <button className="button compact danger" onClick={() => update(null)}>
            إزالة الشرط
          </button>
        ) : (
          <button className="button compact" onClick={() => update({ type: 'group', mode: 'all', negate: false, items: [newCond(subjects)] })}>
            <Icon name="plus" /> إضافة شرط
          </button>
        )}
      </div>
      {tree ? (
        <GroupView group={tree} subjects={subjects} depth={0} onChange={update} />
      ) : (
        <p className="micro muted">{empty}</p>
      )}
      <p className="rule-sentence" aria-live="polite">
        <b>الصياغة:</b> {rule ? describeRule(rule, subjects) : empty}
        {missing > 0 && <span className="bad"> — {missing} شرط غير مكتمل؛ أكمله قبل النشر</span>}
      </p>
    </section>
  );
}
