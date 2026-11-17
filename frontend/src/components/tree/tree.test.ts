import { describe, expect, it } from 'vitest';
import { flatSource, normalise, withParents, searchForest } from './tree';

const UNITS = [
  { id: 'r', name: 'القيادة', parentId: null },
  { id: 'a', name: 'إدارة الصحة', parentId: 'r' },
  { id: 'a1', name: 'مركز صحة واحد', parentId: 'a' },
  { id: 'a11', name: 'قسم صحة 1-أ', parentId: 'a1' },
  { id: 'b', name: 'الإسناد', parentId: 'r' },
  { id: 'x', name: 'وحدة خارج النطاق', parentId: 'missing' },
];

describe('the one units tree', () => {
  it('draws a list the page holds as a tree; a unit whose parent is not listed is a top unit', async () => {
    const s = flatSource(UNITS);
    expect((await s.roots()).map((u) => u.id)).toEqual(['r', 'x']);
    expect((await s.children('r')).map((u) => [u.id, u.childCount])).toEqual([['a', 1], ['b', 0]]);
    expect(s.byId.get('r')?.childCount).toBe(2);
  });

  it('knows what to open to show a unit: its ancestors, the top first', () => {
    const s = flatSource(UNITS);
    expect(s.trail('a11')).toEqual(['r', 'a', 'a1']);
    expect(s.trail('r')).toEqual([]);
    expect(s.trail(null)).toEqual([]);
  });

  it('searches its own list without minding alef forms or ta marbuta, and gives the path', async () => {
    const s = flatSource(UNITS);
    const hits = await s.search!('اداره الصحه', new AbortController().signal);
    expect(hits.map((h) => [h.item.id, h.path, h.trail])).toEqual([['a', 'القيادة', ['r']]]);
    expect(normalise('إدارة')).toBe('اداره');
  });

  it('finds each unit’s parent from depths alone', () => {
    const rows = withParents([
      { id: '1', depth: 0 },
      { id: '2', depth: 1 },
      { id: '3', depth: 2 },
      { id: '4', depth: 1 },
      { id: '5', depth: 0 },
    ]);
    expect(rows.map((r) => r.parentId)).toEqual([null, '1', '2', '1', null]);
  });
});

describe('a search drawn as a hierarchy (owner, 17 Nov 2026)', () => {
  const u = (id: string, name: string) => ({ id, name, childCount: 0 });
  it('puts every result under its whole chain of ancestors, a shared ancestor once', () => {
    const forest = searchForest([
      { item: u('c1', 'مركز صحة واحد'), path: 'الإدارة الرئيسية للصحة ‹ إدارة الصحة', trail: ['m', 'h'], chain: [{ id: 'm', name: 'الإدارة الرئيسية للصحة' }, { id: 'h', name: 'إدارة الصحة' }] },
      { item: u('c2', 'مركز صحة اثنين'), path: 'الإدارة الرئيسية للصحة ‹ إدارة الصحة', trail: ['m', 'h'] },
      { item: u('h', 'إدارة الصحة'), path: 'الإدارة الرئيسية للصحة', trail: ['m'] },
    ]);
    expect(forest.map((n) => n.name)).toEqual(['الإدارة الرئيسية للصحة']);
    const health = forest[0].kids[0];
    expect(health.name).toBe('إدارة الصحة');
    expect(health.item?.id).toBe('h'); // a result and an ancestor at once
    expect(health.kids.map((k) => k.name)).toEqual(['مركز صحة واحد', 'مركز صحة اثنين']);
    expect(health.kids[1].trail).toEqual(['m', 'h']);
    expect(forest[0].item).toBeNull(); // an ancestor only
  });
});
