import { useEffect, useMemo, useRef, useState } from 'react';
import L from '../../lib/leaflet';
import { api, isAbort, newIdempotencyKey } from '../../api/client';
import type { GeoJsonGeometry, MapFeature, PlacementAction, PlacementCheck, PlacementUnit, Relocation, StationLevel } from '../../api/types';
import { useApp } from '../../lib/app';
import { parseCoordinates } from '../../lib/coords';
import { addDays, dubaiISO, localDay, todayDubai } from '../../lib/dates';
import { areaM2, edgeLengths, formatArea, formatMeters, mainRing, ringsOf, toPolygon, type Ring } from '../../lib/footprint';
import { circle, destination, distanceM, formatKm, type LatLng } from '../../lib/geo';
import { renderSymbol } from '../../lib/unitSymbols';
import { featureAnchor } from '../map/MapCanvas';
import { OrgSymbol } from '../UnitSymbol';
import { FootprintEditor, type FootprintLive } from './FootprintEditor';

export type StationLayers = { range: boolean; occupied: boolean; symbols: boolean; sites: boolean };

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const PIN = '<span class="stw-pin green"><i>⌖</i></span>';
type Use = 'PERMANENT' | 'TEMPORARY' | 'WORK_AREA';

/**
 * «طلب تمركز / إعادة تمركز» docked beside the map (ADR-025; interaction rebuilt to the approved polygon prototype of
 * 2 Nov 2026). The map comes first: a copy of the current registered footprint and its organisation symbol is dragged as
 * one rigid object (shape and area kept), or a new footprint is drawn by choosing a vertex count and placing the vertices
 * on the map or by coordinates; vertices can be edited, every change undone, redone or reset. Distance, the allowed
 * range, area, shape and occupancy are shown live and the server checks each committed change. Only then a compact
 * details step asks for the level, use, dates, included units, existing or new site and the reason. The registered site,
 * its boundary and its marker are never changed: the proposal is saved as a relocation request (draft or submitted).
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
  /** A registered site clicked on the map (key changes on every click); chosen as the existing site in the details step. */
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
  const original = useMemo(() => mainRing(site.boundary?.geojson), [site]);
  const originalArea = original ? areaM2(original) : null;
  const typeCode = app.requestTypes.find((t) => t.kind === 'RELOCATION')?.code ?? null;
  const stages = app.requestTypes.find((t) => t.code === typeCode)?.workflowVersion?.stages ?? [];
  const rel = reopen?.relocation;

  const [phase, setPhase] = useState<'map' | 'details'>('map');
  const [live, setLive] = useState<FootprintLive | null>(null);
  const [target, setTarget] = useState(4);
  const [editVerts, setEditVerts] = useState(false);
  const [vLat, setVLat] = useState('');
  const [vLng, setVLng] = useState('');
  const [vError, setVError] = useState('');
  const [use, setUse] = useState<Use>(rel?.action === 'WORK_AREA' ? 'WORK_AREA' : rel?.temporary ? 'TEMPORARY' : 'PERMANENT');
  const [level, setLevel] = useState<StationLevel>(rel?.stationLevel ?? 'BRANCH');
  const [start, setStart] = useState(reopen?.start ? localDay(reopen.start) : addDays(todayDubai(), 14));
  const [end, setEnd] = useState(rel?.temporaryEnd ? localDay(rel.temporaryEnd) : addDays(todayDubai(), 104));
  const [units, setUnits] = useState<PlacementUnit[] | null>(null);
  const [included, setIncluded] = useState<Set<string> | null>(rel?.includedOrgs ? new Set(rel.includedOrgs.map((o) => o.id)) : null);
  const [targetId, setTargetId] = useState<string | null>(rel?.targetSite?.id ?? null);
  const [name, setName] = useState(rel?.proposedName ?? '');
  const [reason, setReason] = useState(reopen?.reason ?? '');
  const [requestId, setRequestId] = useState<string | null>(reopen?.requestId ?? null);
  const [check, setCheck] = useState<PlacementCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [symbolUrl, setSymbolUrl] = useState<string | null>(null);
  const [busyRun, setBusyRun] = useState(false);
  const [error, setError] = useState('');
  const submitKey = useRef(newIdempotencyKey());

  const action: PlacementAction = use === 'WORK_AREA' ? 'WORK_AREA' : 'RELOCATE';
  const temporary = use !== 'PERMANENT';
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
        // default: only the branches at this site; a branch elsewhere is never moved without choosing it
        setIncluded((cur) => cur ?? new Set(u.filter((x) => x.depth > 0 && x.atSite).map((x) => x.id)));
      })
      .catch((e: Error) => alive && (setUnits([]), setError(e.message)));
    return () => {
      alive = false;
    };
  }, [org.id, site.siteId]);

  // the organisation's own symbol: on the registered location and on the proposal copy
  useEffect(() => {
    let alive = true;
    api
      .unitSymbols([org.id])
      .then(async (lookup) => {
        const s = lookup.symbols[org.id];
        if (!s) return;
        const r = await renderSymbol(s.sidc, s.standard, 30);
        if (alive && r.valid) setSymbolUrl(r.url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [org.id]);
  const symbolHtml = symbolUrl ? '<img class="stw-sym-img" src="' + symbolUrl + '" alt="" />' : PIN;

  // occupied registered sites in the proposal period (from the map layer for the same period)
  const busySites = useMemo(() => features.filter((f) => f.availability === 'BUSY' && f.siteId !== site.siteId), [features, site.siteId]);
  const busyRings = useMemo(() => busySites.map((f) => ({ name: f.name, rings: ringsOf(f.boundary?.geojson) })).filter((b) => b.rings.length), [busySites]);

  // ---- the editor (preview layer) ----
  const editorRef = useRef<FootprintEditor | null>(null);
  const rangeRef = useRef<{ min: number; max: number | null } | null>(null);
  rangeRef.current = rule && rule.measure === 'CENTER' ? { min: rule.minM, max: rule.maxM ?? null } : null;
  const busyRef = useRef(busyRings);
  busyRef.current = busyRings;
  const pausedRef = useRef(false);
  pausedRef.current = measuring || phase !== 'map';
  // live readouts written in place while the pointer moves (no React render per move)
  const liveRefs = { dist: useRef<HTMLElement>(null), area: useRef<HTMLElement>(null), delta: useRef<HTMLElement>(null), box: useRef<HTMLDivElement>(null) };
  const paint = (l: FootprintLive) => {
    const set = (el: HTMLElement | null, s: string) => el && el.textContent !== s && (el.textContent = s);
    set(liveRefs.dist.current, l.anchor ? formatMeters(l.dist) : '—');
    const a = l.ring ? areaM2(l.ring) : null;
    set(liveRefs.area.current, a != null ? formatArea(a) : '—');
    set(liveRefs.delta.current, a != null && originalArea ? pct((a - originalArea) / originalArea) : '—');
    const ok = !!l.anchor && l.inRange && !l.kinks && !l.overlaps.length;
    liveRefs.box.current?.classList.toggle('bad', !!l.anchor && !ok);
    liveRefs.box.current?.classList.toggle('ok', ok);
  };

  useEffect(() => {
    if (!map || !from) return;
    const ed = new FootprintEditor(map, {
      origin: from,
      symbolHtml,
      range: () => rangeRef.current,
      busy: () => busyRef.current,
      paused: () => pausedRef.current,
      onLive: (l, final) => {
        paint(l);
        if (final) setLive(l);
      },
    });
    editorRef.current = ed;
    const saved = rel ? mainRing(rel.geometry) : null;
    if (saved) {
      setTarget(saved.length);
      ed.startDraw(saved.length, saved);
    } else if (rel && rel.geometry.type === 'Point') ed.startMove(null, { lat: rel.centroid[0], lng: rel.centroid[1] });
    else ed.startMove(original, from);
    return () => {
      ed.destroy();
      editorRef.current = null;
    };
    // the editor lives as long as the panel and its map; the symbol is swapped in place below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, from?.lat, from?.lng]);
  useEffect(() => editorRef.current?.setSymbol(symbolHtml), [symbolHtml]);
  useEffect(() => editorRef.current?.refresh(), [rule?.id, rule?.minM, rule?.maxM, busyRings]);

  const geometry: GeoJsonGeometry | null = live?.ring ? toPolygon(live.ring) : live?.point ? { type: 'Point', coordinates: [live.point.lng, live.point.lat] } : null;
  const includedList = [...(included ?? [])];

  // the server check (debounced, superseded requests cancelled) for every committed proposal and every detail change
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

  // ---- map: the registered location (fixed reference), the allowed range and the occupied sites ----
  useEffect(() => {
    if (!map || !from) return;
    const g = L.layerGroup().addTo(map);
    if (layers.range && rule && rule.measure === 'CENTER') {
      const outer = rule.maxM != null ? circle(from, rule.maxM) : null;
      const inner = rule.minM > 0 ? circle(from, rule.minM) : null;
      if (outer) {
        L.polygon(inner ? [outer, inner] : [outer], { color: '#1f9d55', weight: 2, dashArray: '8 6', fillColor: '#2bb36a', fillOpacity: 0.12, interactive: false }).addTo(g);
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
        if (f.boundary) L.geoJSON(f.boundary.geojson as never, { interactive: false, style: { color: '#c0392b', weight: 2, fillColor: '#e74c3c', fillOpacity: 0.35 } } as L.GeoJSONOptions).addTo(g);
        if (at) L.marker(at, { interactive: false, zIndexOffset: -200, icon: L.divIcon({ className: 'stw-busy-tag', html: '<span><i>⊘</i> موقع محجوز</span>', iconSize: [0, 0] }) }).addTo(g);
      }
    }
    // the registered footprint and symbol stay where they are, unchanged, for comparison
    if (original) L.polygon(original.map((p) => [p.lat, p.lng] as L.LatLngTuple), { color: '#2f6db0', weight: 2.5, fillColor: '#4a86c8', fillOpacity: 0.22, interactive: false }).addTo(g);
    L.marker(from, {
      interactive: false,
      zIndexOffset: 800,
      icon: L.divIcon({ className: 'stw-current', html: '<div class="stw-orig-sym">' + symbolHtml + '<span class="lbl">' + esc(site.name) + ' · الموقع المعتمد</span></div>', iconSize: [0, 0] }),
    }).addTo(g);
    return () => {
      g.remove();
    };
  }, [map, from?.lat, from?.lng, rule?.id, rule?.minM, rule?.maxM, rule?.measure, layers.range, layers.occupied, busySites, site.name, original, symbolHtml]); // eslint-disable-line react-hooks/exhaustive-deps

  // undo / redo from the keyboard while the map step is open (not while typing)
  useEffect(() => {
    if (phase !== 'map') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) (e.preventDefault(), editorRef.current?.undo());
      else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) (e.preventDefault(), editorRef.current?.redo());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  // a registered site clicked on the map in the details step is chosen as the existing site
  useEffect(() => {
    if (!pickedSite || phase !== 'details') return;
    const f = features.find((x) => x.siteId === pickedSite.siteId);
    if (f && f.siteId !== site.siteId) {
      setTargetId(f.siteId);
      if (!name) setName(f.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedSite?.key]);

  const candidates = useMemo(() => {
    const at = live?.anchor ?? from;
    return features
      .filter((f) => f.siteId !== site.siteId && featureAnchor(f))
      .map((f) => ({ f, d: at ? distanceM(at, featureAnchor(f)!) : 0 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 12);
  }, [features, site.siteId, live?.anchor, from]);

  // ---- persistence: the proposal is a relocation request (draft, or submitted for approval) ----
  const resource = site.resources.find((r) => !r.parentResourceId) ?? site.resources[0];
  const persist = async (): Promise<string> => {
    if (!typeCode) throw new Error('لا يوجد نوع طلب «نقل مقر» منشور.');
    if (!resource) throw new Error('لا يوجد للمقر الحالي سجل مورد يرتبط به الطلب؛ يضيفه مسؤول المرافق.');
    if (!geometry) throw new Error('حدد الموقع المقترح على الخريطة.');
    const subject =
      (action === 'WORK_AREA' ? 'منطقة عمل مؤقتة — ' : 'تمركز ' + (level === 'MAIN' ? 'مقر رئيسي' : 'مقر فرعي') + ' — ') + org.name + ' — ' + (name.trim() || 'الموقع المقترح');
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
      temporary,
      temporaryEnd: temporary ? period.end : null,
      targetSiteId: targetId,
      includedOrgIds: includedList,
    });
    return id;
  };

  const run = async (submit: boolean) => {
    if (name.trim().length < 2) return setError('اكتب اسماً للموقع المقترح.');
    if (submit && reason.trim().length < 10) return setError('اكتب مبرر الطلب (10 أحرف على الأقل).');
    setBusyRun(true);
    setError('');
    try {
      const id = await persist();
      if (submit) {
        const fresh = await api.request(id);
        const sent = await api.submit(id, fresh.version, undefined, submitKey.current);
        app.toast('أُرسل الطلب ' + sent.number + ' للاعتماد؛ لا يتغير الموقع المعتمد قبل الاعتماد والتفعيل.');
      } else app.toast('حُفظت مسودة الطلب مع حدودها المقترحة؛ لم يتغير الموقع المعتمد.');
      app.bump();
      onSaved(id, submit);
    } catch (e) {
      setError((e as Error).message);
      if (submit) submitKey.current = newIdempotencyKey();
    } finally {
      setBusyRun(false);
    }
  };

  // ---- view ----
  const ed = editorRef.current;
  const localOk = !!live?.anchor && live.inRange && live.kinks === 0 && live.overlaps.length === 0;
  const serverOk = !!check && check.ok && !checking;
  const geometryReady = localOk && serverOk && (action !== 'WORK_AREA' || !!live?.ring) && !!typeCode;
  const blocking = check?.conflicts.filter((c) => c.blocking) ?? [];
  const shared = check?.conflicts.filter((c) => !c.blocking && c.kind === 'SHARED') ?? [];
  const rangeText = rule ? formatKm(rule.minM) + ' – ' + (rule.maxM != null ? formatKm(rule.maxM) : 'دون حد أعلى') : null;
  const ringArea = live?.ring ? areaM2(live.ring) : null;
  const drawing = live?.mode === 'draw';
  const showVertices = drawing || editVerts;
  const verts: Ring = live?.verts ?? [];
  const lengths = edgeLengths(verts);

  const head = (
    <>
      <header className="stw-panel-head">
        <h2>{phase === 'map' ? 'اقتراح الموقع على الخريطة' : 'تفاصيل الطلب'}</h2>
        <button className="stw-x" onClick={onClose} aria-label="إلغاء دون حفظ">
          ✕
        </button>
      </header>
      <div className="stw-for">
        <OrgSymbol orgId={org.id} size={20} />
        <span>
          <b>{org.name}</b>
          <small>
            الموقع المعتمد: {site.name}
            {originalArea ? ' · ' + formatArea(originalArea) : ' · دون حدود مسجلة'}
          </small>
        </span>
      </div>
    </>
  );

  if (phase === 'details') {
    const unitsAtSite = units?.filter((u) => u.depth > 0) ?? [];
    return (
      <aside className="stw-panel" aria-label="تفاصيل طلب التمركز">
        {head}
        <dl className="stw-read compact">
          <dt>المسافة</dt>
          <dd>{check ? formatKm(check.distanceM) + (rangeText ? ' (المسموح ' + rangeText + ')' : '') : '—'}</dd>
          <dt>المساحة المقترحة</dt>
          <dd>{ringArea != null ? formatArea(ringArea) : 'نقطة فقط'}</dd>
          <dt>الإشغال</dt>
          <dd className={blocking.length ? 'n' : 'y'}>{blocking.length ? '✕ محجوز' : shared.length ? '✓ استخدام مشترك مسموح' : '✓ متاح للفترة'}</dd>
        </dl>
        <div className="stw-chips-row" role="radiogroup" aria-label="نوع الاستخدام">
          {(
            [
              ['PERMANENT', 'مقر دائم'],
              ['TEMPORARY', 'مقر مؤقت'],
              ['WORK_AREA', 'منطقة عمل مؤقتة'],
            ] as [Use, string][]
          ).map(([u, l]) => (
            <button key={u} role="radio" aria-checked={use === u} className={'stw-chip-btn ' + (use === u ? 'on' : '')} onClick={() => setUse(u)}>
              {l}
            </button>
          ))}
        </div>
        {action === 'RELOCATE' && (
          <div className="stw-chips-row" role="radiogroup" aria-label="مستوى التمركز">
            {(
              [
                ['MAIN', 'مقر رئيسي'],
                ['BRANCH', 'مقر فرعي'],
              ] as [StationLevel, string][]
            ).map(([v, l]) => (
              <button key={v} role="radio" aria-checked={level === v} className={'stw-chip-btn ' + (level === v ? 'on' : '')} onClick={() => setLevel(v)}>
                {l}
              </button>
            ))}
          </div>
        )}
        <div className="stw-dates">
          <label>
            <span>{temporary ? 'من' : 'تاريخ التفعيل المطلوب'}</span>
            <input type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} aria-label="تاريخ البداية" />
          </label>
          {temporary && (
            <label>
              <span>إلى</span>
              <input type="date" value={end} onChange={(e) => e.target.value && setEnd(e.target.value)} aria-label="تاريخ النهاية" />
            </label>
          )}
        </div>
        {!periodOk && <p className="stw-error">نهاية المدة يجب أن تكون بعد بدايتها.</p>}
        <div className="stw-sub">الجهات المشمولة</div>
        <label className="stw-check locked">
          <input type="checkbox" checked readOnly disabled />
          <span>
            <b>{org.name}</b>
            <small>الجهة المختارة</small>
          </span>
        </label>
        {units === null && <p className="stw-hint">جارٍ تحميل الأقسام التابعة…</p>}
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
        <div className="stw-sub">الموقع</div>
        <div className="stw-chips-row" role="radiogroup" aria-label="موقع جديد أو قائم">
          <button role="radio" aria-checked={!targetId} className={'stw-chip-btn ' + (!targetId ? 'on' : '')} onClick={() => setTargetId(null)}>
            موقع جديد مقترح
          </button>
          <button role="radio" aria-checked={!!targetId} className={'stw-chip-btn ' + (targetId ? 'on' : '')} onClick={() => candidates[0] && setTargetId(candidates[0].f.siteId)}>
            موقع مسجل قائم
          </button>
        </div>
        {targetId && (
          <label className="stw-field">
            <span>الموقع المسجل (أو انقره على الخريطة)</span>
            <select value={targetId} onChange={(e) => setTargetId(e.target.value || null)}>
              {candidates.map(({ f, d }) => (
                <option key={f.siteId} value={f.siteId}>
                  {f.name} — {formatKm(d)} — {f.availability === 'BUSY' ? 'محجوز' : f.availability === 'PARTIAL' ? 'متاح جزئياً' : 'متاح'}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="stw-field">
          <span>اسم الموقع المقترح</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="مثال: المبنى الإداري الجديد" />
        </label>
        <label className="stw-field">
          <span>مبرر الطلب</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3} placeholder="لماذا يلزم هذا التمركز؟" />
        </label>
        {check && !checking && !check.ok && (
          <ul className="stw-msgs" role="alert">
            {check.messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        {checkError && <p className="stw-error">{checkError}</p>}
        <p className="stw-hint">
          مسار الاعتماد: {stages.length ? stages.map((s) => s.name).join(' ← ') : 'وفق التدفق المنشور'}. لا يتغير الموقع المعتمد ولا سجل المواقع بالحفظ أو الإرسال؛ التفعيل بعد
          الاعتماد غير مبني بعد.
        </p>
        <div className="stw-error" role="alert">
          {error}
        </div>
        <div className="stw-actions">
          <button className="stw-btn primary" disabled={busyRun || !serverOk || !periodOk} onClick={() => run(true)}>
            {busyRun ? 'جارٍ الإرسال…' : 'إرسال الطلب'}
          </button>
          <button className="stw-btn" disabled={busyRun} onClick={() => run(false)}>
            حفظ كمسودة
          </button>
        </div>
        <button className="stw-link" disabled={busyRun} onClick={() => setPhase('map')}>
          → العودة إلى الخريطة
        </button>
      </aside>
    );
  }

  return (
    <aside className="stw-panel" aria-label="اقتراح الموقع على الخريطة">
      {head}
      <div className="stw-tabs" role="tablist" aria-label="طريقة الاقتراح">
        <button role="tab" aria-selected={!drawing} className={!drawing ? 'on' : ''} onClick={() => (setEditVerts(false), ed?.startMove(original, from!))}>
          أ · نقل الحدود الحالية
        </button>
        <button role="tab" aria-selected={drawing} className={drawing ? 'on' : ''} onClick={() => ed?.startDraw(target)}>
          ب · رسم حدود جديدة
        </button>
      </div>
      <p className="stw-hint">
        {drawing
          ? live?.closed
            ? 'اسحب المساحة أو رمزها لنقل الحدود كاملة، أو اسحب رأساً لتعديله.'
            : 'انقر على الخريطة لوضع الرؤوس بالترتيب، أو أدخل إحداثيات كل رأس أدناه.'
          : original
            ? 'اسحب المساحة الخضراء أو رمزها لنقل الحدود كاملة — يبقى الشكل والمساحة كما هما. الحدود المعتمدة تبقى بالأزرق دون تغيير.'
            : 'لا حدود مسجلة للموقع الحالي: اسحب رمز الجهة إلى الموقع المقترح، أو ارسم حدوداً جديدة.'}
      </p>

      {drawing && (
        <div className="stw-row">
          <label className="stw-field inline">
            <span>عدد الرؤوس</span>
            <input
              type="number"
              min={3}
              max={20}
              value={target}
              aria-label="عدد الرؤوس"
              onChange={(e) => {
                const n = Math.max(3, Math.min(20, Math.round(Number(e.target.value) || 3)));
                setTarget(n);
                ed?.setTarget(n);
              }}
            />
          </label>
          <span className="stw-hint">
            {live?.vertices ?? 0} / {live?.target ?? target} {live?.closed ? '· مكتمل' : ''}
          </span>
        </div>
      )}
      {drawing && !live?.closed && (
        <div className="stw-coords">
          <label>
            <span>خط العرض</span>
            <input inputMode="decimal" value={vLat} onChange={(e) => setVLat(e.target.value)} aria-label="خط عرض الرأس" />
          </label>
          <label>
            <span>خط الطول</span>
            <input inputMode="decimal" value={vLng} onChange={(e) => setVLng(e.target.value)} aria-label="خط طول الرأس" />
          </label>
          <button
            className="stw-btn small"
            onClick={() => {
              const r = parseCoordinates(vLat, vLng);
              if (!r.point) return setVError(r.error || 'أدخل خط العرض وخط الطول.');
              setVError('');
              ed?.addVertex(r.point);
              setVLat('');
              setVLng('');
            }}
          >
            إضافة رأس
          </button>
        </div>
      )}
      {vError && <p className="stw-error">{vError}</p>}

      <div className="stw-live" ref={liveRefs.box}>
        <span>المسافة من الموقع المعتمد</span>
        <b ref={liveRefs.dist}>{live?.anchor ? formatMeters(live.dist) : '—'}</b>
        <em className={checking ? '' : serverOk ? 'y' : 'n'}>{checking ? '⏳ جارٍ التحقق من الخادم…' : check ? (check.ok ? '✓ تحقق الخادم: صالح' : '✕ تحقق الخادم: غير صالح') : ''}</em>
      </div>
      <dl className="stw-read">
        <dt>النطاق المسموح</dt>
        <dd>{rangeText ?? 'لا قاعدة مسافة مهيأة'}</dd>
        <dt>المساحة المعتمدة</dt>
        <dd>{originalArea ? formatArea(originalArea) : '—'}</dd>
        <dt>المساحة المقترحة</dt>
        <dd ref={liveRefs.area}>{ringArea != null ? formatArea(ringArea) : '—'}</dd>
        <dt>الفرق في المساحة</dt>
        <dd ref={liveRefs.delta}>{ringArea != null && originalArea ? pct((ringArea - originalArea) / originalArea) : '—'}</dd>
        <dt>صحة الشكل</dt>
        <dd className={live?.kinks ? 'n' : 'y'}>{live?.ring ? (live.kinks ? '✕ أضلاع متقاطعة' : '✓ صالح') : drawing ? 'لم يكتمل الرسم' : 'نقطة'}</dd>
        <dt>الإشغال</dt>
        <dd className={live?.overlaps.length || blocking.length ? 'n' : 'y'}>
          {live?.overlaps.length ? '✕ تداخل مع: ' + live.overlaps.join('، ') : blocking.length ? '✕ ' + blocking[0].message : shared.length ? '◐ استخدام مشترك مسموح' : '✓ لا تداخل'}
        </dd>
      </dl>
      {check && !checking && !check.ok && (
        <ul className="stw-msgs" role="alert">
          {check.messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {checkError && <p className="stw-error">{checkError}</p>}

      {showVertices && verts.length > 0 && (
        <table className="stw-vt" aria-label="رؤوس الحدود المقترحة">
          <thead>
            <tr>
              <th>#</th>
              <th>خط العرض</th>
              <th>خط الطول</th>
              <th>الضلع التالي</th>
            </tr>
          </thead>
          <tbody>
            {verts.map((v, i) => (
              <VertexRow key={i + ':' + v.lat + ':' + v.lng} i={i} v={v} next={live?.closed || i < verts.length - 1 ? lengths[i] : null} onSet={(p) => ed?.setVertex(i, p)} />
            ))}
          </tbody>
        </table>
      )}

      <div className="stw-tools">
        <button className="stw-btn small" disabled={!live?.canUndo} onClick={() => ed?.undo()} title="Ctrl+Z">
          ↶ تراجع
        </button>
        <button className="stw-btn small" disabled={!live?.canRedo} onClick={() => ed?.redo()} title="Ctrl+Y">
          ↷ إعادة
        </button>
        <button className="stw-btn small" onClick={() => ed?.reset()}>
          إعادة الضبط
        </button>
        {!drawing && original && (
          <button className={'stw-btn small ' + (editVerts ? 'on' : '')} aria-pressed={editVerts} onClick={() => (setEditVerts(!editVerts), ed?.setEditVertices(!editVerts))}>
            تعديل الرؤوس
          </button>
        )}
        <button className="stw-btn small" onClick={() => ed?.focus()}>
          ◎ المقترح
        </button>
        <button className="stw-btn small" onClick={() => ed?.compare(original)}>
          ⇆ مقارنة الموقعين
        </button>
      </div>
      <div className="stw-actions sticky">
        <button className="stw-btn primary" disabled={!geometryReady} onClick={() => (setError(''), setPhase('details'))}>
          متابعة إلى تفاصيل الطلب
        </button>
        <button className="stw-btn" onClick={onClose}>
          إلغاء
        </button>
      </div>
      <p className="stw-hint">المعاينة مؤقتة: لا تتغير حدود الموقع المعتمد ولا علامته. يعيد الخادم فحص المسافة والإشغال والصلاحيات بعد كل وضع وعند الحفظ والإرسال والاعتماد.</p>
    </aside>
  );
}

function pct(x: number): string {
  if (Math.abs(x) < 0.000005) return '0٪';
  return (x > 0 ? '+' : '−') + Math.abs(x * 100).toLocaleString('ar', { maximumFractionDigits: 3, minimumFractionDigits: 3 }) + '٪';
}

/** One vertex: precise coordinates typed and applied on Enter or leaving the field; edge length to the next vertex. */
function VertexRow({ i, v, next, onSet }: { i: number; v: LatLng; next: number | null; onSet: (p: LatLng) => void }) {
  const [lat, setLat] = useState(v.lat.toFixed(6));
  const [lng, setLng] = useState(v.lng.toFixed(6));
  const [err, setErr] = useState('');
  const apply = () => {
    if (lat === v.lat.toFixed(6) && lng === v.lng.toFixed(6)) return;
    const r = parseCoordinates(lat, lng);
    if (!r.point) return setErr(r.error || 'إحداثيات غير صالحة');
    setErr('');
    onSet(r.point);
  };
  const key = (e: React.KeyboardEvent) => e.key === 'Enter' && apply();
  return (
    <tr className={err ? 'bad' : ''}>
      <td>{i + 1}</td>
      <td>
        <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} onBlur={apply} onKeyDown={key} aria-label={'خط عرض الرأس ' + (i + 1)} title={err} />
      </td>
      <td>
        <input inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} onBlur={apply} onKeyDown={key} aria-label={'خط طول الرأس ' + (i + 1)} title={err} />
      </td>
      <td>{next == null ? '—' : formatMeters(next)}</td>
    </tr>
  );
}
