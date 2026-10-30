import { useEffect, useMemo, useRef, useState } from 'react';
import L from '../../lib/leaflet';
import { api, isAbort, newIdempotencyKey } from '../../api/client';
import type { GeoJsonGeometry, MapFeature, PlacementAction, PlacementCheck, PlacementUnit, Relocation, StationLevel } from '../../api/types';
import { useApp } from '../../lib/app';
import { addDays, dubaiISO, fullDate, localDay, todayDubai } from '../../lib/dates';
import { ensureGeoman } from '../../lib/geoman';
import { circle, clampToRange, destination, distanceM, formatKm, pointInGeometry, translate, type LatLng } from '../../lib/geo';
import { featureAnchor } from '../map/MapCanvas';
import { OrgSymbol } from '../UnitSymbol';

export type StationLayers = { range: boolean; occupied: boolean; symbols: boolean; sites: boolean };

type Pm = { enableDraw: (shape: string, o: object) => void; disableDraw: () => void };

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/**
 * «طلب تمركز / إعادة تمركز» docked beside the map (ADR-025). The person chooses the kind (premises, or a temporary work
 * area), the level (main or branch premises), the duration and the organisations the change covers, then drags a
 * proposed marker away from the current premises. Distance to the current premises, the configured allowed range and
 * every occupied registered site are shown live; a point outside the range or on an occupied site cannot be confirmed.
 * The proposal is saved as a relocation request (draft or submitted for approval) and never moves the current site's
 * marker or changes the site register — the server checks the rule and the occupancy again at save, submission and
 * approval.
 */
