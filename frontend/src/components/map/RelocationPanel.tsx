import { useEffect, useMemo, useRef, useState } from 'react';
import L from '../../lib/leaflet';
import { api, newIdempotencyKey } from '../../api/client';
import type { GeoJsonGeometry, MapFeature } from '../../api/types';
import { useApp } from '../../lib/app';
import { addDays, dubaiISO, todayDubai } from '../../lib/dates';
import { ensureGeoman } from '../../lib/geoman';
import { formatArea } from '../../lib/mapState';
import { OrgSymbol } from '../UnitSymbol';
import { featureAnchor } from './MapCanvas';

type Pm = { enableDraw: (shape: string, o: object) => void; disableDraw: () => void };

/**
 * Request to move an organisation's premises (ADR-023), docked beside the map: which organisation moves (the whole
 * organisation or a section with its branches), from the selected site, to a new location drawn on the map. The
 * drawing is a proposal attached to the request — shown dashed with an explanatory arrow — and never changes the site
 * register. Submitting runs the configured review: endorsement, completeness, study and decision, then the move.
 */
export function RelocationPanel({
  map,
  site,
  typeCode,
  onClose,
}: {
  map: L.Map | null;
  site: MapFeature;
  typeCode: string;
  onClose: () => void;
}) {
  const app = useApp();
  const { me, orgs } = app;
  const creatable = useMemo(() => {
    const grants = me.grants.filter((g) => g.permissions.includes('CREATE'));
    if (grants.some((g) => g.scope === 'ALL' || g.scope === 'SITE')) return orgs;
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
  const own = (me.primaryOrg && creatable.find((o) => o.id === me.primaryOrg!.id)?.id) || creatable[0]?.id || '';
  const [scope, setScope] = useState<'WHOLE' | 'PART'>('WHOLE');
  const [orgId, setOrgId] = useState(own);
  const [withBranches, setWithBranches] = useState(true);
  const [geometry, setGeometry] = useState<GeoJsonGeometry | null>(null);
  const [area, setArea] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [date, setDate] = useState(addDays(todayDubai(), 14));
  const [reason, setReason] = useState('');
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(newIdempotencyKey());
  const layers = useRef<L.LayerGroup | null>(null);
  const resource = site.resources.find((r) => !r.parentResourceId) ?? site.resources[0];
  const from = featureAnchor(site);

  // the proposal and the arrow from the current site, drawn on the map (display only)
  useEffect(() => {
    if (!map) return;
    layers.current?.remove();
    const group = L.layerGroup().addTo(map);
    layers.current = group;
    if (geometry) {
      const shape = L.geoJSON(geometry as never, { style: { color: '#137c68', weight: 2.5, dashArray: '6 5', fillColor: '#137c68', fillOpacity: 0.12 } }).addTo(group);
      const to = shape.getBounds().getCenter();
      if (from) {
        L.polyline([from, to], { color: '#137c68', weight: 2, dashArray: '4 6', interactive: false }).addTo(group);
        L.marker(to, {
          interactive: false,
          icon: L.divIcon({ className: 'relocation-tag', html: '<span>' + (name || 'الموقع المقترح').replace(/[<>&"']/g, '') + '</span>', iconSize: [0, 0] }),
        }).addTo(group);
      }
    }
    return () => {
      group.remove();
    };
  }, [map, geometry, name, from?.lat, from?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      (map as unknown as { pm?: Pm } | null)?.pm?.disableDraw();
    },
    [map],
  );

  const [toolsReady, setToolsReady] = useState(false);
  useEffect(() => {
    if (!map) return;
    let live = true;
    ensureGeoman(map)
      .then(() => live && setToolsReady(true))
      .catch(() => live && setError('تعذر تحميل أدوات الرسم المحلية.'));
    return () => {
      live = false;
    };
  }, [map]);

  const draw = (shape: 'Rectangle' | 'Polygon') => {
    const pm = (map as unknown as { pm?: Pm } | null)?.pm;
    if (!map || !pm || !toolsReady) return setError('أدوات الرسم غير جاهزة بعد.');
    setError('');
    setDrawing(true);
    pm.enableDraw(shape, { snappable: false, allowSelfIntersection: false });
    map.once('pm:create', (e: L.LeafletEvent) => {
      const created = (e as unknown as { layer: L.Polygon }).layer;
      const g = created.toGeoJSON().geometry as unknown as GeoJsonGeometry;
      created.remove();
      setDrawing(false);
      setGeometry(g);
      // planar estimate for the panel; the server computes the area it stores
      const b = created.getBounds();
      const h = b.getNorthWest().distanceTo(b.getSouthWest());
      const w = b.getNorthWest().distanceTo(b.getNorthEast());
      setArea(shape === 'Rectangle' ? w * h : null);
      map.fitBounds(L.latLngBounds([b.getSouthWest(), b.getNorthEast(), ...(from ? [from] : [])]), { padding: [60, 60], maxZoom: 17 });
    });
  };

  const submit = async () => {
    if (!orgId) return setError('اختر الجهة المنقولة.');
    if (!geometry) return setError('ارسم الموقع الجديد على الخريطة.');
    if (name.trim().length < 2) return setError('اكتب اسماً للموقع المقترح.');
    if (reason.trim().length < 10) return setError('اكتب مبرر النقل (10 أحرف على الأقل).');
    if (!resource) return setError('لا يوجد للموقع الحالي سجل مورد يرتبط به الطلب؛ يضيفه مسؤول المرافق.');
    setBusy(true);
    setError('');
    try {
      const d = await api.createRequest({
        typeCode,
        origin: 'MAP',
        ownerOrgId: orgId,
        resourceIds: [resource.id],
        subject: 'نقل مقر — ' + (orgs.find((o) => o.id === orgId)?.name ?? '') + ' من ' + site.name + ' إلى ' + name.trim(),
        unit: 'DAYS',
        period: { start: dubaiISO(date), end: null },
        values: { reason: reason.trim() },
      });
      await api.saveRelocation(d.id, { organizationId: orgId, includeDescendants: withBranches, fromSiteId: site.siteId, proposedName: name.trim(), geometry });
      const fresh = await api.request(d.id);
      const sent = await api.submit(d.id, fresh.version, undefined, key.current);
      app.toast('أُرسل طلب نقل المقر ' + sent.number + ' للمراجعة؛ لا يتغير سجل المواقع قبل الاعتماد والتسجيل');
      app.bump();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      key.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="card map-detail relocation-panel" aria-label={'نقل المقر من ' + site.name}>
      <div className="flex spread">
        <span className="eyebrow">RELOCATION / {site.code}</span>
        <button className="icon-button" onClick={onClose} aria-label="إغلاق طلب النقل دون حفظ">
          ✕
        </button>
      </div>
      <h2>نقل المقر</h2>
      <p className="micro muted">
        من <b>{site.name}</b> إلى موقع ترسمه على الخريطة. الرسم مقترح ضمن الطلب ولا يغيّر سجل المواقع.
      </p>

      <h3 className="detail-h">الجهة المنقولة</h3>
      <div className="segmented" role="radiogroup" aria-label="نطاق النقل">
        <button role="radio" aria-checked={scope === 'WHOLE'} className={scope === 'WHOLE' ? 'active' : ''} onClick={() => (setScope('WHOLE'), setOrgId(own), setWithBranches(true))}>
          الجهة كاملة
        </button>
        <button role="radio" aria-checked={scope === 'PART'} className={scope === 'PART' ? 'active' : ''} onClick={() => setScope('PART')}>
          قسم مع فروعه
        </button>
      </div>
      {scope === 'PART' && (
        <label className="field">
          <span>القسم</span>
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {creatable.map((o) => (
              <option key={o.id} value={o.id}>
                {' '.repeat(o.depth * 2) + o.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="with-symbol micro" style={{ margin: '6px 0' }}>
        <OrgSymbol orgId={orgId} size={22} />
        <b>{orgs.find((o) => o.id === orgId)?.name ?? '—'}</b>
      </div>
      <label className="check-label">
        <input type="checkbox" checked={withBranches} onChange={(e) => setWithBranches(e.target.checked)} />
        تشمل الفروع التابعة
      </label>

      <h3 className="detail-h">الموقع الجديد</h3>
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className={'button compact ' + (geometry ? '' : 'primary')} disabled={drawing || !toolsReady} onClick={() => draw('Rectangle')}>
          {geometry ? 'إعادة الرسم — مستطيل' : 'ارسم الموقع الجديد — مستطيل'}
        </button>
        <button className="button compact" disabled={drawing || !toolsReady} onClick={() => draw('Polygon')}>
          رسم بحدود حرة
        </button>
        {drawing && (
          <button className="button compact ghost" onClick={() => ((map as unknown as { pm?: Pm } | null)?.pm?.disableDraw(), setDrawing(false))}>
            إلغاء الرسم
          </button>
        )}
      </div>
      <p className="micro muted" role="status">
        {drawing
          ? 'ارسم على الخريطة: اسحب لرسم المستطيل، أو انقر رؤوس الحدود ثم انقر الرأس الأول للإغلاق.'
          : geometry
            ? 'الموقع المقترح مرسوم بخط متقطع، مع سهم من الموقع الحالي.' + (area ? ' المساحة التقريبية ' + formatArea(area) + '.' : '')
            : 'لم يُرسم الموقع الجديد بعد.'}
      </p>
      <label className="field">
        <span>اسم الموقع المقترح</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="مثال: المبنى الإداري الجديد" />
      </label>
      <label className="field">
        <span>التاريخ المطلوب للنقل</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field">
        <span>مبرر النقل</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} placeholder="لماذا تنتقل الجهة؟" />
      </label>
      <div className="error-text" role="alert">
        {error}
      </div>
      <div className="flex" style={{ gap: 8 }}>
        <button className="button primary" disabled={busy || drawing} onClick={submit}>
          {busy ? 'جارٍ الإرسال…' : 'إرسال طلب النقل'}
        </button>
        <button className="button" disabled={busy} onClick={onClose}>
          إلغاء
        </button>
      </div>
      <p className="micro muted" style={{ marginTop: 10 }}>
        المسار: موافقة الجهة الطالبة ← دراسة الاكتمال ← الدراسة والقرار ← تنفيذ النقل ← الإغلاق.
      </p>
    </aside>
  );
}
