// TMRKZ — symbol-first stationing interaction prototype (Leaflet + milsymbol, fictional data).
// The accepted product flow: click an organisation SYMBOL → compact contextual toolbar → drag a copy of THAT org's
// symbol to propose a location → live distance/availability, no snap-back → drop → minimal confirmation card.
// Progressive disclosure: no request details until a position is chosen. Nothing here is production code.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import ms from 'milsymbol';
import './flow.css';
import { FACILITIES, ORGS, OCCUPIED, RULE, destination, distanceM, formatKm, inRange, pointInOccupied, type Facility, type LatLng, type Org } from './flow-data';

const CENTER_VIEW = FACILITIES.reduce((a, f) => ({ lat: a.lat + f.at.lat / FACILITIES.length, lng: a.lng + f.at.lng / FACILITIES.length }), { lat: 0, lng: 0 });

// ---- milsymbol identity symbols (cached) ---------------------------------------------------------------
const svgCache = new Map<string, string>();
function symbolSvg(sidc: string, size: number): string {
  const key = sidc + ':' + size;
  let s = svgCache.get(key);
  if (!s) { s = new (ms as unknown as { Symbol: new (s: string, o: object) => { asSVG(): string } }).Symbol(sidc, { size, standard: 'APP6' }).asSVG(); svgCache.set(key, s); }
  return s;
}
const ll = (p: LatLng): L.LatLngExpression => [p.lat, p.lng];
const circleRing = (c: LatLng, m: number, steps = 90): L.LatLngExpression[] => { const o: L.LatLngExpression[] = []; for (let i = 0; i <= steps; i++) o.push(ll(destination(c, (i * 360) / steps, m))); return o; };

