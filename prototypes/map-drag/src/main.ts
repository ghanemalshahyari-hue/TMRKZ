// Shared chrome for both prototypes: header, controls, the dominant map, a minimal committed-state panel and the
// measurement HUD. Query params drive it so the Playwright driver can open any combination deterministically:
//   ?p=a|b   prototype   ?n=10|100|1000   facilities   ?mode=naive|opt   (A only)
import './style.css';
import { metrics } from './metrics';
import { makeFacilities, formatKm } from './data';
import { mountProtoA, type Commit, type Mode, type ProtoHandle } from './protoA';
import { mountProtoB } from './protoB';

const qs = new URLSearchParams(location.search);
const p = (qs.get('p') === 'b' ? 'b' : 'a') as 'a' | 'b';
const n = [10, 100, 1000].includes(Number(qs.get('n'))) ? Number(qs.get('n')) : 100;
const mode = (qs.get('mode') === 'naive' ? 'naive' : 'opt') as Mode;

metrics.proto = p === 'a' ? 'Leaflet (A)' : 'MapLibre + Terra Draw (B)';
metrics.scene = n + ' موقع';

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="top">
    <div class="brand"><span class="logo">⌖</span><b>TMRKZ</b><span class="sub">نموذج تفاعل الخريطة — مقارنة</span></div>
    <div class="controls">
      <div class="seg" role="group" aria-label="النموذج">
        <a class="${p === 'a' ? 'on' : ''}" href="?p=a&n=${n}&mode=${mode}">أ · Leaflet</a>
        <a class="${p === 'b' ? 'on' : ''}" href="?p=b&n=${n}">ب · MapLibre</a>
      </div>
      <div class="seg" role="group" aria-label="عدد المواقع">
        ${[10, 100, 1000].map((x) => `<a class="${x === n ? 'on' : ''}" href="?p=${p}&n=${x}${p === 'a' ? '&mode=' + mode : ''}">${x}</a>`).join('')}
      </div>
      ${p === 'a' ? `<div class="seg" role="group" aria-label="الأسلوب">
        <a class="${mode === 'naive' ? 'on' : ''}" href="?p=a&n=${n}&mode=naive" title="يماثل السلوك الحالي">الحالي</a>
        <a class="${mode === 'opt' ? 'on' : ''}" href="?p=a&n=${n}&mode=opt" title="الأسلوب المقترح">المُحسّن</a>
      </div>` : `<button id="footprint" class="btn ghost">✏︎ ارسم منطقة (Terra Draw)</button>`}
    </div>
  </header>
  <div class="body">
    <main class="mapwrap"><div id="map" class="map" role="application" aria-label="خريطة النموذج"></div>
      <div id="hud" class="hud" aria-live="off"></div>
    </main>
    <aside class="panel" aria-label="حالة الطلب">
      <h2>الموقع المقترح</h2>
      <p class="muted">الحالة المُثبّتة (ما يُرسَل إلى الخادم) تتحدّث عند الإفلات فقط — لا أثناء السحب.</p>
      <dl id="commit"></dl>
      <button id="confirm" class="btn primary" disabled>تأكيد الموقع</button>
      <p id="toast" class="toast" hidden></p>
      <p class="muted small">النموذج أ «الحالي» يعيد إنتاج نمط الواجهة الحالي (تحديث الحالة وإعادة بناء الأيقونة في كل حركة، وارتداد العلامة عند الحد). «المُحسّن» و«ب» يفصلان السحب عن حالة الواجهة.</p>
    </aside>
  </div>`;

metrics.attachHud(document.getElementById('hud')!);

const mapEl = document.getElementById('map')!;
let handle: ProtoHandle;
if (p === 'a') handle = mountProtoA(mapEl, makeFacilities(n), mode);
else handle = mountProtoB(mapEl, makeFacilities(n));

const commitEl = document.getElementById('commit')!;
const confirmBtn = document.getElementById('confirm') as HTMLButtonElement;
const toast = document.getElementById('toast')!;
let last: Commit | null = null;

handle.onCommit((c) => {
  last = c;
  const ok = c.inRange && !c.occupied && c.valid !== false && !c.validating;
  commitEl.innerHTML =
    `<dt>المسافة من المقر الحالي</dt><dd>${formatKm(c.distanceM)}</dd>` +
    `<dt>ضمن النطاق المسموح</dt><dd class="${c.inRange ? 'ok' : 'bad'}">${c.inRange ? '✓ نعم' : '✕ لا'}</dd>` +
    `<dt>الإشغال</dt><dd class="${c.occupied ? 'bad' : 'ok'}">${c.occupied ? '✕ ' + c.occupied : '✓ متاح'}</dd>` +
    `<dt>التحقق</dt><dd>${c.validating ? 'جارٍ التحقق من الخادم…' : ok ? '✓ صالح' : '—'}</dd>`;
  confirmBtn.disabled = !ok;
});
confirmBtn.onclick = () => {
  if (!last) return;
  toast.hidden = false;
  toast.textContent = `تم تثبيت الموقع المقترح على ${last.distanceM >= 1000 ? (last.distanceM / 1000).toFixed(2) + ' كم' : Math.round(last.distanceM) + ' م'} (نموذج فقط — لا يُكتب شيء).`;
};

// Prototype B: optional footprint drawing via Terra Draw
if (p === 'b') {
  const btn = document.getElementById('footprint') as HTMLButtonElement;
  btn.onclick = async () => {
    const started = await (handle as ProtoHandle & { startFootprint(): Promise<boolean> }).startFootprint();
    btn.textContent = started ? '✏︎ ارسم مستطيل المنطقة ثم عدّله' : 'Terra Draw غير متوافق مع هذا الإصدار';
    btn.disabled = true;
  };
}

// expose a tiny surface for the automated driver (no secrets, just geometry + readiness)
(window as unknown as { __proto: Record<string, unknown> }).__proto = Object.assign(
  (window as unknown as { __proto: Record<string, unknown> }).__proto ?? {},
  { info: { p, n, mode }, markerSelector: p === 'a' ? '.pA-prop' : '.pB-prop' },
);
