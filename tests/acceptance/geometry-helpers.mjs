// Shared steps for the re-stationing geometry checks (owner correction of 5 Nov 2026: the geometry itself is the
// control). The map instance is read from the request map's wrapper (`tmrkzMap`) only to project coordinates to
// pixels and to read what the editor holds; every interaction is a real pointer or keyboard action on the page.

const MAP = '.tz-mapframe .tz-map-layer';

/** The proposed site as the editor holds it now: one ring list per part ([[lng, lat], …] closed rings). */
export const proposedParts = (page) =>
  page.evaluate(async (sel) => {
    const m = document.querySelector(sel).tmrkzMap;
    const src = m.getSource('rs-edit');
    const d = src.getData ? await src.getData() : src.serialize().data;
    return d.features.map((f) => f.geometry.coordinates);
  }, MAP);

/** A geographic point as a page pixel (canvas offset included). */
export const toScreen = (page, [lng, lat]) =>
  page.evaluate(([sel, ll]) => {
    const m = document.querySelector(sel).tmrkzMap;
    const p = m.project(ll);
    const r = m.getCanvas().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [MAP, [lng, lat]]);

/** Whether the request map renders a feature of a role in a layer (e.g. the current site «CURRENT» in rs-fill). */
export const rendersRole = (page, layer, role) =>
  page.evaluate(([sel, l, r]) => {
    const m = document.querySelector(sel).tmrkzMap;
    return m.getLayer(l) ? m.queryRenderedFeatures({ layers: [l] }).some((f) => f.properties.role === r) : false;
  }, [MAP, layer, role]);

export const ringCentre = (ring) => {
  const pts = ring.slice(0, -1);
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
};

/** Translation of each part (metres east, north) between two states of the same site, and the largest difference. */
export function partVectors(before, after) {
  const v = before.map((part, i) => {
    const [a, b] = [ringCentre(part[0]), ringCentre(after[i][0])];
    const k = Math.cos((a[1] * Math.PI) / 180);
    return [(b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 110900];
  });
  const spread = Math.max(0, ...v.flatMap((x) => v.map((y) => Math.hypot(x[0] - y[0], x[1] - y[1]))));
  return { vectors: v, spread, metres: Math.hypot(...v[0]) };
}

/** A slow pointer drag (visible in a recording): press, move in steps, optional pauses and frames, release. */
export async function slowDrag(page, from, to, { steps = 30, pause = 250, mid } = {}) {
  await page.mouse.move(from.x, from.y, { steps: 10 });
  await page.waitForTimeout(pause);
  await page.mouse.down();
  await page.waitForTimeout(pause);
  const half = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  await page.mouse.move(half.x, half.y, { steps: Math.ceil(steps / 2) });
  if (mid) await mid();
  await page.mouse.move(to.x, to.y, { steps: Math.ceil(steps / 2) });
  await page.waitForTimeout(pause);
  await page.mouse.up();
  await page.waitForTimeout(700);
}

/** A new request through steps 1–3 to the new-site step, from a site (map first; nothing is saved on the way). */
export async function toNewSiteStep(page, ui, siteId, unitName) {
  await page.goto(`${ui}/#restationing/new?site=${siteId}`);
  await page.waitForSelector('.tz-flow', { timeout: 30000 });
  await page.waitForSelector('.tz-mapframe canvas.maplibregl-canvas', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.locator('[data-testid=units-to-move] .rs-check', { hasText: unitName }).first().locator('input').check();
  await page.getByRole('button', { name: 'التالي: نوع إعادة التمركز' }).click();
  await page.getByRole('button', { name: 'التالي: الموقع الجديد' }).click();
  await page.waitForTimeout(2000);
}

/** The current stationing record of a unit (the authoritative register as this person may read it). */
export const recordOf = (page, orgName) =>
  page.evaluate(async (n) => (await (await fetch('/api/v1/stationing/current')).json()).find((c) => c.orgName === n), orgName);
