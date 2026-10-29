import { useEffect, useRef, useState } from 'react';
import L from '../../lib/leaflet';
import { api, type ApiError } from '../../api/client';
import type { GeoJsonGeometry, GeometryCheck, SiteDetail } from '../../api/types';
import { formatArea } from '../../lib/mapState';

type Ring = [number, number][]; // [lng, lat] (GeoJSON order)
type Shape = { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] };

let geoman: Promise<unknown> | null = null;
/** Leaflet-Geoman Free (MIT), loaded on first use. Only free features are used: draw polygon, edit vertices. */
function loadGeoman() {
  if (!geoman) geoman = Promise.all([import('@geoman-io/leaflet-geoman-free'), import('@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css')]);
  return geoman;
}

function polygons(s: Shape | null): Ring[][] {
  if (!s) return [];
  return s.type === 'Polygon' ? [s.coordinates] : s.coordinates;
}

function fromPolygons(p: Ring[][]): Shape | null {
  const parts = p.filter((x) => x.length && x[0].length >= 4);
  if (!parts.length) return null;
  return parts.length === 1 ? { type: 'Polygon', coordinates: parts[0] } : { type: 'MultiPolygon', coordinates: parts };
}

function close(r: Ring): Ring {
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) return [...r, r[0]];
  return r;
}

/** Outer ring without the repeated closing vertex (what the vertex table edits). */
function open(r: Ring): Ring {
  return r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r;
}

const round = (v: number) => Math.round(v * 1e7) / 1e7;

/**
 * «تحرير سجل الموقع»: an explicit, separate mode for an authorised facility manager. Drawing is click by click, vertices
 * can be dragged or typed in the table (no drag is required), every change can be undone, and «إلغاء» discards
 * everything — nothing reaches the server until «حفظ إصدار جديد», which is refused if the boundary changed meanwhile.
 */
