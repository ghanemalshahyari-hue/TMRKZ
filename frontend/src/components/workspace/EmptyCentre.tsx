import { Icon } from '../ui';

/**
 * The middle of an operational screen in an empty installation (owner, 20 Nov 2026; ADR-094): no map is created and nothing
 * is drawn until the system holds units, a site, a stationing or a request. The screen's lists and panels stay as they are.
 */
export function EmptyCentre({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="tz-empty-centre" data-testid="empty-centre" role="note">
      <Icon name="map" />
      <b>{title}</b>
      <p>{hint}</p>
    </div>
  );
}
