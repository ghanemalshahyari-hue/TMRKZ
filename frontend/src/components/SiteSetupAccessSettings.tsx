import { useEffect, useMemo, useState } from 'react';
import { api, type SiteSetupAccessRule } from '../api/client';
import type { OrgNode, Person, RoleDef } from '../api/types';
import { useApp } from '../lib/app';

type Flat = { id: string; name: string; code: string; level: number };
const flatten = (nodes: OrgNode[], level = 1, out: Flat[] = []): Flat[] => {
  for (const n of nodes) {
    out.push({ id: n.id, name: n.name, code: n.code, level });
    flatten(n.children ?? [], level + 1, out);
  }
  return out;
};
const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * «الإعدادات → صلاحيات تهيئة المواقع» (owner brief §3, phase 7; ADR-089): who may set up a site with its unit's initial
 * stationing besides the system administrator — the roles, the people, the units (with or without the units under them) and
 * the levels. Not hard-coded: the initial rule is «معتمد عمليات الوحدة». The server checks it on every save.
 */
export function SiteSetupAccessSettings() {
  const app = useApp();
  const [rule, setRule] = useState<SiteSetupAccessRule | null>(null);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [tree, setTree] = useState<OrgNode[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Person[]>([]);
  const [unitQ, setUnitQ] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    api.siteSetupAccessRule().then(setRule, (e: Error) => setErr(e.message));
    api.roles().then(setRoles, () => undefined);
    api.orgTree().then(setTree, () => undefined);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(() => api.people(q.trim()).then((p) => setFound(p.items.slice(0, 8)), () => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const units = useMemo(() => flatten(tree), [tree]);
  const unitHits = unitQ.trim().length < 2 ? [] : units.filter((u) => u.name.includes(unitQ.trim()) || u.code.includes(unitQ.trim())).slice(0, 8);
  if (!rule) return <section className="card padding" data-testid="site-setup-access" style={{ gridColumn: '1 / -1' }}><h2>صلاحيات تهيئة المواقع</h2>{err ? <p className="sw-err">{err}</p> : <p className="micro muted">جارٍ التحميل…</p>}</section>;

  const set = (r: Partial<SiteSetupAccessRule>) => (setRule({ ...rule, ...r }), setDirty(true));
  const toggleRole = (code: string) => set({ roles: rule.roles.includes(code) ? rule.roles.filter((x) => x !== code) : [...rule.roles, code] });
  const toggleLevel = (l: number) => set({ levels: rule.levels.includes(l) ? rule.levels.filter((x) => x !== l) : [...rule.levels, l].sort((a, b) => a - b) });
  const save = () => {
    setBusy(true);
    setErr('');
    api.saveSiteSetupAccessRule({
      roles: rule.roles, persons: rule.persons.map((p) => p.id), units: rule.units.map((u) => ({ id: u.id, includeDescendants: u.includeDescendants })), levels: rule.levels, reason: reason.trim(),
    }).then((r) => {
      setRule(r);
      setDirty(false);
      setReason('');
      app.toast('حُفظت صلاحيات تهيئة المواقع');
    }, (e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  const roleName = (c: string) => roles.find((r) => r.code === c)?.name ?? c;
  // the rule in one sentence, as the server applies it
  const who = [...rule.roles.map((c) => '«' + roleName(c) + '»'), ...rule.persons.map((p) => p.name)].join('، ') || '—';
  const where = rule.units.length ? rule.units.map((u) => u.name + (u.includeDescendants ? ' وما تحتها' : '')).join('، ') : 'الوحدات في نطاق صلاحيته';
  const levels = rule.levels.length ? 'المستويات ' + rule.levels.join('، ') : 'كل المستويات';

  return (
    <section className="card padding sa-settings" data-testid="site-setup-access" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h2>صلاحيات تهيئة المواقع</h2>
        <span className="pill">{rule.saved ? 'محفوظة' : 'الإعداد المبدئي'}</span>
      </div>
      <p className="micro muted" style={{ margin: '6px 0 12px' }}>من يهيئ موقع «معسكر» ويسجل التمركز المبدئي لوحدته، غير مدير النظام الذي يهيئ دائماً. يفحص الخادم القاعدة عند كل حفظ.</p>
      <p className="sa-sentence" data-testid="site-setup-access-sentence"><b>{who}</b> يهيئ مواقع <b>{where}</b> · {levels}.</p>
      <div className="sa-grid">
        <fieldset className="sa-box">
          <legend>الدور</legend>
          <div className="sa-checks" data-testid="sa-roles">
            {roles.filter((r) => !r.system || rule.roles.includes(r.code) || r.code === 'UNIT_OPERATIONS_APPROVER').map((r) => (
              <label key={r.code} className="sa-check"><input type="checkbox" checked={rule.roles.includes(r.code)} onChange={() => toggleRole(r.code)} /> {r.name}</label>
            ))}
          </div>
        </fieldset>
        <fieldset className="sa-box">
          <legend>الأشخاص</legend>
          <ul className="sa-chosen">{rule.persons.map((p) => <li key={p.id}>{p.name}<button type="button" aria-label={'إزالة ' + p.name} onClick={() => set({ persons: rule.persons.filter((x) => x.id !== p.id) })}>✕</button></li>)}</ul>
          <input className="sw-input" aria-label="بحث عن شخص" placeholder="ابحث بالاسم أو الرقم…" value={q} onChange={(e) => setQ(e.target.value)} />
          {found.length > 0 && <ul className="sa-hits">{found.filter((p) => !rule.persons.some((x) => x.id === p.id)).map((p) => <li key={p.id}><button type="button" onClick={() => { set({ persons: [...rule.persons, { id: p.id, name: p.displayName }] }); setQ(''); }}>＋ {p.displayName}</button></li>)}</ul>}
        </fieldset>
        <fieldset className="sa-box">
          <legend>الوحدات ونطاقها</legend>
          <ul className="sa-chosen">{rule.units.map((u) => (
            <li key={u.id}>{u.name}
              <label className="sa-check"><input type="checkbox" checked={u.includeDescendants} onChange={(e) => set({ units: rule.units.map((x) => (x.id === u.id ? { ...x, includeDescendants: e.target.checked } : x)) })} /> وما تحتها</label>
              <button type="button" aria-label={'إزالة ' + u.name} onClick={() => set({ units: rule.units.filter((x) => x.id !== u.id) })}>✕</button>
            </li>
          ))}</ul>
          <input className="sw-input" aria-label="بحث عن وحدة" placeholder="ابحث باسم الوحدة أو رمزها…" value={unitQ} onChange={(e) => setUnitQ(e.target.value)} />
          {unitHits.length > 0 && <ul className="sa-hits">{unitHits.filter((u) => !rule.units.some((x) => x.id === u.id)).map((u) => <li key={u.id}><button type="button" onClick={() => { set({ units: [...rule.units, { id: u.id, name: u.name, includeDescendants: true }] }); setUnitQ(''); }}>＋ {u.name} <small>المستوى {u.level}</small></button></li>)}</ul>}
          <p className="micro muted">بلا وحدات: الوحدات التي يغطيها الدور، أو كل الوحدات للأشخاص المسمَّين.</p>
        </fieldset>
        <fieldset className="sa-box">
          <legend>المستويات</legend>
          <div className="sa-checks" data-testid="sa-levels">
            {LEVELS.map((l) => <label key={l} className="sa-check"><input type="checkbox" checked={rule.levels.includes(l)} onChange={() => toggleLevel(l)} /> {l}</label>)}
          </div>
          <p className="micro muted">المستوى 1 هو الوحدة العليا. بلا اختيار: كل المستويات.</p>
        </fieldset>
      </div>
      {rule.updatedBy && <p className="micro muted">آخر تغيير: {rule.updatedBy}{rule.reason ? ' — ' + rule.reason : ''}</p>}
      <div className="sa-save">
        <input className="sw-input" aria-label="سبب التغيير" placeholder="سبب التغيير (يُحفظ في سجل التدقيق)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="button" className="button primary" data-testid="save-site-setup-access" disabled={busy || !dirty || reason.trim().length < 5} onClick={save}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</button>
      </div>
      {err && <p className="sw-err" role="alert">{err}</p>}
    </section>
  );
}