// ---- app shell ----------------------------------------------------------------------------------------
const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="fx-top">
    <div class="fx-brand"><span class="fx-logo">⌖</span><b>TMRKZ</b><span class="fx-sub">مساحة العمل الإدارية — نموذج التفاعل بالرموز</span></div>
    <div class="fx-top-search"><input id="fx-search" placeholder="ابحث عن جهة …" aria-label="ابحث عن جهة" /><div id="fx-search-pop" class="fx-search-pop" hidden></div></div>
    <span class="fx-user"><span class="fx-avatar">م</span><span><b>مستخدم تجريبي</b><small>مقدم الطلب</small></span></span>
  </header>
  <div class="fx-body">
    <main class="fx-mapwrap"><div id="fx-map" class="fx-map" role="application" aria-label="الخريطة الإدارية"></div>
      <div id="fx-hint" class="fx-hint" hidden></div>
      <div id="fx-toolbar" class="fx-toolbar" hidden></div>
      <div id="fx-picker" class="fx-picker" hidden></div>
      <div class="fx-legend">
        <b>المفتاح</b>
        <span><i class="sw blue"></i> رمز هوية الجهة (معلوماتي)</span>
        <span><i class="sw ring"></i> النطاق المسموح للتمركز</span>
        <span><i class="sw red"></i> منطقة محجوزة</span>
      </div>
    </main>
    <aside id="fx-panel" class="fx-panel" aria-label="تفاصيل الطلب"></aside>
  </div>`;

const map = L.map('fx-map', { zoomControl: true, attributionControl: false, preferCanvas: true, minZoom: 10, maxZoom: 18, zoomSnap: 0.5 });
map.setView(ll(CENTER_VIEW), 13);
const canvas = L.canvas({ padding: 0.5 });

// occupied zones — always visible, no occupant identity disclosed
for (const z of OCCUPIED) {
  const poly = L.polygon(z.ring.map(ll), { renderer: canvas, color: '#c0392b', weight: 1.5, fillColor: '#e74c3c', fillOpacity: 0.28, interactive: true }).addTo(map);
  poly.bindTooltip('منطقة محجوزة', { sticky: true, direction: 'top' });
}

// ---- state ---------------------------------------------------------------------------------------------
type Mode = 'idle' | 'propose' | 'pick';
type Action = 'RELOCATE' | 'WORK_AREA';
let selected: Org | null = null;
let mode: Mode = 'idle';
let action: Action = 'RELOCATE';
const facLayer = L.layerGroup().addTo(map);
const propLayer = L.layerGroup().addTo(map);
const facMarkers = new Map<string, L.Marker>();

// ---- facility symbols on the map -----------------------------------------------------------------------
function facilityHtml(f: Facility, dimOrg?: string): string {
  const isOrigin = f.orgs.length === 1 && f.orgs[0].id === dimOrg;
  const head = f.orgs.length > 1
    ? `<span class="fx-stack">${f.orgs.slice(0, 2).map((o) => `<span class="fx-sym-svg">${symbolSvg(o.sidc, 30)}</span>`).join('')}<i class="fx-count">${f.orgs.length}</i></span>`
    : `<span class="fx-sym-svg ${isOrigin ? 'is-origin' : ''}">${symbolSvg(f.orgs[0].sidc, 36)}</span>`;
  const label = isOrigin ? f.orgs[0].name + ' · الموقع الحالي' : f.orgs.length > 1 ? f.name + ' · ' + f.orgs.length + ' جهات' : f.orgs[0].name;
  return `<div class="fx-fac ${isOrigin ? 'origin' : ''} ${selected && f.orgs.some((o) => o.id === selected!.id) ? 'sel' : ''}">${head}<span class="fx-fac-label">${label}</span></div>`;
}
function drawFacilities(dimOrg?: string) {
  facLayer.clearLayers();
  facMarkers.clear();
  for (const f of FACILITIES) {
    if (mode === 'propose' && dimOrg && f.orgs.length === 1 && f.orgs[0].id === dimOrg) {
      // the origin symbol stays visible but marked «الموقع الحالي»
    }
    const m = L.marker(ll(f.at), { icon: L.divIcon({ className: 'fx-fac-icon', html: facilityHtml(f, dimOrg), iconSize: [0, 0] }), keyboard: true, title: f.name }).addTo(facLayer);
    m.on('click', () => onFacilityClick(f));
    facMarkers.set(f.id, m);
  }
}
drawFacilities();

// ---- selection + contextual toolbar --------------------------------------------------------------------
const toolbar = document.getElementById('fx-toolbar')!;
const picker = document.getElementById('fx-picker')!;
const hint = document.getElementById('fx-hint')!;
const panel = document.getElementById('fx-panel')!;

function onFacilityClick(f: Facility) {
  if (mode === 'pick') { pickExisting(f); return; }
  if (mode === 'propose') return;
  if (f.orgs.length === 1) selectOrg(f.orgs[0]);
  else showPicker(f);
}

function showPicker(f: Facility) {
  selected = null;
  hideToolbar();
  const pt = map.latLngToContainerPoint(ll(f.at));
  picker.innerHTML = `<div class="fx-picker-head">عدة جهات في «${f.name}»</div>` +
    f.orgs.map((o) => `<button data-org="${o.id}"><span class="fx-sym-svg">${symbolSvg(o.sidc, 26)}</span><span><b>${o.name}</b><small>${o.kind}</small></span></button>`).join('') +
    `<button class="fx-picker-x" data-x>إغلاق</button>`;
  placeFloating(picker, pt, -10);
  picker.hidden = false;
  picker.querySelectorAll('button[data-org]').forEach((b) => b.addEventListener('click', () => { picker.hidden = true; selectOrg(f.orgs.find((o) => o.id === (b as HTMLElement).dataset.org)!); }));
  picker.querySelector('[data-x]')?.addEventListener('click', () => (picker.hidden = true));
}

function selectOrg(o: Org) {
  selected = o;
  picker.hidden = true;
  drawFacilities();
  map.panTo(ll(o.at), { animate: true });
  const pt = map.latLngToContainerPoint(ll(o.at));
  const perm = o.canPropose;
  toolbar.innerHTML = `
    <div class="fx-tb-head"><span class="fx-sym-svg">${symbolSvg(o.sidc, 26)}</span><span><b>${o.name}</b><small>${o.kind} · ${o.facility}</small></span></div>
    <div class="fx-tb-actions">
      <button class="fx-tb-btn primary" data-a="propose" ${perm ? '' : 'disabled'}>⇄ اقتراح تغيير موقع</button>
      <button class="fx-tb-btn" data-a="existing" ${perm ? '' : 'disabled'}>▣ اختيار موقع قائم</button>
      <button class="fx-tb-btn" data-a="work" ${perm ? '' : 'disabled'}>⬚ منطقة عمل مؤقتة</button>
    </div>
    ${perm ? '' : '<p class="fx-tb-note">لا تملك صلاحية التقديم لهذه الجهة.</p>'}
    <button class="fx-tb-x" data-a="close" aria-label="إلغاء التحديد">✕</button>`;
  placeFloating(toolbar, pt, -46);
  toolbar.hidden = false;
  toolbar.querySelector('[data-a="propose"]')?.addEventListener('click', () => startPropose(o, 'RELOCATE'));
  toolbar.querySelector('[data-a="work"]')?.addEventListener('click', () => startPropose(o, 'WORK_AREA'));
  toolbar.querySelector('[data-a="existing"]')?.addEventListener('click', () => startPickExisting(o));
  toolbar.querySelector('[data-a="close"]')?.addEventListener('click', deselect);
}
function hideToolbar() { toolbar.hidden = true; }
function deselect() { selected = null; hideToolbar(); picker.hidden = true; drawFacilities(); }

// keep floating UI pinned to the map point
function placeFloating(el: HTMLElement, pt: L.Point, dy: number) { el.style.left = pt.x + 'px'; el.style.top = pt.y + dy + 'px'; }
let anchor: { el: HTMLElement; at: LatLng; dy: number } | null = null;
function follow(el: HTMLElement, at: LatLng, dy: number) { anchor = { el, at, dy }; }
map.on('move zoom', () => {
  if (anchor && !anchor.el.hidden) placeFloating(anchor.el, map.latLngToContainerPoint(ll(anchor.at)), anchor.dy);
  if (!toolbar.hidden && selected) placeFloating(toolbar, map.latLngToContainerPoint(ll(selected.at)), -46);
});

// ---- propose: drag a copy of the org's own symbol ------------------------------------------------------
let dyn: { marker: L.Marker; line: L.Polyline; ring: L.Polygon; inner: L.Polyline; chip: L.Marker } | null = null;

function startPropose(o: Org, a: Action) {
  selected = o; action = a; mode = 'propose';
  hideToolbar(); picker.hidden = true;
  drawFacilities(o.id); // mark origin
  const from = o.at;
  const start = destination(from, 65, (RULE.minM + (RULE.maxM ?? 6000)) / 2);
  const ring = L.polygon([circleRing(from, RULE.maxM ?? 6000), circleRing(from, RULE.minM)], { renderer: canvas, color: '#1f9d55', weight: 2, dashArray: '8 6', fillColor: '#2bb36a', fillOpacity: 0.1, interactive: false }).addTo(propLayer);
  const inner = L.polyline(circleRing(from, RULE.minM), { renderer: canvas, color: '#c0392b', weight: 1.2, dashArray: '4 6', interactive: false }).addTo(propLayer);
  const line = L.polyline([ll(from), ll(start)], { renderer: canvas, color: '#16324f', weight: 2.2, dashArray: '6 6', interactive: false }).addTo(propLayer);
  const icon = L.divIcon({ className: 'fx-proposal', html: `<span class="fx-sym-svg">${symbolSvg(o.sidc, 38)}</span><span class="fx-prop-badge">مقترح</span>`, iconSize: [0, 0] });
  const marker = L.marker(ll(start), { draggable: true, autoPan: true, zIndexOffset: 1400, icon, keyboard: true, title: 'اسحب الرمز المقترح' }).addTo(propLayer);
  const chip = L.marker(ll(start), { interactive: false, zIndexOffset: 1500, icon: L.divIcon({ className: 'fx-chip', html: '<span></span>', iconSize: [0, 0] }) }).addTo(propLayer);
  dyn = { marker, line, ring, inner, chip };

  showHint('اسحب الرمز إلى الموقع المقترح — المسافة والإتاحة تظهر مباشرة · Esc للإلغاء');
  let frame = 0;
  const paint = (p: LatLng) => {
    const d = distanceM(from, p);
    const ir = a === 'WORK_AREA' ? d <= (RULE.maxM ?? 6000) : inRange(from, p);
    const occ = pointInOccupied(p, OCCUPIED);
    dyn!.line.setLatLngs([ll(from), ll(p)]);
    const mEl = marker.getElement();
    mEl?.classList.toggle('bad', !ir || !!occ);
    dyn!.chip.setLatLng(ll(p));
    const span = dyn!.chip.getElement()?.querySelector('span');
    const txt = formatKm(d) + (occ ? ' · محجوز' : !ir ? ' · خارج النطاق' : '');
    if (span && span.textContent !== txt) span.textContent = txt;
    dyn!.chip.getElement()?.classList.toggle('bad', !ir || !!occ);
  };
  marker.on('drag', () => { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; const l = marker.getLatLng(); dyn!.chip.setLatLng(l); paint({ lat: l.lat, lng: l.lng }); }); });
  marker.on('dragend', () => { if (frame) { cancelAnimationFrame(frame); frame = 0; } const l = marker.getLatLng(); openCard(o, a, { lat: l.lat, lng: l.lng }); });
  paint(start);
}

function endPropose() {
  mode = 'idle'; action = 'RELOCATE';
  propLayer.clearLayers(); dyn = null;
  hideHint(); panel.innerHTML = ''; panel.classList.remove('open');
  drawFacilities();
}

// ---- "select existing site": click another facility to place the proposal there ------------------------
let pickOrigin: Org | null = null;
function startPickExisting(o: Org) {
  selected = o; mode = 'pick'; pickOrigin = o; hideToolbar();
  drawFacilities(o.id);
  document.getElementById('fx-map')!.classList.add('fx-picking');
  showHint('اختر موقعاً مسجلاً على الخريطة ليكون الموقع المقترح — Esc للإلغاء');
}
function pickExisting(f: Facility) {
  const o = pickOrigin!; mode = 'idle';
  document.getElementById('fx-map')!.classList.remove('fx-picking');
  if (f.orgs.some((x) => x.id === o.id)) { showHint('هذا هو الموقع الحالي للجهة — اختر موقعاً آخر'); mode = 'pick'; return; }
  // reuse the propose visuals at the chosen existing facility
  startPropose(o, 'RELOCATE');
  dyn!.marker.setLatLng(ll(f.at)); dyn!.chip.setLatLng(ll(f.at));
  openCard(o, 'RELOCATE', f.at, f);
}

// ---- progressive-disclosure confirmation card (only after a position is chosen) ------------------------
function openCard(o: Org, a: Action, p: LatLng, existing?: Facility) {
  const d = distanceM(o.at, p);
  const ir = a === 'WORK_AREA' ? d <= (RULE.maxM ?? 6000) : inRange(o.at, p);
  const occ = pointInOccupied(p, OCCUPIED);
  const ok = ir && !occ;
  hideHint();
  panel.classList.add('open');
  panel.innerHTML = `
    <div class="fx-card-head"><span class="fx-sym-svg">${symbolSvg(o.sidc, 26)}</span><span><b>${o.name}</b><small>${a === 'WORK_AREA' ? 'منطقة عمل مؤقتة' : 'اقتراح تغيير موقع'}</small></span>
      <button class="fx-card-x" data-x aria-label="إلغاء">✕</button></div>
    <div class="fx-card-summary ${ok ? 'ok' : 'bad'}">
      <div><span>المسافة من الموقع الحالي</span><b>${formatKm(d)}</b></div>
      <div><span>ضمن النطاق المسموح</span><b class="${ir ? 'y' : 'n'}">${ir ? '✓ نعم' : '✕ لا'}</b></div>
      <div><span>الإتاحة</span><b class="${occ ? 'n' : 'y'}">${occ ? '✕ موقع محجوز' : '✓ متاح'}</b></div>
      <div><span>الموقع</span><b>${existing ? 'موقع مسجل: ' + existing.name : 'موقع إداري جديد مقترح'}</b></div>
    </div>
    <div class="fx-card-body">
      ${a === 'RELOCATE' ? `<fieldset><legend>مستوى التمركز</legend>
        <label><input type="radio" name="lvl" value="MAIN"> مقر رئيسي</label>
        <label><input type="radio" name="lvl" value="BRANCH" checked> مقر فرعي</label></fieldset>` : ''}
      <fieldset><legend>المدة</legend>
        ${a === 'RELOCATE' ? '<label><input type="radio" name="dur" value="PERM" checked> دائم</label>' : ''}
        <label><input type="radio" name="dur" value="TEMP" ${a === 'WORK_AREA' ? 'checked' : ''}> مؤقت</label>
        <div class="fx-dates" ${a === 'WORK_AREA' ? '' : 'hidden'}><label>من<input type="date"></label><label>إلى<input type="date"></label></div>
      </fieldset>
      <fieldset><legend>الجهات المشمولة</legend>
        <label><input type="checkbox" checked disabled> ${o.name} <small>(الجهة المختارة)</small></label>
        <label><input type="checkbox"> قسم تابع (تجريبي)</label>
      </fieldset>
      <label class="fx-field"><span>سبب الطلب</span><textarea rows="2" placeholder="لماذا يلزم هذا التمركز؟"></textarea></label>
      ${ok ? '' : `<p class="fx-card-why">لا يمكن التأكيد: ${occ ? 'الموقع المقترح داخل منطقة محجوزة.' : 'الموقع خارج النطاق المسموح (' + formatKm(RULE.minM) + ' – ' + formatKm(RULE.maxM ?? 0) + ').'} اسحب الرمز إلى موقع صالح.</p>`}
    </div>
    <div class="fx-card-actions">
      <button class="fx-btn primary" data-submit ${ok ? '' : 'disabled'}>إرسال الطلب</button>
      <button class="fx-btn" data-back>رجوع للتعديل</button>
      <button class="fx-btn ghost" data-cancel>إلغاء</button>
    </div>
    <p class="fx-card-foot">لا يتغير الموقع الفعلي ولا سجل المواقع عند الإرسال؛ يعيد الخادم فحص المسافة والإشغال عند الإرسال والاعتماد.</p>`;
  const dur = panel.querySelector('input[name="dur"][value="TEMP"]') as HTMLInputElement | null;
  const perm = panel.querySelector('input[name="dur"][value="PERM"]') as HTMLInputElement | null;
  const dates = panel.querySelector('.fx-dates') as HTMLElement | null;
  dur?.addEventListener('change', () => dates && (dates.hidden = !dur.checked));
  perm?.addEventListener('change', () => dates && (dates.hidden = perm.checked));
  panel.querySelector('[data-back]')?.addEventListener('click', () => { panel.classList.remove('open'); panel.innerHTML = ''; showHint('اسحب الرمز إلى موقع آخر، أو Esc للإلغاء'); });
  panel.querySelector('[data-cancel]')?.addEventListener('click', cancelAll);
  panel.querySelector('[data-x]')?.addEventListener('click', cancelAll);
  panel.querySelector('[data-submit]')?.addEventListener('click', () => { toast('أُرسل الطلب (نموذج فقط — لا يُكتب شيء).'); cancelAll(); });
}

function cancelAll() { endPropose(); mode = 'idle'; pickOrigin = null; document.getElementById('fx-map')!.classList.remove('fx-picking'); deselect(); }

// ---- hint + toast --------------------------------------------------------------------------------------
function showHint(t: string) { hint.textContent = t; hint.hidden = false; }
function hideHint() { hint.hidden = true; }
let toastT = 0;
function toast(t: string) { let el = document.getElementById('fx-toast'); if (!el) { el = document.createElement('div'); el.id = 'fx-toast'; el.className = 'fx-toast'; document.body.appendChild(el); } el.textContent = t; el.classList.add('show'); window.clearTimeout(toastT); toastT = window.setTimeout(() => el!.classList.remove('show'), 3200); }

// Escape cancels anything in progress
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (mode !== 'idle' || !toolbar.hidden || !picker.hidden) { e.preventDefault(); cancelAll(); } } });
// a background click closes the toolbar/picker (not during a proposal)
map.on('click', () => { if (mode === 'idle') { hideToolbar(); picker.hidden = true; } });

// ---- side search: locate/select an org (not the only way to start) -------------------------------------
const search = document.getElementById('fx-search') as HTMLInputElement;
const pop = document.getElementById('fx-search-pop')!;
search.addEventListener('input', () => {
  const q = search.value.trim();
  if (q.length < 1) { pop.hidden = true; return; }
  const hits = ORGS.filter((o) => o.name.includes(q) || o.facility.includes(q)).slice(0, 6);
  pop.innerHTML = hits.length ? hits.map((o) => `<button data-org="${o.id}"><span class="fx-sym-svg">${symbolSvg(o.sidc, 24)}</span><span><b>${o.name}</b><small>${o.facility}</small></span></button>`).join('') : '<p class="fx-note">لا نتائج</p>';
  pop.hidden = false;
  pop.querySelectorAll('button[data-org]').forEach((b) => b.addEventListener('click', () => { pop.hidden = true; search.value = ''; const o = ORGS.find((x) => x.id === (b as HTMLElement).dataset.org)!; map.setView(ll(o.at), 14, { animate: true }); setTimeout(() => selectOrg(o), 250); }));
});

follow(toolbar, CENTER_VIEW, 0); // placeholder; real anchor set on select