export function StationingPanel({
  map,
  org,
  site,
  features,
  layers,
  pickedSite,
  reopen,
  measuring = false,
  onPeriod,
  onClose,
  onSaved,
}: {
  map: L.Map | null;
  org: { id: string; name: string };
  site: MapFeature;
  features: MapFeature[];
  layers: StationLayers;
  /** A registered site clicked on the map while placing (key changes on every click). */
  pickedSite: { siteId: string; key: number } | null;
  /** A saved draft opened again from the map (its request id and proposal). */
  reopen?: { requestId: string; relocation: Relocation; start: string | null; reason: string } | null;
  /** The distance tool owns map clicks while it is on. */
  measuring?: boolean;
  onPeriod: (p: { start: string; end: string | null }) => void;
  onClose: () => void;
  onSaved: (requestId: string, submitted: boolean) => void;
}) {
  const app = useApp();
  const from = useMemo(() => featureAnchor(site), [site]);
  const typeCode = app.requestTypes.find((t) => t.kind === 'RELOCATION')?.code ?? null;
  const stages = app.requestTypes.find((t) => t.code === typeCode)?.workflowVersion?.stages ?? [];
  const rel = reopen?.relocation;

  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [action, setAction] = useState<PlacementAction>(rel?.action ?? 'RELOCATE');
  const [level, setLevel] = useState<StationLevel>(rel?.stationLevel ?? 'BRANCH');
  const [temporary, setTemporary] = useState(rel?.temporary ?? false);
  const [start, setStart] = useState(reopen?.start ? localDay(reopen.start) : addDays(todayDubai(), 14));
  const [end, setEnd] = useState(rel?.temporaryEnd ? localDay(rel.temporaryEnd) : addDays(todayDubai(), 104));
  const [units, setUnits] = useState<PlacementUnit[] | null>(null);
  const [included, setIncluded] = useState<Set<string> | null>(rel?.includedOrgs ? new Set(rel.includedOrgs.map((o) => o.id)) : null);
  const [point, setPoint] = useState<LatLng | null>(rel ? { lat: rel.centroid[0], lng: rel.centroid[1] } : null);
  const [footprint, setFootprint] = useState<GeoJsonGeometry | null>(rel && rel.geometry.type !== 'Point' ? rel.geometry : null);
  const [targetId, setTargetId] = useState<string | null>(rel?.targetSite?.id ?? null);
  const [check, setCheck] = useState<PlacementCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [live, setLive] = useState<{ d: number; clamped: 'MIN' | 'MAX' | null; busy: string | null } | null>(null);
  const [latText, setLatText] = useState('');
  const [lngText, setLngText] = useState('');
  const [coordError, setCoordError] = useState('');
  const [drawing, setDrawing] = useState(false);
  const [name, setName] = useState(rel?.proposedName ?? '');
  const [reason, setReason] = useState(reopen?.reason ?? '');
  const [requestId, setRequestId] = useState<string | null>(reopen?.requestId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [moved, setMoved] = useState(!!rel);
  const submitKey = useRef(newIdempotencyKey());

  const rule = check?.rule ?? null;
  const period = { start: dubaiISO(start), end: temporary ? dubaiISO(end) : null };
  const periodOk = !temporary || end > start;

  useEffect(() => onPeriod(period), [start, end, temporary]); // eslint-disable-line react-hooks/exhaustive-deps

  // organisations covered by the change: the organisation and its branches, marked whether each is at this site now
  useEffect(() => {
    let alive = true;
    api
      .placementUnits(org.id, site.siteId)
      .then((u) => {
        if (!alive) return;
        setUnits(u);
        // default: only the branches that are at this site; a branch elsewhere is never moved without choosing it
        setIncluded((cur) => cur ?? new Set(u.filter((x) => x.depth > 0 && x.atSite).map((x) => x.id)));
      })
      .catch((e: Error) => alive && (setUnits([]), setError(e.message)));
    return () => {
      alive = false;
    };
  }, [org.id, site.siteId]);

  const geometry: GeoJsonGeometry | null = footprint ?? (point ? { type: 'Point', coordinates: [point.lng, point.lat] } : null);
  const includedList = [...(included ?? [])];

  // server check (debounced, superseded requests cancelled); the first one also tells the rule for the initial point
  useEffect(() => {
    if (!from) return;
    const g: GeoJsonGeometry = geometry ?? { type: 'Point', coordinates: [from.lng, from.lat] };
    const ctl = new AbortController();
    setChecking(true);
    const t = window.setTimeout(() => {
      api
        .placementCheck(
          {
            action,
            organizationId: org.id,
            fromSiteId: site.siteId,
            stationLevel: action === 'RELOCATE' ? level : undefined,
            geometry: g,
            targetSiteId: targetId,
            start: period.start,
            end: period.end,
            excludeRequestId: requestId ?? undefined,
            includedOrgIds: includedList,
          },
          ctl.signal,
        )
        .then((c) => {
          setCheckError(null);
          if (!geometry) {
            // nothing placed yet: put the proposal in the middle of the allowed range, ready to be dragged
            const min = c.rule?.minM ?? 0;
            const max = c.rule?.maxM ?? Math.max(min + 2000, 2000);
            setPoint(destination(from, 60, (min + max) / 2));
            return;
          }
          setCheck(c);
        })
        .catch((e) => !isAbort(e) && setCheckError((e as Error).message))
        .finally(() => !ctl.signal.aborted && setChecking(false));
    }, 220);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(geometry), action, level, targetId, period.start, period.end, includedList.join(','), from?.lat, from?.lng]);

  useEffect(() => {
    if (point) {
      setLatText(point.lat.toFixed(6));
      setLngText(point.lng.toFixed(6));
    }
  }, [point?.lat, point?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // occupied registered sites in the proposal period (from the map layer for the same period)
  const busySites = useMemo(() => features.filter((f) => f.availability === 'BUSY' && f.siteId !== site.siteId), [features, site.siteId]);
  const busyAt = (p: LatLng): string | null => busySites.find((f) => f.boundary && pointInGeometry(p, f.boundary.geojson))?.name ?? null;

  // ---- map: static context (range, current premises, occupied sites) ----
  useEffect(() => {
    if (!map || !from) return;
    const g = L.layerGroup().addTo(map);
    if (layers.range && rule && rule.measure === 'CENTER') {
      const outer = rule.maxM != null ? circle(from, rule.maxM) : null;
      const inner = rule.minM > 0 ? circle(from, rule.minM) : null;
      if (outer) {
        L.polygon(inner ? [outer, inner] : [outer], {
          color: '#1f9d55',
          weight: 2,
          dashArray: '8 6',
          fillColor: '#2bb36a',
          fillOpacity: 0.16,
          interactive: false,
        }).addTo(g);
        const top = destination(from, 0, rule.maxM!);
        L.marker([top.lat, top.lng], {
          interactive: false,
          icon: L.divIcon({ className: 'stw-range-tag', html: '<span>النطاق المسموح ' + esc(formatKm(rule.minM)) + ' – ' + esc(formatKm(rule.maxM!)) + '</span>', iconSize: [0, 0] }),
        }).addTo(g);
      }
      if (inner) L.polyline(inner, { color: '#c0392b', weight: 1.5, dashArray: '4 6', interactive: false }).addTo(g);
    }
    if (layers.occupied) {
      for (const f of busySites) {
        const at = featureAnchor(f);
        if (f.boundary) {
          L.geoJSON(f.boundary.geojson as never, {
            interactive: false,
            style: { color: '#c0392b', weight: 2, fillColor: '#e74c3c', fillOpacity: 0.35 },
          } as L.GeoJSONOptions).addTo(g);
        }
        if (at)
          L.marker(at, {
            interactive: false,
            zIndexOffset: -200,
            icon: L.divIcon({ className: 'stw-busy-tag', html: '<span><i>⊘</i> موقع محجوز</span>', iconSize: [0, 0] }),
          }).addTo(g);
      }
    }
    L.marker(from, {
      interactive: false,
      zIndexOffset: 800,
      icon: L.divIcon({ className: 'stw-current', html: '<span class="stw-pin blue"><i>▣</i></span><span class="stw-pin-label">' + esc(site.name) + ' · المقر الحالي</span>', iconSize: [0, 0] }),
    }).addTo(g);
    return () => {
      g.remove();
    };
  }, [map, from?.lat, from?.lng, rule?.id, rule?.minM, rule?.maxM, rule?.measure, layers.range, layers.occupied, busySites, site.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- map: the draggable proposal, the line to the current premises and the live distance ----
  const dyn = useRef<{ marker: L.Marker; line: L.Polyline; tag: L.Marker; bubble: L.Marker; shape: L.GeoJSON | null } | null>(null);
  const stateRef = useRef({ rule, footprint, step, measuring });
  stateRef.current = { rule, footprint, step, measuring };

  const okNow = !!check && check.ok && !checking && !!point;
  const statusClass = !point ? '' : checking ? 'pending' : okNow ? 'ok' : 'bad';

  const bubbleHtml = (d: number, blockedBy: string | null) => {
    const r = stateRef.current.rule;
    const inRange = !r || ((d >= r.minM) && (r.maxM == null || d <= r.maxM));
    const free = !blockedBy && !(check && check.conflicts.some((c) => c.blocking) && !checking);
    return (
      '<div class="stw-bubble"><b>الموقع الجديد</b>' +
      '<span class="' + (inRange ? 'y' : 'n') + '">' + (inRange ? '✓ ضمن النطاق المسموح' : '✕ خارج النطاق المسموح') + '</span>' +
      '<span class="' + (free ? 'y' : 'n') + '">' + (free ? '✓ الموقع متاح' : '✕ موقع محجوز') + '</span></div>'
    );
  };

  useEffect(() => {
    if (!map || !from || !point) return;
    const markerIcon = L.divIcon({ className: 'stw-proposal', html: '<span class="stw-pin green"><i>⌖</i></span>', iconSize: [0, 0] });
    const marker = L.marker([point.lat, point.lng], { draggable: true, autoPan: true, zIndexOffset: 1200, icon: markerIcon, keyboard: true, title: 'الموقع المقترح — اسحب لتغيير الموقع' }).addTo(map);
    const line = L.polyline([from, [point.lat, point.lng]], { color: '#16324f', weight: 2.2, dashArray: '6 6', interactive: false }).addTo(map);
    const tag = L.marker([(from.lat + point.lat) / 2, (from.lng + point.lng) / 2], { interactive: false, icon: L.divIcon({ className: 'stw-dist', html: '', iconSize: [0, 0] }) }).addTo(map);
    const bubble = L.marker([point.lat, point.lng], { interactive: false, zIndexOffset: 1300, icon: L.divIcon({ className: 'stw-bubble-wrap', html: '', iconSize: [0, 0] }) }).addTo(map);
    dyn.current = { marker, line, tag, bubble, shape: null };
    let last = L.latLng(point.lat, point.lng);
    marker.on('drag', () => {
      let p = marker.getLatLng();
      const r = stateRef.current.rule;
      let clamped: 'MIN' | 'MAX' | null = null;
      if (r && r.measure === 'CENTER') {
        const c = clampToRange(from, p, r.minM, r.maxM);
        clamped = c.clamped;
        if (c.clamped) {
          p = L.latLng(c.point.lat, c.point.lng);
          marker.setLatLng(p);
        }
      }
      const shape = dyn.current?.shape;
      if (shape) {
        const dLat = p.lat - last.lat;
        const dLng = p.lng - last.lng;
        shape.eachLayer((l) => {
          const poly = l as L.Polygon;
          const move = (ll: unknown): unknown => (Array.isArray(ll) ? ll.map(move) : L.latLng((ll as L.LatLng).lat + dLat, (ll as L.LatLng).lng + dLng));
          poly.setLatLngs(move(poly.getLatLngs()) as L.LatLng[]);
        });
      }
      last = p;
      const d = distanceM(from, p);
      line.setLatLngs([from, p]);
      tag.setLatLng([(from.lat + p.lat) / 2, (from.lng + p.lng) / 2]);
      bubble.setLatLng(p);
      const blocked = busyAt(p);
      setLive({ d, clamped, busy: blocked });
    });
    marker.on('dragstart', () => setTargetId(null));
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      const fp = stateRef.current.footprint;
      if (fp) setFootprint(translate(fp, p.lat - point.lat, p.lng - point.lng));
      setMoved(true);
      setPoint({ lat: p.lat, lng: p.lng });
    });
    return () => {
      marker.remove();
      line.remove();
      tag.remove();
      bubble.remove();
      dyn.current = null;
    };
    // the marker is rebuilt only when the point is set from outside a drag (initial, coordinates, a registered site)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, from?.lat, from?.lng, point?.lat, point?.lng]);

  // keep the marker's colour, the distance chip and the bubble in step with the latest check
  const shownD = live?.d ?? (point && from ? distanceM(from, point) : 0);
  useEffect(() => {
    const x = dyn.current;
    if (!x || !point) return;
    const el = x.marker.getElement();
    el?.classList.toggle('bad', statusClass === 'bad');
    el?.classList.toggle('ok', statusClass === 'ok');
    const r = rule;
    const inRange = !r || (shownD >= r.minM && (r.maxM == null || shownD <= r.maxM));
    x.tag.setIcon(L.divIcon({ className: 'stw-dist ' + (inRange ? '' : 'bad'), html: '<span>' + esc(formatKm(shownD)) + '</span>', iconSize: [0, 0] }));
    x.bubble.setIcon(L.divIcon({ className: 'stw-bubble-wrap', html: bubbleHtml(shownD, live?.busy ?? null), iconSize: [0, 0] }));
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // the drawn footprint of the proposal (optional for premises, required for a work area)
  useEffect(() => {
    if (!map || !footprint) return;
    const shape = L.geoJSON(footprint as never, { interactive: false, style: { color: '#1f9d55', weight: 2.5, dashArray: '6 5', fillColor: '#1f9d55', fillOpacity: 0.15 } }).addTo(map);
    if (dyn.current) dyn.current.shape = shape;
    return () => {
      if (dyn.current?.shape === shape) dyn.current.shape = null;
      shape.remove();
    };
  }, [map, footprint]);

  // reset live drag feedback once the server has answered for the dropped point
  useEffect(() => {
    if (!checking) setLive(null);
  }, [checking]);

  // an empty map click while editing places the proposal there; a registered site clicked on the map is chosen as target
  useEffect(() => {
    if (!map) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      if (stateRef.current.step !== 'edit' || stateRef.current.measuring || drawingRef.current) return;
      const fp = stateRef.current.footprint;
      setTargetId(null);
      setMoved(true);
      setPoint((cur) => {
        if (fp && cur) setFootprint(translate(fp, e.latlng.lat - cur.lat, e.latlng.lng - cur.lng));
        return { lat: e.latlng.lat, lng: e.latlng.lng };
      });
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map]);
  const drawingRef = useRef(false);
  drawingRef.current = drawing;

  useEffect(() => {
    if (!pickedSite || step !== 'edit') return;
    chooseSite(pickedSite.siteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedSite?.key]);

  useEffect(
    () => () => {
      (map as unknown as { pm?: Pm } | null)?.pm?.disableDraw();
    },
    [map],
  );

  const candidates = useMemo(
    () =>
      features
        .filter((f) => f.siteId !== site.siteId && featureAnchor(f))
        .map((f) => ({ f, d: from ? distanceM(from, featureAnchor(f)!) : 0 }))
        .sort((a, b) => a.d - b.d),
    [features, site.siteId, from],
  );

  function chooseSite(id: string) {
    const f = features.find((x) => x.siteId === id);
    if (!f || f.siteId === site.siteId) return;
    const at = featureAnchor(f);
    if (!at) return;
    setTargetId(f.siteId);
    setFootprint(null);
    setMoved(true);
    setPoint({ lat: at.lat, lng: at.lng });
    if (!name) setName(f.name);
  }

  const applyCoords = () => {
    const lat = Number(latText);
    const lng = Number(lngText);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return setCoordError('أدخل خط عرض بين −90 و90 وخط طول بين −180 و180.');
    }
    setCoordError('');
    setTargetId(null);
    setMoved(true);
    if (footprint && point) setFootprint(translate(footprint, lat - point.lat, lng - point.lng));
    setPoint({ lat, lng });
    map?.panTo([lat, lng]);
  };

  const drawArea = async () => {
    if (!map) return;
    try {
      await ensureGeoman(map);
    } catch {
      return setError('تعذر تحميل أدوات الرسم المحلية.');
    }
    const pm = (map as unknown as { pm?: Pm }).pm;
    if (!pm) return;
    setError('');
    setDrawing(true);
    pm.enableDraw('Rectangle', { snappable: false });
    map.once('pm:create', (e: L.LeafletEvent) => {
      const created = (e as unknown as { layer: L.Polygon }).layer;
      const g = created.toGeoJSON().geometry as unknown as GeoJsonGeometry;
      const c = created.getBounds().getCenter();
      created.remove();
      setDrawing(false);
      setTargetId(null);
      setFootprint(g);
      setMoved(true);
      setPoint({ lat: c.lat, lng: c.lng });
    });
  };

  // ---- persistence: the proposal is a relocation request (draft, or submitted for approval) ----
  const resource = site.resources.find((r) => !r.parentResourceId) ?? site.resources[0];
  const persist = async (): Promise<string> => {
    if (!typeCode) throw new Error('لا يوجد نوع طلب «نقل مقر» منشور.');
    if (!resource) throw new Error('لا يوجد للمقر الحالي سجل مورد يرتبط به الطلب؛ يضيفه مسؤول المرافق.');
    if (!geometry) throw new Error('حدد الموقع المقترح على الخريطة.');
    const subject = (action === 'WORK_AREA' ? 'منطقة عمل مؤقتة — ' : 'تمركز ' + (level === 'MAIN' ? 'مقر رئيسي' : 'مقر فرعي') + ' — ') + org.name + ' — ' + (name.trim() || 'الموقع المقترح');
    const draft = { typeCode, origin: 'MAP' as const, ownerOrgId: org.id, resourceIds: [resource.id], subject, unit: 'DAYS' as const, period, values: { reason: reason.trim() } };
    let id = requestId;
    if (!id) {
      const d = await api.createRequest(draft);
      id = d.id;
      setRequestId(id);
    } else {
      const cur = await api.request(id);
      await api.updateDraft(id, { ...draft, typeCode: undefined, expectedVersion: cur.version });
    }
    await api.saveRelocation(id, {
      organizationId: org.id,
      includeDescendants: false,
      fromSiteId: site.siteId,
      proposedName: name.trim(),
      geometry,
      action,
      stationLevel: action === 'RELOCATE' ? level : undefined,
      temporary: action === 'WORK_AREA' || temporary,
      temporaryEnd: action === 'WORK_AREA' || temporary ? period.end : null,
      targetSiteId: targetId,
      includedOrgIds: includedList,
    });
    return id;
  };

  const validateReview = () => {
    if (name.trim().length < 2) return 'اكتب اسماً للموقع المقترح.';
    if (reason.trim().length < 10) return 'اكتب مبرر الطلب (10 أحرف على الأقل).';
    return '';
  };

  const saveDraft = async () => {
    const v = name.trim().length < 2 ? 'اكتب اسماً للموقع المقترح قبل الحفظ.' : '';
    if (v) return setError(v);
    setBusy(true);
    setError('');
    try {
      const id = await persist();
      app.toast('حُفظت مسودة الطلب؛ لم يتغير أي موقع فعلي.');
      app.bump();
      onSaved(id, false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const v = validateReview();
    if (v) return setError(v);
    setBusy(true);
    setError('');
    try {
      const id = await persist();
      const fresh = await api.request(id);
      const sent = await api.submit(id, fresh.version, undefined, submitKey.current);
      app.toast('أُرسل الطلب ' + sent.number + ' للاعتماد؛ لا يتغير الموقع الفعلي قبل الاعتماد والتفعيل.');
      app.bump();
      onSaved(id, true);
    } catch (e) {
      setError((e as Error).message);
      submitKey.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  };

  // ---- view ----
  const blocking = check?.conflicts.filter((c) => c.blocking) ?? [];
  const shared = check?.conflicts.filter((c) => !c.blocking && c.kind === 'SHARED') ?? [];
  const inRange = check ? check.range === 'IN_RANGE' || check.range === 'NO_RULE' : false;
  const canContinue = okNow && periodOk && !drawing && (action !== 'WORK_AREA' || !!footprint) && !!typeCode;
  const reasons: string[] = [];
  if (!point) reasons.push('ضع العلامة على الخريطة.');
  if (check && !check.ok) reasons.push(...check.messages);
  if (!periodOk) reasons.push('نهاية المدة يجب أن تكون بعد بدايتها.');
  if (action === 'WORK_AREA' && !footprint) reasons.push('ارسم حدود منطقة العمل على الخريطة.');
  if (!typeCode) reasons.push('لا يوجد نوع طلب «نقل مقر» منشور.');
  const unitsAtSite = units?.filter((u) => u.depth > 0) ?? [];
  const rangeText = rule ? formatKm(rule.minM) + ' – ' + (rule.maxM != null ? formatKm(rule.maxM) : 'دون حد أعلى') : null;

  if (step === 'review') {
    const incNames = unitsAtSite.filter((u) => included?.has(u.id)).map((u) => u.name);
    return (
      <aside className="stw-panel" aria-label="مراجعة الطلب">
        <header className="stw-panel-head">
          <h2>مراجعة الطلب</h2>
          <button className="stw-x" onClick={onClose} aria-label="إغلاق دون حفظ">✕</button>
        </header>
        <div className="stw-step-title"><span className="stw-num">5</span>مراجعة وإرسال الطلب</div>
        <dl className="stw-review">
          <dt>الجهة</dt>
          <dd className="with-symbol"><OrgSymbol orgId={org.id} size={18} />{org.name}</dd>
          <dt>المقر الحالي</dt>
          <dd>{site.name}</dd>
          <dt>نوع الإجراء</dt>
          <dd>{action === 'WORK_AREA' ? 'منطقة عمل مؤقتة' : 'تمركز — ' + (level === 'MAIN' ? 'مقر رئيسي' : 'مقر فرعي')}</dd>
          <dt>المدة</dt>
          <dd>{action === 'WORK_AREA' || temporary ? 'مؤقت: ' + fullDate(period.start) + ' ← ' + fullDate(period.end) : 'دائم من ' + fullDate(period.start)}</dd>
          <dt>الموقع المقترح</dt>
          <dd>
            {check?.targetSite ? 'موقع مسجل: ' + check.targetSite.name : 'موقع إداري جديد مقترح'}
            <small className="stw-mono">{point ? point.lat.toFixed(5) + ' , ' + point.lng.toFixed(5) : ''}</small>
          </dd>
          <dt>المسافة</dt>
          <dd>{check ? formatKm(check.distanceM) + (rangeText ? ' (المسموح ' + rangeText + ')' : ' — لا قاعدة مسافة مهيأة') : '—'}</dd>
          <dt>حالة الإشغال</dt>
          <dd>{blocking.length ? '✕ محجوز' : shared.length ? '✓ متاح (استخدام مشترك مسموح)' : '✓ متاح للفترة'}</dd>
          <dt>الجهات المشمولة</dt>
          <dd>{[org.name, ...incNames].join('، ')}</dd>
          <dt>مسار الاعتماد المتوقع</dt>
          <dd>{stages.length ? stages.map((s) => s.name).join(' ← ') : 'وفق التدفق المنشور'}{' ← التفعيل بعد الاعتماد'}</dd>
        </dl>
        <label className="stw-field">
          <span>اسم الموقع المقترح</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="مثال: المبنى الإداري الجديد" />
        </label>
        <label className="stw-field">
          <span>مبرر الطلب</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3} placeholder="لماذا يلزم هذا التمركز؟" />
        </label>
        <p className="stw-hint">لا يتغير الموقع الفعلي ولا سجل المواقع عند الإرسال؛ التفعيل بعد استيفاء الموافقات، ويعيد الخادم فحص المسافة والإشغال عند الإرسال والاعتماد.</p>
        <div className="stw-error" role="alert">{error}</div>
        <div className="stw-actions">
          <button className="stw-btn primary" disabled={busy} onClick={submit}>{busy ? 'جارٍ الإرسال…' : 'إرسال الطلب'}</button>
          <button className="stw-btn" disabled={busy} onClick={() => setStep('edit')}>تعديل</button>
        </div>
        <button className="stw-link" disabled={busy} onClick={saveDraft}>حفظ كمسودة دون إرسال</button>
      </aside>
    );
  }

  return (
    <aside className="stw-panel" aria-label="طلب تمركز / إعادة تمركز">
      <header className="stw-panel-head">
        <h2>طلب تمركز / إعادة تمركز</h2>
        <button className="stw-x" onClick={onClose} aria-label="إلغاء دون حفظ">✕</button>
      </header>
      <div className="stw-for">
        <OrgSymbol orgId={org.id} size={20} />
        <span><b>{org.name}</b><small>المقر الحالي: {site.name}</small></span>
      </div>

      <section className="stw-step">
        <div className="stw-step-title"><span className="stw-num">1</span>اختر نوع الطلب</div>
        <div className="stw-cards two" role="radiogroup" aria-label="نوع الطلب">
          <button role="radio" aria-checked={action === 'RELOCATE'} className={'stw-card ' + (action === 'RELOCATE' ? 'on' : '')} onClick={() => setAction('RELOCATE')}>
            <i className="stw-radio" /><span className="stw-card-ico">🏢</span><b>تمركز</b><small>نقل أو إضافة مقر</small>
          </button>
          <button role="radio" aria-checked={action === 'WORK_AREA'} className={'stw-card ' + (action === 'WORK_AREA' ? 'on' : '')} onClick={() => (setAction('WORK_AREA'), setTemporary(true))}>
            <i className="stw-radio" /><span className="stw-card-ico">⬚</span><b>منطقة عمل مؤقتة</b><small>تخصيص منطقة استخدام مؤقتة</small>
          </button>
        </div>
      </section>

      {action === 'RELOCATE' && (
        <section className="stw-step">
          <div className="stw-step-title"><span className="stw-num">2</span>حدد مستوى التمركز</div>
          <div className="stw-cards" role="radiogroup" aria-label="مستوى التمركز">
            <button role="radio" aria-checked={level === 'MAIN'} className={'stw-card row ' + (level === 'MAIN' ? 'on' : '')} onClick={() => setLevel('MAIN')}>
              <i className="stw-radio" /><span className="stw-card-ico">🏛</span><span><b>مقر رئيسي</b><small>يصبح المقر الأساسي للجهة بعد الاعتماد</small></span>
            </button>
            <button role="radio" aria-checked={level === 'BRANCH'} className={'stw-card row ' + (level === 'BRANCH' ? 'on' : '')} onClick={() => setLevel('BRANCH')}>
              <i className="stw-radio" /><span className="stw-card-ico">🏬</span><span><b>مقر فرعي</b><small>إضافة موقع فرعي مع بقاء المقر الرئيسي</small></span>
            </button>
          </div>
        </section>
      )}

      <section className="stw-step">
        <div className="stw-step-title"><span className="stw-num">{action === 'RELOCATE' ? 3 : 2}</span>حدد المدة</div>
        <div className="stw-cards" role="radiogroup" aria-label="المدة">
          {action === 'RELOCATE' && (
            <button role="radio" aria-checked={!temporary} className={'stw-card row ' + (!temporary ? 'on' : '')} onClick={() => setTemporary(false)}>
              <i className="stw-radio" /><span className="stw-card-ico">∞</span><span><b>دائم</b><small>مستمر حتى يتم تغييره</small></span>
            </button>
          )}
          <button role="radio" aria-checked={temporary} className={'stw-card row ' + (temporary ? 'on' : '')} onClick={() => setTemporary(true)}>
            <i className="stw-radio" /><span className="stw-card-ico">📅</span><span><b>مؤقت</b><small>لفترة محددة ثم العودة إلى المقر الأصلي بعد الاعتماد</small></span>
          </button>
        </div>
        <div className="stw-dates">
          <label>
            <span>{temporary ? 'من' : 'تاريخ التفعيل المطلوب'}</span>
            <input type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} />
          </label>
          {temporary && (
            <label>
              <span>إلى</span>
              <input type="date" value={end} onChange={(e) => e.target.value && setEnd(e.target.value)} />
            </label>
          )}
        </div>
        {!periodOk && <p className="stw-error">نهاية المدة يجب أن تكون بعد بدايتها.</p>}
      </section>

      <section className="stw-step">
        <div className="stw-step-title"><span className="stw-num">{action === 'RELOCATE' ? 4 : 3}</span>الجهات المشمولة</div>
        <label className="stw-check locked">
          <input type="checkbox" checked readOnly disabled />
          <span><b>{org.name}</b><small>الجهة المختارة</small></span>
        </label>
        {units === null && <p className="stw-hint">جارٍ تحميل الأقسام التابعة…</p>}
        {units && unitsAtSite.length === 0 && <p className="stw-hint">لا أقسام تابعة ظاهرة لك.</p>}
        <div className="stw-units">
          {unitsAtSite.map((u) => (
            <label key={u.id} className="stw-check" style={{ paddingInlineStart: 6 + (u.depth - 1) * 14 }}>
              <input
                type="checkbox"
                checked={included?.has(u.id) ?? false}
                onChange={(e) =>
                  setIncluded((cur) => {
                    const next = new Set(cur ?? []);
                    if (e.target.checked) next.add(u.id);
                    else next.delete(u.id);
                    return next;
                  })
                }
              />
              <span>
                <b>{u.name}</b>
                <small>{u.atSite ? 'في المقر الحالي' : 'في مقر آخر' + (u.otherSites?.length ? ': ' + u.otherSites.map((s) => s.name).join('، ') : '')}</small>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="stw-step">
        <div className="stw-step-title"><span className="stw-num">{action === 'RELOCATE' ? 5 : 4}</span>اختر الموقع على الخريطة</div>
        <ul className="stw-conds" aria-live="polite">
          <li className={moved ? 'y' : ''}>{action === 'WORK_AREA' ? 'ارسم منطقة العمل ثم اسحبها أو اسحب علامتها' : 'اسحب العلامة الخضراء إلى الموقع المطلوب، أو انقر على الخريطة'}</li>
          <li className={!check ? '' : inRange ? 'y' : 'n'}>
            {rangeText ? 'يجب أن يكون ضمن النطاق المسموح (' + rangeText + ')' : 'لا توجد قاعدة مسافة مهيأة لهذا الإجراء'}
          </li>
          <li className={!check ? '' : blocking.length ? 'n' : 'y'}>لا يمكن اختيار موقع محجوز (يظهر باللون الأحمر)</li>
        </ul>
        <div className={'stw-live ' + statusClass}>
          <span>المسافة من المقر الحالي</span>
          <b>{point ? formatKm(shownD) : '—'}</b>
          {live?.clamped === 'MAX' && <em>وصلت إلى الحد الأقصى المسموح</em>}
          {live?.clamped === 'MIN' && <em>لا يمكن الاقتراب أكثر من الحد الأدنى</em>}
          {live?.busy && <em className="n">فوق موقع محجوز: {live.busy}</em>}
          {!live && checking && point && <em>جارٍ التحقق من الخادم…</em>}
        </div>
        {check && !checking && check.messages.length > 0 && (
          <ul className="stw-msgs" role="alert">
            {check.messages.map((m) => <li key={m}>{m}</li>)}
          </ul>
        )}
        {check && !checking && shared.map((c) => <p key={c.label} className="stw-hint">ℹ {c.message}</p>)}
        {check?.otherProposals ? <p className="stw-hint">ℹ يوجد {check.otherProposals} مقترح آخر قيد المراجعة في الموقع نفسه.</p> : null}
        {checkError && <p className="stw-error">{checkError}</p>}

        {action === 'WORK_AREA' && (
          <div className="stw-row">
            <button className="stw-btn small" disabled={drawing} onClick={drawArea}>{footprint ? 'إعادة رسم منطقة العمل' : 'ارسم منطقة العمل (مستطيل)'}</button>
            {drawing && <button className="stw-btn small ghost" onClick={() => ((map as unknown as { pm?: Pm } | null)?.pm?.disableDraw(), setDrawing(false))}>إلغاء الرسم</button>}
          </div>
        )}

        <details className="stw-more">
          <summary>إدخال الإحداثيات أو اختيار موقع مسجل</summary>
          <div className="stw-coords">
            <label><span>خط العرض</span><input inputMode="decimal" value={latText} onChange={(e) => setLatText(e.target.value)} aria-label="خط العرض" /></label>
            <label><span>خط الطول</span><input inputMode="decimal" value={lngText} onChange={(e) => setLngText(e.target.value)} aria-label="خط الطول" /></label>
            <button className="stw-btn small" onClick={applyCoords}>تطبيق</button>
          </div>
          {coordError && <p className="stw-error">{coordError}</p>}
          <label className="stw-field">
            <span>موقع مسجل في نافذة العرض</span>
            <select value={targetId ?? ''} onChange={(e) => (e.target.value ? chooseSite(e.target.value) : setTargetId(null))}>
              <option value="">— موقع إداري جديد مقترح —</option>
              {candidates.map(({ f, d }) => (
                <option key={f.siteId} value={f.siteId}>
                  {f.name} — {formatKm(d)} — {f.availability === 'BUSY' ? 'محجوز' : f.availability === 'PARTIAL' ? 'متاح جزئياً' : 'متاح'}
                </option>
              ))}
            </select>
          </label>
          {action === 'RELOCATE' && (
            <div className="stw-row">
              <button className="stw-btn small" disabled={drawing} onClick={drawArea}>{footprint ? 'إعادة رسم حدود الموقع المقترح' : 'رسم حدود الموقع المقترح (اختياري)'}</button>
              {footprint && <button className="stw-btn small ghost" onClick={() => setFootprint(null)}>إزالة الحدود</button>}
            </div>
          )}
        </details>
      </section>

      {!canContinue && point && reasons.length > 0 && !checking && <p className="stw-hint">لا يمكن المتابعة: {reasons[0]}</p>}
      <div className="stw-error" role="alert">{error}</div>
      <div className="stw-actions sticky">
        <button className="stw-btn primary" disabled={!canContinue} onClick={() => (setError(''), setStep('review'))}>
          متابعة ←
        </button>
        <button className="stw-btn" onClick={onClose}>إلغاء</button>
      </div>
    </aside>
  );
}
