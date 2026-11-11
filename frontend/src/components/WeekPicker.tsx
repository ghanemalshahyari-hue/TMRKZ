import { useEffect, useRef, useState } from 'react';
import { addDays, dubaiISO, fullDate, todayDubai } from '../lib/dates';
import { Icon } from './ui';
import './weekPicker.css';

const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const WEEKDAYS = ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];

const pad = (n: number) => String(n).padStart(2, '0');
/** The days of a month's calendar page: leading blanks to its weekday (Sunday first), then each day as `YYYY-MM-DD`. */
export function monthCells(year: number, month: number): (string | null)[] {
  const first = new Date(Date.UTC(year, month, 1));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const out: (string | null)[] = Array.from({ length: first.getUTCDay() }, () => null);
  for (let d = 1; d <= days; d++) out.push(`${year}-${pad(month + 1)}-${pad(d)}`);
  return out;
}

/**
 * The seven days a page shows, chosen without typing (owner, 11 Nov 2026): the arrows step a week; the range opens a
 * calendar with the year (arrows or a list), the twelve months and the month's days — a click on a day starts the seven
 * days there. «اليوم» returns to today.
 */
export function WeekPicker({ start, onChange }: { start: string; onChange: (day: string) => void }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => Number(start.slice(0, 4)));
  const [month, setMonth] = useState(() => Number(start.slice(5, 7)) - 1);
  const box = useRef<HTMLDivElement | null>(null);
  const today = todayDubai();
  const end = addDays(start, 6);
  useEffect(() => {
    if (!open) return;
    setYear(Number(start.slice(0, 4)));
    setMonth(Number(start.slice(5, 7)) - 1);
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => (document.removeEventListener('mousedown', away), document.removeEventListener('keydown', esc));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const pick = (day: string) => {
    onChange(day);
    setOpen(false);
  };
  const thisYear = Number(today.slice(0, 4));
  const years = Array.from({ length: 21 }, (_, i) => thisYear - 10 + i);
  return (
    <div className="wp" ref={box}>
      <button className="button compact" onClick={() => onChange(addDays(start, -7))} aria-label="الأسبوع السابق">→ السابق</button>
      <button className="wp-range" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="week-picker">
        <Icon name="clock" />
        {fullDate(dubaiISO(start))} — {fullDate(dubaiISO(end))}
      </button>
      <button className="button compact" onClick={() => onChange(addDays(start, 7))} aria-label="الأسبوع التالي">التالي ←</button>
      {open && (
        <div className="wp-pop" role="dialog" aria-label="اختيار الفترة">
          <div className="wp-year">
            <button className="icon-button" aria-label="السنة السابقة" onClick={() => setYear(year - 1)}>→</button>
            <select aria-label="السنة" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {(years.includes(year) ? years : [...years, year].sort()).map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            <button className="icon-button" aria-label="السنة التالية" onClick={() => setYear(year + 1)}>←</button>
          </div>
          <div className="wp-months" role="group" aria-label="الشهر">
            {MONTHS.map((m, i) => (
              <button key={m} className={i === month ? 'on' : ''} aria-pressed={i === month} onClick={() => setMonth(i)}>{m}</button>
            ))}
          </div>
          <div className="wp-days" role="grid" aria-label={MONTHS[month] + ' ' + year}>
            {WEEKDAYS.map((w) => (
              <span key={w} className="wp-wd">{w}</span>
            ))}
            {monthCells(year, month).map((d, i) =>
              d == null ? (
                <span key={'b' + i} />
              ) : (
                <button
                  key={d}
                  className={(d >= start && d <= end ? 'in ' : '') + (d === start ? 'first ' : '') + (d === today ? 'today' : '')}
                  onClick={() => pick(d)}
                  aria-label={fullDate(dubaiISO(d))}
                >
                  {Number(d.slice(8))}
                </button>
              ),
            )}
          </div>
          <div className="wp-quick">
            <button className="button compact" onClick={() => pick(today)}>اليوم</button>
            <button className="button compact" onClick={() => pick(`${year}-${pad(month + 1)}-01`)}>بداية {MONTHS[month]}</button>
          </div>
          <p className="wp-hint">اضغط يوماً لتبدأ الأيام السبعة منه.</p>
        </div>
      )}
    </div>
  );
}
