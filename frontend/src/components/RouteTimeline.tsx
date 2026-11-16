import type { StageView } from '../api/types';
import { fullTime } from '../lib/dates';
import { TASK_STATE } from '../lib/labels';
import { onlySkipped, skippedSummary, skippedUnits } from '../lib/routeSkips';

/** A request's approval path: its steps in order, each with its tasks and the hierarchy units it skipped (ADR-062). */
function stageModeLabel(s: StageView): string {
  if (s.mode === 'ANY') return 'تكفي موافقة واحدة';
  return s.tasks.length > 1 ? 'مراجعات متوازية — يلزم الجميع' : 'مراجعة متسلسلة';
}

/** The hierarchy units a climbing step skipped (ADR-062): muted, a skip mark, «تم التجاوز» and the reason — never approved. */
function SkippedUnits({ stage }: { stage: StageView }) {
  if (!stage.skipped?.length) return null;
  return (
    <ul className="tl-skips" data-testid="skipped-units">
      {stage.skipped
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((k) => (
          <li key={k.order} className="tl-skip" data-skipped={k.organizationId ?? k.order}>
            <span className="tl-skip-mark" aria-hidden="true">⤼</span>
            <span className="tl-skip-name">{k.organizationName ?? 'جهة'}</span>
            <b className="tl-skip-state">تم التجاوز</b>
            <small className="tl-skip-reason">{k.reason}</small>
          </li>
        ))}
    </ul>
  );
}

/** «تم تجاوز 3 جهات في السلسلة الهرمية لعدم وجود معتمد», opening to the names (ADR-062). */
function SkippedNote({ stages }: { stages: StageView[] }) {
  const summary = skippedSummary(stages);
  if (!summary) return null;
  return (
    <details className="tl-skip-note" data-testid="skipped-note">
      <summary>{summary}</summary>
      <ul>
        {skippedUnits(stages).map((u, i) => (
          <li key={i}>
            {u.name} — {u.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Timeline({ stages }: { stages: StageView[] }) {
  if (!stages.length) return <p className="micro muted">تظهر مراحل المراجعة بعد تقديم الطلب.</p>;
  return (
    <div className="timeline">
      <SkippedNote stages={stages} />
      {stages.map((s, i) => {
        // a step whose every unit was skipped ended without an approval: passed, never a check mark
        const passed = onlySkipped(s);
        const complete = !passed && (s.state === 'COMPLETE' || s.state === 'CARRIED');
        const active = s.state === 'ACTIVE';
        return (
          <div key={s.key} className={'timeline-item ' + (complete ? 'complete' : active ? 'active' : passed ? 'passed' : '')} data-stage={s.key}>
            <i>{passed ? '⤼' : complete ? '✓' : s.state === 'SKIPPED' ? '—' : i + 1}</i>
            <div>
              <b>{s.name}</b>
              <br />
              <small>
                {stageModeLabel(s)} · {s.slaDays} يوم
                {s.state === 'SKIPPED' ? ' · لم تنطبق شروط المرحلة' : s.state === 'CARRIED' ? ' · موافقة سابقة محفوظة وفق سياسة التعديل' : ''}
                {passed ? ' · تم تجاوز جهات هذه المرحلة كلها لعدم وجود معتمد، وانتقل الطلب إلى المرحلة التالية' : ''}
              </small>
              <SkippedUnits stage={s} />
              <div className="task-chips">
                {s.tasks.map((t) => {
                  const done = t.state === 'APPROVED';
                  return (
                    <span key={t.id ?? s.key + t.roleName} className={'task-chip ' + (done ? 'done' : '')} title={t.decidedBy ? t.decidedBy + ' · ' + fullTime(t.decidedAt) : TASK_STATE[t.state]}>
                      {t.roleName}
                      {t.orgName ? ' · ' + t.orgName : ''}
                      {done ? ' ✓' : t.state !== 'OPEN' && TASK_STATE[t.state] ? ' · ' + TASK_STATE[t.state] : ''}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