export function BoundaryEditor({
  map,
  site,
  onDone,
  onCancel,
}: {
  map: L.Map;
  site: SiteDetail;
  onDone: (version: number) => void;
  onCancel: () => void;
}) {
  const startVersion = site.geometryVersion ?? 0;
  const initial: Shape | null =
    site.geometry && site.geometry.type !== 'Point' ? (site.geometry.geojson as unknown as Shape) : null;
  const [shape, setShape] = useState<Shape | null>(initial);
  const [history, setHistory] = useState<(Shape | null)[]>([]);
  const [method, setMethod] = useState<'DRAWN' | 'COORDINATES'>('DRAWN');
  const [part, setPart] = useState(0);
  const [clickAdd, setClickAdd] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [check, setCheck] = useState<GeometryCheck | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const layer = useRef<L.Polygon | null>(null);
  const pendingRef = useRef<Ring>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const shapeRef = useRef(shape);
  shapeRef.current = shape;

  const change = (next: Shape | null, how: 'DRAWN' | 'COORDINATES') => {
    setHistory((h) => [...h.slice(-49), shapeRef.current]);
    setShape(next);
    setMethod(how);
    setCheck(null);
  };

  useEffect(() => {
    let live = true;
    loadGeoman()
      .then(() => {
        // the map existed before Geoman was loaded, so its init hook did not run for it
        const m = map as unknown as { pm?: unknown };
        if (!m.pm) m.pm = new (L as unknown as { PM: { Map: new (x: L.Map) => unknown } }).PM.Map(map);
        if (live) setReady(true);
      })
      .catch(() => live && setError('تعذر تحميل أدوات الرسم المحلية؛ استخدم إدخال الإحداثيات.'));
    return () => {
      live = false;
    };
  }, [map]);

  // draw the editable shape; Geoman edits update the state (and the vertex table)
  useEffect(() => {
    if (!ready) return;
    layer.current?.remove();
    layer.current = null;
    if (!shape) return;
    const latlngs = polygons(shape).map((poly) => poly.map((ring) => open(ring).map(([x, y]) => L.latLng(y, x))));
    const p = L.polygon(latlngs as never, { color: '#0d5d4e', weight: 3, fillOpacity: 0.15, dashArray: '6 4' }).addTo(map);
    try {
      (p as unknown as { pm?: { enable: (o: object) => void } }).pm?.enable({ allowSelfIntersection: false, draggable: false, snappable: false });
    } catch {
      setError('تعذر تفعيل سحب الرؤوس؛ عدّل الرؤوس من الجدول.');
    }
    p.on('pm:edit', () => {
      const g = p.toGeoJSON().geometry as unknown as Shape;
      change(
        g.type === 'Polygon'
          ? { type: 'Polygon', coordinates: g.coordinates.map((r) => close(r.map(([x, y]) => [round(x), round(y)] as [number, number]))) }
          : { type: 'MultiPolygon', coordinates: g.coordinates.map((pp) => pp.map((r) => close(r.map(([x, y]) => [round(x), round(y)] as [number, number])))) },
        'DRAWN',
      );
    });
    layer.current = p;
    return () => {
      p.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, shape]);

  // click-to-add vertices (alternative to drawing gestures): the first three clicks make a polygon, later clicks extend it
  useEffect(() => {
    if (!clickAdd) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      const pt: [number, number] = [round(e.latlng.lng), round(e.latlng.lat)];
      const cur = polygons(shapeRef.current).map((p) => p.map((r) => open(r)));
      if (!cur.length) {
        pendingRef.current = [...pendingRef.current, pt];
        setPendingCount(pendingRef.current.length);
        if (pendingRef.current.length >= 3) {
          const ring = close(pendingRef.current);
          pendingRef.current = [];
          setPendingCount(0);
          change(fromPolygons([[ring]]), 'COORDINATES');
          setPart(0);
        }
        return;
      }
      const idx = cur[part] ? part : 0;
      cur[idx][0] = [...cur[idx][0], pt];
      change(fromPolygons(cur.map((p) => p.map(close))), 'COORDINATES');
    };
    map.on('click', onClick);
    map.getContainer().classList.add('adding-vertices');
    return () => {
      map.off('click', onClick);
      map.getContainer().classList.remove('adding-vertices');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clickAdd, part]);

  const startDraw = () => {
    const m = map as unknown as { pm?: { enableDraw: (s: string, o: object) => void; disableDraw: () => void } };
    if (!m.pm) return setError('أدوات الرسم غير جاهزة؛ استخدم إدخال الإحداثيات أو إضافة الرؤوس بالنقر.');
    setDrawing(true);
    m.pm.enableDraw('Polygon', { snappable: false, allowSelfIntersection: false, finishOn: null });
    map.once('pm:create', (e: L.LeafletEvent) => {
      const created = (e as unknown as { layer: L.Polygon }).layer;
      const g = created.toGeoJSON().geometry as unknown as { coordinates: [number, number][][] };
      created.remove();
      setDrawing(false);
      const ring = close(g.coordinates[0].map(([x, y]) => [round(x), round(y)] as [number, number]));
      const existing = polygons(shapeRef.current);
      change(fromPolygons([...existing, [ring]]), 'DRAWN');
      setPart(existing.length);
    });
  };
  const stopDraw = () => {
    (map as unknown as { pm?: { disableDraw: () => void } }).pm?.disableDraw();
    setDrawing(false);
  };

  useEffect(
    () => () => {
      (map as unknown as { pm?: { disableDraw: () => void } }).pm?.disableDraw();
      layer.current?.remove();
    },
    [map],
  );

  const undo = () => {
    if (pendingRef.current.length) {
      pendingRef.current = pendingRef.current.slice(0, -1);
      setPendingCount(pendingRef.current.length);
      return;
    }
    setHistory((h) => {
      if (!h.length) return h;
      setShape(h[h.length - 1]);
      setCheck(null);
      return h.slice(0, -1);
    });
  };

  const parts = polygons(shape);
  const outer = parts[part] ? open(parts[part][0]) : [];
  const setVertex = (i: number, axis: 0 | 1, value: number) => {
    if (!Number.isFinite(value)) return;
    const cur = parts.map((p) => p.map((r) => open(r).map((v) => [...v] as [number, number])));
    cur[part][0][i][axis] = value;
    change(fromPolygons(cur.map((p) => p.map(close))), 'COORDINATES');
  };
  const removeVertex = (i: number) => {
    const cur = parts.map((p) => p.map((r) => open(r)));
    if (cur[part][0].length <= 3) return setError('المضلع يحتاج ثلاثة رؤوس على الأقل.');
    cur[part][0] = cur[part][0].filter((_, j) => j !== i);
    change(fromPolygons(cur.map((p) => p.map(close))), 'COORDINATES');
  };
  const insertAfter = (i: number) => {
    const cur = parts.map((p) => p.map((r) => open(r)));
    const ring = cur[part][0];
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    ring.splice(i + 1, 0, [round((a[0] + b[0]) / 2), round((a[1] + b[1]) / 2)]);
    change(fromPolygons(cur.map((p) => p.map(close))), 'COORDINATES');
  };
  const removePart = () => {
    const cur = parts.filter((_, j) => j !== part);
    change(fromPolygons(cur), 'DRAWN');
    setPart(0);
  };

  const [paste, setPaste] = useState('');
  const applyPaste = () => {
    // one vertex per line: «خط العرض، خط الطول» (lat, lng) as people usually read coordinates
    const pts: [number, number][] = [];
    for (const line of paste.split(/\n+/)) {
      const m = line.trim().split(/[\s,،;]+/).filter(Boolean).map(Number);
      if (!m.length) continue;
      if (m.length < 2 || !m.every(Number.isFinite)) return setError('سطر غير صالح: «' + line.trim() + '». اكتب خط العرض ثم خط الطول.');
      pts.push([round(m[1]), round(m[0])]);
    }
    if (pts.length < 3) return setError('أدخل ثلاثة رؤوس على الأقل.');
    setError('');
    change(fromPolygons([...parts, [close(pts)]]), 'COORDINATES');
    setPart(parts.length);
    setPaste('');
  };

  const validate = async () => {
    if (!shape) return setError('ارسم الحدود أو أدخل الرؤوس أولاً.');
    setBusy(true);
    setError('');
    try {
      setCheck(await api.validateGeometry(site.id, shape as GeoJsonGeometry, 'EPSG:4326'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!shape) return setError('لا توجد حدود للحفظ.');
    if (reason.trim().length < 5) return setError('اكتب سبب التغيير (5 أحرف على الأقل).');
    setBusy(true);
    setError('');
    try {
      const v = await api.saveGeometry(site.id, { geometry: shape as GeoJsonGeometry, crs: 'EPSG:4326', expectedVersion: startVersion, reason: reason.trim(), method });
      onDone(v.version);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'GEOMETRY_STALE' ? err.message + ' استخدم «إلغاء» ثم افتح التحرير من جديد.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="card boundary-editor" aria-label={'تحرير حدود ' + site.name}>
      <div className="flex spread">
        <span className="eyebrow">EDIT SITE RECORD / {site.code}</span>
        <span className="pill">من الإصدار {startVersion}</span>
      </div>
      <h3>تحرير سجل الموقع — حدود «{site.name}»</h3>
      <p className="micro muted">
        النظام EPSG:4326، والإحداثيات تحفظ بترتيب GeoJSON (خط الطول، خط العرض). اختيار الموقع أو تحريك الخريطة لا يغيّر سجله؛ التغيير يحدث هنا فقط.
      </p>
      {!ready && <p className="micro muted">جارٍ تحميل أدوات الرسم المحلية…</p>}
      <div className="editor-tools">
        <button className="button compact" onClick={drawing ? stopDraw : startDraw} disabled={!ready || clickAdd}>
          {drawing ? 'إيقاف الرسم' : shape ? 'رسم جزء إضافي' : 'رسم الحدود بالنقر'}
        </button>
        <button className={'button compact ' + (clickAdd ? 'primary' : '')} onClick={() => setClickAdd((v) => !v)} disabled={drawing} aria-pressed={clickAdd}>
          {clickAdd ? 'إنهاء إضافة الرؤوس' : 'إضافة رأس بالنقر على الخريطة'}
        </button>
        <button className="button compact" onClick={undo} disabled={!history.length && !pendingCount}>
          تراجع
        </button>
        {shape && (
          <button className="button compact ghost" onClick={() => (change(null, 'DRAWN'), setPart(0))} disabled={drawing}>
            البدء برسم جديد
          </button>
        )}
      </div>
      {!shape && initial && <p className="micro note">ستحل الحدود الجديدة محل الإصدار الحالي عند الحفظ؛ «تراجع» يعيد الحدود الحالية.</p>}
      {drawing && <p className="micro note">انقر على الخريطة لإضافة كل رأس، ثم انقر الرأس الأول لإغلاق المضلع.</p>}
      {clickAdd && <p className="micro note">كل نقرة تضيف رأساً إلى نهاية الحد الخارجي للجزء {part + 1}{pendingCount ? ' (' + pendingCount + ' رأس — يكتمل المضلع عند الثالث)' : ''}.</p>}

      {parts.length > 1 && (
        <label className="field">
          <span>الجزء المعروض في الجدول</span>
          <select value={part} onChange={(e) => setPart(Number(e.target.value))}>
            {parts.map((_, i) => (
              <option key={i} value={i}>
                الجزء {i + 1}
              </option>
            ))}
          </select>
        </label>
      )}
      {outer.length > 0 && (
        <div className="vertex-table" role="table" aria-label="رؤوس الحد الخارجي">
          <div role="row" className="vertex-head">
            <span>#</span>
            <span>خط العرض</span>
            <span>خط الطول</span>
            <span />
          </div>
          {outer.map(([x, y], i) => (
            <div role="row" key={part + '-' + i + '-' + x + '-' + y}>
              <span>{i + 1}</span>
              <input type="number" step="0.000001" defaultValue={y} aria-label={'خط عرض الرأس ' + (i + 1)} onBlur={(e) => Number(e.target.value) !== y && setVertex(i, 1, Number(e.target.value))} />
              <input type="number" step="0.000001" defaultValue={x} aria-label={'خط طول الرأس ' + (i + 1)} onBlur={(e) => Number(e.target.value) !== x && setVertex(i, 0, Number(e.target.value))} />
              <span className="vertex-actions">
                <button className="icon-button" onClick={() => insertAfter(i)} aria-label={'إضافة رأس بعد ' + (i + 1)}>
                  ＋
                </button>
                <button className="icon-button" onClick={() => removeVertex(i)} aria-label={'حذف الرأس ' + (i + 1)}>
                  −
                </button>
              </span>
            </div>
          ))}
          {parts.length > 1 && (
            <button className="button compact ghost" onClick={removePart}>
              حذف الجزء {part + 1}
            </button>
          )}
        </div>
      )}
      <label className="field">
        <span>إدخال رؤوس بالإحداثيات — سطر لكل رأس: خط العرض، خط الطول</span>
        <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'25.2051, 55.2701\n25.2058, 55.2722\n25.2040, 55.2730'} />
        <button className="button compact" onClick={applyPaste} disabled={!paste.trim()}>
          إضافة كجزء من الحدود
        </button>
      </label>

      {check && (
        <div className={'note ' + (check.valid ? '' : 'red')} role="status">
          {check.valid
            ? 'الحدود صالحة · ' + (check.type === 'MultiPolygon' ? 'عدة أجزاء' : 'مضلع') + ' · ' + check.vertices + ' رأس · المساحة ' + formatArea(check.areaM2)
            : check.problems.join(' · ')}
        </div>
      )}
      <label className="field">
        <span>سبب التغيير</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: تحديث الحدود وفق مخطط الصيانة المعتمد" />
      </label>
      <div className="error-text" role="alert">
        {error}
      </div>
      <div className="editor-actions">
        <button className="button" onClick={validate} disabled={busy || !shape}>
          تحقق من الحدود
        </button>
        <button className="button primary" onClick={save} disabled={busy || !shape}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ إصدار جديد'}
        </button>
        <button className="button ghost" onClick={onCancel} disabled={busy}>
          إلغاء دون حفظ
        </button>
      </div>
    </aside>
  );
}
