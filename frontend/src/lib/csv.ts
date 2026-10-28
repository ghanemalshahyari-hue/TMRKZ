/** Parses `code,name,parentCode` lines (header optional) for the org-structure import preview. */
export function parseOrgCsv(text: string): { code: string; name: string; parentCode: string | null }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
    .filter((c) => !(c[0]?.toLowerCase() === 'code' && c[1]?.toLowerCase() === 'name'))
    .map(([code = '', name = '', parentCode = '']) => ({ code, name, parentCode: parentCode || null }));
}
