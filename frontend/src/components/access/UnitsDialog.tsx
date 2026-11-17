import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { HierarchyLevel, OrgBranch } from '../../api/types';
import type { TreeSource } from '../tree/tree';
import { UnitTree } from '../tree/UnitTree';
import { Dialog, DialogHead, Icon } from '../ui';
import './unitsDialog.css';

export type UnitChoice = { id: string; name: string; mode: 'ONE' | 'BRANCH' | 'LEVELS'; levels: number[] };

/** A number of units, in Arabic. */
export function unitCount(n: number): string {
  return n === 1 ? 'وحدة واحدة' : n === 2 ? 'وحدتان' : n.toLocaleString('en-US') + (n >= 3 && n <= 10 ? ' وحدات' : ' وحدة');
}

/** The sentence for what a chosen unit covers. */
export function coveredText(u: UnitChoice, units: number | undefined): string {
  if (u.mode === 'ONE') return u.name + ' فقط';
  if (u.mode === 'LEVELS') {
    if (!u.levels.length) return 'اختر مستوى واحداً على الأقل';
    return 'المستوى ' + [...u.levels].sort((a, b) => a - b).join(' و') + (units == null ? '' : ' — ' + unitCount(units));
  }
  return units == null || units <= 1 ? u.name + ' وفروعها' : u.name + ' + ' + unitCount(units - 1) + ' تابعة';
}

/** What a chosen level covers for «معتمد السلسلة الهرمية», in TNQL's words (ADR-061). */
export function chainCoveredText(u: UnitChoice, units: number | undefined): string {
  if (u.mode === 'ONE') return 'مستوى ' + u.name + ' فقط';
  if (u.mode === 'BRANCH') return u.name + (units == null ? ' + التابعة' : ' + ' + Math.max(0, units - 1).toLocaleString('en-US') + ' تابعة') + ' (حيث لا معتمد مباشر)';
  return 'النطاق المحفوظ: مستويات ' + u.levels.join('، ');
}

/**
 * «تعيين» as in the movement programme (ADR-042): a tree starting at the main units the granter may reach, and a table of the
 * chosen units, each with its own reach. A newly ticked unit starts as «الوحدة فقط», so nothing widens without being chosen; a
 * final approver is given a whole unit with its levels, or every unit. The server still refuses what the granter may not give.
 */
