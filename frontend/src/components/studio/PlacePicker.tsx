import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { HierarchyLevel, OrgBranch, OrgFrom, Responsibility, RoleDef, WfPlace } from '../../api/types';
import { PLACE_KINDS } from '../../lib/flowGraph';
import { NumberField } from '../NumberField';

/** A unit found by typing its name, so it works with any number of units. */
export function OrgPicker({ value, name, onChange, label }: { value?: string; name?: string; onChange: (id: string | undefined, name: string | undefined) => void; label: string }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<OrgBranch[]>([]);
  const wanted = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setFound([]);
    const ticket = ++wanted.current;
    const t = setTimeout(() => {
      api.orgSearch(term).then((r) => ticket === wanted.current && setFound(r.slice(0, 12))).catch(() => setFound([]));
    }, 220);
    return () => clearTimeout(t);
  }, [q]);
  if (value) {
    return (
      <div className="fs-org-chosen">
        <b>{name ?? 'جهة مختارة'}</b>
        <button type="button" className="link-button" onClick={() => onChange(undefined, undefined)}>تغيير</button>
      </div>
    );
  }
  return (
    <div className="fs-org-picker">
      <input aria-label={label} placeholder="اكتب اسم الجهة…" value={q} onChange={(e) => setQ(e.target.value)} />
      {found.length > 0 && (
        <ul role="listbox">
          {found.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => (onChange(o.id, o.name), setQ(''), setFound([]))}>{o.name}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Who, and at which place: a role and how its unit is found for each request. */
export function PlacePicker({ place, roles, levels, responsibilities, onChange, onRemove, onManage }: {
  place: WfPlace;
  roles: RoleDef[];
  levels: HierarchyLevel[];
  responsibilities: Responsibility[];
  onChange: (p: WfPlace) => void;
  onRemove: () => void;
  onManage: () => void;
}) {
  const kind = PLACE_KINDS.find((k) => k.value === place.orgFrom);
  const setKind = (orgFrom: OrgFrom) => onChange({ role: place.role, orgFrom, ...(orgFrom === 'UP' ? { levelsUp: 1 } : {}) });
  return (
    <div className="fs-place" data-testid="place">
      <label>
        الدور
        <select value={place.role} onChange={(e) => onChange({ ...place, role: e.target.value })}>
          <option value="">— اختر —</option>
          {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
        </select>
      </label>
      <label>
        الجهة
        <select aria-label="طريقة تحديد الجهة" value={place.orgFrom} onChange={(e) => setKind(e.target.value as OrgFrom)}>
          {PLACE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </label>
      {kind && <small className="muted">{kind.hint}</small>}
      {place.orgFrom === 'UP' && (
        <label>
          كم مستوى للأعلى
          <NumberField value={place.levelsUp ?? 1} onChange={(v) => onChange({ ...place, levelsUp: Math.max(1, Math.trunc(v ?? 1)) })} />
        </label>
      )}
      {place.orgFrom === 'AT_LEVEL' && (
        <label>
          المستوى
          {levels.length ? (
            <select value={place.level ?? ''} onChange={(e) => onChange({ ...place, level: e.target.value === '' ? undefined : Number(e.target.value) })}>
              <option value="">— اختر —</option>
              {levels.map((l) => <option key={l.level} value={l.level}>المستوى {l.level} ({l.units.toLocaleString('en-US')} وحدة)</option>)}
            </select>
          ) : (
            <NumberField value={place.level ?? null} onChange={(v) => onChange({ ...place, level: v == null ? undefined : Math.trunc(v) })} />
          )}
        </label>
      )}
      {place.orgFrom === 'FIXED' && <OrgPicker label="الجهة المحددة" value={place.orgId} name={place.orgName} onChange={(orgId, orgName) => onChange({ ...place, orgId, orgName })} />}
      {place.orgFrom === 'RESPONSIBLE' && (
        <label>
          المسؤولية
          <select value={place.responsibility ?? ''} onChange={(e) => onChange({ ...place, responsibility: e.target.value || undefined })}>
            <option value="">— اختر —</option>
            {responsibilities.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
          <button type="button" className="link-button" onClick={onManage}>إدارة المسؤوليات</button>
        </label>
      )}
      <button type="button" className="link-button fs-remove" onClick={onRemove}>إزالة</button>
    </div>
  );
}
