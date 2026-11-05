import type { ReactNode } from 'react';
import { Icon } from '../ui';

export type RailAction = { key: string; label: string; hint: string; icon: string; active?: boolean; onClick: () => void };

/**
 * The left action panel (§7): large action cards, each opening or focusing a real part of the workspace. Only actions
 * the person may use are passed in; the server still decides every call. Below them sits the request drawer.
 */
export function ActionRail({ actions, children }: { actions: RailAction[]; children?: ReactNode }) {
  return (
    <div className="tz-rail">
      <nav className="tz-actions" aria-label="إجراءات مساحة التمركز">
        {actions.map((a) => (
          <button key={a.key} className={'tz-action' + (a.active ? ' active' : '')} aria-pressed={a.active} onClick={a.onClick} title={a.hint}>
            <span className="tz-action-icon">
              <Icon name={a.icon} />
            </span>
            <span className="tz-action-text">
              <b>{a.label}</b>
              <small>{a.hint}</small>
            </span>
          </button>
        ))}
      </nav>
      {children}
    </div>
  );
}
