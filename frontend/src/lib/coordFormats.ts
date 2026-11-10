// coordFormats.ts — WGS84 latitude/longitude <-> UTM <-> MGRS, and a tolerant reader of what a person types or pastes.
// Ported from MOVER (app/NavMap/src/coords.js, same owner; ADR-048) with its golden vectors (coordFormats.golden.json: PROJ for
// UTM, the `mgrs` package for MGRS — never against itself). Pure: no DOM, no network.
//
// Datum: WGS84 only. UTM here follows the MGRS convention for the letter: it is the LATITUDE BAND (C–M south, N–X north), not a
// hemisphere, so «40R» is the UAE (24°–32°N).

const A = 6378137.0; // WGS84 semi-major axis
const F = 1 / 298.257223563;
const K0 = 0.9996;
const N = F / (2 - F); // third flattening
const BIG_A = (A / (1 + N)) * (1 + (N * N) / 4 + N ** 4 / 64); // rectifying radius
const ALPHA = [N / 2 - (2 / 3) * N * N + (5 / 16) * N ** 3, (13 / 48) * N * N - (3 / 5) * N ** 3, (61 / 240) * N ** 3];
const BETA = [N / 2 - (2 / 3) * N * N + (37 / 96) * N ** 3, (1 / 48) * N * N + (1 / 15) * N ** 3, (17 / 480) * N ** 3];
const DELTA = [2 * N - (2 / 3) * N * N - 2 * N ** 3, (7 / 3) * N * N - (8 / 5) * N ** 3, (56 / 15) * N ** 3];

export const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
const COL_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export type Utm = { zone: number; band: string; north: boolean; easting: number; northing: number };
export type LatLon = { lat: number; lon: number };

export function latBand(lat: number): string | null {
  if (!(lat >= -80 && lat <= 84)) return null;
  return BANDS[Math.min(19, Math.floor((lat + 80) / 8))];
}

export function utmZone(lat: number, lon: number): number {
  let z = Math.floor(((((lon + 180) % 360) + 360) % 360) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) z = 32; // Norway
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) z = 31;
    else if (lon >= 9 && lon < 21) z = 33;
    else if (lon >= 21 && lon < 33) z = 35;
    else if (lon >= 33 && lon < 42) z = 37;
  } // Svalbard
  return z;
}

/** Null outside 80°S–84°N. `zone` may be forced. */
export function toUtm(lat: number, lon: number, zone?: number): Utm | null {
  const band = latBand(lat);
  if (band === null || !Number.isFinite(lon)) return null;
  const z = zone || utmZone(lat, lon);
  const lon0 = rad((z - 1) * 6 - 180 + 3);
  const phi = rad(lat);
  const dl = rad(lon) - lon0;
  const e = (2 * Math.sqrt(N)) / (1 + N);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi0 = Math.atan2(t, Math.cos(dl));
  const eta0 = Math.asinh(Math.sin(dl) / Math.hypot(t, Math.cos(dl)));
  let xi = xi0;
  let eta = eta0;
  ALPHA.forEach((a, i) => {
    const j = 2 * (i + 1);
    xi += a * Math.sin(j * xi0) * Math.cosh(j * eta0);
    eta += a * Math.cos(j * xi0) * Math.sinh(j * eta0);
  });
  const north = lat >= 0;
  return { zone: z, band, north, easting: 500000 + K0 * BIG_A * eta, northing: (north ? 0 : 10000000) + K0 * BIG_A * xi };
}

/** {lat, lon} from grid numbers; `north` is the hemisphere (bandIsNorth(band)). */
export function fromUtm(zone: number, north: boolean, easting: number, northing: number): LatLon {
  const xi = (northing - (north ? 0 : 10000000)) / (K0 * BIG_A);
  const eta = (easting - 500000) / (K0 * BIG_A);
  let xi1 = xi;
  let eta1 = eta;
  BETA.forEach((b, i) => {
    const j = 2 * (i + 1);
    xi1 -= b * Math.sin(j * xi) * Math.cosh(j * eta);
    eta1 -= b * Math.cos(j * xi) * Math.sinh(j * eta);
  });
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  DELTA.forEach((d, i) => {
    phi += d * Math.sin(2 * (i + 1) * chi);
  });
  const lon = (zone - 1) * 6 - 180 + 3 + deg(Math.atan2(Math.sinh(eta1), Math.cos(xi1)));
  return { lat: deg(phi), lon };
}

