import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { HierarchyLevel, OrgBranch } from '../../api/types';
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

/**
 * «تعيين» as in the movement programme (ADR-042): a tree starting at the main units the granter may reach, and a table of the
 * chosen units, each with its own reach. A newly ticked unit starts as «الوحدة فقط», so nothing widens without being chosen; a
 * final approver is given a whole unit with its levels, or every unit. The server still refuses what the granter may not give.
 */
export function UnitsDialog({ roleName, home, value, everything, finalApprover, onSave, onClose }: {
  roleName: string;
  home: { id: string; name: string };
  value: UnitChoice[];
  everything: boolean;
  finalApprover: boolean;
  onSave: (units: UnitChoice[], everything: boolean) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<UnitChoice[]>(value);
  const [all, setAll] = useState(everything);
  const [roots, setRoots] = useState<OrgBranch[] | null>(null);
  const [mainIds, setMainIds] = useState<Set<string>>(new Set());
  const [kids, setKids] = useState<Record<string, OrgBranch[] | 'loading'>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<OrgBranch[] | null>(null);
  const [levels, setLevels] = useState<HierarchyLevel[]>([]);
  const [covered, setCovered] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const asked = useRef<Record<string, string>>({});

  useEffect(() => {
    api.hierarchyLevels().then(setLevels).catch(() => setLevels([]));
  }, []);

  useEffect(() => {
    let live = true;
    api
      .grantRoots()
      .then(async (mains) => {
        if (!live) return;
        setMainIds(new Set(mains.map((m) => m.id)));
        setRoots(mains.length ? mains : await api.orgRoots()); // a hierarchy with no main units starts at its top
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) return setHits(null);
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.orgSearch(q.trim(), ctl.signal).then(setHits).catch(() => undefined);
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

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
  const toggleRow = (o: { id: string; name: string }) =>
    setRows((rs) => (rs.some((r) => r.id === o.id) ? rs.filter((r) => r.id !== o.id) : [...rs, { id: o.id, name: o.name, mode: finalApprover ? 'BRANCH' : 'ONE', levels: [] }]));
  const patch = (id: string, p: Partial<UnitChoice>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const expand = (id: string) => {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!kids[id]) {
      setKids((k) => ({ ...k, [id]: 'loading' }));
      api.orgChildren(id).then((r) => setKids((k) => ({ ...k, [id]: r }))).catch((e: Error) => setError(e.message));
    }
  };

  const node = (o: OrgBranch): React.ReactNode => {
    const children = kids[o.id];
    return (
      <li key={o.id}>
        <div className={'ud-node' + (chosen.has(o.id) ? ' on' : '')}>
          {o.childCount > 0 ? (
            <button type="button" className="ud-arrow" aria-label={(open.has(o.id) ? 'طي ' : 'فتح ') + o.name} aria-expanded={open.has(o.id)} onClick={() => expand(o.id)}>
              {open.has(o.id) ? '▾' : '◂'}
            </button>
          ) : (
            <span className="ud-arrow" />
          )}
          <label>
            <input type="checkbox" checked={chosen.has(o.id)} onChange={() => toggleRow(o)} /> {o.name}
          </label>
        </div>
        {open.has(o.id) && children === 'loading' && <div className="ud-note">جارٍ التحميل…</div>}
        {open.has(o.id) && Array.isArray(children) && <ul>{children.map(node)}</ul>}
      </li>
    );
  };

  // as the tree: the main units and below only
  const shown = (hits ?? []).filter((h) => !mainIds.size || mainIds.has(h.id) || h.path?.some((p) => mainIds.has(p.id)));
  const incomplete = rows.some((r) => r.mode === 'LEVELS' && !r.levels.length);
  return (
    <Dialog open onClose={onClose} className="large-dialog">
      <DialogHead eyebrow="UNITS" title={'تعيين ' + roleName} small={home.name} onClose={onClose} />
      <div className="dialog-content ud-body" data-testid="units-dialog">
        {finalApprover && (
          <label className="check-label">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> كل الوحدات الحالية والمستقبلية
          </label>
        )}
        {!all && (
          <div className="ud-grid">
            <section className="ud-tree" aria-label="الهيكل">
              <input type="search" aria-label="ابحث عن وحدة" placeholder="ابحث عن وحدة بالاسم…" value={q} onChange={(e) => setQ(e.target.value)} />
              {hits ? (
                <ul>
                  {shown.map((h) => (
                    <li key={h.id}>
                      <label className="ud-hit">
                        <input type="checkbox" checked={chosen.has(h.id)} onChange={() => toggleRow(h)} /> {h.name}
                        {h.path?.length ? <small className="muted"> {h.path.map((p) => p.name).join(' ‹ ')}</small> : null}
                      </label>
                    </li>
                  ))}
                  {shown.length === 0 && <li className="ud-note">لا توجد وحدة بهذا الاسم.</li>}
                </ul>
              ) : (
                <ul data-testid="units-tree">{roots?.map(node)}</ul>
              )}
            </section>
            <section className="ud-chosen">
              <h4>الوحدات المحددة <span className="pill">{rows.length.toLocaleString('en-US')}</span></h4>
              {rows.length === 0 && <div className="empty">لم تُحدد أي وحدة. ضع علامة على وحدة من الهيكل.</div>}
              {rows.length > 0 && (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>الوحدة</th>
                      <th>الوحدات المغطاة</th>
                      <th>نطاق الاعتماد</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} data-testid="unit-row">
                        <td>{r.name}</td>
                        <td data-testid="unit-covered">{coveredText(r, covered[r.id])}</td>
                        <td>
                          <select aria-label={'نطاق الاعتماد ' + r.name} value={r.mode} onChange={(e) => patch(r.id, { mode: e.target.value as UnitChoice['mode'] })}>
                            {!finalApprover && <option value="ONE">الوحدة فقط</option>}
                            <option value="BRANCH">الوحدة مع جميع مستوياتها</option>
                            {!finalApprover && <option value="LEVELS">مستويات محددة</option>}
                          </select>
                          {r.mode === 'LEVELS' && (
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
              <p className="micro muted">تصل إلى هذا المعتمد طلبات الوحدات المشمولة، ما لم يوجد معتمد أقرب منه إلى الوحدة طالبة الإجراء.</p>
            </section>
          </div>
        )}
      </div>
      <div className="dialog-actions">
        {error && <div className="error-text" role="alert">{error}</div>}
        <button className="button primary" disabled={incomplete} onClick={() => onSave(all ? [] : rows, all)}>
          اعتماد الاختيار
        </button>
        <button className="button" onClick={onClose}>إلغاء</button>
      </div>
    </Dialog>
  );
}
