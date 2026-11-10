import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../ui';

type Sheet = 'rail' | 'context' | null;
type PanelMode = 'normal' | 'max' | 'min';
type Panels = { swapped: boolean; rail: PanelMode; context: PanelMode };

/** The next size after a click, as MOVER's card chrome: «تكبير» and «تصغير» each toggle, and either one leaves the other. */
export function nextMode(mode: PanelMode, action: 'max' | 'min'): PanelMode {
  return mode === action ? 'normal' : action;
}

/** A viewer's own arrangement of a page's panels, remembered in this browser only (it may be unavailable: then the defaults). */
function remembered(key: string | undefined, fallback: Panels): Panels {
  if (!key) return fallback;
  try {
    const v = JSON.parse(localStorage.getItem('tmrkz.panels.' + key) ?? 'null') as Partial<Panels> | null;
    const mode = (m: unknown): PanelMode => (m === 'max' || m === 'min' ? m : 'normal');
    return v ? { swapped: typeof v.swapped === 'boolean' ? v.swapped : fallback.swapped, rail: mode(v.rail), context: mode(v.context) } : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The three-column operational console (owner brief «FULL APPLICATION UI REBUILD», §6, §24), right to left: the
 * context panel, the map (dominant), the action panel. On a tablet the context panel collapses and the actions become
 * a compact rail; on a phone the map comes first and both panels open as bottom sheets. With `swapSides` the two side
 * columns trade places (rail right, context left), each keeping its own width at every size.
 *
 * With `panels` (owner, 10 Nov 2026, after MOVER's card chrome) each side panel has its own controls: «⇄» moves it to the
 * other side, «تكبير» widens it (a long unit tree, then back), «تصغير» folds it to a thin strip so the map gets the room.
 * The arrangement is the viewer's own and is remembered in the browser under the given key.
 */
export function OperationalWorkspace({ context, centre, rail, contextLabel = 'التفاصيل', railLabel = 'الطلبات والإجراءات', sheetKey, listRail = false, create = false, swapSides = false, panels }: {
  context: ReactNode;
  centre: ReactNode;
  rail: ReactNode;
  contextLabel?: string;
  railLabel?: string;
  /** Changing it (another request, the editor) closes an open bottom sheet. */
  sheetKey?: string;
  /** The left column holds a list (the Sites page), so it keeps a readable width on a tablet. */
  listRail?: boolean;
  /** A new or edited request (map-first): compact step panel and context at every width, the map dominant. */
  create?: boolean;
  /** The rail on the right and the context panel on the left (owner, 10 Nov 2026: «تهيئة المواقع والتمركز»). */
  swapSides?: boolean;
  /** Movable, widenable, foldable side panels; the key under which this page's arrangement is remembered. */
  panels?: string;
}) {
  const [contextOpen, setContextOpen] = useState(true);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [arr, setArr] = useState<Panels>(() => remembered(panels, { swapped: swapSides, rail: 'normal', context: 'normal' }));
  useEffect(() => setSheet(null), [sheetKey]);
  useEffect(() => {
    if (!panels) return;
    try {
      localStorage.setItem('tmrkz.panels.' + panels, JSON.stringify(arr));
    } catch {
      /* storage unavailable: the arrangement lasts for this visit only */
    }
  }, [panels, arr]);
  const swapped = panels ? arr.swapped : swapSides;
  const bar = (which: 'rail' | 'context', label: string) => {
    if (!panels) return null;
    const mode = arr[which];
    const set = (action: 'max' | 'min') => setArr((a) => ({ ...a, [which]: nextMode(a[which], action) }));
    // which side this panel is on now, in the page's right-to-left order: the context is on the right unless swapped
    const onRight = (which === 'context') !== swapped;
    return (
      <div className={'tz-panelbar' + (mode === 'min' ? ' folded' : '')} data-panel={which} data-mode={mode}>
        <button type="button" className="tz-panelbar-title" onClick={() => mode === 'min' && set('min')} title={mode === 'min' ? 'استعادة الحجم' : label} aria-label={label}>
          {label}
        </button>
        <div className="tz-panelbar-acts">
          <button type="button" className="tz-pbtn" data-act="swap" title={onRight ? 'نقل إلى اليسار' : 'نقل إلى اليمين'} aria-label={(onRight ? 'نقل «' + label + '» إلى اليسار' : 'نقل «' + label + '» إلى اليمين')} onClick={() => setArr((a) => ({ ...a, swapped: !a.swapped }))}>⇄</button>
          <button type="button" className={'tz-pbtn' + (mode === 'max' ? ' on' : '')} data-act="max" aria-pressed={mode === 'max'} title={mode === 'max' ? 'استعادة الحجم' : 'تكبير'} aria-label={(mode === 'max' ? 'استعادة حجم «' : 'تكبير «') + label + '»'} onClick={() => set('max')}>{mode === 'max' ? '⤡' : '⤢'}</button>
          <button type="button" className={'tz-pbtn' + (mode === 'min' ? ' on' : '')} data-act="min" aria-pressed={mode === 'min'} title={mode === 'min' ? 'استعادة الحجم' : 'تصغير'} aria-label={(mode === 'min' ? 'استعادة حجم «' : 'تصغير «') + label + '»'} onClick={() => set('min')}>{mode === 'min' ? '▢' : '–'}</button>
        </div>
      </div>
    );
  };
  const cls = 'tz-console' + (listRail ? ' list-rail' : '') + (create ? ' create' : '') + (swapped ? ' swapped' : '')
    + (panels ? ' chrome rail-' + arr.rail + ' ctx-' + arr.context : contextOpen || create ? '' : ' context-closed') + (sheet ? ' sheet-' + sheet : '');
  return (
    <div className={cls}>
      <div className="tz-col tz-col-context" data-sheet={sheet === 'context' ? 'open' : undefined}>
        <button className="tz-sheet-close" aria-label="إغلاق" onClick={() => setSheet(null)}>
          <Icon name="close" />
        </button>
        {bar('context', contextLabel)}
        {context}
      </div>
      <div className="tz-col tz-col-centre">
        {!panels && (
          <button className="tz-context-toggle" aria-pressed={!contextOpen} onClick={() => setContextOpen((o) => !o)} title={contextOpen ? 'طي لوحة التفاصيل' : 'إظهار لوحة التفاصيل'}>
            <Icon name="panel" />
            <span>{contextOpen ? 'طي التفاصيل' : 'التفاصيل'}</span>
          </button>
        )}
        {centre}
      </div>
      <div className="tz-col tz-col-rail" data-sheet={sheet === 'rail' ? 'open' : undefined}>
        <button className="tz-sheet-close" aria-label="إغلاق" onClick={() => setSheet(null)}>
          <Icon name="close" />
        </button>
        {bar('rail', railLabel)}
        {rail}
      </div>
      <nav className="tz-sheet-tabs" aria-label="لوحات مساحة العمل">
        <button className={sheet === 'rail' ? 'active' : ''} aria-pressed={sheet === 'rail'} onClick={() => setSheet(sheet === 'rail' ? null : 'rail')}>
          <Icon name="file" /> {railLabel}
        </button>
        <button className={sheet === null ? 'active' : ''} aria-pressed={sheet === null} onClick={() => setSheet(null)}>
          <Icon name="map" /> الخريطة
        </button>
        <button className={sheet === 'context' ? 'active' : ''} aria-pressed={sheet === 'context'} onClick={() => setSheet(sheet === 'context' ? null : 'context')}>
          <Icon name="panel" /> {contextLabel}
        </button>
      </nav>
    </div>
  );
}
