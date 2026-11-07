import { useEffect, useMemo, useState } from 'react';
import { api, type PostureUnit } from '../api/client';
import type { GeoPolygon, RestationingRequest, SiteGeometry } from '../api/types';
import { installedTerrain3d, type MapView } from '../components/map/maplibre';
import type { BasemapMode, Terrain3dSource } from '../components/map/maplibre/offlineStyle';
import { Icon } from '../components/ui';
import { MapFrame, MapLegend } from '../components/workspace/MapFrame';
import { OperationalWorkspace } from '../components/workspace/OperationalWorkspace';
import { RequestMap } from '../components/workspace/RequestMap';
import { useApp } from '../lib/app';
import { fullDate } from '../lib/dates';
import { PURPOSE_TITLE, UNIT_STATE, isPurpose } from '../lib/requestPurpose';

/** One unit's posture as the map's request shape: its site as «current», its own two areas. Nothing here is a request or can be edited. */
function asMapRequest(u: PostureUnit): RestationingRequest {
  return {
    id: 'posture', number: '', state: 'ACTIVATED_PERMANENT', requestingUnit: { id: u.id, name: u.name }, requester: { id: '', name: '' }, units: [],
    currentSites: u.site ? [{ unit: u.name, site: { id: u.site.id, name: u.site.name }, geometry: u.site.geometry as RestationingRequest['currentSites'][number]['geometry'] }] : [],
    purpose: 'DEPLOYMENT_AREAS',
    content: { kind: u.kind === 'TEMPORARY' ? 'TEMPORARY' : 'PERMANENT', scope: [], site: u.site?.geometry && u.site.geometry.type !== 'Point' ? { geometry: u.site.geometry, copiedFrom: u.site.id, shape: 'COPY' } : null, primary: (u.primary as GeoPolygon | null) ?? null, alternative: (u.alternative as GeoPolygon | null) ?? null, reason: '', exceptions: {}, occupants: {} },
    policyVersion: null, routeNo: 0, route: [], previousRoutes: [], revisions: [], returned: null, paused: null, finalApprover: null,
    can: { edit: false, submit: false, decide: false, activate: false },
  } as unknown as RestationingRequest;
}

/**
 * «الموقف العملياتي»: read only, on the same offline map (2D and 3D). A unit in this person's reach, where it is stationed, its
 * kind, its own deployment areas and whether a request is in progress. There are no actions here because the right opens none;
 * the server refuses them whatever a page sends. A unit outside the reach at the same site is only counted.
 */
export function PosturePage() {
  const app = useApp();
  const [units, setUnits] = useState<PostureUnit[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<BasemapMode>('street');
  const [view, setView] = useState<MapView>('2d');
  const [terrain3d, setTerrain3d] = useState<Terrain3dSource | null | undefined>(undefined);
  const [fit, setFit] = useState(0);
  useEffect(() => {
    installedTerrain3d().then(setTerrain3d);
    api.operationalPosture().then((p) => {
      setUnits(p.units);
      setSelected((s) => s ?? p.units.find((u) => u.site)?.id ?? p.units[0]?.id ?? null);
    }).catch((e: Error) => (setUnits([]), app.toast(e.message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.revision]);
  const unit = units?.find((u) => u.id === selected) ?? null;
  const req = useMemo(() => (unit ? asMapRequest(unit) : null), [unit]);
  useEffect(() => setFit((k) => k + 1), [selected]);
  const rail = (
    <div className="tz-rail">
      <section className="tz-drawer open tz-site-list" aria-label="وحداتي">
        <div className="tz-drawer-head"><span className="tz-drawer-toggle"><Icon name="units" /><span>وحدتي والوحدات التابعة</span><span className="tz-chip">{units?.length ?? '…'}</span></span></div>
        <div className="rs-list" data-testid="posture-tree">
          {units?.length === 0 && <div className="tz-muted tz-pad">لا وحدات ضمن صلاحيتك.</div>}
          {units?.map((u) => (
            <button key={u.id} data-unit={u.id} className={'rs-item' + (u.id === selected ? ' active' : '')} aria-current={u.id === selected} style={{ paddingInlineStart: 10 + u.depth * 14 }} onClick={() => setSelected(u.id)}>
              <span className="rs-item-head"><b>{u.name}</b></span>
              <small>{u.site?.name ?? 'بلا تمركز معتمد'}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
  const context = (
    <aside className="tz-context" aria-label="موقف الوحدة">
      <div className="tz-context-body" data-testid="posture-details">
        {!unit && <section className="tz-card"><p className="tz-muted">اختر وحدة.</p></section>}
        {unit && (
          <section className="tz-card rs-summary">
            <h2 className="tz-site-title">{unit.name}</h2>
            <dl className="rs-facts">
              <div><dt>الموقع الحالي</dt><dd data-testid="posture-site">{unit.site?.name ?? '—'}</dd></div>
              <div><dt>نوع التمركز</dt><dd>{unit.kind === 'TEMPORARY' ? 'مؤقت' : unit.kind ? 'دائم' : '—'}{unit.plannedEnd ? ' · حتى ' + fullDate(unit.plannedEnd) : ''}</dd></div>
              <div><dt>منطقة الانتشار الرئيسية</dt><dd data-testid="posture-primary">{unit.primary ? 'معتمدة' : 'لا توجد'}</dd></div>
              <div><dt>منطقة الانتشار البديلة</dt><dd data-testid="posture-alternative">{unit.alternative ? 'معتمدة' : 'لا توجد'}</dd></div>
              <div><dt>الحالة</dt><dd>{UNIT_STATE[unit.state] ?? unit.state}</dd></div>
              <div><dt>حالة الطلب الجاري</dt><dd data-testid="posture-request">{unit.request ? (isPurpose(unit.request.purpose) ? PURPOSE_TITLE[unit.request.purpose] : '') + ' — ' + unit.request.state : 'لا يوجد'}</dd></div>
              {!!unit.otherUnitsAtSite && <div><dt>جهة أخرى في الموقع</dt><dd data-testid="posture-others">{unit.otherUnitsAtSite}</dd></div>}
            </dl>
            <p className="tz-muted micro">عرض فقط: لا يتغير من هنا شيء.</p>
          </section>
        )}
      </div>
    </aside>
  );
  return (
    <OperationalWorkspace
      listRail
      railLabel="الوحدات"
      contextLabel="الموقف"
      sheetKey={selected ?? ''}
      rail={rail}
      context={context}
      centre={
        <MapFrame
          title={<span className="tz-mapstep"><Icon name="map" /><b>الموقف العملياتي</b>{unit && <small>{unit.name}</small>}</span>}
          mode={mode}
          setMode={setMode}
          view={view}
          setView={setView}
          has3d={!!terrain3d}
          onFit={() => setFit((k) => k + 1)}
          legend={<MapLegend stage="full" fold />}
        >
          {terrain3d !== undefined && req && <RequestMap view={view} terrain3d={terrain3d} request={req} checks={null} mode={mode} fitMaxZoom={13} hideSite fit fitKey={fit} referenceInteractive={false} />}
        </MapFrame>
      }
    />
  );
}

export type { SiteGeometry };
