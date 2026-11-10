import { INPUT_FORMATS, type FormatKey } from '../../lib/coordFormats';
import { readRow, reformat, type PointRow } from '../../lib/siteWizard';

/**
 * «جدول الإحداثيات» (owner, 10 Nov 2026): one point per row, one under another, in any coordinate format — chosen, or read
 * automatically from what is typed (decimal degrees, degrees and minutes, degrees-minutes-seconds, UTM, MGRS; Arabic digits
 * too). A row can take its position from the map, move up or down, have a point inserted after it, or be removed. The points
 * are joined in order on the map as soon as there are three; changing the format rewrites every row without moving a point.
 */
export function PointsTable({ rows, fmt, single, picking, onRows, onFormat, onPick }: {
  rows: PointRow[];
  fmt: FormatKey;
  /** A point site: one row only. */
  single: boolean;
  /** The row whose position the next map click sets, or null. */
  picking: number | null;
  onRows: (rows: PointRow[]) => void;
  onFormat: (fmt: FormatKey) => void;
  onPick: (row: number | null) => void;
}) {
  const shown = single ? (rows.length ? rows.slice(0, 1) : [readRow('', fmt)]) : rows;
  const set = (i: number, text: string) => onRows(shown.map((r, j) => (j === i ? readRow(text, fmt) : r)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...shown];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onRows(next);
  };
  const insert = (i: number) => onRows([...shown.slice(0, i + 1), readRow('', fmt), ...shown.slice(i + 1)]);
  const remove = (i: number) => onRows(shown.filter((_, j) => j !== i));
  const example = INPUT_FORMATS.find((f) => f.key === fmt)?.example ?? '';
  return (
    <div className="sw-points" data-testid="points-table">
      <label className="sw-small">
        <span>نظام الإحداثيات</span>
        <select className="sw-input" aria-label="نظام الإحداثيات" value={fmt} onChange={(e) => { const f = e.target.value as FormatKey; onFormat(f); onRows(reformat(shown, f)); }}>
          {INPUT_FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </label>
      <p className="sw-hint" dir="ltr">{example}</p>
      <ol className="sw-rows">
        {shown.map((r, i) => (
          <li key={i} className={'sw-prow' + (picking === i ? ' picking' : '') + (r.error ? ' bad' : '')} data-row={i}>
            <span className="sw-n">{i + 1}</span>
            <div className="sw-pcell">
              <input className="sw-input" dir="ltr" aria-label={'النقطة ' + (i + 1)} value={r.text} placeholder={example.split('·')[0].trim()} onChange={(e) => set(i, e.target.value)} />
              {r.error ? <small className="sw-perr">{r.error}</small> : r.point && fmt !== 'dd' && fmt !== '' ? <small className="sw-pread" dir="ltr">{r.point.lat.toFixed(6)}, {r.point.lng.toFixed(6)}</small> : null}
            </div>
            <div className="sw-pacts">
              <button type="button" className={'sw-mini' + (picking === i ? ' on' : '')} aria-pressed={picking === i} title="حدد هذه النقطة على الخريطة" aria-label={'النقطة ' + (i + 1) + ' من الخريطة'} data-act="pick" onClick={() => onPick(picking === i ? null : i)}>من الخريطة</button>
              {!single && (
                <>
                  <button type="button" className="sw-mini" disabled={i === 0} title="إلى الأعلى" aria-label={'النقطة ' + (i + 1) + ' إلى الأعلى'} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="sw-mini" disabled={i === shown.length - 1} title="إلى الأسفل" aria-label={'النقطة ' + (i + 1) + ' إلى الأسفل'} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="sw-mini" title="نقطة بعد هذه" aria-label={'نقطة بعد النقطة ' + (i + 1)} onClick={() => insert(i)}>＋</button>
                  <button type="button" className="sw-mini sw-del" title="حذف" aria-label={'حذف النقطة ' + (i + 1)} onClick={() => remove(i)}>✕</button>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      {picking !== null && <p className="sw-hint">انقر على الخريطة في مكان النقطة {picking + 1}.</p>}
      {!single && <button type="button" className="sw-link" data-testid="add-point" onClick={() => onRows([...shown, readRow('', fmt)])}>＋ إضافة نقطة</button>}
    </div>
  );
}
