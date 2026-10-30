import { useEffect, useMemo, useRef, useState } from 'react';
import L from '../../lib/leaflet';
import { api, type ApiError } from '../../api/client';
import type { Site, SiteDetail } from '../../api/types';
import { useApp } from '../../lib/app';

const round = (v: number) => Math.round(v * 1e7) / 1e7;

type Pos = { lat: number; lng: number };

/**
 * «العلامة على الخريطة»: place a new site's marker by clicking the map, or move an existing site's marker, as a
 * direct and audited edit of the site register — the same authority as boundary editing, never a reservation or an
 * approval request. The marker is dragged or its coordinates are typed; nothing is written until «حفظ», and selecting
 * or panning the map changes nothing. The registered boundary, resources and responsibility are untouched.
 */
export function SiteMarkerEditor({
  map,
  mode,
  site,
  onCancel,
  onCreated,
  onMoved,
}: {
  map: L.Map | null;
  mode: 'CREATE' | 'MOVE';
  /** The site being repositioned (MOVE only). */
  site?: SiteDetail;
  onCancel: () => void;
  onCreated: (site: Site) => void;
  onMoved: () => void;
}) {
  const app = useApp();
  const { me, orgs } = app;

  // organisations this person may administer facilities for (the server re-checks MANAGE_FACILITIES on the chosen org)
  const manageable = useMemo(() => {
    const grants = me.grants.filter((g) => g.permissions.includes('MANAGE_FACILITIES'));
    if (grants.some((g) => g.scope === 'ALL' || g.all)) return orgs;
    const roots = new Set(grants.map((g) => g.organization?.id).filter(Boolean) as string[]);
    const out: typeof orgs = [];
    let inside = -1;
    for (const o of orgs) {
      if (inside >= 0 && o.depth <= inside) inside = -1;
      if (roots.has(o.id) && inside < 0) inside = o.depth;
      if (inside >= 0) out.push(o);
    }
    return out;
  }, [me.grants, orgs]);

  const startPos: Pos | null = useMemo(() => {
    if (mode === 'MOVE' && site) {
      if (site.location) return { lat: site.location.lat, lng: site.location.lng };
      // a site with a boundary but no marker yet: start at the centre of its boundary (display only, not stored)
      if (site.geometry && site.geometry.type !== 'Point') {
        const c = L.geoJSON(site.geometry.geojson as never).getBounds().getCenter();
        return { lat: round(c.lat), lng: round(c.lng) };
      }
    }
    return null;
  }, [mode, site]);

  const [pos, setPos] = useState<Pos | null>(startPos);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('مرفق');
  const [orgId, setOrgId] = useState(() => (me.primaryOrg && manageable.find((o) => o.id === me.primaryOrg!.id)?.id) || manageable[0]?.id || '');
  const [capacity, setCapacity] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const markerRef = useRef<L.Marker | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const posRef = useRef<Pos | null>(pos);
  posRef.current = pos;

  // one draggable marker on its own layer; dragging updates the coordinates, which also move the marker
  useEffect(() => {
    if (!map) return;
    const group = L.layerGroup().addTo(map);
    layerRef.current = group;
    const onClick = (e: L.LeafletMouseEvent) => {
      // the first click places the marker; afterwards the map is only dragged/panned and the marker is moved by drag
      if (posRef.current) return;
      setPos({ lat: round(e.latlng.lat), lng: round(e.latlng.lng) });
    };
    map.on('click', onClick);
    map.getContainer().classList.add('placing-marker');
    if (startPos) map.panTo([startPos.lat, startPos.lng]);
    return () => {
      map.off('click', onClick);
      map.getContainer().classList.remove('placing-marker');
      group.remove();
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // draw / move the marker to the current position
  useEffect(() => {
    const group = layerRef.current;
    if (!group || !pos) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const html = '<span class="marker-edit-pin" aria-hidden="true"></span>';
    if (!markerRef.current) {
      const m = L.marker([pos.lat, pos.lng], {
        draggable: true,
        keyboard: false,
        title: mode === 'CREATE' ? 'موقع الموقع الجديد (اسحب للضبط)' : 'علامة «' + (site?.name ?? '') + '» (اسحب للضبط)',
        icon: L.divIcon({ className: 'marker-edit', html, iconSize: [22, 22], iconAnchor: [11, 11] }),
      }).addTo(group);
      m.on('dragend', () => {
        const ll = m.getLatLng();
        setPos({ lat: round(ll.lat), lng: round(ll.lng) });
      });
      markerRef.current = m;
    } else {
      const cur = markerRef.current.getLatLng();
      if (round(cur.lat) !== pos.lat || round(cur.lng) !== pos.lng) markerRef.current.setLatLng([pos.lat, pos.lng]);
    }
  }, [pos, mode, site]);

  const setCoord = (axis: 'lat' | 'lng', value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    if (axis === 'lat' && Math.abs(n) > 90) return setError('خط العرض بين −90 و90.');
    if (axis === 'lng' && Math.abs(n) > 180) return setError('خط الطول بين −180 و180.');
    setError('');
    setPos((p) => ({ lat: axis === 'lat' ? round(n) : p?.lat ?? 0, lng: axis === 'lng' ? round(n) : p?.lng ?? 0 }));
  };

  const fit = () => {
    if (map && pos) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 15));
  };

  const submit = async () => {
    if (!pos) return setError(mode === 'CREATE' ? 'انقر على الخريطة لتحديد موقع العلامة، أو أدخل الإحداثيات.' : 'حدد موقع العلامة الجديد.');
    setBusy(true);
    setError('');
    try {
      if (mode === 'CREATE') {
        if (code.trim().length < 2) throw new Error('اكتب رمز الموقع.');
        if (name.trim().length < 2) throw new Error('اكتب اسم الموقع.');
        if (kind.trim().length < 2) throw new Error('اكتب تصنيف الموقع.');
        if (!orgId) throw new Error('اختر الجهة المسؤولة عن الموقع.');
        const cap = capacity.trim() === '' ? null : Number(capacity);
        if (cap != null && (!Number.isInteger(cap) || cap < 0)) throw new Error('السعة عدد صحيح موجب أو اتركها فارغة.');
        const created = await api.createSite({
          code: code.trim(),
          name: name.trim(),
          kind: kind.trim(),
          responsibleOrgId: orgId,
          capacity: cap,
          location: { lat: pos.lat, lng: pos.lng },
        });
        onCreated(created);
      } else {
        if (reason.trim().length < 5) throw new Error('اكتب سبب نقل العلامة (5 أحرف على الأقل).');
        await api.moveSiteMarker(site!.id, { location: { lat: pos.lat, lng: pos.lng }, reason: reason.trim() });
        onMoved();
      }
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="card boundary-editor" aria-label={mode === 'CREATE' ? 'إضافة موقع جديد بعلامة على الخريطة' : 'نقل علامة ' + (site?.name ?? '')}>
      <div className="flex spread">
        <span className="eyebrow">{mode === 'CREATE' ? 'ADD SITE / MARKER' : 'EDIT SITE RECORD / MARKER'}</span>
        <button className="icon-button" onClick={onCancel} aria-label="إغلاق دون حفظ">
          ✕
        </button>
      </div>
      <h3>{mode === 'CREATE' ? 'إضافة موقع جديد' : 'نقل علامة «' + (site?.name ?? '') + '»'}</h3>
      <p className="micro muted">
        {mode === 'CREATE'
          ? 'انقر على الخريطة لتحديد موقع الموقع، ثم اسحب العلامة أو عدّل الإحداثيات للضبط. يُسجَّل الموقع عند «إضافة الموقع» فقط.'
          : 'اسحب العلامة إلى موضعها الجديد أو عدّل الإحداثيات، ثم احفظ بسبب. لا يتغير سجل الموقع إلا عند الحفظ، ولا تتأثر الحدود ولا الموارد.'}
      </p>

      {mode === 'CREATE' && (
        <>
          <div className="row">
            <label className="field">
              <span>رمز الموقع</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} placeholder="مثال: FAC-120" />
            </label>
            <label className="field">
              <span>تصنيف الموقع</span>
              <input value={kind} onChange={(e) => setKind(e.target.value)} maxLength={40} />
            </label>
          </div>
          <label className="field">
            <span>اسم الموقع</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="مثال: المبنى الإداري" />
          </label>
          <label className="field">
            <span>الجهة المسؤولة</span>
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="الجهة المسؤولة">
              {manageable.length === 0 && <option value="">لا توجد جهة تملك صلاحية إدارة مرافقها</option>}
              {manageable.map((o) => (
                <option key={o.id} value={o.id}>
                  {' '.repeat(o.depth * 2) + o.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>السعة (اختياري)</span>
            <input type="number" min={0} step={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="اتركها فارغة إن لم تُعرف" />
          </label>
        </>
      )}

      <div className="vertex-head" style={{ marginTop: 6 }}>
        <span>الإحداثيات</span>
      </div>
      <div className="row">
        <label className="field">
          <span>خط العرض</span>
          <input type="number" step="0.000001" value={pos ? pos.lat : ''} onChange={(e) => setCoord('lat', e.target.value)} aria-label="خط العرض" />
        </label>
        <label className="field">
          <span>خط الطول</span>
          <input type="number" step="0.000001" value={pos ? pos.lng : ''} onChange={(e) => setCoord('lng', e.target.value)} aria-label="خط الطول" />
        </label>
      </div>
      <p className="micro note" role="status">
        {pos ? 'العلامة محددة — اسحبها على الخريطة أو عدّل الإحداثيات.' : 'لم تُحدَّد العلامة بعد — انقر على الخريطة.'}
        {pos && (
          <>
            {' '}
            <button className="link-button text-link" onClick={fit} type="button">
              تقريب إلى العلامة
            </button>
          </>
        )}
      </p>

      {mode === 'MOVE' && (
        <label className="field">
          <span>سبب نقل العلامة</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} placeholder="مثال: تصحيح موضع العلامة وفق المسح" />
        </label>
      )}

      <div className="error-text" role="alert">
        {error}
      </div>
      <div className="editor-actions">
        <button className="button primary" onClick={submit} disabled={busy || !pos}>
          {busy ? 'جارٍ الحفظ…' : mode === 'CREATE' ? 'إضافة الموقع' : 'حفظ موقع العلامة'}
        </button>
        <button className="button ghost" onClick={onCancel} disabled={busy}>
          إلغاء دون حفظ
        </button>
      </div>
    </aside>
  );
}
