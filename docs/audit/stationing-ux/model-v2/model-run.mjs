// Browser evidence for the stationing domain model V2 prototype (owner briefs of 3 Nov 2026): 25 scenarios plus the
// polygon-drag acceptance, at 1920×1080 and 1366×768 first, then 768×1024 and 390×844 (touch). Each step records what
// was done, the states shown, every action with whether it is enabled and why not, each sensitive action's dialog, and
// layout facts; drags assert the GEOGRAPHIC state (centroid moved, area kept, distances recomputed), not pointer movement.
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
    expect(await page.locator('[data-testid=step-compare]').isVisible(), 'comparison step');
    expect((await text('[data-testid=step-compare]')).includes('دائم'), 'permanent');
    expect((await page.locator('.md-compare td.good').count()) >= 2, 'both relations within the configured ranges');
    return [await shot('03-whole-permanent')];
  });

  // B1: actual polygon dragging in steps 3 and 4 — the geographic state must change
  await step('B1', 'polygon-drag', async (expect, ms) => {
    await open(3);
    await page.getByRole('button', { name: /^3 الموقع الرئيسي/ }).click();
    await page.locator('.stw-prop-sym').first().waitFor({ timeout: 8000 });
    await settle(1200);
    if (touch) expect((await model()).sheet === 'collapsed' && (await page.locator('[data-testid=compact-status]').isVisible()), 'phone: the sheet steps down to its working height with a compact readout');
    const req = (w) => w.requests.find((r) => r.id === 'r-pm-bld');
    const cur = await page.evaluate(() => {
      const w = window.__stationingModel.world;
      const s = w.stationings.find((x) => x.org === 'o-pm-bld' && x.kind === 'PERMANENT' && x.state === 'CURRENT');
      return w.sites.find((x) => x.id === s.siteId).ring;
    });
    const readout = async (k) => text(touch ? '[data-testid=compact-readout]' : '[data-testid=readout-' + k + ']');
    const screenOf = (p) =>
      page.evaluate(([lat, lng]) => {
        const m = window.__stationingModel.map;
        const pt = m.latLngToContainerPoint([lat, lng]);
        const r = m.getContainer().getBoundingClientRect();
        return { x: r.left + pt.x, y: r.top + pt.y };
      }, [p.lat, p.lng]);
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
    const shots = [await shot('B1-1-primary-before')];
    let s0 = await model();
    const p0 = req(s0.world).candidates.PRIMARY.ring;
    const r0 = await readout('primary');
    await drag(110, -50);
    let s1 = await model();
    const p1 = req(s1.world).candidates.PRIMARY.ring;
    ms.primaryMoveM = Math.round(dist(centre(p0), centre(p1)));
    ms.primaryAreaChangePct = +((Math.abs(area(p1) - area(p0)) / area(p0)) * 100).toFixed(4);
    ms.mapPannedM = Math.round(dist(s0.center, s1.center));
    const d1 = dist(centre(cur), centre(p1));
    const r1 = await readout('primary');
    expect(ms.primaryMoveM > 80, 'primary polygon moved on the map (' + ms.primaryMoveM + ' m)');
    expect(ms.primaryAreaChangePct < 0.5, 'shape and area kept by the engine (Δ ' + ms.primaryAreaChangePct + ' %)');
    expect(ms.mapPannedM < 5, (touch ? 'touch' : 'mouse') + ' drag moved the proposal, not the base map (map moved ' + ms.mapPannedM + ' m)');
    expect(r1 !== r0 && Math.abs(km(r1) - d1) < 60, 'distance readout recomputed (' + r1.split('·')[0] + ' ≈ ' + Math.round(d1) + ' m)');
    shots.push(await shot('B1-2-primary-moved'));
    // towards the current site until the configured range is broken: validation must turn invalid
    const a = await screenOf(centre(cur));
    const b = await screenOf(centre(p1));
    const f = 1 - 3000 / d1;
    await drag((a.x - b.x) * f, (a.y - b.y) * f);
    const s2 = await model();
    const d2 = dist(centre(cur), centre(req(s2.world).candidates.PRIMARY.ring));
    ms.invalidDistanceM = Math.round(d2);
    expect(d2 < 5000 && (await readout('primary')).includes('✕') && (await page.locator('[data-testid=next]').isDisabled()), 'validation updated: out of range, next step blocked (' + Math.round(d2) + ' m)');
    shots.push(await shot('B1-3-primary-invalid'));
    await drag(-(a.x - b.x) * f, -(a.y - b.y) * f);
    s1 = await model();
    expect(!(await page.locator('[data-testid=next]').isDisabled()), 'back within range: next step available');
    await tap(page.locator('[data-testid=next]'));
    await page.locator('.stw-prop-sym').first().waitFor({ timeout: 8000 });
    await settle(1200);
    s0 = await model();
    const pr = req(s0.world).candidates.PRIMARY.ring;
    const q0 = req(s0.world).candidates.ALTERNATIVE.ring;
    const ra = await readout('alternative');
    await drag(-90, 70);
    const s3 = await model();
    const q1 = req(s3.world).candidates.ALTERNATIVE.ring;
    ms.alternativeMoveM = Math.round(dist(centre(q0), centre(q1)));
    const dPA = dist(centre(pr), centre(q1));
    const rb = await readout('alternative');
    expect(ms.alternativeMoveM > 80, 'alternative polygon moved (' + ms.alternativeMoveM + ' m)');
    expect(rb !== ra && Math.abs(km(rb) - dPA) < 60, 'primary → alternative distance recomputed from the primary (' + rb.split('·')[0] + ' ≈ ' + Math.round(dPA) + ' m)');
    expect(dist(s0.center, s3.center) < 5, 'the base map did not pan');
    shots.push(await shot('B1-4-alternative-moved'));
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
    await tap(page.getByRole('button', { name: /2 المدة/ }));
    await settle(500);
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
    expect(await page.locator('[data-testid=compare]').isVisible(), 'comparison table');
    expect(
      (await facts(page)).tags.some((t) => t.includes('من الرئيسي')) || (touch && (await text('[data-testid=compare]')).includes('من الموقع الرئيسي المقترح')),
      'the alternative distance is labelled from the primary',
    );
    return [await shot('06-current-primary-alternative')];
  });
  await step(7, 'fallback', async (expect) => {
    await open(7);
    expect((await facts(page)).states.includes('PRIMARY_NOT_ACCEPTED'), 'primary not accepted');
    const a = await shot('07a-primary-not-accepted');
    const r = await confirm('button[data-act=SWITCH]', { snap: '07-dialog-switch' });
    dialogOk(expect, r, 'switch');
    const f = await facts(page);
    expect(f.states.includes('UNDER_REVIEW_ALTERNATIVE'), 'alternative under review');
    expect((await text('.md-stages')).includes('محمول') && (await text('.md-stages')).includes('أُبطل'), 'carried and invalidated decisions shown');
    expect((await text('[data-testid=events]')).includes('RELOCATION_ACTIVE_CANDIDATE_CHANGED'), 'switch audited');
    const b = await shot('07b-alternative-under-review');
    await page.locator('.md-stages').scrollIntoViewIfNeeded();
    await settle(300);
    const c = await shot('07c-stages-carried-invalidated');
    // reopening the primary (not accepted, not finally rejected) has its own dialog too
    await tap(page.locator('button[data-act=REOPEN]'));
    await page.locator('[data-testid=action-dialog]').waitFor({ timeout: 5000 });
    expect(await page.locator('[data-testid=dialog-confirm]').isDisabled(), 'reopen dialog: no confirmation without a reason');
    expect((await text('[data-testid=dialog-consequence]')).length > 20 && (await text('[data-testid=dialog-actor]')).includes('محاكاة'), 'reopen dialog states consequence and simulated actor');
    const d = await shot('07d-dialog-reopen');
    await page.getByRole('button', { name: 'تراجع' }).click();
    await settle(300);
    return [a, r.file, b, c, d];
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