export const bandIsNorth = (band: string) => band >= 'N';

/** «40R BN 34124 07001»; `digits` per axis (1–5), the position TRUNCATED to that cell as MGRS defines it. */
export function toMgrs(lat: number, lon: number, digits = 5): string | null {
  const u = toUtm(lat, lon);
  if (!u) return null;
  const E = Math.floor(u.easting);
  const Nn = Math.floor(u.northing);
  const col = COL_SETS[(u.zone - 1) % 3][Math.floor(E / 100000) - 1];
  const row = ROW_LETTERS[(Math.floor(Nn / 100000) + (u.zone % 2 === 0 ? 5 : 0)) % 20];
  const p = Math.max(1, Math.min(5, digits));
  const part = (v: number) => String(v % 100000).padStart(5, '0').slice(0, p);
  return `${String(u.zone).padStart(2, '0')}${u.band} ${col}${row} ${part(E)} ${part(Nn)}`;
}

/** The SOUTH-WEST corner of the named cell, or null when the reference is malformed or impossible. */
export function fromMgrs(text: string): LatLon | null {
  const m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d{0,10})$/.exec(String(text).replace(/\s+/g, '').toUpperCase());
  if (!m || m[5].length % 2) return null;
  const zone = +m[1];
  const band = m[2];
  if (zone < 1 || zone > 60) return null;
  const colI = COL_SETS[(zone - 1) % 3].indexOf(m[3]);
  if (colI < 0) return null;
  const half = m[5].length / 2;
  const scale = half ? 10 ** (5 - half) : 1e5;
  const e = (colI + 1) * 100000 + (half ? +m[5].slice(0, half) * scale : 0);
  const rowI = ROW_LETTERS.indexOf(m[4]);
  const n100 = ((((rowI - (zone % 2 === 0 ? 5 : 0)) % 20) + 20) % 20) * 100000 + (half ? +m[5].slice(half) * scale : 0);
  const south = BANDS.indexOf(band) * 8 - 80;
  const north = band === 'X' ? 84 : south + 8;
  const isNorth = bandIsNorth(band);
  // northings repeat every 2,000 km: take the cycle that puts the cell inside the band's latitudes, one cell of slack
  const slack = (half ? 10 ** (5 - half) : 100000) / 110574 + 1e-6;
  for (let k = 0; k < 5; k++) {
    const p = fromUtm(zone, isNorth, e, n100 + k * 2000000);
    if (p.lat >= south - slack && p.lat <= north + slack) return p;
  }
  return null;
}

// ── formatting ───────────────────────────────────────────────────────────
export const fmtLatLon = (lat: number, lon: number, dp = 6) => `${lat.toFixed(dp)}, ${lon.toFixed(dp)}`;
export function fmtDms(v: number, pos: string, neg: string): string {
  const s = v < 0 ? neg : pos;
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let x = ((a - d) * 60 - m) * 60;
  if (x >= 59.995) {
    x = 0;
    m += 1;
  }
  if (m >= 60) {
    m = 0;
    d += 1;
  }
  return `${d}°${String(m).padStart(2, '0')}′${x.toFixed(2).padStart(5, '0')}″ ${s}`;
}
/** Degrees and decimal minutes («24°27.234′ N»). */
export function fmtDdm(v: number, pos: string, neg: string): string {
  const s = v < 0 ? neg : pos;
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = (a - d) * 60;
  if (m >= 59.9995) {
    m = 0;
    d += 1;
  }
  return `${d}°${m.toFixed(3).padStart(6, '0')}′ ${s}`;
}
export const fmtUtm = (u: Utm | null) => (u ? `${u.zone}${u.band} ${Math.round(u.easting)} ${Math.round(u.northing)}` : '—');

// ── parsing ──────────────────────────────────────────────────────────────
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
function normalise(text: string): string {
  return String(text || '')
    .replace(/[٠-٩]/g, (c) => String(AR_DIGITS.indexOf(c)))
    .replace(/[،؛;]/g, ',')
    .replace(/٫/g, '.')
    .replace(/[′ʹ’‘]/g, "'")
    .replace(/[″ʺ”“]/g, '"')
    .replace(/º|˚/g, '°')
    .trim();
}

