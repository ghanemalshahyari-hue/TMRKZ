import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  ApiError,
  api,
  type BatchPreview,
  type GrantBody,
  type WorkspaceColumn,
  type WorkspaceHistoryRow,
  type WorkspaceHit,
  type WorkspaceMatrix,
  type WorkspaceNode,
  type WorkspacePerson,
  type WorkspaceSummary,
  type WorkspaceUnit,
} from '../../api/client';
import type { GrantView, RoleDef } from '../../api/types';
import { useApp } from '../../lib/app';
import { dubaiISO, fullDate, todayDubai } from '../../lib/dates';
import { Dialog, DialogHead, Icon } from '../ui';
import { AccessAdminDialog, AccountCardDialog, AvailabilityChips, PermitsTab, ProvidersSection, useRightsCatalogue } from './AccessAdmin';
import { AddUserDialog } from './AddUserDialog';
import { rightsText } from './adminText';
import { cellText, existingUnits } from './assign';
import { bulk, cellKey, changes, counts, lockOf, ticked, toggle, type Pending } from './stage';
import { loadWidths, resize, saveWidths, widthAt, DEFAULT_WIDTHS, type Panel, type PanelWidths } from './panelWidths';
import { FyiMains, UnitOpsRoutes } from './UnitRouting';
import { UnitsDialog, type UnitChoice } from './UnitsDialog';
import './accessWorkspace.css';
import './unitsDialog.css';

type Unit = { id: string; name: string };
type Tab = 'cards' | 'manage' | 'permits' | 'audit';

const n = (v: number) => v.toLocaleString('en-US');
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('');

/**
 * «إدارة الصلاحيات والوحدات», the access workspace of the movement programme (owner, 11 Nov 2026; ADR-058): search first,
 * then work inside one small scope. 01 finds a unit or a person; 02 is the unit tree with its sub-units and people; 03 is the
 * chosen unit's people — as cards, as the permission matrix whose ticks are held as pending changes until «حفظ التعديلات»
 * saves them together under one audit reference, or as the unit's audit trail; 04 is the unit's file and the roles every
 * member inherits. The server checks every change again.
 */
