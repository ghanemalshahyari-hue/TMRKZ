import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { RestationingLeg, SiteGeometry, TerrainAssessment } from '../../api/types';
import type { DemSampler } from '../map/maplibre';
import { formatArea, formatMeters } from '../../lib/footprint';
import { anchorOf, partsOf, validateSite } from '../../lib/siteGeometry';
import { CONNECTOR_TITLE, VERDICT, ruleLines, type Connector, type ConnectorKind } from '../../lib/terrainAnalysis';
import { SLOPE_TONES, TONE_COLOUR, areaSamples, elevationStats, profileOf, profilePoints, type ElevationStats, type Profile, type SlopeLimits, type SlopeTone } from '../../lib/terrainRgb';
import type { SlopeInside, SlopeResult, SlopeShape } from '../map/maplibre';
import type { CardRole } from './terrainCards';
import './terrain3d.css';

/**
 * «تحليل طبيعة الأرض» (owner brief «TRUE OFFLINE 3D TERRAIN», §14–§19, §25): what the ground under the selected
 * geometry is, from two sources kept apart on screen —
 * - the SERVER's terrain analysis (the slope dataset and the policy in force): the class that governs, the share of each
 *   class, mean slope, the allowance and the deployment ranges. It is what the Stationing rules use;
 * - the 3D view's ELEVATION tiles (display only): lowest, highest and centre height, and the profile along a connector.
 * Both are read again when the geometry is dropped somewhere else; nothing is saved. The server's check on save decides.
 */
export type AreaInsight = {
  key: string;
  areaM2: number;
  dem: (ElevationStats & { centre: number | null }) | null;
  assess: TerrainAssessment | null;
  error: string | null;
  pending: boolean;
};

const insightCache = new Map<string, Promise<Omit<AreaInsight, 'pending'>>>();

export const geometryKey = (g: SiteGeometry | null | undefined) => (g ? JSON.stringify(g) : '');

function computeInsight(g: SiteGeometry, sampler: DemSampler | null, policyVersion: number | null): Promise<Omit<AreaInsight, 'pending'>> {
  const key = geometryKey(g) + '#' + (policyVersion ?? '') + '#' + (sampler ? 'dem' : '');
  let p = insightCache.get(key);
  if (!p) {
    const parts = partsOf(g);
    const dem = sampler
      ? Promise.all([sampler.heights(areaSamples(parts)), sampler.heights([anchorOf(parts)])]).then(([hs, [c]]) => {
          const s = elevationStats(hs);
          return s ? { ...s, centre: c } : null;
        })
      : Promise.resolve(null);
    const assess = api.terrainAssess(g, policyVersion).then(
      (a) => ({ assess: a, error: null }),
      (e: Error) => ({ assess: null, error: e.message || 'تعذّر تحليل طبيعة الأرض على الخادم' }),
    );
    p = Promise.all([dem, assess]).then(([d, a]) => ({ key: geometryKey(g), areaM2: validateSite(parts).areaM2, dem: d, ...a }));
    insightCache.set(key, p);
    if (insightCache.size > 60) insightCache.delete(insightCache.keys().next().value!);
  }
  return p;
}

