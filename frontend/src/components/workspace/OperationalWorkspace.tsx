import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../ui';

type Sheet = 'rail' | 'context' | null;

/**
 * The three-column operational console (owner brief «FULL APPLICATION UI REBUILD», §6, §24), right to left: the
 * context panel, the map (dominant), the action panel. On a tablet the context panel collapses and the actions become
 * a compact rail; on a phone the map comes first and both panels open as bottom sheets.
 */
export function OperationalWorkspace({ context, centre, rail, contextLabel = 'التفاصيل', railLabel = 'الطلبات والإجراءات', sheetKey, listRail = false, create = false }: {
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
}) {
  const [contextOpen, setContextOpen] = useState(true);
  const [sheet, setSheet] = useState<Sheet>(null);
  useEffect(() => setSheet(null), [sheetKey]);
  return (
    <div className={'tz-console' + (listRail ? ' list-rail' : '') + (create ? ' create' : '') + (contextOpen || create ? '' : ' context-closed') + (sheet ? ' sheet-' + sheet : '')}>
      <div className="tz-col tz-col-context" data-sheet={sheet === 'context' ? 'open' : undefined}>
        <button className="tz-sheet-close" aria-label="إغلاق" onClick={() => setSheet(null)}>
          <Icon name="close" />
        </button>
        {context}
      </div>
      <div className="tz-col tz-col-centre">
        <button className="tz-context-toggle" aria-pressed={!contextOpen} onClick={() => setContextOpen((o) => !o)} title={contextOpen ? 'طي لوحة التفاصيل' : 'إظهار لوحة التفاصيل'}>
          <Icon name="panel" />
          <span>{contextOpen ? 'طي التفاصيل' : 'التفاصيل'}</span>
        </button>
        {centre}
      </div>
      <div className="tz-col tz-col-rail" data-sheet={sheet === 'rail' ? 'open' : undefined}>
        <button className="tz-sheet-close" aria-label="إغلاق" onClick={() => setSheet(null)}>
          <Icon name="close" />
        </button>
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
