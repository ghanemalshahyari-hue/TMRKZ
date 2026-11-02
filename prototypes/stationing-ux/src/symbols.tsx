import { useEffect, useState } from 'react';
import { renderSymbol } from '../../../frontend/src/lib/unitSymbols';
import { ORGS } from './data';

/** Organisation id → rendered symbol (data URL), or null when it has no approved symbol (a neutral mark is shown). */
export type Symbols = Map<string, string | null>;

/** The organisations' identity symbols, rendered locally once with the application's own renderer. */
export function useOrgSymbols(): Symbols {
  const [m, setM] = useState<Symbols>(new Map());
  useEffect(() => {
    let live = true;
    Promise.all(ORGS.map(async (o) => [o.id, o.sidc ? await renderSymbol(o.sidc, 'APP6', 28).catch(() => null) : null] as const)).then((rows) => {
      if (live) setM(new Map(rows.map(([id, r]) => [id, r && r.valid ? r.url : null])));
    });
    return () => {
      live = false;
    };
  }, []);
  return m;
}

export function SymbolMark({ url, name, size = 22 }: { url: string | null | undefined; name: string; size?: number }) {
  return url ? (
    <img className="ux-sym" src={url} alt="" style={{ height: size }} title={name} />
  ) : (
    <span className="ux-sym generic" style={{ height: Math.round(size * 0.72), width: size }} title={name + ' — لم يُحدد رمز'} aria-hidden="true" />
  );
}

export const symbolHtml = (url: string | null | undefined, size = 22) =>
  url ? '<img class="ux-sym" src="' + url + '" alt="" style="height:' + size + 'px" />' : '<span class="ux-sym generic" style="height:' + Math.round(size * 0.72) + 'px;width:' + size + 'px"></span>';
