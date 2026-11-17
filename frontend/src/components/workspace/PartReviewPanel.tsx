import { useState } from 'react';
import type { RequestPart } from '../../api/types';

export type PartChoice = 'APPROVE' | 'CHANGES';

const STATE_TEXT: Record<string, string> = {
  APPROVED: 'معتمد',
  REOPENED: 'عُدّل بعد اعتماده: يُقرَّر من جديد',
  CHANGES_REQUESTED: 'تعديل مطلوب',
  EDITED: 'عُدّل بعد طلب التعديل',
  PENDING: 'بانتظار القرار',
};
const TONE: Record<string, string> = { APPROVED: 'ok', REOPENED: 'warn', CHANGES_REQUESTED: 'bad', EDITED: 'warn', PENDING: 'none' };

/** Which parts still need this stage's decision: those it has not approved, or approved and changed since. */
export const openParts = (parts: readonly RequestPart[]) => parts.filter((p) => p.current !== 'APPROVED');

/**
 * «الاعتماد الجزئي» (owner brief §6, phase 8; ADR-090): the parts of the request — the new site, the main area, the sub-area —
 * each approved or returned for changes by the stage that decides now. A part this stage approved and that has not changed is
 * kept («معتمد») and not decided again. The decision is the server's: RETURN when a part needs changes, APPROVE when all are
 * approved; the route itself is unchanged.
 */
export function PartReviewPanel({ parts, busy, onDecide }: { parts: readonly RequestPart[]; busy: boolean; onDecide: (choices: Record<string, PartChoice>, notes: Record<string, string>) => void }) {
  const [choice, setChoice] = useState<Record<string, PartChoice>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const open = openParts(parts);
  const decided = open.every((p) => choice[p.part]);
  const changes = open.filter((p) => choice[p.part] === 'CHANGES');
  return (
    <section className="tz-card pr-panel" data-testid="part-review" aria-label="الاعتماد الجزئي">
      <h4>الاعتماد الجزئي</h4>
      <p className="micro tz-muted">اعتمد كل جزء أو أعده للتعديل. الجزء المعتمد في هذه المرحلة لا يُقرَّر مرة أخرى ما لم يُعدَّل.</p>
      <ul className="pr-list">
        {parts.map((p) => {
          const kept = p.current === 'APPROVED';
          return (
            <li key={p.part} className={'pr-row' + (kept ? ' is-kept' : '')} data-part={p.part}>
              <div className="pr-head">
                <b>{p.label}</b>
                <span className={'da-chip is-' + TONE[p.current]} data-testid={`part-state-${p.part}`}>{STATE_TEXT[p.current] ?? p.current}</span>
              </div>
              {p.last && p.last.state !== p.current && <small className="tz-muted">آخر قرار: {STATE_TEXT[p.last.state] ?? p.last.state} — {p.last.stageLabel}{p.last.note ? ': ' + p.last.note : ''}</small>}
              {kept ? (
                <small className="pr-kept">✓ اعتُمد في هذه المرحلة ولم يتغير.</small>
              ) : (
                <div className="pr-choose" role="group" aria-label={'قرار ' + p.label}>
                  <button type="button" className={'button' + (choice[p.part] === 'APPROVE' ? ' primary' : '')} aria-pressed={choice[p.part] === 'APPROVE'} data-testid={`part-approve-${p.part}`} onClick={() => setChoice({ ...choice, [p.part]: 'APPROVE' })}>اعتماد</button>
                  <button type="button" className={'button' + (choice[p.part] === 'CHANGES' ? ' danger' : '')} aria-pressed={choice[p.part] === 'CHANGES'} data-testid={`part-changes-${p.part}`} onClick={() => setChoice({ ...choice, [p.part]: 'CHANGES' })}>تعديل مطلوب</button>
                </div>
              )}
              {choice[p.part] === 'CHANGES' && !kept && (
                <input className="sw-input" aria-label={'ما المطلوب في ' + p.label} placeholder="ما المطلوب تعديله؟" value={notes[p.part] ?? ''} onChange={(e) => setNotes({ ...notes, [p.part]: e.target.value })} />
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" className={'button ' + (changes.length ? 'danger' : 'primary')} data-testid="part-decide" disabled={busy || !decided || open.length === 0}
        onClick={() => onDecide(Object.fromEntries(open.map((p) => [p.part, choice[p.part]])) as Record<string, PartChoice>, notes)}>
        {changes.length ? `إعادة للتعديل (${changes.length === 1 ? 'جزء واحد' : changes.length + ' أجزاء'})` : 'اعتماد الأجزاء'}
      </button>
    </section>
  );
}

/** For the requester of a returned request: which parts are approved and which need changes. */
export function ReturnedParts({ parts }: { parts: readonly RequestPart[] }) {
  const shown = parts.filter((p) => p.last);
  if (!shown.length) return null;
  return (
    <ul className="pr-list pr-returned" data-testid="returned-parts">
      {shown.map((p) => (
        <li key={p.part} className="pr-row">
          <div className="pr-head">
            <b>{p.label}</b>
            <span className={'da-chip is-' + TONE[p.last!.state]}>{STATE_TEXT[p.last!.state] ?? p.last!.state}</span>
          </div>
          <small className="tz-muted">{p.last!.state === 'APPROVED' ? 'معتمد في «' + p.last!.stageLabel + '»: تعديله يعيد فتح اعتماده.' : p.last!.note ?? p.last!.stageLabel}</small>
        </li>
      ))}
    </ul>
  );
}
