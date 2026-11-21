import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { MapFeature, StationingRecord } from '../../api/types';
import { useApp } from '../../lib/app';
import { restriction } from '../../lib/navigation';
import { registeredSites, unitsPerSite, type RefSite } from '../../lib/sitesLayer';

type Registered = { sites: MapFeature[]; current: StationingRecord[]; loaded: boolean };
export type RegisteredView = Registered & { all: RefSite[]; counts: Map<string, number> };

// one load per person and data revision, shared by every map on the screen
let cache: { key: string; promise: Promise<Omit<Registered, 'loaded'>> } | null = null;

/**
 * The registered sites this person may see (`/map/features`: boundaries, markers, responsible organisation — scoped by
 * the server) and the authoritative current stationing (`/stationing/current`), for the reference layer and the site
 * details. Asked for only with a right the endpoints accept; otherwise empty.
 *
 * <p>Pass {@code enabled: false} to opt the current mount out of the fetch entirely — used by the Operational Posture
 * page (ADR-094 Gate 2 §G), which gets its site list from the Site-Hub summary and does not need the whole registered
 * catalogue. The hook still runs (React rules), it just does not kick off any network calls.
 */
export function useRegisteredSites(opts?: { enabled?: boolean }): RegisteredView {
  const enabled = opts?.enabled !== false;
  const app = useApp();
  const mayList = enabled && !restriction('stationing', app.can, app.summaryOnly);
  const mayCurrent = enabled && (app.can('VIEW') || app.can('VIEW_SUMMARY') || app.can('AUDIT'));
  const key = `${app.me.id}:${app.revision}:${mayList}:${mayCurrent}`;
  const [state, setState] = useState<Registered>({ sites: [], current: [], loaded: false });
  useEffect(() => {
    if (!enabled) {
      // Opted out — publish an immediately-loaded empty view without hitting the network. A disabled mount must
      // not contribute to or overwrite the shared cache used by enabled mounts on other screens.
      setState({ sites: [], current: [], loaded: true });
      return () => {};
    }
    if (!cache || cache.key !== key) {
      cache = {
        key,
        promise: Promise.all([
          mayList ? api.mapFeatures({}).then((r) => r.features).catch(() => [] as MapFeature[]) : Promise.resolve([] as MapFeature[]),
          mayCurrent ? api.stationingCurrent().catch(() => [] as StationingRecord[]) : Promise.resolve([] as StationingRecord[]),
        ]).then(([sites, current]) => ({ sites, current })),
      };
    }
    let live = true;
    cache.promise.then((v) => live && setState({ ...v, loaded: true }));
    return () => {
      live = false;
    };
  }, [key, mayList, mayCurrent, enabled]);
  // the register's sites, then the sites known only from a readable stationing (drawn once the server gives a shape)
  const all = useMemo(() => registeredSites(state.sites, state.current), [state.sites, state.current]);
  const counts = useMemo(() => unitsPerSite(state.current), [state.current]);
  return { ...state, all, counts };
}