export function AccessWorkspace({ onStudio }: { onStudio: () => void }) {
  const app = useApp();
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [unit, setUnit] = useState<Unit | null>(null);
  const [file, setFile] = useState<WorkspaceUnit | null>(null);
  const [tab, setTab] = useState<Tab>('cards');
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [page, setPage] = useState(0);
  const [matrix, setMatrix] = useState<WorkspaceMatrix | null>(null);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [pending, setPending] = useState<Pending>({});
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<WorkspacePerson | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const catalogue = useRightsCatalogue();
  const colsRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<PanelWidths>(loadWidths);
  const total = () => colsRef.current?.getBoundingClientRect().width ?? window.innerWidth;
  const setWidth = (panel: Panel, px: number) => setWidths((w) => resize(w, panel, px, total()));
  const keep = () => setWidths((w) => (saveWidths(w), w));
  const reset = (panel: Panel) =>
    setWidths((w) => {
      const next = { ...w, [panel]: DEFAULT_WIDTHS[panel] };
      saveWidths(next);
      return next;
    });

  useEffect(() => {
    api.workspaceSummary().then(setSummary).catch(() => setSummary(null));
    api.roles().then(setRoles).catch(() => setRoles([]));
  }, [app.revision, reloadKey]);
  useEffect(() => {
    if (!unit) return setFile(null);
    api.workspaceUnit(unit.id).then(setFile).catch(() => setFile(null));
  }, [unit?.id, app.revision, reloadKey]);
  useEffect(() => {
    if (!unit) return setMatrix(null);
    const t = window.setTimeout(
      () =>
        api
          .workspaceMatrix(unit.id, q || undefined, page, roleFilter || undefined)
          .then((m) => (setMatrix(m), setError(null)))
          .catch((e: Error) => (setMatrix(null), setError(e.message))),
      q ? 250 : 0,
    );
    return () => window.clearTimeout(t);
  }, [unit?.id, q, page, roleFilter, app.revision, reloadKey]);

  const pendingCount = counts(pending).total;
  const choose = (u: Unit, opts?: { q?: string; tab?: Tab }) => {
    if (unit?.id !== u.id && pendingCount && !window.confirm('لديك ' + changes(pendingCount) + ' لم يُحفظ. الانتقال إلى وحدة أخرى يتجاهلها؟')) return;
    if (unit?.id !== u.id) setPending({});
    setUnit(u);
    setPage(0);
    setQ(opts?.q ?? '');
    setRoleFilter('');
    if (opts?.tab) setTab(opts.tab);
  };
  const reload = () => setReloadKey((k) => k + 1);
  const pages = matrix ? Math.max(1, Math.ceil(matrix.total / matrix.pageSize)) : 1;

  return (
    <div className="aw" data-testid="access-workspace">
      <section className="aw-hero">
        <div>
          <span className="aw-eyebrow">إدارة الصلاحيات والوحدات</span>
          <h1>ابحث أولاً، ثم اعمل داخل نطاق صغير</h1>
          <p>واجهة واحدة تجمع البحث، مساحة الوحدة، دليل التغيير، ملف الوحدة ومصفوفة التدقيق — دون تحميل المؤسسة كاملة.</p>
        </div>
        <button className="button aw-studio" onClick={onStudio} data-testid="aw-studio">
          <Icon name="external" /> مركز الإدارة الحالي
        </button>
      </section>

      <div className="aw-stats">
        <Stat value={summary?.units} label="وحدة ضمن نطاقك" />
        <Stat value={summary?.people} label="مستخدم" />
        <Stat value={summary?.active} label="مستخدم نشط" />
        <Stat value={summary?.pageSize ?? 25} label="صفًا فقط في كل صفحة" />
      </div>

      <TaskSearch
        total={summary?.units}
        onUnit={(u) => choose(u)}
        onPerson={(h) => h.unit && choose(h.unit, { q: h.employeeNo ?? '', tab: 'manage' })}
      />

      <div className="aw-cols" ref={colsRef} style={{ '--aw-tree': widths.tree + 'px', '--aw-file': widths.file + 'px' } as CSSProperties}>
        <UnitTree selected={unit?.id ?? null} trail={file && file.id === unit?.id ? file.trail : undefined} onSelect={(u) => choose(u)} revision={app.revision + reloadKey} />
        <Divider panel="tree" label="عرض لوحة الوحدات" value={widths.tree} box={colsRef} onWidth={setWidth} onDone={keep} onReset={() => reset('tree')} />

        <section className="aw-card aw-main" aria-label="الوحدة المحددة">
          <header className="aw-head">
            <span className="aw-num">03</span>
            <div className="aw-title">
              <h2>{unit ? unit.name : 'اختر وحدة'}</h2>
              <small>{unit && matrix ? n(matrix.total) + ' مستخدم · عرض ' + n(matrix.pageSize) + ' فقط في الصفحة' : 'سيظهر مستخدمو وحدة واحدة فقط.'}</small>
            </div>
            <div className="aw-tabs" role="tablist" aria-label="أقسام الوحدة">
              {(
                [
                  ['cards', 'مساحة العمل'],
                  ['manage', 'إدارة الصلاحيات'],
                  ...(file?.myRights.includes('DUTY') ? [['permits', 'تصاريح المناوبة']] : []),
                  ['audit', 'مصفوفة التدقيق'],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>
          </header>

          {!unit ? (
            <div className="aw-empty">
              <Icon name="units" />
              <b>اختر وحدة للبدء</b>
              <span>لن تُحمّل أي قائمة مستخدمين قبل اختيار نطاق واضح.</span>
            </div>
          ) : tab === 'audit' ? (
            <AuditTab unit={unit} revision={app.revision + reloadKey} />
          ) : tab === 'permits' && matrix ? (
            <PermitsTab unit={unit} matrix={matrix} onChanged={reload} />
          ) : (
            <>
              <div className="aw-add-row">
                <button className="button compact aw-add-user" data-testid="add-user" onClick={() => setAdding(true)}>
                  <Icon name="user-plus" /> إضافة مستخدم
                </button>
              </div>
              <div className="aw-tools">
                <label className="aw-search-in">
                  <Icon name="search" />
                  <input type="search" placeholder="بحث داخل الوحدة المحددة" aria-label="بحث داخل الوحدة المحددة" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} />
                </label>
                <select aria-label="تصفية حسب الصلاحية" value={roleFilter} onChange={(e) => (setRoleFilter(e.target.value), setPage(0))}>
                  <option value="">كل الصلاحيات</option>
                  {matrix?.columns.map((c) => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </select>
              </div>
              {error && <div className="error-text" role="alert">{error}</div>}
              {matrix && tab === 'cards' && (
                <Cards
                  matrix={matrix}
                  filtered={!!q || !!roleFilter}
                  onView={setViewing}
                  onAccount={(p) => setAccount(p.id)}
                />
              )}
              {matrix && tab === 'manage' && (
                <Manage
                  unit={unit}
                  matrix={matrix}
                  roles={roles}
                  catalogue={catalogue}
                  onAccount={(p) => setAccount(p.id)}
                  pending={pending}
                  setPending={setPending}
                  fresh={fresh}
                  onSaved={() => (reload(), app.bump())}
                />
              )}
              {matrix && pages > 1 && (
                <div className="aw-pager" data-testid="aw-pager">
                  <button className="button compact" disabled={page === 0} onClick={() => setPage(page - 1)}>السابق</button>
                  <span>صفحة {n(page + 1)} من {n(pages)} — الإجمالي {n(matrix.total)}</span>
                  <button className="button compact" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>التالي</button>
                </div>
              )}
              {tab === 'manage' && (
                <div className="aw-routing">
                  <UnitOpsRoutes command={unit} />
                  {summary?.global && <FyiMains />}
                </div>
              )}
            </>
          )}
        </section>

        <Divider panel="file" label="عرض ملف الوحدة" value={widths.file} box={colsRef} onWidth={setWidth} onDone={keep} onReset={() => reset('file')} />
        <UnitFile file={file} global={!!summary?.global} onChanged={(f) => (setFile(f), reload())} onReload={reload} />
      </div>

      <section className="aw-note" role="note">
        <Icon name="shield" />
        <div>
          <b>لا تُطبَّق التغييرات حتى الضغط على «حفظ التعديلات».</b>
          <span>جميع التغييرات تخضع لقواعد التفويض والتدقيق المعتمدة، وتُسجَّل بمرجع تدقيق واحد لكل حفظة.</span>
        </div>
      </section>

      {adding && unit && (
        <AddUserDialog
          unit={unit}
          onClose={() => setAdding(false)}
          onAdded={(personId, key, already) => {
            setAdding(false);
            setFresh(personId);
            setTab('manage');
            setPage(0);
            setQ(key);
            reload();
            app.toast(already ? 'المستخدم ضمن هذه الوحدة بالفعل' : 'تمت إضافة المستخدم ✓ حدد صلاحياته في صفه');
          }}
        />
      )}
      {viewing && matrix && <PersonView person={viewing} columns={matrix.columns} unit={unit!} onClose={() => setViewing(null)} />}
      {account && <AccountCardDialog personId={account} catalogue={catalogue} onClose={() => setAccount(null)} onChanged={reload} />}
    </div>
  );
}

function Stat({ value, label }: { value: number | undefined; label: string }) {
  return (
    <div className="aw-stat">
      <b>{value == null ? '—' : n(value)}</b>
      <span>{label}</span>
    </div>
  );
}

// ---- 01 search -------------------------------------------------------------------------------------------------------

function TaskSearch({ total, onUnit, onPerson }: { total: number | undefined; onUnit: (u: Unit) => void; onPerson: (h: WorkspaceHit) => void }) {
  const [kind, setKind] = useState<'UNITS' | 'PEOPLE'>('UNITS');
  const [text, setText] = useState('');
  const [hits, setHits] = useState<WorkspaceHit[] | null>(null);
  useEffect(() => {
    if (!text.trim()) return setHits(null);
    const t = window.setTimeout(() => api.workspaceSearch(text.trim(), kind).then(setHits).catch(() => setHits([])), 250);
    return () => window.clearTimeout(t);
  }, [text, kind]);
  const pick = (h: WorkspaceHit) => {
    setText('');
    setHits(null);
    if (kind === 'UNITS') onUnit({ id: h.id, name: h.name ?? '' });
    else onPerson(h);
  };
  return (
    <section className="aw-card aw-find" aria-label="مركز المهام والبحث">
      <header className="aw-head">
        <span className="aw-num">01</span>
        <h2>مركز المهام والبحث</h2>
        <small className="aw-hint">لا تبدأ من شجرة فيها {total ? n(total) : 'آلاف'} وحدة. ابحث باسم الوحدة أو الشخص.</small>
      </header>
      <div className="aw-find-row">
        <div className="aw-seg" role="radiogroup" aria-label="نوع البحث">
          <button role="radio" aria-checked={kind === 'UNITS'} className={kind === 'UNITS' ? 'on' : ''} onClick={() => setKind('UNITS')}>الوحدات</button>
          <button role="radio" aria-checked={kind === 'PEOPLE'} className={kind === 'PEOPLE' ? 'on' : ''} onClick={() => setKind('PEOPLE')}>الأشخاص</button>
        </div>
        <label className="aw-search-in aw-grow">
          <Icon name="search" />
          <input
            type="search"
            aria-label={kind === 'UNITS' ? 'ابحث عن وحدة بالاسم' : 'ابحث عن شخص بالاسم أو الرقم'}
            placeholder={kind === 'UNITS' ? 'ابحث عن وحدة بالاسم...' : 'ابحث عن شخص بالاسم أو الرقم...'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      </div>
      {hits && (
        <ul className="aw-hits" role="listbox" aria-label="نتائج البحث">
          {hits.length === 0 && <li className="aw-muted">لا نتائج ضمن نطاقك.</li>}
          {hits.map((h) => (
            <li key={h.id + (h.unit?.id ?? '')}>
              <button role="option" aria-selected={false} onClick={() => pick(h)}>
                <b>{kind === 'UNITS' ? h.name : h.displayName}</b>
                {kind === 'PEOPLE' && <span className="latin aw-muted"> · {h.employeeNo}</span>}
                <small>{h.path}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- 02 tree ---------------------------------------------------------------------------------------------------------

function UnitTree({ selected, trail, onSelect, revision }: { selected: string | null; trail?: string[]; onSelect: (u: Unit) => void; revision: number }) {
  const [roots, setRoots] = useState<WorkspaceNode[] | null>(null);
  const [kids, setKids] = useState<Record<string, WorkspaceNode[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [hits, setHits] = useState<WorkspaceHit[] | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const kidsRef = useRef(kids);
  kidsRef.current = kids;
  const first = useRef(true);
  const listRef = useRef<HTMLUListElement | null>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .workspaceTree()
      .then(async (r) => {
        if (!live) return;
        setRoots(r);
        const ids = new Set(openRef.current);
        // a single top unit opens by itself, as in the movement programme
        if (first.current && r.length === 1 && r[0].childCount) ids.add(r[0].id);
        first.current = false;
        // a refresh (a save, a new member…) keeps the tree as the person left it: every open branch is read again, so its
        // counts are current; before 16 Nov 2026 the branches were dropped and stayed marked open with nothing under them
        const loaded = await Promise.all([...ids].map((id) => api.workspaceTree(id).then((c) => [id, c] as const).catch(() => null)));
        if (!live) return;
        const next: Record<string, WorkspaceNode[]> = {};
        for (const x of loaded) if (x) next[x[0]] = x[1];
        setKids(next);
        setOpen(new Set(Object.keys(next)));
      })
      .catch(() => live && setRoots([]));
    return () => {
      live = false;
    };
  }, [revision]);
  // a unit chosen from a search, a person or the file opens its branch down to it, as MOVER's revealUnit
  const trailKey = trail?.join() ?? '';
  useEffect(() => {
    if (!selected || !trail?.length) return;
    let live = true;
    (async () => {
      const add: Record<string, WorkspaceNode[]> = {};
      for (const id of trail) {
        if (kidsRef.current[id]) continue;
        const c = await api.workspaceTree(id).catch(() => null);
        if (!live) return;
        if (c) add[id] = c;
      }
      setKids((k) => ({ ...k, ...add }));
      setOpen((o) => new Set([...o, ...trail.filter((id) => add[id] || kidsRef.current[id])]));
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, trailKey]);
  // …and brings it into view once it is drawn
  useEffect(() => {
    if (!selected || shown.current === selected) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-node="${selected}"]`);
    if (!el) return;
    shown.current = selected;
    el.scrollIntoView({ block: 'nearest' });
  }, [selected, kids, open, roots]);
  useEffect(() => {
    if (!text.trim()) return setHits(null);
    const t = window.setTimeout(() => api.workspaceSearch(text.trim(), 'UNITS').then(setHits).catch(() => setHits([])), 250);
    return () => window.clearTimeout(t);
  }, [text]);
  const expand = (id: string, force = false) => {
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id) && !force) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!kids[id]) api.workspaceTree(id).then((c) => setKids((k) => ({ ...k, [id]: c }))).catch(() => undefined);
  };
  const node = (u: WorkspaceNode, depth: number): React.ReactNode => (
    <li key={u.id}>
      <div className={'aw-node' + (selected === u.id ? ' on' : '')} data-node={u.id} style={{ paddingInlineStart: 6 + depth * 14 }}>
        {u.childCount ? (
          <button className="aw-twist" aria-label={(open.has(u.id) ? 'طي ' : 'فتح ') + u.name} aria-expanded={open.has(u.id)} onClick={() => expand(u.id)}>
            {open.has(u.id) ? '−' : '+'}
          </button>
        ) : (
          <span className="aw-twist aw-leaf">·</span>
        )}
        <button className="aw-node-name" onClick={() => onSelect({ id: u.id, name: u.name })} aria-current={selected === u.id}>
          {u.name}
        </button>
        <span className="aw-counts latin" title={u.childCount + ' وحدة فرعية · ' + u.peopleCount + ' مستخدم'}>
          {u.childCount > 0 && (
            <>
              {n(u.childCount)} <Icon name="tree" /> ·{' '}
            </>
          )}
          {n(u.peopleCount)} <Icon name="user" />
        </span>
      </div>
      {open.has(u.id) && kids[u.id] && <ul>{kids[u.id].map((c) => node(c, depth + 1))}</ul>}
    </li>
  );
  return (
    <section className="aw-card aw-tree" aria-label="الوحدات">
      <header className="aw-head">
        <span className="aw-num">02</span>
        <h2>الوحدات</h2>
        <button className="icon-button aw-collapse" aria-label="طي الكل" title="طي الكل" onClick={() => setOpen(new Set())}>—</button>
      </header>
      <label className="aw-search-in">
        <Icon name="search" />
        <input type="search" aria-label="بحث بالداخل" placeholder="بحث بالداخل — تُعرض النتيجة بمسار..." value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {hits ? (
        <ul className="aw-hits aw-inline">
          {hits.length === 0 && <li className="aw-muted">لا نتائج.</li>}
          {hits.map((h) => (
            <li key={h.id}>
              <button onClick={() => (onSelect({ id: h.id, name: h.name ?? '' }), setText(''))}>
                <b>{h.name}</b>
                <small>{h.path}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="aw-nodes" role="tree" aria-label="شجرة الوحدات" ref={listRef}>
          {roots === null && <li className="aw-muted">جارٍ التحميل…</li>}
          {roots?.map((r) => node(r, 0))}
        </ul>
      )}
    </section>
  );
}

// ---- 03 cards ----------------------------------------------------------------------------------------------------

function effectiveRoles(p: WorkspacePerson, columns: WorkspaceColumn[]) {
  return columns
    .map((c) => ({ c, cell: p.cells[c.code] }))
    .filter(({ cell }) => cell && (cell.direct || cell.inherited || cell.temporary));
}

function Cards({ matrix, filtered, onView, onAccount }: { matrix: WorkspaceMatrix; filtered: boolean; onView: (p: WorkspacePerson) => void; onAccount: (p: WorkspacePerson) => void }) {
  // a unit's users are the people added to it, never every HR employee (owner, 16 Nov 2026; ADR-061)
  if (!matrix.people.length)
    return (
      <div className="aw-empty small" data-testid="aw-no-users">
        {filtered
          ? 'لا يوجد مستخدمون مطابقون في هذه الوحدة.'
          : 'لا يوجد مستخدمون في هذه الوحدة بعد. يُضاف المستخدم من «إضافة مستخدم» بالبحث بالرقم العسكري أو رقم المستخدم، أو بطلب صلاحيات معتمد.'}
      </div>
    );
  return (
    <ul className="aw-people" data-testid="aw-cards">
      {matrix.people.map((p) => {
        // as MOVER's cards: up to three direct grants, then up to two inherited or temporary ones; the eye shows them all
        const held = effectiveRoles(p, matrix.columns);
        const direct = held.filter(({ cell }) => cell.direct).slice(0, 3);
        const other = held.filter(({ cell }) => !cell.direct).slice(0, 2);
        const more = held.length - direct.length - other.length;
        const ident = [p.employeeNo, p.position].filter(Boolean).join(' · ');
        return (
          <li key={p.id} className="aw-person" data-person={p.id}>
            <span className="aw-avatar" aria-hidden="true">{initials(p.displayName)}</span>
            <div className="aw-who">
              <b>
                <i className={'aw-dot' + (p.active && !p.accessDisabled ? ' on' : '')} title={p.active ? 'نشط' : 'غير نشط'} />
                {p.displayName}
              </b>
              {ident && <small className="aw-ident">{ident}</small>}
              <small>
                {p.username ? <span className="latin">{p.username} · </span> : null}
                {n(p.effective)} صلاحية فعّالة
              </small>
            </div>
            <div className="aw-chips">
              {[...direct, ...other].map(({ c, cell }) => (
                <span key={c.code} className={'aw-chip' + (cell.direct ? ' direct' : cell.temporary ? ' temp' : ' inherit')} title={cell.direct ? 'منح مباشر' : cell.temporary ? 'مؤقتة' : 'موروثة من الوحدة'}>
                  {c.name}
                </span>
              ))}
              {more > 0 && <span className="aw-chip tag">+{n(more)}</span>}
              {p.acting && <span className="aw-chip tag">بالإنابة</span>}
              {p.withoutHr && <span className="aw-chip tag">بدون موارد</span>}
              {p.hrUnavailable && <span className="aw-chip temp">غائب: {p.hrUnavailable}</span>}
              {p.accessDisabled && <span className="aw-chip tag">موقوف</span>}
            </div>
            <div className="aw-acts">
              <button className="icon-button" aria-label={'عرض الصلاحيات الفعّالة: ' + p.displayName} title="عرض الصلاحيات الفعّالة" onClick={() => onView(p)}>
                <Icon name="eye" />
              </button>
              <button className="icon-button" aria-label={'فتح بطاقة الحساب وتعديلها: ' + p.displayName} title="فتح بطاقة الحساب وتعديلها" onClick={() => onAccount(p)}>
                <Icon name="edit" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PersonView({ person, columns, unit, onClose }: { person: WorkspacePerson; columns: WorkspaceColumn[]; unit: Unit; onClose: () => void }) {
  const rows = effectiveRoles(person, columns);
  return (
    <Dialog open onClose={onClose} className="small-dialog">
      <DialogHead eyebrow={unit.name} title={person.displayName} small={person.employeeNo + ' · ' + n(rows.length) + ' صلاحية فعالة'} onClose={onClose} />
      <div className="dialog-body">
        {rows.length === 0 && <p className="aw-muted">لا صلاحية فعالة في هذه الوحدة.</p>}
        <ul className="aw-why">
          {rows.map(({ c, cell }) => (
            <li key={c.code}>
              <b>{c.name}</b>
              {cell.direct && <span>مباشرة: {cell.direct.scopeText}{cell.direct.validTo ? ' — حتى ' + fullDate(cell.direct.validTo) : ''}</span>}
              {cell.inherited === 'UNIT' && <span className="aw-ok">موروثة من عضوية الوحدة</span>}
              {cell.inherited === 'SEAT' && <span className="aw-ok">من منصبه في الموارد البشرية</span>}
              {cell.temporary && !cell.direct && <span className="aw-warn">مؤقتة: تفويض ساري في هذه الوحدة</span>}
            </li>
          ))}
        </ul>
        {person.lock && <p className="aw-muted"><Icon name="lock" /> {person.lock}</p>}
      </div>
    </Dialog>
  );
}

// ---- 03 manage: the matrix with pending changes ------------------------------------------------------------------

function Manage({
  unit,
  matrix,
  roles,
  pending,
  setPending,
  fresh,
  onSaved,
  catalogue,
  onAccount,
}: {
  unit: Unit;
  matrix: WorkspaceMatrix;
  roles: RoleDef[];
  catalogue: import('../../api/client').AccessRightDef[];
  onAccount: (p: WorkspacePerson) => void;
  pending: Pending;
  setPending: (p: Pending) => void;
  fresh: string | null;
  onSaved: () => void;
}) {
  const app = useApp();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [bulkRole, setBulkRole] = useState('');
  const [review, setReview] = useState<BatchPreview | null>(null);
  const [saved, setSaved] = useState<{ reference: string; affected: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ person: WorkspacePerson; column: WorkspaceColumn; grant?: GrantView } | null>(null);
  const [admin, setAdmin] = useState<{ person: WorkspacePerson; column: WorkspaceColumn; grant?: GrantView } | null>(null);
  const [wholeOk, setWholeOk] = useState(false);
  // the departments of «معتمد التوفر» share one column of chips, as TNQL's
  const avail = matrix.columns.filter((col) => col.mode === 'AVAIL');
  const shown = matrix.columns.filter((col) => col.mode !== 'AVAIL');
  const tableRef = useRef<HTMLDivElement | null>(null);
  const c = counts(pending);
  const checkable = matrix.columns.filter((col) => col.mode === 'CHECK' && !col.lock);
  useEffect(() => setChosen(new Set()), [matrix]);
  useEffect(() => {
    if (!fresh) return;
    const row = tableRef.current?.querySelector<HTMLElement>(`tr[data-person="${fresh}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [fresh, matrix]);

  const tick = (p: WorkspacePerson, col: WorkspaceColumn) => {
    const why = lockOf(p, col);
    if (why) return app.toast('🔒 ' + why);
    setSaved(null);
    setReview(null);
    setPending(toggle(pending, p, col.code));
  };
  // owner, 16 Nov 2026: «حفظ الصلاحيات لا يحتاج تأكيد» — «حفظ التعديلات» checks on the server and saves in one step. The bar stays only
  // when the server refuses a line, or when the change reaches every member of the unit (the server asks that to be acknowledged).
  const apply = async (fingerprint: string, whole: boolean) => {
    try {
      const r = await api.workspaceApply(unit.id, Object.values(pending), fingerprint, whole);
      setSaved({ reference: r.reference, affected: r.affected });
      setPending({});
      setReview(null);
      onSaved();
    } catch (e) {
      setReview(null);
      app.toast(e instanceof ApiError && e.status === 409 ? 'تغيّرت هذه الصلاحيات أثناء الحفظ؛ اضغط «حفظ التعديلات» مجدداً.' : (e as Error).message);
    }
  };
  const save = async () => {
    if (!c.total) return;
    setBusy(true);
    try {
      const r = await api.workspacePreview(unit.id, Object.values(pending));
      if (r.ok && !r.wholeUnit) await apply(r.fingerprint, false);
      else {
        setWholeOk(false);
        setReview(r);
      }
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirmWhole = async () => {
    if (!review) return;
    setBusy(true);
    try {
      await apply(review.fingerprint, wholeOk);
    } finally {
      setBusy(false);
    }
  };
  const discard = () => (setPending({}), setReview(null));
  const doBulk = (action: 'GRANT' | 'REVOKE') => {
    const col = matrix.columns.find((x) => x.code === bulkRole);
    if (!col) return;
    const rows = matrix.people.filter((p) => chosen.has(p.id));
    const r = bulk(pending, rows, col, action);
    setPending(r.pending);
    setReview(null);
    app.toast(r.staged ? 'أُضيف ' + changes(r.staged) + ' إلى المعلّق — اضغط «حفظ التعديلات»' : 'لا تغيير: الصفوف المحددة على هذه الحالة أو مقفلة');
  };

  // «تعيين» columns are saved at once through the units dialog, as in the movement programme
  const body = (p: WorkspacePerson, code: string, scope: GrantBody['scope']): GrantBody => ({ personId: p.id, organizationId: unit.id, roleCode: code, validFrom: dubaiISO(todayDubai()), scope });
  const saveUnits = async (units: UnitChoice[], everything: boolean) => {
    if (!editing) return;
    const { person, column, grant } = editing;
    setEditing(null);
    const scope = {
      mode: 'CUSTOM' as const,
      all: everything,
      targets: everything ? [] : units.map((u) => ({ kind: 'ORGANIZATION' as const, id: u.id, includeDescendants: u.mode !== 'ONE', levels: u.mode === 'LEVELS' ? u.levels : undefined })),
    };
    try {
      if (!everything && !units.length) {
        if (grant) await api.endMembership(grant.id, 'سحب من «تعيين» في إدارة الصلاحيات والوحدات');
      } else if (grant) await api.replaceGrant(grant.id, body(person, column.code, scope));
      else await api.createGrant(body(person, column.code, scope));
      app.toast('حُفظ «' + column.name + '» لـ ' + person.displayName);
      onSaved();
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  const allChosen = matrix.people.length > 0 && matrix.people.every((p) => chosen.has(p.id));
  return (
    <div className="aw-manage">
      {saved ? (
        <div className="aw-bar ok" role="status">
          <Icon name="check" /> تم حفظ التعديلات — المتأثرون: <b className="latin">{saved.affected}</b> · مرجع التدقيق: <b className="latin">{saved.reference}</b>
          <button className="button compact" onClick={() => setSaved(null)}>إغلاق</button>
        </div>
      ) : review ? (
        <div className={'aw-bar ' + (review.ok ? 'confirm' : 'bad')} role="alert" aria-label={review.ok ? 'تعديل يشمل كل مستخدمي الوحدة' : 'لم تُحفظ التعديلات'}>
          <div>
            <b>
              {review.ok ? 'هذا التعديل يشمل كل مستخدمي الوحدة' : 'لم تُحفظ التعديلات'} — {changes(c.total)}
              {review.grants > 0 && ' · إضافة ' + review.grants}
              {review.revokes > 0 && ' · سحب ' + review.revokes}
            </b>
            {!review.ok && <small>صحّح ما يلي أو ألغِ هذه التعديلات، ثم احفظ مجدداً.</small>}
            {review.lines.filter((l) => l.problem).map((l) => (
              <small key={l.personId + l.roleCode} className="aw-bad-line">✗ {l.person} — {l.role}: {l.problem}</small>
            ))}
            {review.ok && review.wholeUnit && (
              <label className="aw-whole">
                <input type="checkbox" checked={wholeOk} onChange={(e) => setWholeOk(e.target.checked)} data-testid="aw-whole" /> أؤكد أن هذا التعديل يشمل كل مستخدمي الوحدة
              </label>
            )}
          </div>
          {review.ok && (
            <button className="button compact primary" disabled={busy || !wholeOk} onClick={confirmWhole} data-testid="aw-confirm">حفظ</button>
          )}
          <button className="button compact" onClick={() => setReview(null)}>{review.ok ? 'إلغاء' : 'إغلاق'}</button>
        </div>
      ) : (
        <div className="aw-bar">
          <span>لا تعدل معلّقاً — أشّر مربعات الصلاحيات ثم اضغط «حفظ التعديلات» أسفل الجدول.</span>
          {c.total > 0 && (
            <>
              <button className="button compact primary" disabled={busy} onClick={save}>حفظ التعديلات</button>
              <button className="button compact" onClick={discard}>إلغاء التعديلات</button>
            </>
          )}
        </div>
      )}

      {chosen.size > 0 && (
        <div className="aw-bulk" role="group" aria-label="إجراء على الصفوف المحددة">
          <b>{n(chosen.size)} محدد</b>
          <select aria-label="الصلاحية" value={bulkRole} onChange={(e) => setBulkRole(e.target.value)}>
            <option value="">اختر الصلاحية…</option>
            {checkable.map((col) => (
              <option key={col.code} value={col.code}>{col.name}</option>
            ))}
          </select>
          <button className="button compact" disabled={!bulkRole} onClick={() => doBulk('GRANT')}>إضافة صلاحية</button>
          <button className="button compact" disabled={!bulkRole} onClick={() => doBulk('REVOKE')}>إزالة صلاحية</button>
          <button className="button compact" onClick={() => setChosen(new Set())}>إلغاء التحديد</button>
        </div>
      )}

      <div className="aw-table" ref={tableRef}>
        <table className="aw-matrix" data-testid="aw-matrix">
          <thead>
            <tr>
              <th className="aw-pick">
                <input
                  type="checkbox"
                  aria-label="تحديد كل الصفوف"
                  checked={allChosen}
                  onChange={() => setChosen(allChosen ? new Set() : new Set(matrix.people.map((p) => p.id)))}
                />
              </th>
              <th className="aw-c-mil">الرقم العسكري</th>
              <th className="aw-c-rank">الرتبة العسكرية</th>
              <th className="aw-user">الاسم</th>
              <th className="aw-c-uid">رقم الـــU</th>
              <th className="aw-c-pos">المنصب</th>
              {shown.map((col) => (
                <th key={col.code} title={col.lock ?? (col.mode !== 'CHECK' ? 'يُحفظ فوراً عند الضغط' : undefined)} data-col={col.code}>
                  {col.lock && <Icon name="lock" />} {col.name}
                  {col.mode !== 'CHECK' && <span className="aw-instant" title="يُحفظ فوراً عند الضغط">⚡فوري</span>}
                  {HELP[col.code] && <ColumnHelp code={col.code} name={col.name} />}
                </th>
              ))}
              {avail.length > 0 && <th title="لكل إدارة توفير: فعالة في وحدة مزوّدة، احتياطية في غيرها. يُحفظ فوراً">معتمد التوفر</th>}
            </tr>
          </thead>
          <tbody>
            {matrix.people.length === 0 && (
              <tr>
                <td colSpan={shown.length + (avail.length ? 7 : 6)} className="aw-muted">لا يوجد مستخدمون مطابقون.</td>
              </tr>
            )}
            {matrix.people.map((p) => (
              <tr key={p.id} data-person={p.id} className={p.id === fresh ? 'um-fresh' : undefined}>
                <td className="aw-pick">
                  <input
                    type="checkbox"
                    aria-label={'تحديد ' + p.displayName}
                    checked={chosen.has(p.id)}
                    onChange={() => setChosen((s) => {
                      const next = new Set(s);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    })}
                  />
                </td>
                <td className="aw-c-mil"><span className="latin">{p.employeeNo || '—'}</span></td>
                <td className="aw-c-rank" title={p.rank ? undefined : 'غير متوفر من مصدر الموارد البشرية'}>{p.rank || '—'}</td>
                <td className="aw-user">
                  <button className="aw-name" onClick={() => onAccount(p)} title="بطاقة الحساب">
                    <i className={'aw-dot' + (p.active && !p.accessDisabled ? ' on' : '')} title={p.active ? 'نشط' : 'غير نشط'} />
                    {p.displayName}
                  </button>
                  {p.acting && <span className="um-tag">بالإنابة</span>}
                  {p.withoutHr && <span className="um-tag">بدون موارد</span>}
                  {p.hrUnavailable && <span className="um-tag aw-away" title="لا تذهب إليه الخطوات حتى يعود">غائب</span>}
                  {p.accessDisabled && <span className="um-tag">موقوف</span>}
                  {p.added && <RemoveMember unit={unit} person={p} onDone={onSaved} />}
                </td>
                <td className="aw-c-uid"><span className="latin">{p.username || '—'}</span></td>
                <td className="aw-c-pos" title={p.position ?? undefined}>{p.position || '—'}</td>
                {shown.map((col) => {
                  const cell = p.cells[col.code];
                  const key = cellKey(p.id, col.code);
                  const why = lockOf(p, col);
                  const marks = (
                    <>
                      {cell?.inherited && <span className="aw-mark inh" title={cell.inherited === 'UNIT' ? 'موروثة من الوحدة' : 'من منصبه في الموارد البشرية'}>✓</span>}
                      {cell?.temporary && <span className="aw-mark tmp" title="مؤقتة">⌛</span>}
                    </>
                  );
                  const tint = cell?.inherited ? ' inh' : '';
                  if (col.mode === 'ADMIN') {
                    const grant = p.grants.find((g) => g.role.code === col.code && g.active);
                    return (
                      <td key={col.code} className={'aw-cell' + tint} title={grant?.scopeText}>
                        {why && !grant ? (
                          <button className="aw-lock" aria-label={'مقفلة: ' + why} onClick={() => app.toast('🔒 ' + why)}><Icon name="lock" /></button>
                        ) : (
                          <button className={'button compact aw-assign' + (grant ? ' primary' : '')} data-cell={col.code} onClick={() => setAdmin({ person: p, column: col, grant })}>
                            {grant ? rightsText(grant.rights, catalogue.length || 10) + (grant.delegated ? ' · مفوَّضة' : '') : 'تعيين'}
                          </button>
                        )}
                        {marks}
                      </td>
                    );
                  }
                  if (col.mode === 'ASSIGN') {
                    const grant = p.grants.find((g) => g.role.code === col.code && g.active);
                    return (
                      <td key={col.code} className={'aw-cell' + tint} title={grant?.scopeText}>
                        {why ? (
                          <button className="aw-lock" aria-label={'مقفلة: ' + why} onClick={() => app.toast('🔒 ' + why)}>
                            <Icon name="lock" />
                            {grant && <small>{cellText(grant)}</small>}
                          </button>
                        ) : (
                          <button className={'button compact aw-assign' + (grant ? ' primary' : '')} data-cell={col.code} onClick={() => setEditing({ person: p, column: col, grant })}>
                            {cellText(grant)}
                          </button>
                        )}
                        {marks}
                      </td>
                    );
                  }
                  return (
                    <td key={col.code} className={'aw-cell' + tint + (pending[key] ? ' staged' : '')}>
                      {why ? (
                        <button className="aw-lock" aria-label={'مقفلة: ' + why} onClick={() => app.toast('🔒 ' + why)}>
                          <Icon name="lock" />
                          {cell?.direct && <small>✓</small>}
                        </button>
                      ) : (
                        <input
                          type="checkbox"
                          data-cell={col.code}
                          aria-label={col.name + ' — ' + p.displayName}
                          checked={ticked(pending, p.id, col.code, cell)}
                          onChange={() => tick(p, col)}
                          title={cell?.direct?.scopeText}
                        />
                      )}
                      {marks}
                    </td>
                  );
                })}
                {avail.length > 0 && (
                  <td className="aw-cell aa-avail">
                    <AvailabilityChips unit={unit} person={p} columns={avail} providers={matrix.providers} onChanged={onSaved} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="aw-legend" aria-label="دليل الخلايا">
        <span><i className="sq direct" /> مباشرة (مربع اختيار)</span>
        <span><i className="sq inh" /> موروثة من الوحدة</span>
        <span><i className="sq tmp" /> مؤقتة</span>
        <span><i className="sq lock" /> مقفلة (حساب نظام أو مسار مخصص)</span>
        <span className="aw-muted">«تعيين»: يحفظ فوراً عند الضغط</span>
      </div>

      <div className="aw-foot">
        <span>
          <b className="aw-count latin">{c.total}</b> {c.total === 1 ? 'تعديل' : 'تعديلاً'} معلقاً — لا يُحفظ شيء قبل الضغط على «حفظ التعديلات»
        </span>
        <button className="button compact" disabled={!c.total} onClick={discard}>تراجع</button>
        <button className="button primary" disabled={!c.total || busy} onClick={save} data-testid="aw-save">حفظ التعديلات</button>
      </div>

      {admin && (
        <AccessAdminDialog unit={unit} person={admin.person} column={admin.column} grant={admin.grant} catalogue={catalogue} onClose={() => setAdmin(null)} onSaved={onSaved} />
      )}
      {editing && (
        <UnitsDialog
          roleName={editing.column.name}
          home={unit}
          chain={editing.column.code === 'CHAIN_APPROVER'}
          person={editing.person.displayName}
          finalApprover={editing.column.code !== 'CHAIN_APPROVER' && !!roles.find((r) => r.code === editing.column.code)?.permissions.includes('APPROVE')}
          everything={!!editing.grant?.all}
          value={existingUnits(editing.grant)}
          onSave={saveUnits}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RemoveMember({ unit, person, onDone }: { unit: Unit; person: WorkspacePerson; onDone: () => void }) {
  const app = useApp();
  const remove = () => {
    const reason = window.prompt('سبب إزالة «' + person.displayName + '» من «' + unit.name + '»؟ صلاحياته الممنوحة تبقى حتى تسحبها.');
    if (!reason || !reason.trim()) return;
    api
      .endUnitMember(person.id, unit.id, reason.trim())
      .then(() => (app.toast('أُزيل «' + person.displayName + '» من الوحدة'), onDone()))
      .catch((e: Error) => app.toast(e.message));
  };
  return (
    <button className="um-remove" onClick={remove} aria-label={'إزالة ' + person.displayName + ' من الوحدة'}>
      إزالة
    </button>
  );
}

// ---- 03 audit ----------------------------------------------------------------------------------------------------

const ACTIONS: Record<string, string> = {
  MEMBERSHIP_CREATED: 'منح',
  MEMBERSHIP_ENDED: 'سحب',
  UNIT_GRANT_ADDED: 'منح لكل أعضاء الوحدة',
  UNIT_GRANT_ENDED: 'سحب من أعضاء الوحدة',
  ACCESS_BATCH_SAVED: 'حفظة تعديلات',
  UNIT_MEMBER_ADDED: 'إضافة مستخدم',
  UNIT_MEMBER_ENDED: 'إزالة مستخدم',
};

function AuditTab({ unit, revision }: { unit: Unit; revision: number }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; rows: WorkspaceHistoryRow[] } | null>(null);
  useEffect(() => {
    api.workspaceHistory(unit.id, page).then(setData).catch(() => setData(null));
  }, [unit.id, page, revision]);
  const pages = data ? Math.max(1, Math.ceil(data.total / 25)) : 1;
  return (
    <div className="aw-audit" data-testid="aw-audit">
      <div className="aw-table">
        <table className="aw-matrix">
          <thead>
            <tr>
              <th>الوقت</th>
              <th>الإجراء</th>
              <th>المستخدم</th>
              <th>الصلاحية</th>
              <th>بواسطة</th>
              <th>السبب</th>
              <th>مرجع التدقيق</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="aw-muted">لا تغييرات مسجلة لهذه الوحدة بعد.</td>
              </tr>
            )}
            {data?.rows.map((r) => (
              <tr key={r.id}>
                <td className="latin">{fullDate(r.at)}</td>
                <td>{ACTIONS[r.action] ?? r.action}{r.action === 'ACCESS_BATCH_SAVED' && r.grants != null ? ' (إضافة ' + r.grants + ' · سحب ' + r.revokes + ')' : ''}</td>
                <td>{r.person ?? (r.action.startsWith('UNIT_GRANT') ? 'كل أعضاء الوحدة' : '—')}{r.employeeNo && <small className="latin aw-muted"> {r.employeeNo}</small>}</td>
                <td>{r.role ?? '—'}</td>
                <td>{r.by ?? '—'}</td>
                <td>{r.reason ?? '—'}</td>
                <td className="latin">{r.reference ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > 25 && (
        <div className="aw-pager">
          <button className="button compact" disabled={page === 0} onClick={() => setPage(page - 1)}>السابق</button>
          <span>صفحة {n(page + 1)} من {n(pages)}</span>
          <button className="button compact" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>التالي</button>
        </div>
      )}
    </div>
  );
}

// ---- 04 unit file ------------------------------------------------------------------------------------------------

function UnitFile({ file, global, onChanged, onReload }: { file: WorkspaceUnit | null; global: boolean; onChanged: (f: WorkspaceUnit) => void; onReload: () => void }) {
  const app = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      file
        ? ([
            ['اسم الوحدة', file.name],
            ['المستوى', file.level ?? '—'],
            ['الوحدة الأم', file.parent?.name ?? '—'],
            ['مدير الوحدة', file.managers.length ? file.managers.join('، ') : 'غير معيّن'],
            ['المستخدمون', n(file.people)],
            ['النشطون', n(file.active)],
            ['الوحدات الفرعية', n(file.children)],
          ] as [string, string | number][])
        : [],
    [file],
  );
  const flip = (code: string, on: boolean, name: string) => {
    if (!file) return;
    let reason: string | undefined;
    if (!on) {
      const r = window.prompt('سبب سحب «' + name + '» من كل أعضاء «' + file.name + '»؟');
      if (!r || !r.trim()) return;
      reason = r.trim();
    }
    setBusy(code);
    api
      .workspaceUnitGrant(file.id, code, on, reason)
      .then((f) => (onChanged(f), app.toast(on ? 'يرث كل أعضاء الوحدة «' + name + '»' : 'سُحب «' + name + '» من أعضاء الوحدة')))
      .catch((e: Error) => app.toast(e.message))
      .finally(() => setBusy(null));
  };
  return (
    <section className="aw-card aw-file" aria-label="ملف الوحدة" data-testid="aw-file">
      <header className="aw-head">
        <span className="aw-num">04</span>
        <h2>ملف الوحدة</h2>
        <span className="aw-badge">للقراءة</span>
      </header>
      {!file ? (
        <p className="aw-muted">اختر وحدة لعرض المصدر والنطاق والإحصاءات.</p>
      ) : (
        <>
          <dl className="aw-kv">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <h3>صلاحيات موروثة من عضوية الوحدة</h3>
          <div className="aw-chips">
            {file.inherited.length === 0 && <span className="aw-muted">لا شيء؛ كل صلاحية هنا ممنوحة لشخص بعينه.</span>}
            {file.inherited.map((r) => (
              <span key={r.code} className="aw-chip inherit" title={'منذ ' + fullDate(r.since) + (r.grantedBy ? ' · ' + r.grantedBy : '')}>
                {r.name} · {r.scope === 'SITE' ? 'للعلم' : 'own_unit'}
              </span>
            ))}
          </div>
          {file.unitRoles.length > 0 && (
            <>
              <h3>منح لكل أعضاء الوحدة</h3>
              <ul className="aw-unit-roles">
                {file.unitRoles.map((r) => (
                  <li key={r.code}>
                    <label title={r.lock ?? undefined}>
                      <input type="checkbox" checked={r.on} disabled={!!r.lock || busy === r.code} onChange={() => flip(r.code, !r.on, r.name)} />
                      {r.lock && <Icon name="lock" />} {r.name}
                    </label>
                  </li>
                ))}
              </ul>
              <small className="aw-muted">يرثها كل من في الوحدة الآن ومن يُضاف لاحقاً. الاعتمادات تُمنح لشخص بعينه فقط.</small>
            </>
          )}
          <ProvidersSection file={file} global={global} onChanged={onReload} />
        </>
      )}
    </section>
  );
}

// ---- the dividers between the panels (owner, 16 Nov 2026) ------------------------------------------------------------

/** A vertical divider the person drags (or moves with the arrow keys) to widen or narrow a side panel; double-click resets it. */
function Divider({ panel, label, value, box, onWidth, onDone, onReset }: {
  panel: Panel;
  label: string;
  value: number;
  box: RefObject<HTMLDivElement | null>;
  onWidth: (panel: Panel, px: number) => void;
  onDone: () => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const rtl = () => (box.current ? getComputedStyle(box.current).direction === 'rtl' : true);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const host = box.current;
    if (!host || e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    const dir = rtl();
    const move = (ev: PointerEvent) => onWidth(panel, widthAt(panel, ev.clientX, host.getBoundingClientRect(), dir));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDragging(false);
      onDone();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    // the divider moves the way the arrow points: the tree grows when it moves away from the tree's edge, the file likewise
    const dx = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 64 : 16);
    const growsRight = panel === 'tree' ? !rtl() : rtl();
    onWidth(panel, value + (growsRight ? dx : -dx));
    onDone();
  };
  return (
    <div
      className={'aw-divider' + (dragging ? ' dragging' : '')}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      title={label + ' — اسحب لتغيير العرض، ونقرتان للعرض الأصلي'}
      data-divider={panel}
      onPointerDown={down}
      onKeyDown={key}
      onDoubleClick={onReset}
    >
      <span aria-hidden="true" />
    </div>
  );
}

// ---- a column's «?», as TNQL's permission help (app/permission_help.py) -------------------------------------------------

const HELP: Record<string, { allows: string; who: string; covers: string; excludes: string; sensitive: string }> = {
  CHAIN_APPROVER: {
    allows: 'اعتماد الطلب أو ردّه عند وصوله إلى مستوى الوحدة في السلسلة الهرمية.',
    who: 'قائد الوحدة أو من يُكلَّف بالاسم.',
    covers: 'الطلبات التي تمر بمستوى هذه الوحدة؛ ومع «هذا المستوى ومع جميع الوحدات التابعة» كل وحدة تابعة ليس لها معتمد مباشر.',
    excludes: 'لا يرد على التوفر، ولا يتخذ القرار التشغيلي النهائي، ولا يدير الصلاحيات.',
    sensitive: 'توقيع اعتماد: يُمنح لشخص بالاسم لا لوحدة كاملة.',
  },
};

function ColumnHelp({ code, name }: { code: string; name: string }) {
  // drawn above the page at the button's place: inside the table the pinned columns and the scroll box would cover it
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const h = HELP[code];
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (at) return setAt(null);
    const r = e.currentTarget.getBoundingClientRect();
    setAt({ top: r.bottom + 6, left: Math.min(Math.max(8, r.left + r.width / 2 - 150), window.innerWidth - 308) });
  };
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [at]);
  const open = !!at;
  const setOpen = (v: boolean) => !v && setAt(null);
  return (
    <span className="aw-help">
      <button type="button" className="aw-help-btn" aria-label={'شرح ' + name} aria-expanded={open} onClick={toggle}>?</button>
      {at && (
        <span className="aw-help-pop" role="dialog" aria-label={'شرح ' + name} style={{ top: at.top, left: at.left }}>
          <b>{name}</b>
          <span><i>ما تتيحه:</i> {h.allows}</span>
          <span><i>لمن:</i> {h.who}</span>
          <span><i>ما تشمله:</i> {h.covers}</span>
          <span><i>ما لا تشمله:</i> {h.excludes}</span>
          <span className="aw-help-warn">{h.sensitive}</span>
          <button type="button" className="button compact" onClick={() => setOpen(false)}>إغلاق</button>
        </span>
      )}
    </span>
  );
}

