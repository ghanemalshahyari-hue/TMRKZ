/**
 * The one units tree (owner, 16 Nov 2026: «use a global one, not every time we build a new one in every page»): what a tree is
 * made of, wherever it is drawn. A source gives the top units, a unit's children and, optionally, a search; the component
 * (UnitTree.tsx) draws them the same way on every page.
 */
export type TreeItem = { id: string; name: string; childCount: number };
/**
 * A search result: the unit, its path as text, and its ancestors (top first) so the tree can open down to it. `chain` names
 * the ancestors too, so a search can show its results as a hierarchy (owner, 17 Nov 2026).
 */
export type TreeHit<T> = { item: T; path: string; trail?: string[]; chain?: { id: string; name: string }[] };

/** A node of a search drawn as a tree: a unit found, or one of its ancestors; with the ancestors' ids (top first). */
export type SearchNode<T> = { id: string; name: string; item: T | null; trail: string[]; kids: SearchNode<T>[] };

/** The results of a search as one forest: every result under its whole chain of ancestors, shared ancestors drawn once. */
export function searchForest<T extends TreeItem>(hits: TreeHit<T>[]): SearchNode<T>[] {
  const nodes = new Map<string, SearchNode<T>>();
  const roots: SearchNode<T>[] = [];
  const node = (id: string, name: string, trail: string[]) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, name, item: null, trail, kids: [] }));
    return n;
  };
  const attach = (parent: SearchNode<T> | null, n: SearchNode<T>) => {
    const list = parent ? parent.kids : roots;
    if (!list.includes(n)) list.push(n);
  };
  for (const h of hits) {
    const names = h.path ? h.path.split(' ‹ ') : [];
    const chain = h.chain ?? (h.trail && h.trail.length === names.length ? h.trail.map((id, i) => ({ id, name: names[i] })) : []);
    let parent: SearchNode<T> | null = null;
    chain.forEach((a, i) => {
      const n = node(a.id, a.name, chain.slice(0, i).map((x) => x.id));
      attach(parent, n);
      parent = n;
    });
    const leaf = node(h.item.id, h.item.name, chain.map((x) => x.id));
    leaf.item = h.item;
    attach(parent, leaf);
  }
  return roots;
}
export type TreeSource<T extends TreeItem> = {
  roots: () => Promise<T[]>;
  children: (id: string) => Promise<T[]>;
  search?: (q: string, signal: AbortSignal) => Promise<TreeHit<T>[]>;
};

type Flat = { id: string; name: string; parentId: string | null };
export type FlatSource<T extends Flat> = TreeSource<T & { childCount: number }> & {
  /** The unit's ancestors, the top first, without the unit: what to open to show it. */
  trail: (id: string | null | undefined) => string[];
  byId: Map<string, T & { childCount: number }>;
};

/**
 * A tree from a list the page already holds (each unit with its parent). A unit whose parent is not in the list is a top
 * unit, so a list scoped to a person's reach still draws as a tree.
 */
export function flatSource<T extends Flat>(items: T[]): FlatSource<T> {
  const byId = new Map<string, T & { childCount: number }>();
  for (const it of items) byId.set(it.id, { ...it, childCount: 0 });
  const kids = new Map<string | null, (T & { childCount: number })[]>();
  for (const it of byId.values()) {
    const p = it.parentId && byId.has(it.parentId) ? it.parentId : null;
    if (p) byId.get(p)!.childCount++;
    kids.set(p, [...(kids.get(p) ?? []), it]);
  }
  const trail = (id: string | null | undefined) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let cur = id ? byId.get(id)?.parentId ?? null : null; cur && byId.has(cur) && !seen.has(cur); cur = byId.get(cur)!.parentId) {
      seen.add(cur);
      out.unshift(cur);
    }
    return out;
  };
  return {
    byId,
    trail,
    roots: async () => kids.get(null) ?? [],
    children: async (id) => kids.get(id) ?? [],
    search: async (q) => {
      const term = normalise(q);
      return [...byId.values()]
        .filter((u) => normalise(u.name).includes(term))
        .slice(0, 200)
        .map((u) => {
          const ids = trail(u.id);
          return { item: u, trail: ids, path: ids.map((a) => byId.get(a)!.name).join(' ‹ ') };
        });
    },
  };
}

/** A list in tree order with depths only (no parent ids): each unit's parent is the nearest earlier unit one level up. */
export function withParents<T extends { depth?: number }>(items: T[]): (T & { parentId: string | null })[] {
  const stack: { id: string; depth: number }[] = [];
  return items.map((it) => {
    const depth = it.depth ?? 0;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parentId = stack.length ? stack[stack.length - 1].id : null;
    stack.push({ id: (it as unknown as { id: string }).id, depth });
    return { ...it, parentId };
  });
}

/** Arabic-insensitive matching for the tree's own search: alef forms, ta marbuta and diacritics do not matter. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .trim();
}