/** The analysis of one geometry, read when it changes (never per frame: the page passes committed geometries only). */
export function useAreaInsight(g: SiteGeometry | null | undefined, sampler: DemSampler | null, policyVersion: number | null): AreaInsight | null {
  const [state, setState] = useState<AreaInsight | null>(null);
  const key = geometryKey(g);
  useEffect(() => {
    if (!g) return setState(null);
    let alive = true;
    setState((s) => (s && s.key === key ? s : { key, areaM2: validateSite(partsOf(g)).areaM2, dem: null, assess: null, error: null, pending: true }));
    computeInsight(g, sampler, policyVersion).then((r) => alive && setState({ ...r, pending: false }));
    return () => {
      alive = false;
    };
  }, [key, sampler, policyVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** The elevation profile of one connector, from the 3D view's elevation tiles (display only). */
export function useProfile(c: Connector | null, sampler: DemSampler | null): { key: string; profile: Profile | null; pending: boolean } | null {
  const key = c ? `${c.kind}:${c.from.lat},${c.from.lng}:${c.to.lat},${c.to.lng}` : '';
  const [state, setState] = useState<{ key: string; profile: Profile | null; pending: boolean } | null>(null);
  useEffect(() => {
    if (!c || !sampler) return setState(null);
    let alive = true;
    setState({ key, profile: null, pending: true });
    const pts = profilePoints(c.from, c.to);
    sampler.heights(pts.map((p) => p.at)).then((hs) => alive && setState({ key, profile: profileOf(pts, hs), pending: false }));
    return () => {
      alive = false;
    };
  }, [key, sampler]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

const m = (v: number) => Math.round(v).toLocaleString('ar-AE') + ' م';
const pct = (v: number) => v.toLocaleString('ar-AE', { maximumFractionDigits: 1 }) + '٪';
const km = (v: number) => (v / 1000).toLocaleString('ar-AE', { maximumFractionDigits: 2 }) + ' كم';

export const ROLE_TITLE: Record<CardRole, string> = {
  CURRENT: 'الموقع الحالي',
  SITE: 'موقع إعادة التمركز',
  PRIMARY: 'منطقة الانتشار الرئيسية',
  ALTERNATIVE: 'منطقة الانتشار البديلة',
};

export function TerrainPanel({ role, roles, onRole, insight, rule, move, connector, kinds, onLeg, profile, demAvailable }: {
  role: CardRole | null;
  roles: CardRole[];
  onRole: (r: CardRole) => void;
  insight: AreaInsight | null;
  /** A deployment area's leg: the rule, from the server's check of this geometry or the preview of its analysis. */
  rule: { leg: RestationingLeg | undefined; source: 'server' | 'preview'; discrepancy: string | null } | null;
  /** The re-stationing site: its distance from the current site, information only. */
  move: number | null;
  connector: Connector | null;
  kinds: ConnectorKind[];
  onLeg: (k: ConnectorKind) => void;
  profile: { profile: Profile | null; pending: boolean } | null;
  demAvailable: boolean;
}) {
  const a = insight?.assess ?? null;
  const d = insight?.dem ?? null;
  const verdict = rule?.leg ? VERDICT[rule.leg.status] : null;
  const lines = rule?.leg ? ruleLines(rule.leg) : null;
  return (
    <section
      className="tz-card tz-terrain"
      aria-label="تحليل طبيعة الأرض"
      data-testid="terrain-panel"
      data-role={role ?? ''}
      data-key={insight?.key ? String(insight.key.length) + ':' + insight.key.slice(0, 60) : ''}
      data-pending={insight?.pending ? 'true' : 'false'}
      data-class={a?.controllingClass ?? ''}
      data-allowance={a ? String(rule?.leg?.terrain?.allowanceM ?? a.allowanceM) : ''}
      data-min={d ? String(Math.round(d.min)) : ''}
      data-max={d ? String(Math.round(d.max)) : ''}
      data-centre={d?.centre != null ? String(Math.round(d.centre)) : ''}
      data-effective-max={rule?.leg ? String(rule.leg.effectiveMaxM) : ''}
      data-verdict={rule?.leg?.status ?? ''}
      data-source={rule?.source ?? ''}
    >
      <div className="tz-card-head">
        <h3>تحليل طبيعة الأرض</h3>
      </div>
      <div className="tz-terrain-roles" role="group" aria-label="الشكل الذي يُحلَّل">
        {roles.map((r) => (
          <button key={r} aria-pressed={r === role} aria-label={'تحليل ' + ROLE_TITLE[r]} className={'chip r-' + r + (r === role ? ' active' : '')} onClick={() => onRole(r)}>
            <i className={'sw ' + ({ CURRENT: 'current', SITE: 'site', PRIMARY: 'primary', ALTERNATIVE: 'alternative' } as const)[r]} /> {ROLE_TITLE[r]}
          </button>
        ))}
      </div>
      {!role || !insight ? (
        <p className="tz-muted">اختر موقعاً أو منطقة على الخريطة لعرض طبيعة الأرض تحتها.</p>
      ) : (
        <>
          <dl className="tz-terrain-facts">
            <div>
              <dt>نوع الأرض</dt>
              <dd data-testid="terrain-class">{insight.pending ? '…' : a ? a.controllingLabel + (a.tie ? (a.resolved ? ' (تعادل حُسم بالأولوية)' : ' (تعادل غير محسوم)') : '') : '—'}</dd>
            </div>
            {a?.meanSlopePct != null && (
              <div>
                <dt>متوسط الانحدار</dt>
                <dd>{pct(a.meanSlopePct)}</dd>
              </div>
            )}
            <div>
              <dt>أعلى ارتفاع</dt>
              <dd data-testid="terrain-max">{d ? m(d.max) : insight.pending ? '…' : '—'}</dd>
            </div>
            <div>
              <dt>أدنى ارتفاع</dt>
              <dd data-testid="terrain-min">{d ? m(d.min) : insight.pending ? '…' : '—'}</dd>
            </div>
            <div>
              <dt>فرق الارتفاع</dt>
              <dd>{d ? m(d.range) : '—'}</dd>
            </div>
            <div>
              <dt>ارتفاع المركز</dt>
              <dd>{d?.centre != null ? m(d.centre) : '—'}</dd>
            </div>
            <div>
              <dt>المساحة</dt>
              <dd>{formatArea(insight.areaM2)}</dd>
            </div>
          </dl>
          {a && a.shares.some((s) => s.percent > 0) && (
            <ul className="tz-terrain-shares" aria-label="تركيب الأرض داخل الشكل" data-testid="terrain-shares">
              {a.shares
                .filter((s) => s.percent > 0)
                .sort((x, y) => y.percent - x.percent)
                .map((s) => (
                  <li key={s.code} className={s.code === a.controllingClass ? 'on' : ''}>
                    <span>{s.label}</span>
                    <i style={{ width: Math.max(2, s.percent) + '%' }} />
                    <b>{pct(s.percent)}</b>
                  </li>
                ))}
            </ul>
          )}
          {insight.error && <p className="rs-bad">{insight.error}</p>}
          <p className="tz-terrain-src">
            {a ? `التصنيف من تحليل الانحدار المعتمد على الخادم (${a.datasetCode} ${a.datasetVersion}، ${a.surfaceModel})${a.policyVersion != null ? ` — سياسة التمركز النسخة ${a.policyVersion}` : ''}. ` : ''}
            {demAvailable ? 'الارتفاعات من نموذج الارتفاع ثلاثي الأبعاد (Copernicus GLO-30) للعرض فقط ولا تدخل في أي قاعدة.' : 'نموذج الارتفاع غير مثبت في حزمة الخرائط: لا ارتفاعات.'}
          </p>

          {rule && (
            <div className={'tz-terrain-rule ' + (verdict?.tone ?? '')} data-testid="terrain-rule">
              <h4>تعديل مدى المسافة حسب طبيعة الأرض</h4>
              {rule.leg && lines ? (
                <dl>
                  <div>
                    <dt>المدى الأساسي</dt>
                    <dd>{lines.base}</dd>
                  </div>
                  <div>
                    <dt>معدّل طبيعة الأرض</dt>
                    <dd>{lines.terrain}</dd>
                  </div>
                  <div>
                    <dt>المدى الفعّال</dt>
                    <dd data-testid="terrain-effective">{lines.effective}</dd>
                  </div>
                  {lines.exception && (
                    <div>
                      <dt>الاستثناء</dt>
                      <dd>{lines.exception}</dd>
                    </div>
                  )}
                  <div>
                    <dt>المسافة (مركز إلى مركز)</dt>
                    <dd>{rule.leg.distanceM != null ? km(rule.leg.distanceM) : '—'}</dd>
                  </div>
                </dl>
              ) : (
                <p className="tz-muted">{insight.pending ? 'جارٍ التحليل…' : 'لا نطاق قبل تحليل الخادم للمنطقة.'}</p>
              )}
              {verdict && <span className={'tz-terrain-verdict ' + verdict.tone} data-testid="terrain-verdict">{verdict.text}</span>}
              <small className="tz-muted">{rule.source === 'server' ? 'من فحص الخادم عند آخر حفظ.' : 'معاينة من تحليل الخادم للمنطقة الآن — يقرّر فحص الخادم عند الحفظ.'}</small>
              {rule.discrepancy && <p className="rs-bad" data-testid="terrain-discrepancy">تباين: {rule.discrepancy} — يُعتمد فحص الخادم.</p>}
            </div>
          )}
          {move != null && (
            <p className="tz-move-info" data-testid="terrain-move">
              <i className="sw move" /> المسافة من الموقع الحالي: <b>{formatMeters(move)}</b> — للعلم فقط، لا قيد على مسافة إعادة التمركز.
            </p>
          )}
        </>
      )}

      {kinds.length > 0 && (
        <div className="tz-terrain-profile" data-testid="terrain-profile" data-profile-leg={connector?.kind ?? ''}>
          <h4>مقطع ارتفاع المسار</h4>
          <div className="tz-terrain-legs" role="group" aria-label="مقطع المسار">
            {kinds.map((k) => (
              <button key={k} aria-pressed={connector?.kind === k} className={'chip' + (connector?.kind === k ? ' active' : '')} onClick={() => onLeg(k)}>
                {k === 'move' ? 'الانتقال' : k === 'primary' ? 'الانتشار الرئيسي' : 'الانتشار البديل'}
              </button>
            ))}
          </div>
          {connector && <small className="tz-muted">{CONNECTOR_TITLE[connector.kind]} · {km(connector.distanceM)}{connector.kind === 'move' ? ' — للعلم فقط' : ''}</small>}
          {!demAvailable ? (
            <p className="tz-muted">نموذج الارتفاع غير مثبت في حزمة الخرائط.</p>
          ) : profile?.profile ? (
            <ElevationProfile p={profile.profile} />
          ) : (
            <p className="tz-muted">{profile?.pending ? 'جارٍ القراءة…' : '—'}</p>
          )}
        </div>
      )}
    </section>
  );
}

/** Distance along the connector (start at the left) against height; display only. */
export function ElevationProfile({ p }: { p: Profile }) {
  const W = 300;
  const H = 120;
  const L = 34;
  const B = 18;
  const pad = Math.max(10, (p.max - p.min) * 0.12);
  const lo = Math.floor((p.min - pad) / 10) * 10;
  const hi = Math.ceil((p.max + pad) / 10) * 10;
  const x = (d: number) => L + ((W - L - 6) * d) / Math.max(1, p.length);
  const y = (h: number) => 6 + ((H - B - 6) * (hi - h)) / Math.max(1, hi - lo);
  const line = p.d.map((d, i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)},${y(p.h[i]).toFixed(1)}`).join('');
  const area = `${line}L${x(p.length).toFixed(1)},${H - B}L${L},${H - B}Z`;
  const ticks = [lo, Math.round((lo + hi) / 2 / 10) * 10, hi];
  return (
    <figure className="tz-profile" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`مقطع ارتفاع: من ${m(p.start)} إلى ${m(p.end)}، أعلى نقطة ${m(p.max)}`}>
        <defs>
          <linearGradient id="tz-profile-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3ccf7a" stopOpacity="0.85" />
            <stop offset="1" stopColor="#3ccf7a" stopOpacity="0.08" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - 6} y1={y(t)} y2={y(t)} className="grid" />
            <text x={L - 4} y={y(t) + 3} textAnchor="end">{t}</text>
          </g>
        ))}
        <path d={area} fill="url(#tz-profile-fill)" />
        <path d={line} className="line" />
        <text x={L} y={H - 4} textAnchor="start">0</text>
        <text x={W - 6} y={H - 4} textAnchor="end">{(p.length / 1000).toFixed(2)} km</text>
        <text x={4} y={10} textAnchor="start">m</text>
      </svg>
      <figcaption dir="rtl">
        <span>أعلى نقطة: <b>{m(p.max)}</b></span>
        <span>أدنى نقطة: <b>{m(p.min)}</b></span>
        <span>فرق الارتفاع بين الطرفين: <b>{m(Math.abs(p.end - p.start))}</b></span>
        <span>أقصى انحدار على المسار: <b>{pct(p.maxSlopePct)}</b></span>
      </figcaption>
    </figure>
  );
}

/** A geometry's card on the ground (TerrainCards): compact, or expanded when selected. */
export function cardLines(role: CardRole, insight: AreaInsight | null, extra: [string, string][] = []): { compact: string; lines: [string, string][] } {
  const a = insight?.assess;
  const d = insight?.dem;
  const area = insight ? formatArea(insight.areaM2) : '—';
  const elev = d?.centre != null ? m(d.centre) : null;
  const lines: [string, string][] = [['المساحة', area]];
  if (elev) lines.push(['الارتفاع', elev]);
  if (d && role !== 'CURRENT') lines.push(['أدنى / أعلى', `${m(d.min)} / ${m(d.max)}`]);
  if (a && role !== 'CURRENT') lines.push(['التصنيف', a.controllingLabel]);
  return { compact: area + (elev ? ' · ' + elev : ''), lines: [...lines, ...extra] };
}


const TONE_WORD: Record<SlopeTone, string> = { ok: 'مناسب', care: 'بحذر', risk: 'مرتفع أو منخفض شديد' };
const TONE_VERDICT: Record<SlopeTone, string> = {
  ok: 'مناسب للتمركز هنا',
  care: 'ممكن، مع الحذر من الانحدار',
  risk: 'مسموح مع الحذر من الانحدار',
};

const SHAPE_TITLE: Record<SlopeShape, string> = { site: ROLE_TITLE.SITE, primary: ROLE_TITLE.PRIMARY, alternative: ROLE_TITLE.ALTERNATIVE };

/**
 * «الانحدار» on the map: the ground inside the site and the deployment areas being placed, in green, orange or red, with
 * what each colour means and, for the shape being edited, its share and a sentence following the colour with the most
 * ground. The limits are the administrator's (Stationing policy). Display only: it blocks nothing, and the server's class
 * in the terrain panel is the one the rules use.
 */
export function SlopeControl({ on, setOn, limits, available, inside }: {
  on: boolean;
  setOn: (v: boolean) => void;
  limits: SlopeLimits;
  available: boolean;
  inside: SlopeInside | null;
}) {
  const [result, setResult] = useState<SlopeResult | null>(null);
  useEffect(() => {
    if (!inside) return setResult(null);
    return inside.subscribe(setResult);
  }, [inside]);
  const tone = result?.tone ?? null;
  const n = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const range: Record<SlopeTone, string> = {
    ok: `0–${n(limits.greenBelowPct)}٪`,
    care: limits.redFromPct > limits.greenBelowPct ? `${n(limits.greenBelowPct)}–${n(limits.redFromPct)}٪` : '',
    risk: `≥ ${n(limits.redFromPct)}٪`,
  };
  return (
    <div className="tz-slope" data-testid="slope-control" data-on={on ? 'true' : 'false'} data-tone={tone ?? ''} data-live={result?.live ? 'true' : 'false'} data-shape={result?.shape ?? ''}>
      <button
        className={on ? 'on' : ''}
        aria-pressed={on}
        disabled={!available}
        title={!available ? 'نموذج الارتفاع غير مثبت في حزمة الخرائط' : 'ألوان الانحدار داخل الموقع والمناطق'}
        onClick={() => setOn(!on)}
      >
        <i className="tz-slope-swatch" aria-hidden /> الانحدار
      </button>
      {on && available && (
        <div className="tz-slope-legend" role="status">
          {tone ? (
            <>
              <small data-testid="slope-shape">{result ? SHAPE_TITLE[result.shape] : ''}</small>
              <b className={'tz-slope-verdict ' + tone} data-testid="slope-verdict">{TONE_VERDICT[tone]}</b>
            </>
          ) : (
            <small>ضع الموقع أو المنطقة لعرض الانحدار داخلها</small>
          )}
          <ul>
            {SLOPE_TONES.filter((t) => range[t]).map((t) => (
              <li key={t} data-tone={t}>
                <i style={{ background: TONE_COLOUR[t] }} /> <span>{TONE_WORD[t]}</span> <small dir="ltr">{range[t]}</small>
                {tone && <b data-testid={'slope-share-' + t}>{pct(Math.round(result!.shares[t]))}</b>}
              </li>
            ))}
          </ul>
          <small>للعرض من نموذج الارتفاع، ولا يمنع الحفظ؛ التصنيف المعتمد من الخادم</small>
        </div>
      )}
    </div>
  );
}
