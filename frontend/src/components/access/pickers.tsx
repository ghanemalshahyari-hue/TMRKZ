import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Person, Site } from '../../api/types';
import { OrgTree, SiteTree } from '../map/BrowseTrees';

/** Search people by name, employee number or account and pick one (never loads the whole directory). */
export function PersonPicker({ value, onChange }: { value: string; onChange: (id: string, person?: Person) => void }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .people(q)
        .then((p) => setPeople(p.items))
        .catch(() => setPeople([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <>
      <input placeholder="ابحث بالاسم أو الرقم الوظيفي…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث الأشخاص" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value, people.find((p) => p.id === e.target.value))}
        size={4}
        style={{ marginTop: 6, width: '100%' }}
        aria-label="الشخص"
      >
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName} · {p.employeeNo}
          </option>
        ))}
      </select>
    </>
  );
}

/** Lazy organisation tree with search; "with branches" is chosen per pick. */
export function OrgPick({
  selected,
  withBranches,
  onPick,
  onWithBranches,
  revision,
  branchOption = true,
}: {
  selected: { id: string; name: string } | null;
  withBranches: boolean;
  onPick: (org: { id: string; name: string } | null) => void;
  onWithBranches: (v: boolean) => void;
  revision: number;
  branchOption?: boolean;
}) {
  return (
    <div className="access-tree">
      <OrgTree
        selectedId={selected?.id ?? null}
        includeSub={withBranches}
        onSelect={onPick}
        onIncludeSub={onWithBranches}
        revision={revision}
        subOption={branchOption}
      />
    </div>
  );
}

/** Lazy site tree with search; resolves the chosen site's name and resources. */
export function SitePick({ selectedId, onPick, revision }: { selectedId: string | null; onPick: (site: Site) => void; revision: number }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="access-tree">
      <SiteTree
        selectedId={selectedId}
        revision={revision}
        onSelect={(id) =>
          api
            .site(id)
            .then((s) => (setError(null), onPick(s)))
            .catch((e: Error) => setError(e.message))
        }
      />
      {error && <p className="micro muted">{error}</p>}
    </div>
  );
}
