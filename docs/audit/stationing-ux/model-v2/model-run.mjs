// Browser evidence for the stationing domain model V2 prototype (owner briefs of 3 Nov 2026): 41 scenarios plus the
// polygon-drag acceptance, at 1920×1080 and 1366×768 first, then 768×1024 and 390×844 (touch). Each step records what
// was done, the states shown, every action with whether it is enabled and why not, each sensitive action's dialog, and
// layout facts; drags assert the GEOGRAPHIC state (centroid moved, area kept, distances recomputed), not pointer movement.
// Owner correction of 3 Nov 2026: ONE proposed site; steps 26–40 are the owner's fifteen coverage items in order, 41 the
// later registration of deployment areas. Areas are drawn by placing vertices on the map, as a user would; distances
// are checked here with the driver's own shortest-distance computation, independent of the page's code.
// Headless Microsoft Edge (playwright-core); fictional data; the prototype must run on :5194.
// Usage (from tests/acceptance): node ../../docs/audit/stationing-ux/model-v2/model-run.mjs        SIZES=768,390 for touch sizes;
// ONLY=23,24,25 for a subset of steps
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = await import(pathToFileURL(fileURLToPath(new URL('../../../../tests/acceptance/lib/browser.mjs', import.meta.url))).href);
const BASE = process.env.PROTO_URL ?? 'http://127.0.0.1:5194/model.html';
const OUT = fileURLToPath(new URL('./', import.meta.url));
const ALL = { 1920: [1920, 1080, false], 1366: [1366, 768, false], 768: [768, 1024, true], 390: [390, 844, true] };
const SIZES = (process.env.SIZES ?? '1920,1366').split(',');
// ONLY=23,24,25 runs those steps alone; their results replace only the same steps in results.json
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const results = [];
const browser = await lib.launch();

// geography in the driver itself, independent of the page's code
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) => 2 * R * Math.asin(Math.sqrt(Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2));
const centre = (ring) => ({ lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length, lng: ring.reduce((s, p) => s + p.lng, 0) / ring.length });
const area = (ring) => {
  const c = centre(ring);
  const xy = ring.map((p) => [rad(p.lng - c.lng) * R * Math.cos(rad(c.lat)), rad(p.lat - c.lat) * R]);
  return Math.abs(xy.reduce((s, [x, y], i) => s + x * xy[(i + 1) % xy.length][1] - xy[(i + 1) % xy.length][0] * y, 0) / 2);
};
/** Shortest distance between two polygons (planar, local metres; enough for the tolerance used). */
const nearestM = (A, B) => {
  const ref = centre([...A, ...B]);
  const k = Math.cos(rad(ref.lat));
  const xy = (p) => [(p.lng - ref.lng) * 111320 * k, (p.lat - ref.lat) * 111320];
  const a = A.map(xy);
  const b = B.map(xy);
  const seg = (p, s, e) => {
    const dx = e[0] - s[0];
    const dy = e[1] - s[1];
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / L)) : 0;
    return Math.hypot(p[0] - s[0] - t * dx, p[1] - s[1] - t * dy);
  };
  let best = Infinity;
  for (const p of a) b.forEach((s, i) => (best = Math.min(best, seg(p, s, b[(i + 1) % b.length]))));
  for (const p of b) a.forEach((s, i) => (best = Math.min(best, seg(p, s, a[(i + 1) % a.length]))));
  return best;
};
const km = (t) => {
  const m = /([\d.,]+)\s*(كم|م)/.exec(t ?? '');
  return m ? Number(m[1].replace(',', '')) * (m[2] === 'كم' ? 1000 : 1) : NaN;
};