/** One angle: «24.4539», «24.4539N», «N 24.4539», «24°27'14.04"N», «-54.37». */
function parseAngle(tok: string): { value: number; axis: 'lat' | 'lon' | null } | null {
  const t = tok.trim().toUpperCase();
  const hem = (/^[NSEW]/.exec(t) || /[NSEW]$/.exec(t) || [null])[0];
  const body = t.replace(/^[NSEW]\s*/, '').replace(/\s*[NSEW]$/, '');
  const dms = /^(-?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*'\s*)?(?:(\d+(?:\.\d+)?)\s*"?\s*)?$/.exec(body);
  if (!dms) return null;
  const d = parseFloat(dms[1]);
  const mi = dms[2] ? parseFloat(dms[2]) : 0;
  const s = dms[3] ? parseFloat(dms[3]) : 0;
  // «24 27» is NOT 24°00′27″: seconds only after marked minutes, minutes/seconds only after WHOLE degrees
  if (dms[3] && !dms[2]) return null;
  if ((dms[2] || dms[3]) && !Number.isInteger(d)) return null;
  if (dms[3] && !Number.isInteger(mi)) return null;
  if (mi >= 60 || s >= 60) return null;
  let v = Math.abs(d) + mi / 60 + s / 3600;
  if (d < 0 || dms[1].startsWith('-')) v = -v;
  if (hem === 'S' || hem === 'W') v = -Math.abs(v);
  return { value: v, axis: hem === 'N' || hem === 'S' ? 'lat' : hem === 'E' || hem === 'W' ? 'lon' : null };
}

export type Parsed = { ok: true; kind: 'latlon' | 'utm' | 'mgrs'; lat: number; lon: number; label: string } | { ok: false; error: string };

/** «24.4539, 54.3773» · «24.4539N 54.3773E» · «24°27'14"N 54°22'38"E» · «40R 234125 2707001» · «40RBN3412407001». */
export function parseCoordinate(input: string): Parsed {
  const text = normalise(input);
  if (!text) return { ok: false, error: 'أدخل إحداثياً' };
  const mg = fromMgrs(text);
  if (mg) return { ok: true, kind: 'mgrs', ...mg, label: 'MGRS' };
  const um = /^(\d{1,2})\s*([C-HJ-NP-X])\s+(?:E\s*)?(\d{5,7}(?:\.\d+)?)\s*(?:m|mE)?[\s,]+(?:N\s*)?(\d{5,8}(?:\.\d+)?)\s*(?:m|mN)?$/i.exec(text);
  if (um) {
    const zone = +um[1];
    const band = um[2].toUpperCase();
    if (zone < 1 || zone > 60) return { ok: false, error: 'رقم نطاق UTM يجب أن يكون بين 1 و60' };
    const e = parseFloat(um[3]);
    const n = parseFloat(um[4]);
    if (!(e >= 100000 && e <= 900000) || !(n >= 0 && n <= 10000000)) return { ok: false, error: 'إحداثيات UTM خارج المدى الممكن (الشرق 100000–900000، الشمال 0–10000000)' };
    const p = fromUtm(zone, bandIsNorth(band), e, n);
    if (!(Math.abs(p.lat) <= 84)) return { ok: false, error: 'إحداثيات UTM خارج النطاق' };
    const south = BANDS.indexOf(band) * 8 - 80;
    const top = band === 'X' ? 84 : south + 8;
    if (p.lat < south - 1e-4 || p.lat > top + 1e-4) return { ok: false, error: `الشريط ${band} لا يطابق هذا الشمال (خط العرض ${p.lat.toFixed(2)}°): تحقق من حرف الشريط` };
    return { ok: true, kind: 'utm', ...p, label: 'UTM' };
  }
  // two angles: split on a comma, or between the two groups when each carries a hemisphere letter, or on whitespace for decimals
  let parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) {
    const m = /^(.*?[NSEW]|.*?["'°]\s*)\s+([NSEW]?\s*-?\d.*)$/i.exec(text);
    parts = m ? [m[1].trim(), m[2].trim()] : text.split(/\s+/);
  }
  const unknown = { ok: false as const, error: 'صيغة غير مفهومة: استخدم «خط العرض, خط الطول» أو UTM أو MGRS' };
  if (parts.length !== 2) return unknown;
  const a = parseAngle(parts[0]);
  const b = parseAngle(parts[1]);
  if (!a || !b) return unknown;
  let lat = a;
  let lon = b;
  if (a.axis === 'lon' || b.axis === 'lat') {
    lat = b;
    lon = a;
  }
  if (lat.axis === 'lon' || lon.axis === 'lat') return { ok: false, error: 'خط العرض (N/S) وخط الطول (E/W) لا يمكن أن يكونا من المحور نفسه' };
  if (!(Math.abs(lat.value) <= 90)) return { ok: false, error: 'خط العرض يجب أن يكون بين -90 و90' };
  if (!(Math.abs(lon.value) <= 180)) return { ok: false, error: 'خط الطول يجب أن يكون بين -180 و180' };
  return { ok: true, kind: 'latlon', lat: lat.value, lon: lon.value, label: 'خط عرض / خط طول' };
}

export type FormatKey = '' | 'dd' | 'ddm' | 'dms' | 'utm' | 'mgrs';
/** «نظام الإحداثيات»: the formats a person can pick, each with the example shown in the box. */
export const INPUT_FORMATS: { key: FormatKey; label: string; example: string }[] = [
  { key: '', label: 'تلقائي (أي صيغة)', example: '24.4539, 54.3773  ·  40R 234125 2707001  ·  40RBN3412407001' },
  { key: 'dd', label: 'درجات عشرية', example: '24.4539, 54.3773' },
  { key: 'ddm', label: 'درجات ودقائق', example: '24 27.234 N, 54 22.638 E' },
  { key: 'dms', label: 'درجات ودقائق وثوانٍ', example: '24 27 14 N, 54 22 38 E' },
  { key: 'utm', label: 'UTM', example: '40R 234125 2707001' },
  { key: 'mgrs', label: 'MGRS', example: '40RBN3412407001' },
];

/** Read `input` in the format the person CHOSE; a text in another format is refused, by name. */
export function parseInFormat(input: string, fmt: FormatKey): Parsed {
  if (!fmt) return parseCoordinate(input);
  const def = INPUT_FORMATS.find((f) => f.key === fmt);
  if (!def) return { ok: false, error: 'صيغة غير معروفة' };
  const wrong = { ok: false as const, error: `هذه ليست صيغة «${def.label}». مثال: ${def.example}` };
  const text = normalise(input);
  if (!text) return { ok: false, error: 'أدخل إحداثياً' };
  if (fmt === 'utm' || fmt === 'mgrs') {
    const p = parseCoordinate(text);
    if (p.ok && p.kind !== fmt) return wrong;
    return p.ok ? p : { ...p, error: `${p.error} — مثال: ${def.example}` };
  }
  const per = { dd: 1, ddm: 2, dms: 3 }[fmt];
  let marked = text;
  if (!/[°'"]/.test(text)) {
    const nums = text.match(/-?\d+(?:\.\d+)?/g) || [];
    if (nums.length !== per * 2) return wrong;
    const hems = text.toUpperCase().match(/[NSEW]/g) || [];
    const latH = hems.find((h) => h === 'N' || h === 'S') || '';
    const lonH = hems.find((h) => h === 'E' || h === 'W') || '';
    const angle = (ns: string[], h: string) => (per === 1 ? ns[0] : per === 2 ? `${ns[0]}°${ns[1]}'` : `${ns[0]}°${ns[1]}'${ns[2]}"`) + h;
    marked = `${angle(nums.slice(0, per), latH)}, ${angle(nums.slice(per), lonH)}`;
  } else {
    const hasSec = /"/.test(text);
    const hasMin = /'/.test(text);
    if ((fmt === 'dms') !== hasSec || (fmt === 'ddm' && !hasMin) || (fmt === 'dd' && hasMin)) return wrong;
  }
  const p = parseCoordinate(marked);
  if (!p.ok) return p;
  return p.kind === 'latlon' ? { ...p, label: def.label } : wrong;
}

/** A position written in a chosen format, to be read back by parseInFormat (the conversion between formats). */
export function formatIn(fmt: FormatKey, lat: number, lon: number): string {
  if (fmt === 'ddm') return `${fmtDdm(lat, 'N', 'S')}, ${fmtDdm(lon, 'E', 'W')}`;
  if (fmt === 'dms') return `${fmtDms(lat, 'N', 'S')}, ${fmtDms(lon, 'E', 'W')}`;
  if (fmt === 'utm') return fmtUtm(toUtm(lat, lon));
  if (fmt === 'mgrs') return toMgrs(lat, lon) ?? fmtLatLon(lat, lon);
  return fmtLatLon(lat, lon);
}