export function UnitsDialog({ roleName, home, value, everything, finalApprover, chain = false, person, onSave, onClose }: {
  roleName: string;
  home: { id: string; name: string };
  value: UnitChoice[];
  everything: boolean;
  finalApprover: boolean;
  /** «معتمد السلسلة الهرمية» (ADR-061, TNQL's dialog): «هذا المستوى فقط» (the default) or with every unit below it; no main unit. */
  chain?: boolean;
  person?: string;
  onSave: (units: UnitChoice[], everything: boolean) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<UnitChoice[]>(value);
  const [all, setAll] = useState(everything);
  const [mainIds, setMainIds] = useState<Set<string>>(new Set());
  const [levels, setLevels] = useState<HierarchyLevel[]>([]);
  const [covered, setCovered] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const asked = useRef<Record<string, string>>({});

  useEffect(() => {
    api.hierarchyLevels().then(setLevels).catch(() => setLevels([]));
  }, []);

  // the one units tree (owner, 16 Nov 2026): from the main units the granter may reach, and a search inside them only
  const mainRef = useRef<Set<string>>(new Set());
  const source = useMemo<TreeSource<OrgBranch>>(
    () => ({
      roots: async () => {
        const mains = await api.grantRoots();
        mainRef.current = new Set(mains.map((m) => m.id));
        setMainIds(mainRef.current);
        return mains.length ? mains : api.orgRoots(); // a hierarchy with no main units starts at its top
      },
      children: (id) => api.orgChildren(id),
      search: (q, signal) =>
        api.orgSearch(q, signal).then((r) =>
          r
            .filter((h) => !mainRef.current.size || mainRef.current.has(h.id) || h.path?.some((x) => mainRef.current.has(x.id)))
            .map((h) => ({ item: h, path: (h.path ?? []).map((x) => x.name).join(' ‹ '), trail: (h.path ?? []).map((x) => x.id) })),
        ),
    }),
    [],
  );

  // what each row covers today, asked only when the row's reach changes
  useEffect(() => {
    for (const r of rows) {
      const key = r.mode + ':' + r.levels.join(',');
      if (asked.current[r.id] === key || r.mode === 'ONE' || (r.mode === 'LEVELS' && !r.levels.length)) continue;
      asked.current[r.id] = key;
      api.scopePreview(r.id, true, r.mode === 'LEVELS' ? r.levels : undefined)
        .then((p) => setCovered((c) => ({ ...c, [r.id]: p.units })))
        .catch(() => undefined);
    }
  }, [rows]);

  const chosen = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const isMain = (id: string) => chain && mainIds.has(id);
  const toggleRow = (o: { id: string; name: string }) =>
    isMain(o.id) && !chosen.has(o.id)
      ? setError('الوحدة الرئيسية ليست مستوى في السلسلة الهرمية — اختر مستوى تحتها')
      : setRows((rs) => (rs.some((r) => r.id === o.id) ? rs.filter((r) => r.id !== o.id) : [...rs, { id: o.id, name: o.name, mode: finalApprover && !chain ? 'BRANCH' : 'ONE', levels: [] }]));
  const dirty = JSON.stringify(rows.map((r) => [r.id, r.mode, r.levels])) !== JSON.stringify(value.map((r) => [r.id, r.mode, r.levels])) || all !== everything;
  const close = () => {
    if (chain && dirty && !window.confirm('تغييرات غير محفوظة… إغلاق دون حفظ؟')) return;
    onClose();
  };
  const save = () => {
    if (chain && !rows.length && value.length && !window.confirm('لم تُحدَّد أي وحدة: سحب «' + roleName + '» من الجميع؟')) return;
    onSave(all ? [] : rows, all);
  };
  const patch = (id: string, p: Partial<UnitChoice>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const incomplete = rows.some((r) => r.mode === 'LEVELS' && !r.levels.length);
  return (
    <Dialog open onClose={close} className="large-dialog">
      <DialogHead eyebrow="UNITS" title={'تعيين ' + roleName} small={person ? person + ' — ' + home.name : home.name} onClose={close} />
      <div className="dialog-content ud-body" data-testid="units-dialog" data-chain={chain || undefined}>
        {chain && (
          <div className="ud-info" data-testid="chain-info">
            يعتمد هذا الشخص مستوى السلسلة الهرمية في كل وحدة تختارها. الافتراضي «هذا المستوى فقط»: لا يشمل التعيين أي وحدة تابعة.
            {rows.some((r) => r.mode === 'BRANCH') && (
              <span> نطاق «هذا المستوى ومع جميع الوحدات التابعة» يمدّ الاعتماد إلى كل وحدة تابعة ليس لها معتمد مباشر: المعتمد المعيَّن على الوحدة نفسها يعتمد أولاً، ولا يُرجع إلى هذا التعيين إلا حيث لا يوجد معتمد مباشر.</span>
            )}
          </div>
        )}
        {finalApprover && !chain && (
          <label className="check-label">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> كل الوحدات الحالية والمستقبلية
          </label>
        )}
        {!all && (
          <div className="ud-grid">
            <section className="ud-tree" aria-label="الهيكل">
              {chain && <h4 className="ud-tree-head">الهيكل التنظيمي <small className="muted">ضع علامة لإضافة الوحدة</small></h4>}
              <UnitTree
                source={source}
                label="الهيكل التنظيمي"
                searchLabel="ابحث عن وحدة"
                search="ابحث عن وحدة بالاسم…"
                testId="units-tree"
                checked={chosen}
                onCheck={toggleRow}
                disabled={(o) => (isMain(o.id) ? 'الوحدة الرئيسية ليست مستوى في السلسلة الهرمية — اختر مستوى تحتها' : null)}
                empty="لا توجد وحدة ضمن ما يمكنك منحه."
              />
            </section>
            <section className="ud-chosen">
              <h4>الوحدات المحددة <span className="pill">{rows.length.toLocaleString('en-US')}</span></h4>
              {rows.length === 0 && <div className="empty">لم تُحدد أي وحدة. ضع علامة على وحدة من الهيكل.</div>}
              {rows.length > 0 && (
                <table className="data-table">
                  <thead>
                    <tr>
                      {chain && <th>#</th>}
                      <th>الوحدة</th>
                      <th>الوحدات المغطاة</th>
                      <th>نطاق الاعتماد</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.id} data-testid="unit-row">
                        {chain && <td className="latin">{i + 1}</td>}
                        <td>{r.name}</td>
                        <td data-testid="unit-covered">{chain ? chainCoveredText(r, covered[r.id]) : coveredText(r, covered[r.id])}</td>
                        <td>
                          {chain ? (
                            <select aria-label={'نطاق الاعتماد ' + r.name} value={r.mode} onChange={(e) => patch(r.id, { mode: e.target.value as UnitChoice['mode'] })}>
                              <option value="ONE">هذا المستوى فقط</option>
                              <option value="BRANCH">هذا المستوى ومع جميع الوحدات التابعة</option>
                              {r.mode === 'LEVELS' && <option value="LEVELS" disabled>النطاق المحفوظ: مستويات محددة</option>}
                            </select>
                          ) : (
                            <select aria-label={'نطاق الاعتماد ' + r.name} value={r.mode} onChange={(e) => patch(r.id, { mode: e.target.value as UnitChoice['mode'] })}>
                              {!finalApprover && <option value="ONE">الوحدة فقط</option>}
                              <option value="BRANCH">الوحدة مع جميع مستوياتها</option>
                              {!finalApprover && <option value="LEVELS">مستويات محددة</option>}
                            </select>
                          )}
                          {!chain && r.mode === 'LEVELS' && (
                            <div className="ud-levels" role="group" aria-label={'مستويات ' + r.name}>
                              {levels.map((l) => (
                                <label key={l.level}>
                                  <input
                                    type="checkbox"
                                    checked={r.levels.includes(l.level)}
                                    onChange={(e) => patch(r.id, { levels: e.target.checked ? [...r.levels, l.level] : r.levels.filter((x) => x !== l.level) })}
                                  />
                                  {l.level}
                                </label>
                              ))}
                              {levels.length === 0 && <small className="muted">تظهر المستويات بعد استيراد الهيكل.</small>}
                            </div>
                          )}
                        </td>
                        <td>
                          <button type="button" className="icon-button" aria-label={'إزالة ' + r.name} onClick={() => toggleRow(r)}>
                            <Icon name="close" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!chain && <p className="micro muted">تصل إلى هذا المعتمد طلبات الوحدات المشمولة، ما لم يوجد معتمد أقرب منه إلى الوحدة طالبة الإجراء.</p>}
            </section>
          </div>
        )}
      </div>
      <div className="dialog-actions">
        {error && <div className="error-text" role="alert">{error}</div>}
        {chain && <span className="ud-count">المحدد: <b className="latin">{rows.length}</b></span>}
        <button className="button primary" disabled={(incomplete && !chain) || (chain && rows.some((r) => r.mode === 'LEVELS'))} onClick={save} data-testid="units-save">
          {chain ? 'حفظ التعيين' : 'اعتماد الاختيار'}
        </button>
        <button className="button" onClick={close}>إلغاء</button>
      </div>
    </Dialog>
  );
}
