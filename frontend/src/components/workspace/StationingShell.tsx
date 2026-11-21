import { type ReactNode } from 'react';
import { Icon } from '../ui';

/**
 * «مساحة التمركز» shell (owner UX consolidation, 20 Nov 2026 §1): one persistent header strip above every state of the
 * stationing workspace — idle list, request detail, new-request editor, saved draft, read-only view, legacy record, site
 * setup. The user always sees ONE workspace, never a separate app. Mode names below name the operational context in the
 * strip; legacy records say «طلب اعتماد موقع قديم», never «إعادة تمركز».
 */
export type ShellMode = 'deployment' | 'restationing' | 'view-or-edit' | 'legacy' | 'site-setup' | null;
const SHELL_LABEL: Record<Exclude<ShellMode, null>, string> = {
  deployment: 'طلب مناطق انتشار',
  restationing: 'طلب إعادة تمركز',
  'view-or-edit': 'طلب محفوظ',
  legacy: 'طلب اعتماد موقع قديم',
  'site-setup': 'تهيئة مواقع التمركز',
};

export function StationingShell({ mode, onExit, exitLabel, children }: { mode: ShellMode; onExit: (() => void) | null; exitLabel?: string; children: ReactNode }) {
  return (
    <div className="tz-stationing-shell" data-mode={mode ?? 'idle'}>
      <header className="tz-stationing-shell-head" aria-label="مساحة التمركز">
        <div className="tz-ssh-title"><Icon name="map" /><b>مساحة التمركز</b></div>
        {mode && (
          <span className="tz-ssh-mode" data-testid="stationing-mode">
            <span className="tz-ssh-sep">←</span>
            <span>{SHELL_LABEL[mode]}</span>
          </span>
        )}
        {onExit && (
          <button type="button" className="tz-ssh-exit" onClick={onExit} data-testid="stationing-exit">
            <Icon name="close" /> <span>{exitLabel ?? 'إلغاء والعودة إلى القائمة'}</span>
          </button>
        )}
      </header>
      <div className="tz-stationing-shell-body">{children}</div>
    </div>
  );
}