async function facts(page) {
  return page.evaluate(() => {
    const dock = document.querySelector('.md-dock')?.getBoundingClientRect();
    const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const tags = [...document.querySelectorAll('.md-tag')].filter((t) => getComputedStyle(t).visibility !== 'hidden');
    const m = document.querySelector('.ux-map')?.getBoundingClientRect();
    const scale = document.querySelector('.leaflet-control-scale')?.getBoundingClientRect();
    const zoom = document.querySelector('.leaflet-control-zoom')?.getBoundingClientRect();
    return {
      states: [...document.querySelectorAll('.md-dock [data-state]')].map((e) => e.getAttribute('data-state')),
      actions: [...document.querySelectorAll('.md-act')].map((a) => ({ act: a.querySelector('button')?.dataset.act, label: a.querySelector('button')?.textContent?.trim(), enabled: !a.querySelector('button')?.disabled, why: a.querySelector('.md-why')?.textContent ?? null })),
      tags: tags.map((t) => t.className.replace('md-tag ', '') + ': ' + t.textContent.trim()),
      sheet: document.querySelector('.md-dock')?.getAttribute('data-sheet'),
      dockShare: dock && m ? Math.round((dock.height / m.height) * 100) : null,
      tagsUnderCard: tags.filter((t) => hit(t.getBoundingClientRect(), dock)).map((t) => t.textContent.trim()),
      tagOverlaps: tags.flatMap((a, i) => tags.slice(i + 1).filter((b) => hit(a.getBoundingClientRect(), b.getBoundingClientRect())).map((b) => a.textContent.trim() + ' ⟷ ' + b.textContent.trim())),
      tagsClipped: m ? tags.filter((t) => { const r = t.getBoundingClientRect(); return r.left < m.left - 1 || r.right > m.right + 1; }).map((t) => t.textContent.trim()) : [],
      scaleOverTag: tags.filter((t) => hit(t.getBoundingClientRect(), scale)).map((t) => t.textContent.trim()),
      controlsOverSheet: !!(dock && ((zoom && zoom.bottom > dock.top + 1 && zoom.top < dock.bottom) || (scale && scale.bottom > dock.top + 1 && scale.top < dock.bottom))) && getComputedStyle(document.querySelector('.md-dock')).position === 'absolute' && document.querySelector('.ux.phone') !== null,
      horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

for (const size of SIZES) {
  const [width, height, touch] = ALL[size];
  const ctx = await lib.newContext(browser, { viewport: { width, height }, ...(touch ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  lib.watch(page, 'model ' + size);
  mkdirSync(OUT + 'screenshots/' + size, { recursive: true });
  const settle = (ms = 900) => page.waitForTimeout(ms);
  const open = async (n) => {
    await page.goto('about:blank');
    await page.goto(BASE + '#s=' + n);
    await page.locator('.md-card').first().waitFor({ timeout: 15000 });
    await settle(1400);
  };
  const actor = async (id) => {
    await page.selectOption('[data-testid=actor]', id);
    await settle(400);
  };
  const shot = async (name) => {
    const file = 'screenshots/' + size + '/' + name + '.png';
    await page.screenshot({ path: OUT + file });
    return file;
  };
  const text = (sel) => page.locator(sel).first().innerText().catch(() => '');
  const action = async (label) => (await facts(page)).actions.find((a) => a.label?.includes(label));
  const byAct = async (t) => (await facts(page)).actions.find((a) => a.act === t);
  const tap = async (loc) => (touch ? loc.tap() : loc.click());
  const dialogs = [];
  /** A sensitive action through its own dialog: confirmation impossible without a reason, then confirmed with one. */
  const confirm = async (loc, { reason = 'سبب موثق للإجراء في المحاكاة', policy, snap } = {}) => {
    await tap(typeof loc === 'string' ? page.locator(loc).first() : loc);
    const d = page.locator('[data-testid=action-dialog]');
    await d.waitFor({ timeout: 5000 });
    const info = {
      action: await d.getAttribute('data-action'),
      title: await d.locator('h3').innerText(),
      record: await d.locator('[data-testid=dialog-record]').innerText(),
      consequence: await d.locator('[data-testid=dialog-consequence]').innerText(),
      actor: await d.locator('[data-testid=dialog-actor]').innerText(),
      confirmDisabledWithoutReason: await d.locator('[data-testid=dialog-confirm]').isDisabled(),
    };
    await d.locator('[data-testid=dialog-reason]').fill(reason);
    if (policy) {
      info.confirmDisabledWithoutPolicy = await d.locator('[data-testid=dialog-confirm]').isDisabled();
      await d.locator('[data-testid=dialog-policy]').fill(policy);
    }
    const file = snap ? await shot(snap) : null;
    await d.locator('[data-testid=dialog-confirm]').click();
    await settle();
    dialogs.push({ size, ...info });
    return { info, file };
  };
  const model = () => page.evaluate(() => {
    const m = window.__stationingModel;
    return { world: m.world, center: m.map.getCenter(), sheet: m.sheet };
  });
  const screenOf = (p) =>
    page.evaluate(([lat, lng]) => {
      const m = window.__stationingModel.map;
      const pt = m.latLngToContainerPoint([lat, lng]);
      const r = m.getContainer().getBoundingClientRect();
      return { x: r.left + pt.x, y: r.top + pt.y };
    }, [p.lat, p.lng]);
  /** Drags the proposal by its symbol handle — mouse, or touch through CDP — and waits for the committed state. */
  const drag = async (dx, dy) => {
    const b = await page.locator('.stw-prop-sym').first().boundingBox();
    const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    if (touch) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
      for (let i = 1; i <= 24; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (dx * i) / 24, y: from.y + (dy * i) / 24 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + dx, from.y + dy, { steps: 24 });
      await page.mouse.up();
    }
    await settle(1100);
  };
  /** Draws an area as a user would: six vertices placed on the map around a centre (the engine closes it at the sixth). */
  const drawArea = async (lat, lng, r = 420, zoom = 13) => {
    // centred in the part of the map a user sees: above the phone's sheet and clear of the map's own controls
    await page.evaluate(([la, ln, z]) => {
      const m = window.__stationingModel.map;
      m.setView([la, ln], z, { animate: false });
      const box = m.getContainer().getBoundingClientRect();
      const dock = document.querySelector('.ux.phone .md-dock')?.getBoundingClientRect();
      const bottom = dock ? Math.min(box.bottom, dock.top) - 60 : box.bottom;
      m.panBy([0, box.top + box.height / 2 - (box.top + bottom) / 2], { animate: false });
    }, [lat, lng, zoom]);
    await settle(500);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const s = await screenOf({ lat: lat + (Math.sin(a) * r) / 111320, lng: lng + (Math.cos(a) * r) / (111320 * Math.cos(rad(lat))) });
      if (touch) await page.touchscreen.tap(s.x, s.y);
      else await page.mouse.click(s.x, s.y);
      await page.waitForTimeout(150);
    }
    await settle(900);
  };
  const pick = async (t) => {
    await tap(page.locator('[data-target=' + t + ']').first());
    await settle(1300);
  };
  /** A step of the request editor; on a phone the collapsed sheet is raised first, as a user would. */
  const toStep = async (n) => {
    if (touch && (await page.locator('.md-dock').getAttribute('data-sheet')) === 'collapsed') {
      await tap(page.locator('[data-testid=sheet-handle]'));
      await settle(500);
    }
    await tap(page.getByRole('button', { name: new RegExp('^' + n + ' ') }));
    await settle(1000);
  };

  const step = async (n, name, run) => {
    if (ONLY && !ONLY.has(String(n))) return;
    const checks = [];
    const expect = (ok, what) => checks.push({ ok: !!ok, what });
    let error = null;
    let shots = [];
    const measures = {};
    try {
      shots = (await run(expect, measures)) ?? [];
    } catch (e) {
      error = String(e.message ?? e).split('\n')[0];
      shots = [await shot(String(n).padStart(2, '0') + '-' + name + '-ERROR')];
    }
    const f = await facts(page);
    const pass = !error && checks.every((c) => c.ok);
    results.push({ size, scenario: n, name, pass, error, checks, shots, measures, facts: f });
    console.log((pass ? 'PASS ' : 'FAIL ') + size + ' ' + n + ' ' + name + (error ? ' — ' + error : '') + checks.filter((c) => !c.ok).map((c) => ' ✕ ' + c.what).join(''));
  };
  const dialogOk = (expect, r, what) => {
    expect(r.info.confirmDisabledWithoutReason, what + ': confirmation impossible without a reason');
    expect(r.info.record && r.info.consequence && r.info.actor.includes('محاكاة'), what + ': dialog states record, consequence and simulated actor');
  };

  await step(1, 'current-stationing', async (expect) => {
    await open(1);
    const t = await text('.md-card');
    expect(t.includes('التمركز الدائم') && t.includes('المبنى المشترك'), 'card shows the permanent stationing and its main site');
    expect((await page.locator('.md-tag.area-p').count()) === 0, 'associated areas hidden by default');
    return [await shot('01-current-stationing')];
  });
  await step(2, 'associated-areas', async (expect) => {
    await open(2);
    expect((await page.locator('.md-tag.area-p').count()) === 1 && (await page.locator('.md-tag.area-a').count()) === 1, 'both associated areas drawn and named');
    expect((await text('.md-card')).includes('قرار خارجي'), 'external-decision provenance shown');
    expect((await text('[data-testid=covered-scope]')).includes('قسم الصيانة الإدارية'), 'explicit covered scope shown');
    return [await shot('02-associated-areas')];
  });
  await step(3, 'whole-permanent', async (expect) => {
    await open(3);
    expect(await page.locator('[data-testid=step-compare]').isVisible(), 'route and submission step');
    expect((await text('[data-testid=step-compare]')).includes('دائم'), 'permanent');
    const cmp = await text('[data-testid=compare]');
    expect(cmp.includes('للمعلومة فقط') && cmp.includes('لا قاعدة مسافة بين التمركز الحالي والموقع المقترح'), 'one proposed site; its distance from the current site is information only');
    expect(!cmp.includes('البديل المقترح') && (await page.locator('.md-compare thead th').count()) === 3, 'no second proposed site: current and proposed columns only');
    expect(cmp.includes('لم تُرسم (اختيارية)') && !(await page.locator('[data-act=SUBMIT]').isDisabled()), 'optional policy: submission possible without deployment areas');
    return [await shot('03-whole-permanent')];
  });

  // B1: actual polygon dragging of the ONE proposed site — the geographic state must change
  await step('B1', 'polygon-drag', async (expect, ms) => {
    await open(3);
    await toStep(3);
    await page.locator('.stw-prop-sym').first().waitFor({ timeout: 8000 });
    await settle(1200);
    if (touch) expect((await model()).sheet === 'collapsed' && (await page.locator('[data-testid=compact-status]').isVisible()), 'phone: the sheet steps down to its working height with a compact readout');
    const req = (w) => w.requests.find((r) => r.id === 'r-pm-bld');
    const cur = await page.evaluate(() => {
      const w = window.__stationingModel.world;
      const s = w.stationings.find((x) => x.org === 'o-pm-bld' && x.kind === 'PERMANENT' && x.state === 'CURRENT');
      return w.sites.find((x) => x.id === s.siteId).ring;
    });
    const readout = async () => text(touch ? '[data-testid=compact-readout]' : '[data-testid=readout-site]');
    const shots = [await shot('B1-1-site-before')];
    let s0 = await model();
    const p0 = req(s0.world).proposal.ring;
    const r0 = await readout();
    await drag(110, -50);
    let s1 = await model();
    const p1 = req(s1.world).proposal.ring;
    ms.siteMoveM = Math.round(dist(centre(p0), centre(p1)));
    ms.siteAreaChangePct = +((Math.abs(area(p1) - area(p0)) / area(p0)) * 100).toFixed(4);
    ms.mapPannedM = Math.round(dist(s0.center, s1.center));
    const d1 = nearestM(cur, p1);
    const r1 = await readout();
    expect(ms.siteMoveM > 80, 'proposed site moved on the map (' + ms.siteMoveM + ' m)');
    expect(ms.siteAreaChangePct < 0.5, 'shape and area kept by the engine (Δ ' + ms.siteAreaChangePct + ' %)');
    expect(ms.mapPannedM < 5, (touch ? 'touch' : 'mouse') + ' drag moved the proposal, not the base map (map moved ' + ms.mapPannedM + ' m)');
    expect(r1 !== r0 && Math.abs(km(r1) - d1) < 60, 'shortest distance from the current site recomputed (' + r1.split('·')[0] + ' ≈ ' + Math.round(d1) + ' m)');
    shots.push(await shot('B1-2-site-moved'));
    // towards the current site, to about 2.5 km: the proposed site has NO distance rule, so the request stays valid
    const a = await screenOf(centre(cur));
    const b = await screenOf(centre(p1));
    const dc = dist(centre(cur), centre(p1));
    const f = 1 - 2500 / dc;
    await drag((a.x - b.x) * f, (a.y - b.y) * f);
    const s2 = await model();
    const d2 = nearestM(cur, req(s2.world).proposal.ring);
    ms.closeDistanceM = Math.round(d2);
    const rr = await readout();
    expect(d2 < 5000 && !rr.includes('✕') && !(await page.locator('[data-testid=next]').first().isDisabled()), 'no distance rule on the proposed site: ' + Math.round(d2) + ' m from the current site is still valid');
    if (!touch) expect((await text('[data-testid=readout-site]')).includes('للمعلومة فقط'), 'the readout says the distance is information only');
    shots.push(await shot('B1-3-site-close-still-valid'));
    if (touch) {
      // B4: the sheet's three heights; controls above it; nothing trapped
      const heights = {};
      for (const want of ['medium', 'expanded', 'collapsed']) {
        await tap(page.locator('[data-testid=sheet-handle]'));
        await settle(700);
        const f2 = await facts(page);
        heights[want] = f2.dockShare;
        expect(f2.sheet === want, 'sheet ' + want);
        expect(!f2.controlsOverSheet, 'map controls above the sheet when ' + want);
        expect(f2.scaleOverTag.length === 0, 'scale bar covers no status tag when ' + want);
        if (want === 'expanded') shots.push(await shot('B1-5-sheet-expanded'));
      }
      ms.sheetSharePct = heights;
      expect(heights.collapsed < 30 && heights.medium < 60 && heights.expanded > 70, 'collapsed / medium / expanded heights ' + JSON.stringify(heights));
    }
    return shots;
  });

  await step(4, 'whole-temporary', async (expect) => {
    await open(4);
    expect((await text('[data-testid=step-compare]')).includes('مؤقت'), 'temporary with dates');
    const a = await shot('04-whole-temporary');
    await toStep(2);
    expect(await page.locator('[data-testid=step-duration] input[type=date]').nth(1).isVisible(), 'end date is mandatory for temporary');
    return [a, await shot('04b-temporary-dates')];
  });
  await step(5, 'partial-temporary', async (expect) => {
    await open(5);
    expect(await page.locator('[data-testid=step-scope] input[type=checkbox]:checked').count(), 'a selected sub-unit');
    return [await shot('05-partial-scope')];
  });
  await step(6, 'comparison', async (expect) => {
    await open(6);
    const cmp = await text('[data-testid=compare]');
    expect(await page.locator('[data-testid=compare]').isVisible(), 'comparison table');
    expect(cmp.includes('للمعلومة فقط'), 'the distance from the current site is information only');
    expect(cmp.includes('منطقة الانتشار الرئيسية') && cmp.includes('منطقة الانتشار البديلة'), 'the owner\'s deployment-area terms');
    expect((await page.locator('.md-compare thead th').count()) === 3, 'one proposed site');
    return [await shot('06-current-proposed-deployment')];
  });
  await step(7, 'return-resubmit', async (expect, ms) => {
    await open(7);
    expect((await facts(page)).states.includes('RETURNED_FOR_CHANGES'), 'returned for changes');
    await page.locator('.stw-prop-sym').first().waitFor({ timeout: 8000 });
    await settle(900);
    await drag(90, 60);
    await toStep(4);
    expect((await text('[data-testid=returned]')).includes('الموقع ومنطقتا الانتشار'), 'the changed fact is shown');
    const a = await shot('07a-returned-site-changed');
    const r = await confirm('button[data-act=RESUBMIT]', { reason: 'موقع جديد بلا تعارض مع أعمال الصيانة', snap: '07-dialog-resubmit' });
    dialogOk(expect, r, 'resubmission');
    const marks = await page.locator('[data-testid=route] li[data-stage]').evaluateAll((els) => els.map((e) => e.dataset.stage + ':' + e.dataset.mark));
    ms.marks = marks;
    expect(JSON.stringify(marks) === JSON.stringify(['h-o-ss:INVALIDATED', 'site:INVALIDATED', 'scope:CARRIED', 'final:']), 'site decisions invalidated, the scope review carried (D18): ' + marks.join(' '));
    expect((await text('[data-testid=events]')).includes('WORKFLOW_INVALIDATION'), 'invalidation audited');
    return [a, r.file, await shot('07b-resubmitted-invalidated-carried')];
  });
  await step(8, 'approved-not-activated', async (expect) => {
    await open(8);
    const blocked = await byAct('ACTIVATE');
    expect(blocked && !blocked.enabled && blocked.why.includes('صاحب الاعتماد النهائي'), 'final approver blocked by separation of duties');
    const a = await shot('08a-final-approver-blocked');
    await actor('p-apr-del');
    const del = await byAct('ACTIVATE');
    expect(del && !del.enabled && del.why.includes('التفويض'), 'their delegate is blocked too');
    await actor('p-act');
    expect((await byAct('ACTIVATE'))?.enabled, 'independent activator may activate');
    const b = await shot('08b-independent-activator');
    await tap(page.locator('button[data-act=ACTIVATE]'));
    await page.locator('[data-testid=action-dialog]').waitFor({ timeout: 5000 });
    expect(await page.locator('[data-testid=dialog-confirm]').isDisabled(), 'activation dialog: no confirmation without a reason');
    const c = await shot('08c-activation-dialog');
    await page.getByRole('button', { name: 'تراجع' }).click();
    return [a, b, c];
  });
  await step(9, 'temporary-scheduled', async (expect) => {
    await open(9);
    expect((await facts(page)).states.includes('TEMPORARY_SCHEDULED'), 'activated, not started');
    const er = await action('عودة مبكرة');
    expect(!er, 'no «early return» before the start');
    const a = await shot('09-temporary-scheduled');
    await tap(page.getByRole('button', { name: '+أسبوع' }));
    await settle();
    expect((await facts(page)).states.includes('ACTIVE_TEMPORARY'), 'starts at its authorised start (simulated time)');
    return [a];
  });
  await step(10, 'temporary-active', async (expect) => {
    await open(10);
    expect(await page.locator('[data-testid=effective-temporary]').isVisible(), 'effective temporary stationing shown');
    expect((await text('.md-card')).includes('التمركز الدائم'), 'permanent stationing kept');
    expect(await page.locator('[data-testid=a3-note]').isVisible(), 'the permanent associated areas stay in force (A3)');
    return [await shot('10-temporary-active')];
  });
  await step(11, 'extension', async (expect) => {
    await open(11);
    expect((await facts(page)).states.includes('EXTENSION_APPROVED_NOT_ACTIVATED'), 'extension approved, not activated');
    const b = await byAct('ACTIVATE_EXTENSION');
    expect(b && !b.enabled && b.why.includes('اعتمد التمديد'), 'its approver cannot activate it');
    const a = await shot('11a-extension-approved-not-activated');
    await actor('p-act');
    const r = await confirm('button[data-act=ACTIVATE_EXTENSION]', { snap: '11-dialog-extension' });
    dialogOk(expect, r, 'extension activation');
    expect((await facts(page)).states.includes('EXTENSION_ACTIVATED'), 'extension activated');
    return [a, r.file, await shot('11b-extension-activated')];
  });
  await step(12, 'early-return', async (expect) => {
    await open(12);
    const b = await action('قبول العودة المبكرة');
    expect(b && !b.enabled && b.why.includes('طالب العودة'), 'the requester (linked account) cannot decide');
    const a = await shot('12a-early-return-requested');
    await actor('p-dec');
    const r = await confirm(page.getByRole('button', { name: /قبول العودة المبكرة/ }), { snap: '12-dialog-early-return' });
    dialogOk(expect, r, 'early return');
    expect((await facts(page)).states.includes('TEMPORARY_ENDED'), 'temporary ended');
    expect((await text('[data-testid=early-return]')).includes('النهاية الفعلية'), 'original and actual end recorded');
    return [a, r.file, await shot('12b-early-return-decided')];
  });
  await step(13, 'permanent-during-temporary', async (expect) => {
    await open(13);
    expect(await page.locator('[data-testid=supersedes]').isVisible(), 'approval shows the temporary stationing that ends at activation');
    expect((await action('ذرياً'))?.enabled, 'atomic activation available to the independent activator');
    return [await shot('13-permanent-approved-during-temporary')];
  });
  await step(14, 'atomic-transition', async (expect) => {
    await open(14);
    const r = await confirm('button[data-act=ACTIVATE]', { snap: '14-dialog-atomic' });
    dialogOk(expect, r, 'atomic activation');
    expect(r.info.consequence.includes('عملية واحدة'), 'the dialog states the atomic consequence');
    const ev = await text('[data-testid=events]');
    expect((await facts(page)).states.includes('ACTIVATED_PERMANENT'), 'permanent activated');
    expect(ev.includes('STATIONING_TEMPORARY_SUPERSEDED') && ev.includes('SUPERSEDED_BY_PERMANENT_STATIONING') && ev.includes('activationRef'), 'supersession recorded with its reason and activation reference (A1)');
    const a = await shot('14a-atomic-transition-request');
    await tap(page.locator('.md-head .ux-x'));
    await settle();
    expect((await page.locator('[data-testid=effective-temporary]').count()) === 0, 'no temporary stationing left active');
    expect((await text('.md-card')).includes('مجمع التقنية الدائم المقترح'), 'new permanent stationing');
    expect((await text('[data-testid=history]')).includes('حلّ محله تمركز دائم معتمد'), 'the superseded temporary and replaced permanent stationing stay in history');
    return [r.file, a, await shot('14b-atomic-transition-organisation')];
  });
  await step(15, 'cancellation-pending', async (expect) => {
    await open(15);
    const r = await confirm('button[data-act=REQUEST_CANCEL]');
    dialogOk(expect, r, 'cancellation request');
    expect((await facts(page)).states.includes('CANCELLATION_PENDING'), 'cancellation pending state');
    await actor('p-act');
    const b = await byAct('ACTIVATE');
    expect(b && !b.enabled && b.why.includes('محجوب'), 'activation blocked while cancellation is pending');
    return [await shot('15-cancellation-pending-blocks-activation')];
  });
  await step(16, 'cancellation-rejected', async (expect) => {
    await open(16);
    const r = await confirm(page.getByRole('button', { name: /رفض الإلغاء/ }), { snap: '16-dialog-cancellation-decision' });
    dialogOk(expect, r, 'cancellation decision');
    expect((await facts(page)).states.includes('APPROVED_NOT_ACTIVATED'), 'back to approved, not activated');
    await actor('p-act');
    expect((await byAct('ACTIVATE'))?.enabled, 'activation available again');
    return [r.file, await shot('16-cancellation-rejected-activation-available')];
  });
  await step(17, 'permanent-site-while-away', async (expect) => {
    await open(17);
    expect(await page.locator('[data-testid=absence-note]').isVisible(), 'absence does not imply availability');
    await tap(page.locator('[data-testid=facility-use]'));
    await settle(300);
    expect(await page.locator('[data-testid=facility-use-note]').isVisible(), 'a separate facility-use process');
    return [await shot('17-permanent-site-separate-process')];
  });
  await step(18, 'parent-partial-temporary', async (expect) => {
    await open(18);
    expect((await page.locator('.md-tag.group').count()) === 1, 'one grouped badge for the temporarily relocated units');
    const a = await shot('18a-parent-units-collapsed');
    await tap(page.locator('[data-testid=toggle-temps]'));
    await settle();
    expect((await page.locator('.md-tag.temp').count()) >= 2, 'temporary sites revealed on request');
    return [a, await shot('18b-parent-units-expanded')];
  });
  await step(19, 'temporary-cancelled-before-start', async (expect) => {
    await open(19);
    const r1 = await confirm('button[data-act=REQUEST_START_CANCEL]');
    dialogOk(expect, r1, 'cancel-before-start request');
    await actor('p-req-dir');
    const self = await action('قبول الإلغاء قبل البدء');
    expect(self && !self.enabled, 'the requester (any linked account) cannot decide it');
    await actor('p-dec');
    const r = await confirm(page.getByRole('button', { name: /قبول الإلغاء قبل البدء/ }), { snap: '19-dialog-cancel-before-start' });
    dialogOk(expect, r, 'cancel-before-start decision');
    expect((await facts(page)).states.includes('TEMPORARY_CANCELLED_BEFORE_START'), 'cancelled before start');
    expect((await text('[data-testid=start-cancellation]')).includes('ACT-MV-2026-0407'), 'activation reference, planned start and end recorded');
    const a = await shot('19a-cancelled-before-start');
    await tap(page.getByRole('button', { name: '+أسبوع' }));
    await settle();
    expect((await facts(page)).states.includes('TEMPORARY_CANCELLED_BEFORE_START'), 'the start job never activates it (simulated time past the start)');
    await tap(page.locator('.md-head .ux-x'));
    await settle();
    expect((await page.locator('[data-testid=effective-temporary]').count()) === 0, 'permanent stationing remains authoritative');
    expect((await text('[data-testid=history]')).includes('أُلغي قبل بدء النفاذ'), 'the activated-then-cancelled record stays in history');
    return [a, await shot('19b-organisation-after-cancel-before-start')];
  });
  await step(20, 'covered-child-no-self-conflict', async (expect) => {
    await open(20);
    expect((await page.locator('[data-testid=clash-exempt]').count()) === 1 && (await page.locator('[data-testid=clash-blocking]').count()) === 0, 'the parent area overlaps, but does not block a covered unit');
    expect((await text('[data-testid=verdict]')).includes('لا تعارض'), 'verdict: no conflict');
    await tap(page.locator('button[data-act=CONFIRM_RESERVATION]'));
    await settle();
    expect((await facts(page)).states.includes('ACTIVE'), 'reservation confirmed');
    return [await shot('20-covered-child-no-self-conflict')];
  });
  await step(21, 'uncovered-unit-conflict', async (expect) => {
    await open(21);
    expect((await page.locator('[data-testid=clash-blocking]').count()) === 1, 'the same area blocks a unit outside its explicit scope');
    expect((await text('[data-testid=availability]')).includes('غير مدرجة صراحةً'), 'explained: a sub-unit not explicitly included');
    await tap(page.locator('button[data-act=CONFIRM_RESERVATION]'));
    await settle();
    expect((await facts(page)).states.includes('BLOCKED'), 'blocked by default');
    return [await shot('21-uncovered-unit-blocked')];
  });
  await step(22, 'external-conflict-exception', async (expect) => {
    await open(22);
    await tap(page.locator('button[data-act=CONFIRM_RESERVATION]'));
    await settle();
    expect((await facts(page)).states.includes('BLOCKED'), 'spatial + time conflict: BLOCK');
    expect((await text('[data-testid=availability]')).includes('تداخل زمني'), 'the time overlap is explained');
    const a = await shot('22a-external-conflict-blocked');
    const r = await confirm('button[data-act=REQUEST_EXCEPTION]', { policy: 'سياسة مشاركة وهمية م-12', snap: '22-dialog-exception-request' });
    expect(r.info.confirmDisabledWithoutPolicy, 'no exception request without a policy reference');
    expect((await facts(page)).states.includes('EXCEPTION_REQUESTED'), 'exception requested');
    await actor('p-req');
    const no = await action('اعتماد الاستثناء');
    expect(no && !no.enabled && no.why.includes('APPROVE_AVAILABILITY_EXCEPTION'), 'only an authorised approver may decide');
    await actor('p-avl');
    const r2 = await confirm('button[data-act=DECIDE_EXCEPTION]', { snap: '22-dialog-exception-approval' });
    dialogOk(expect, r2, 'exception approval');
    expect((await facts(page)).states.includes('ACTIVE'), 'reservation active under the exception');
    const ev = await text('[data-testid=events]');
    expect(ev.includes('AREA_EXCEPTION_APPROVED') && ev.includes('سياسة مشاركة وهمية م-12'), 'audit event with the policy reference');
    return [a, r.file, r2.file, await shot('22b-exception-approved-audited')];
  });
  // owner correction of 3 Nov 2026: a start cancellation still pending at the planned start holds the start
  await step(23, 'held-start-rejected-after-start', async (expect) => {
    await open(23);
    expect((await facts(page)).states.includes('START_HELD_PENDING_CANCELLATION'), 'start held at the planned start while the cancellation is pending');
    expect((await text('[data-testid=start-held]')).includes('البدء موقوف'), 'the hold is explained: not effective, the permanent stationing applies');
    expect((await text('[data-testid=events]')).includes('STATIONING_START_HELD'), 'the start job recorded the hold instead of starting');
    expect((await byAct('REQUEST_EARLY_RETURN')) === undefined, 'no early return: nothing has started');
    const a = await shot('23a-start-held');
    await actor('p-req-dir');
    const self = await action('رفض الإلغاء وبدء النفاذ الآن');
    expect(self && !self.enabled, 'the requester (any linked account) cannot decide it');
    await actor('p-dec');
    const r = await confirm(page.getByRole('button', { name: /رفض الإلغاء وبدء النفاذ الآن/ }), { snap: '23-dialog-reject-after-start' });
    dialogOk(expect, r, 'rejection after the planned start');
    expect(r.info.consequence.includes('لا بأثر رجعي'), 'the dialog states that the start is not backdated');
    expect((await facts(page)).states.includes('ACTIVE_TEMPORARY'), 'effective from the decision');
    const late = await text('[data-testid=late-start]');
    expect(late.includes('بداية معتمدة') && late.includes('بداية النفاذ الفعلية'), 'approved start and actual effective start shown separately');
    const ev = await text('[data-testid=events]');
    expect(['plannedStart', 'actualEffectiveStart', 'decidedAt', 'decisionReason'].every((k) => ev.includes(k)), 'planned start, actual start, decision time and reason recorded');
    const m = await model();
    const t = m.world.stationings.find((s) => s.id === 'tmp-o-hr-rec');
    expect(t.from === m.world.now && t.plannedStart < t.from && t.plannedEnd === m.world.requests.find((x) => x.id === 'r-hr-rec').duration.end, 'effective start = decision time, not backdated; approved end unchanged');
    const b = await shot('23b-rejected-after-start-effective-from-decision');
    await tap(page.locator('.md-head .ux-x'));
    await settle();
    expect(await page.locator('[data-testid=org-late-start]').isVisible(), 'the organisation shows the late effective start');
    return [a, r.file, b, await shot('23c-organisation-late-start')];
  });
  await step(24, 'held-window-expired', async (expect) => {
    await open(24);
    expect((await facts(page)).states.includes('START_HELD_PENDING_CANCELLATION'), 'held');
    const a = await shot('24a-held-before-planned-end');
    await tap(page.getByRole('button', { name: '+أسبوع' }));
    await settle();
    const st = (await facts(page)).states;
    expect(st.includes('TEMPORARY_WINDOW_EXPIRED_WITHOUT_START') && st.includes('NO_LONGER_ACTIONABLE'), 'closed as never effective; the cancellation no longer actionable');
    expect(await page.locator('[data-testid=window-expired]').isVisible(), 'window expiry explained');
    expect((await byAct('DECIDE_START_CANCEL')) === undefined, 'no decision can be taken any more');
    const sc = await text('[data-testid=start-cancellation]');
    expect(sc.includes('لم يعد قابلاً للقرار') && sc.includes('انقضت نافذة النفاذ دون بدء') && sc.includes('تأجل مشروع التوظيف'), 'the cancellation is kept with its own reason and the closing reason');
    const ev = await text('[data-testid=events]');
    expect(ev.includes('STATIONING_TEMPORARY_WINDOW_EXPIRED_WITHOUT_START') && ev.includes('TEMPORARY_START_CANCELLATION_NO_LONGER_ACTIONABLE') && !ev.includes('STATIONING_TEMPORARY_STARTED'), 'both closures recorded; never started');
    const b = await shot('24b-window-expired-without-start');
    await tap(page.locator('.md-head .ux-x'));
    await settle();
    expect((await page.locator('[data-testid=effective-temporary]').count()) === 0, 'the permanent stationing remained authoritative');
    expect((await text('[data-testid=history]')).includes('حتى انقضت نافذته'), 'the never-effective record stays in history');
    return [a, b, await shot('24c-organisation-history')];
  });
  await step(25, 'rejected-before-start', async (expect) => {
    await open(25);
    const st = (await facts(page)).states;
    expect(st.includes('TEMPORARY_SCHEDULED') && st.includes('REQUESTED'), 'activated, not started, cancellation pending');
    const r = await confirm(page.getByRole('button', { name: 'رفض', exact: true }), { snap: '25-dialog-reject-before-start' });
    dialogOk(expect, r, 'rejection before the planned start');
    expect(r.info.consequence.includes('بدايته المعتمدة'), 'the dialog states it starts at the approved start');
    expect((await facts(page)).states.includes('TEMPORARY_SCHEDULED'), 'back to waiting for the start');
    const a = await shot('25a-rejected-before-start');
    await tap(page.getByRole('button', { name: '+أسبوع' }));
    await settle();
    expect((await facts(page)).states.includes('ACTIVE_TEMPORARY'), 'started by the start job');
    const m = await model();
    const t = m.world.stationings.find((s) => s.id === 'tmp-o-hr-rec');
    expect(t.from === t.plannedStart && !t.startRef, 'effective from the ORIGINAL approved start');
    expect((await page.locator('[data-testid=late-start]').count()) === 0, 'no late-start notice');
    return [r.file, a, await shot('25b-started-at-original-start')];
  });

  // owner correction of 3 Nov 2026: one proposed site, a hierarchical route, policies, deployment package (items 1–15)
  const stagesOf = () => page.locator('[data-testid=route] li[data-stage]').evaluateAll((els) => els.map((e) => e.dataset.stage));
  const marksOf = () => page.locator('[data-testid=route] li[data-stage]').evaluateAll((els) => els.map((e) => e.dataset.mark));
  const policy = (k) => page.locator('[data-testid=policy-' + k + ']').evaluate((e) => ({ value: e.dataset.value, version: e.dataset.version }));
  const approveAs = async (who) => {
    await actor(who);
    await tap(page.locator('button[data-act=APPROVE_STAGE]').first());
    await settle(700);
  };
  await step(26, 'child-permanent', async (expect) => {
    await open(26);
    const st = await stagesOf();
    expect(JSON.stringify(st) === JSON.stringify(['h-o-pm-bld-sv', 'h-o-pm-bld', 'h-o-pm', 'site', 'scope', 'final']), 'route derived from the hierarchy above the child unit: three levels, the configured reviews, the final decision');
    const roles = await page.locator('[data-testid=participants] li').evaluateAll((els) => els.map((e) => e.dataset.role));
    expect(roles.filter((r) => r === 'APPROVER').length === 3 && roles.includes('FINAL') && roles.includes('REQUESTER') && roles.includes('ACTIVATION'), 'participants determined by the system and shown to the requester');
    expect(await page.locator('[data-testid=route-locked]').isVisible(), 'the requester cannot alter the system-selected routing');
    expect(!(await page.locator('[data-act=SUBMIT]').isDisabled()), 'submission possible');
    await page.locator('[data-testid=route]').scrollIntoViewIfNeeded();
    return [await shot('26-child-permanent-route')];
  });
  await step(27, 'child-temporary', async (expect) => {
    await open(27);
    const st = await stagesOf();
    expect(JSON.stringify(st) === JSON.stringify(['h-o-ss-mt', 'site', 'final']), 'temporary: the parent, the site review, the final decision at the top-level directorate');
    expect((await text('[data-testid=route] li[data-stage=final]')).includes('الخدمات المشتركة'), 'final scope: the requester\'s top-level directorate');
    await page.locator('[data-testid=route]').scrollIntoViewIfNeeded();
    return [await shot('27-child-temporary-route')];
  });
  await step(28, 'required-complete', async (expect, ms) => {
    await open(28);
    expect((await page.locator('[data-testid=policy-badge]').first().getAttribute('data-value')) === 'REQUIRED', 'required policy in force');
    expect(touch || (await text('[data-testid=readout-site]')).includes('للمعلومة فقط'), 'the proposed site has no distance rule');
    const a = await shot('28a-site-no-rule');
    await pick('PRIMARY_AREA');
    expect(await page.locator('[data-testid=live-distance]').isVisible(), 'live distance measured by the profile method while editing');
    const req = (w) => w.requests.find((r) => r.id === 'r-hr-trn');
    let m = await model();
    const site = req(m.world).proposal.ring;
    const p0 = req(m.world).proposal.areas.PRIMARY_AREA;
    ms.nearestBeforeM = Math.round(nearestM(site, p0));
    // about 3 km from the site (nearest geometry): out of the configured 5–8 km
    const s = await screenOf(centre(site));
    const q = await screenOf(centre(p0));
    const f = 1 - 3500 / dist(centre(site), centre(p0));
    await drag((s.x - q.x) * f, (s.y - q.y) * f);
    m = await model();
    ms.outOfRangeM = Math.round(nearestM(site, req(m.world).proposal.areas.PRIMARY_AREA));
    const t = await text(touch ? '[data-testid=compact-readout]' : '[data-testid=area-primary]');
    expect(ms.outOfRangeM < 5000 && t.includes('✕') && Math.abs(km(t) - ms.outOfRangeM) < 60 && (await page.locator('[data-testid=next]').first().isDisabled()), 'primary deployment area out of range by the shortest distance: refused (' + ms.outOfRangeM + ' m)');
    const b = await shot('28b-primary-out-of-range');
    await drag(-(s.x - q.x) * f, -(s.y - q.y) * f);
    m = await model();
    ms.backM = Math.round(nearestM(site, req(m.world).proposal.areas.PRIMARY_AREA));
    expect(!(await page.locator('[data-testid=next]').first().isDisabled()), 'back in range (' + ms.backM + ' m)');
    await toStep(4);
    expect((await page.locator('[data-testid=submit-checklist] li[data-ok=true]').count()) === 2 && !(await page.locator('[data-act=SUBMIT]').isDisabled()), 'site + primary + alternative deployment area: submission allowed');
    const c = await shot('28c-required-complete');
    await tap(page.locator('[data-act=SUBMIT]'));
    await settle();
    const badge = page.locator('[data-testid=policy-badge]').first();
    expect((await badge.getAttribute('data-version')) === '2' && (await badge.innerText()).includes('مثبَّت عند الإرسال'), 'version 2 pinned at submission');
    return [a, b, c, await shot('28d-submitted-pinned')];
  });
  await step(29, 'optional-site-only', async (expect) => {
    await open(29);
    expect((await text('[data-testid=compare]')).includes('لم تُرسم (اختيارية)'), 'no deployment areas, optional');
    expect((await page.locator('[data-testid=submit-checklist] li[data-ok=true]').count()) === 2, 'both checklist items satisfied');
    await tap(page.locator('[data-act=SUBMIT]'));
    await settle();
    expect((await facts(page)).states.includes('UNDER_REVIEW'), 'submitted with the site only');
    return [await shot('29-optional-site-only-submitted')];
  });
  await step(30, 'optional-complete', async (expect) => {
    await open(30);
    const p = await text('[data-testid=compare-area-primary]');
    const a = await text('[data-testid=compare-area-alternative]');
    expect(p.includes('✓') && p.includes('من مركز إلى مركز') && a.includes('✓'), 'both relations within the profile; centre to centre shown for information');
    expect(!(await page.locator('[data-act=SUBMIT]').isDisabled()), 'submission allowed');
    return [await shot('30-optional-complete-package')];
  });
  await step(31, 'optional-primary-only', async (expect) => {
    await open(31);
    expect(await page.locator('[data-act=SUBMIT]').isDisabled(), 'submission blocked');
    expect((await text('[data-testid=submit-why]')).includes('حزمة واحدة'), 'one deployment area alone is never accepted');
    expect((await page.locator('[data-testid=submit-checklist] li[data-ok=false]').count()) === 1, 'the package item fails');
    return [await shot('31-optional-primary-only-blocked')];
  });
  await step(32, 'policy-change', async (expect, ms) => {
    await open(32);
    ms.before = await policy('stationing_areas_requirement');
    expect(ms.before.value === 'OPTIONAL' && ms.before.version === '1', 'version 1 in force: optional');
    expect((await text('[data-testid=profile-relations]')).includes('أقصر مسافة بين الشكلين'), 'the published profile states its measurement method');
    const a = await shot('32a-policy-optional');
    const r = await confirm('[data-testid=policy-stationing_areas_requirement] button[data-act=SET_POLICY]', { reason: 'منطقتا الانتشار شرط لإرسال طلبات إعادة التمركز', snap: '32-dialog-policy-change' });
    dialogOk(expect, r, 'policy change');
    expect(r.info.consequence.includes('تبقى على الإصدار المثبَّت لها'), 'the dialog states that submitted requests keep their version');
    ms.after = await policy('stationing_areas_requirement');
    expect(ms.after.value === 'REQUIRED' && ms.after.version === '2', 'version 2 in force: required');
    expect((await page.locator('[data-testid=policy-history-stationing_areas_requirement] li').count()) === 2, 'append-only history: two versions');
    const ev = await text('[data-testid=events]');
    expect(ev.includes('STATIONING_POLICY_CHANGED') && ['previous', 'value', 'version', 'effectiveFrom', 'changedBy', 'changedAt', 'reason'].every((k) => ev.includes(k)), 'actor, time, previous and new value, reason, effective date and version recorded');
    const b = await shot('32b-policy-required');
    await page.locator('[data-testid=policy-effective]').fill(new Date(Date.UTC(2026, 10, 17)).toISOString().slice(0, 10));
    await settle(300);
    await confirm('[data-testid=policy-stationing_areas_requirement] button[data-act=SET_POLICY]', { reason: 'العودة إلى الاختيارية من الأسبوع القادم' });
    expect((await policy('stationing_areas_requirement')).value === 'REQUIRED' && (await page.locator('[data-testid=policy-scheduled]').isVisible()), 'back to optional, scheduled; version 2 stays in force until then');
    await actor('p-stn');
    const other = (await facts(page)).actions.find((x) => x.act === 'SET_POLICY');
    expect(other && !other.enabled && other.why.includes('MANAGE_STATIONING_POLICY'), 'only the system administrator can change it');
    return [a, r.file, b, await shot('32c-policy-scheduled-other-person')];
  });
  await step(33, 'version-locked', async (expect) => {
    await open(33);
    const badge = page.locator('[data-testid=policy-badge]').first();
    expect((await badge.getAttribute('data-value')) === 'REQUIRED' && (await badge.getAttribute('data-version')) === '2', 'the submitted request keeps version 2 (required)');
    expect((await badge.innerText()).includes('الإصدار 3'), 'and states that version 3 (optional) is in force now without changing it');
    const a = await shot('33a-request-pinned');
    await tap(page.locator('[data-testid=open-policy]'));
    await settle();
    expect((await text('[data-testid=policy-pinning-stationing_areas_requirement]')).includes('الإصدار 2: 1'), 'one request pinned to version 2');
    return [a, await shot('33b-policy-pinning')];
  });
  await step(34, 'footprint-over-max', async (expect, ms) => {
    await open(34);
    const t = await text('[data-testid=site-area]');
    expect(t.includes('15,000') && t.includes('الإصدار 2') && t.includes('✕'), 'actual area, configured maximum and policy version shown: ' + t);
    expect(await page.locator('[data-testid=area-limit]').isVisible(), 'not resized automatically; the requester is told what to do');
    expect(await page.locator('[data-testid=next]').first().isDisabled(), 'cannot continue');
    const a = await shot('34a-footprint-over-max');
    await tap(page.locator('[data-site-mode=draw]').first());
    await settle(900);
    const m0 = await model();
    const c = centre(m0.world.requests.find((r) => r.id === 'r-pm-bld').proposal.ring);
    await drawArea(c.lat, c.lng, 55, 17);
    const m1 = await model();
    ms.newAreaM2 = Math.round(area(m1.world.requests.find((r) => r.id === 'r-pm-bld').proposal.ring));
    expect(ms.newAreaM2 < 15000 && (await text('[data-testid=site-area]')).includes('✓'), 'a newly drawn smaller boundary passes (' + ms.newAreaM2 + ' m²)');
    await toStep(4);
    expect(!(await page.locator('[data-act=SUBMIT]').isDisabled()), 'submission allowed');
    return [a, await shot('34b-redrawn-within-max')];
  });
  await step(35, 'hierarchy-one-intermediate', async (expect) => {
    await open(35);
    expect(JSON.stringify(await stagesOf()) === JSON.stringify(['h-o-pm', 'site', 'scope', 'final']), 'one intermediate hierarchy approver, then the configured reviews and the final decision');
    await actor('p-apr');
    const early = await byAct('APPROVE_STAGE');
    expect(early && !early.enabled && early.why.includes('المعتمد المُسند'), 'the final approver cannot jump the hierarchy');
    const a = await shot('35a-awaiting-parent');
    await approveAs('p-h-pm');
    await approveAs('p-rev');
    await approveAs('p-rev');
    await approveAs('p-apr');
    expect((await facts(page)).states.includes('APPROVED_NOT_ACTIVATED'), 'approved along the path');
    expect((await marksOf()).every((x) => x === 'APPROVED'), 'every stage approved in order');
    return [a, await shot('35b-approved-along-path')];
  });
  await step(36, 'hierarchy-multiple', async (expect) => {
    await open(36);
    await actor('p-h-bld');
    const wrong = await byAct('APPROVE_STAGE');
    expect(wrong && !wrong.enabled && wrong.why.includes('وحدة الإشراف الهندسي'), 'each level only by its own organisation\'s approver, in order');
    await approveAs('p-h-sv');
    await approveAs('p-h-bld');
    await approveAs('p-h-pm');
    expect(JSON.stringify((await marksOf()).slice(0, 3)) === JSON.stringify(['APPROVED', 'APPROVED', 'APPROVED']), 'three hierarchy approvals in order');
    const a = await shot('36a-three-levels-approved');
    await actor('p-wf');
    await page.locator('[data-testid=route-org]').selectOption('o-ga');
    await settle(300);
    const r = await confirm('[data-testid=route-change] button[data-act=ROUTE_CHANGE]', { reason: 'موافقة الإدارة العامة على المقر المشترك', snap: '36-dialog-route-change' });
    dialogOk(expect, r, 'routing change');
    const st = await stagesOf();
    expect(st.indexOf('a-o-ga') === st.length - 2, 'an added approver before the final decision');
    expect((await text('[data-testid=events]')).includes('REQUEST_ROUTING_CHANGED') && (await page.locator('[data-testid=route-changes]').isVisible()), 'the change is audited and shown');
    return [a, r.file, await shot('36b-route-changed-audited')];
  });
  await step(37, 'temporary-expiry-return', async (expect) => {
    await open(37);
    expect((await page.locator('[data-testid=effective-temporary]').count()) === 0, 'back on the preserved original stationing');
    expect((await text('[data-testid=history]')).includes('انتهى عند نهايته المعتمدة'), 'the temporary record closed by the system, kept in history');
    const m = await model();
    expect(m.world.areas.filter((x) => x.stationingId === 'tmp-o-it').every((x) => x.status === 'RETIRED') && m.world.areas.filter((x) => x.stationingId === 'st-o-it').every((x) => x.status === 'ACTIVE'), 'the temporary deployment areas ended with it; the original stationing keeps its own');
    return [await shot('37-temporary-expired-returned')];
  });
  await step(38, 'temporary-extension', async (expect) => {
    await open(38);
    expect((await facts(page)).states.includes('EXTENSION_ACTIVATED') && (await facts(page)).states.includes('ACTIVE_TEMPORARY'), 'extension activated; still temporary after the original end');
    expect((await text('[data-testid=events]')).includes('STATIONING_TEMPORARY_EXTENDED'), 'the extension period began at the original end');
    const m = await model();
    expect(m.world.areas.filter((x) => x.stationingId === 'tmp-o-it').every((x) => x.status === 'ACTIVE' && x.validTo === m.world.requests.find((r) => r.id === 'r-it-temp').duration.end + 30 * 86400000), 'its deployment areas carried to the new end');
    return [await shot('38-temporary-extended')];
  });
  await step(39, 'permanent-activated', async (expect) => {
    await open(39);
    const t = await text('.md-card');
    expect(t.includes('مكتب المالية الجديد'), 'the new site is the current stationing');
    expect((await text('[data-testid=history]')).includes('حلّ محله تمركز دائم مُفعَّل'), 'the previous stationing stays in history');
    return [await shot('39-permanent-activated')];
  });
  await step(40, 'new-request-to-move-again', async (expect) => {
    await open(40);
    expect(await page.locator('[data-testid=permanent-done]').isVisible(), 'no automatic return; a later move needs a new request');
    const acts = (await facts(page)).actions.map((x) => x.act);
    expect(!acts.includes('ACTIVATE') && !acts.includes('REQUEST_CANCEL') && !acts.includes('APPROVE_STAGE'), 'nothing left to act on in the activated request');
    const a = await shot('40a-activated-request');
    await tap(page.locator('.md-head .ux-x'));
    await settle();
    await tap(page.getByRole('button', { name: /طلب إعادة تمركز/ }));
    await settle(1200);
    const head = await text('.md-editor .ux-crumbs');
    expect(head.includes('مسودة') && head.includes('مكتب المالية الجديد'), 'a brand-new draft that starts from the new current stationing');
    return [a, await shot('40b-new-request')];
  });
  await step(41, 'register-areas-later', async (expect, ms) => {
    await open(41);
    expect(await page.locator('[data-testid=no-areas]').isVisible(), 'activated without deployment areas: no empty record, the later process is offered');
    await actor('p-req');
    expect(await page.locator('[data-act=OPEN_REGISTER_AREAS]').isDisabled(), 'the requester cannot register them');
    await actor('p-stn');
    const a = await shot('41a-no-areas');
    await tap(page.locator('[data-act=OPEN_REGISTER_AREAS]'));
    await settle(1300);
    await drawArea(25.205, 55.41);
    await pick('ALTERNATIVE_AREA');
    await drawArea(25.245, 55.42);
    const [tp, ta] = [await text('[data-testid=area-primary]'), await text('[data-testid=area-alternative]')];
    expect(tp.includes('✓') && ta.includes('✓'), 'both deployment areas drawn and within the published profile');
    const b = await shot('41b-areas-drawn');
    if (touch) {
      await tap(page.locator('[data-testid=sheet-handle]'));
      await tap(page.locator('[data-testid=sheet-handle]'));
      await settle(600);
    }
    await page.locator('[data-testid=decision-authority]').fill('جهة اعتماد وهمية');
    await page.locator('[data-testid=decision-reference]').fill('ق-وهمي/204');
    await settle(300);
    const r = await confirm('button[data-act=REGISTER_AREAS]', { reason: 'قرار منطقتي الانتشار بعد نفاذ التمركز الجديد', snap: '41-dialog-register' });
    dialogOk(expect, r, 'registration');
    const m1 = await model();
    const st = m1.world.stationings.find((s) => s.org === 'o-ga-fin' && s.kind === 'PERMANENT' && s.state === 'CURRENT');
    const areas = m1.world.areas.filter((x) => x.stationingId === st.id);
    ms.registered = areas.map((x) => x.role);
    expect(areas.length === 2 && areas.every((x) => x.status === 'ACTIVE' && x.provenance.registeredBy === 'p-stn'), 'two active records attached to the stationing');
    expect((await text('.md-card')).includes('قرار خارجي ق-وهمي/204') && (await text('.md-card')).includes('منطقة الانتشار الرئيسية'), 'provenance and the owner\'s terms shown');
    return [a, b, r.file, await shot('41c-areas-registered')];
  });
  await ctx.close();
  results.push({ size, scenario: ONLY ? 'dialogs ' + [...ONLY].join(',') : 'dialogs', name: 'dialogs', pass: dialogs.every((d) => d.confirmDisabledWithoutReason), dialogs, checks: [], shots: [], facts: {} });
}
await browser.close();

const file = OUT + 'results.json';
const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { results: [] };
const merged = ONLY
  ? [...prev.results.filter((r) => !results.some((x) => x.size === r.size && String(x.scenario) === String(r.scenario))), ...results]
  : [...prev.results.filter((r) => !SIZES.includes(r.size)), ...results];
writeFileSync(file, JSON.stringify({ run: new Date().toISOString(), base: BASE, browser: 'Microsoft Edge (playwright-core), headless', results: merged, consoleErrors: lib.consoleErrors, externalRequests: lib.external }, null, 2));
const steps = results.filter((r) => r.name !== 'dialogs');
console.log(`\n${steps.filter((r) => r.pass).length}/${steps.length} steps passed · dialogs ${results.filter((r) => r.name === 'dialogs').flatMap((r) => r.dialogs).length} · console errors ${lib.consoleErrors.length} · external requests ${lib.external.length}`);
