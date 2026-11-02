// Real measurement, no invented numbers. A continuous rAF loop records frame intervals; a "drag session"
// scopes the sample so we report frame times *during the gesture*. Long tasks come from PerformanceObserver.
// Two counters prove the interaction architecture: heavy (committed-state) updates during a drag, and server
// validations issued during a drag — both must be 0 while the pointer moves in the optimised path.
//
// The Playwright driver reads window.__proto.metrics.snapshot(); nothing here guesses.

export type DragStats = {
  frames: number;
  durationMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  worstMs: number;
  fpsMean: number;
  janky: number; // frames slower than 25ms (~ below 40fps) while dragging
  longTasks: number;
  longTaskMs: number;
  heavyUpdates: number; // committed-state / React-equivalent updates fired during the gesture
  serverValidations: number; // network validations issued during the gesture
};

class Metrics {
  proto = '';
  scene = '';
  mode = '';
  private intervals: number[] = [];
  private lastT = 0;
  private dragging = false;
  private dragStart = 0;
  private longTasks = 0;
  private longTaskMs = 0;
  private heavy = 0;
  private server = 0;
  private instFps = 0;
  dragStarts = 0;
  dragEnds = 0;
  lastDrag: DragStats | null = null;
  private hud: HTMLElement | null = null;
  private live = { distanceM: 0, inRange: true, occupied: '' as string | '' , clamped: '' as string };

  constructor() {
    const loop = (t: number) => {
      if (this.lastT) {
        const dt = t - this.lastT;
        this.instFps = dt > 0 ? 1000 / dt : 0;
        if (this.dragging) this.intervals.push(dt);
      }
      this.lastT = t;
      this.renderHud();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (this.dragging) { this.longTasks++; this.longTaskMs += e.duration; }
        }
      });
      po.observe({ entryTypes: ['longtask'] });
    } catch { /* longtask not supported: reported as 0 */ }
  }

  attachHud(el: HTMLElement) { this.hud = el; this.renderHud(); }

  beginDrag() {
    this.dragging = true;
    this.dragStarts++;
    this.dragStart = performance.now();
    this.intervals = [];
    this.longTasks = 0;
    this.longTaskMs = 0;
    this.heavy = 0;
    this.server = 0;
  }
  endDrag(): DragStats {
    this.dragging = false;
    this.dragEnds++;
    const dur = performance.now() - this.dragStart;
    const xs = this.intervals.slice().sort((a, b) => a - b);
    const q = (p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
    const sum = xs.reduce((a, b) => a + b, 0);
    const mean = xs.length ? sum / xs.length : 0;
    this.lastDrag = {
      frames: xs.length,
      durationMs: Math.round(dur),
      meanMs: +mean.toFixed(2),
      p50Ms: +q(0.5).toFixed(2),
      p95Ms: +q(0.95).toFixed(2),
      worstMs: +(xs[xs.length - 1] ?? 0).toFixed(2),
      fpsMean: +(mean ? 1000 / mean : 0).toFixed(1),
      janky: xs.filter((d) => d > 25).length,
      longTasks: this.longTasks,
      longTaskMs: +this.longTaskMs.toFixed(1),
      heavyUpdates: this.heavy,
      serverValidations: this.server,
    };
    this.renderHud();
    return this.lastDrag;
  }

  /** Called by a prototype when it performs a committed-state update (the thing we want to NOT happen mid-drag). */
  countHeavyUpdate() { if (this.dragging) this.heavy++; }
  /** Called when a server validation is issued. */
  countServerValidation() { if (this.dragging) this.server++; }
  setLive(l: Partial<typeof this.live>) { Object.assign(this.live, l); }

  snapshot() {
    return { proto: this.proto, scene: this.scene, mode: this.mode, instFps: +this.instFps.toFixed(1), dragStarts: this.dragStarts, dragEnds: this.dragEnds, live: { ...this.live }, lastDrag: this.lastDrag };
  }

  private renderHud() {
    if (!this.hud) return;
    const d = this.lastDrag;
    const km = (m: number) => (m >= 1000 ? (m / 1000).toFixed(2) + ' كم' : Math.round(m) + ' م');
    this.hud.innerHTML =
      `<div class="hud-row"><span>FPS الآني</span><b>${this.instFps.toFixed(0)}</b></div>` +
      `<div class="hud-row"><span>المسافة</span><b>${km(this.live.distanceM)}</b></div>` +
      `<div class="hud-row"><span>الحالة</span><b class="${this.live.occupied ? 'bad' : this.live.inRange ? 'ok' : 'bad'}">${
        this.live.occupied ? '⊘ ' + this.live.occupied : this.live.inRange ? '✓ ضمن النطاق' : '✕ خارج النطاق'
      }${this.live.clamped ? ' · ' + this.live.clamped : ''}</b></div>` +
      `<hr/>` +
      (d
        ? `<div class="hud-title">آخر سحب (${d.frames} إطار / ${d.durationMs} مل‌ث)</div>` +
          `<div class="hud-row"><span>متوسط زمن الإطار</span><b>${d.meanMs} مل‌ث · ${d.fpsMean}f/s</b></div>` +
          `<div class="hud-row"><span>p95 / الأسوأ</span><b>${d.p95Ms} / ${d.worstMs} مل‌ث</b></div>` +
          `<div class="hud-row"><span>إطارات متعثرة &gt;25مل‌ث</span><b class="${d.janky ? 'warn' : 'ok'}">${d.janky}</b></div>` +
          `<div class="hud-row"><span>مهام طويلة</span><b class="${d.longTasks ? 'warn' : 'ok'}">${d.longTasks} (${d.longTaskMs}مل‌ث)</b></div>` +
          `<div class="hud-row"><span>تحديثات حالة أثناء السحب</span><b class="${d.heavyUpdates ? 'warn' : 'ok'}">${d.heavyUpdates}</b></div>` +
          `<div class="hud-row"><span>نداءات خادم أثناء السحب</span><b class="${d.serverValidations ? 'warn' : 'ok'}">${d.serverValidations}</b></div>`
        : `<div class="hud-title">اسحب العلامة الخضراء لبدء القياس</div>`);
  }
}

export const metrics = new Metrics();
(window as unknown as { __proto: { metrics: Metrics } }).__proto = { metrics };

/** Coalesce many pointer events into at most one unit of work per animation frame. */
export function rafThrottle<T extends (...a: never[]) => void>(fn: T): T {
  let scheduled = false;
  let lastArgs: unknown[] = [];
  return ((...args: unknown[]) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      (fn as (...a: unknown[]) => void)(...lastArgs);
    });
  }) as T;
}
