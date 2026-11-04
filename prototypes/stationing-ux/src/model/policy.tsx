// The administrative stationing policies — the deployment-area requirement and the maximum footprint area of a proposed
// re-stationing site — and the later registration of a stationing's deployment areas (owner corrections of 3 Nov 2026).
// The system administrator changes a policy by an audited, versioned act; requests keep the versions pinned at
// submission. A stationing activated without deployment areas gets them later through their own process.
import { useEffect, useState, type ReactNode } from 'react';
import L from '../../../../frontend/src/lib/leaflet';
import type { Ring } from '../../../../frontend/src/lib/footprint';
import { symbolHtml } from '../symbols';
import { AREA_LABEL, AreaRelations, VertexSwitch, areaObstacles, drawPair, useAreaEngine } from './areas';
import { Act, Events, Head, who, type CardCtx } from './cards';
import { formatArea, orgName, rangeText, siteOf } from './compare';
import { AREQ_LABEL, MEASURE_LABEL, POLICY_LABEL, checkAreaPair, day, policyAt, policyValue, profileAt, profileRef, when, type AreaRole, type AreasRequirement, type PolicyKey } from './domain';
import { fitPadding } from './fit';

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (s: string) => Date.parse(s + 'T06:00:00Z');

export function PolicyCard({ c }: { c: CardCtx }) {
  const w = c.world;
  const [eff, setEff] = useState(iso(w.now));
  const [km2, setKm2] = useState(String((policyAt(w, 'max_restationing_footprint_area').value as number) / 1e6));
  const effectiveFrom = eff === iso(w.now) ? w.now : parse(eff);
  const prof = profileAt(w);
  const submitted = w.requests.filter((r) => r.policy);
  const pinned = (key: PolicyKey) => {
    const by = new Map<number, number>();
    for (const r of submitted) {
      const v = key === 'stationing_areas_requirement' ? r.policy!.areas.version : r.policy!.maxArea.version;
      by.set(v, (by.get(v) ?? 0) + 1);
    }
    return [...by].map(([v, n]) => 'طلبات مرسلة على الإصدار ' + v + ': ' + n).join(' · ');
  };
  const nextVersion = (key: PolicyKey) => Math.max(...w.policies.filter((p) => p.key === key).map((p) => p.version)) + 1;
  const consequence = 'تسري على المسودات والطلبات التي تُرسل بعد السريان. الطلبات المرسلة (' + submitted.length + ') تبقى على الإصدار المثبَّت لها. يُسجَّل الفاعل والوقت والقيمة السابقة والجديدة والسبب والسريان والإصدار.';
  const target: AreasRequirement = policyAt(w, 'stationing_areas_requirement', effectiveFrom).value === 'REQUIRED' ? 'OPTIONAL' : 'REQUIRED';
  const maxM2 = Math.round(Number(km2) * 1e6);
  const block = (k: PolicyKey, children: ReactNode) => {
    const now = policyAt(w, k);
    const history = w.policies.filter((p) => p.key === k).sort((a, b) => b.version - a.version);
    return (
      <div className="md-block md-policy-block" data-testid={'policy-' + k} data-value={String(now.value)} data-version={now.version}>
        <b className="md-k">
          {POLICY_LABEL[k]} <span className="ux-mono">{k}</span>
        </b>
        <p className="md-v">
          <span className={'md-policy ' + String(now.value).toLowerCase()}>
            <b>{policyValue(k, now.value)}</b> · الإصدار {now.version}
          </span>
          <small>
            منذ {when(now.effectiveFrom)} · {who(w, now.changedBy)}
          </small>
        </p>
        {history
          .filter((p) => p.effectiveFrom > w.now)
          .map((p) => (
            <div className="md-alert info" key={p.version} data-testid="policy-scheduled">
              إصدار مجدول: الإصدار {p.version} ({policyValue(k, p.value)}) يسري من {when(p.effectiveFrom)}؛ حتى ذلك الوقت يبقى الإصدار {now.version} نافذاً.
            </div>
          ))}
        <small data-testid={'policy-pinning-' + k}>{pinned(k) || 'لا طلبات مرسلة'}. تغيير السياسة لا يغيّر متطلبات طلب مرسل.</small>
        {children}
        <details data-testid={'policy-history-' + k}>
          <summary className="md-k">سجل الإصدارات ({history.length}) — للإضافة فقط</summary>
          <ol className="md-events">
            {history.map((p) => (
              <li key={p.version}>
                <span className="ux-mono">
                  الإصدار {p.version}: {p.previous !== undefined ? policyValue(k, p.previous) + ' ← ' : ''}
                  {policyValue(k, p.value)}
                </span>
                <small>
                  يسري من {when(p.effectiveFrom)} · {who(w, p.changedBy)} · في {when(p.changedAt)} · السبب: {p.reason}
                </small>
              </li>
            ))}
          </ol>
        </details>
      </div>
    );
  };
  return (
    <section className="ux-card md-card" aria-label="سياسات التمركز الإدارية">
      <Head c={c} title="سياسات التمركز الإدارية" sub="يغيّرها مسؤول النظام بإصدار جديد؛ تُثبَّت للطلب عند إرساله" onClose={() => c.select(null)} />
      <label className="md-field">
        يسري الإصدار الجديد من
        <input type="date" value={eff} min={iso(w.now)} onChange={(e) => setEff(e.target.value)} data-testid="policy-effective" />
      </label>
      {block(
        'stationing_areas_requirement',
        <>
        <small>
          إلزامية: لا يُرسل الطلب دون الموقع المقترح ومنطقة الانتشار الرئيسية ومنطقة الانتشار البديلة. اختيارية: يُرسل دون منطقتين، أو بهما معاً — لا إحداهما وحدها. قيمة واحدة للدائم والمؤقت.
        </small>
        <div className="ux-actions">
          <Act
            c={c}
            a={{ t: 'SET_POLICY', key: 'stationing_areas_requirement', value: target, effectiveFrom, reason: '' }}
            label={target === 'REQUIRED' ? 'جعل منطقتي الانتشار إلزاميتين' : 'جعل منطقتي الانتشار اختياريتين'}
            kind="auth"
            dialog={{
              title: POLICY_LABEL.stationing_areas_requirement + ': ' + AREQ_LABEL[target],
              record: 'stationing_areas_requirement · الإصدار ' + nextVersion('stationing_areas_requirement') + ' · ' + policyValue('stationing_areas_requirement', policyAt(w, 'stationing_areas_requirement', effectiveFrom).value) + ' ← ' + AREQ_LABEL[target] + ' · يسري من ' + when(effectiveFrom),
              consequence,
              kind: 'auth',
              confirm: 'نشر الإصدار',
            }}
          />
        </div>
        </>,
      )}
      {block(
        'max_restationing_footprint_area',
        <>
        <small>يُقارن بمساحة حدود الموقع المقترح. التجاوز يمنع الإرسال ويُظهر المساحة والحد والإصدار. لا يُصغَّر الشكل ولا يُقترح موقع.</small>
        <label className="md-field">
          الحد الجديد (كم²)
          <input type="number" min="0.001" step="0.001" value={km2} onChange={(e) => setKm2(e.target.value)} data-testid="policy-max-area" />
        </label>
        <div className="ux-actions">
          <Act
            c={c}
            a={{ t: 'SET_POLICY', key: 'max_restationing_footprint_area', value: maxM2, effectiveFrom, reason: '' }}
            label={'نشر الحد ' + (maxM2 > 0 ? formatArea(maxM2) : '—')}
            kind="auth"
            dialog={{
              title: POLICY_LABEL.max_restationing_footprint_area,
              record: 'max_restationing_footprint_area · الإصدار ' + nextVersion('max_restationing_footprint_area') + ' · ' + policyValue('max_restationing_footprint_area', policyAt(w, 'max_restationing_footprint_area', effectiveFrom).value) + ' ← ' + (maxM2 > 0 ? formatArea(maxM2) : '—') + ' · يسري من ' + when(effectiveFrom),
              consequence,
              kind: 'auth',
              confirm: 'نشر الإصدار',
            }}
          />
        </div>
        </>,
      )}
      <div className="md-block">
        <b className="md-k">ملف السياسة المنشور (للعلاقتين)</b>
        <small data-testid="profile-relations">
          «{prof.name}» ({profileRef(prof)}) — مثال وهمي. الموقع المقترح ← منطقة الانتشار الرئيسية: {rangeText(prof.siteToPrimaryArea)} · منطقة الانتشار الرئيسية ← منطقة الانتشار البديلة:{' '}
          {rangeText(prof.primaryAreaToAlternativeArea)} · طريقة القياس: {MEASURE_LABEL[prof.measure]}. <b>لا قاعدة مسافة بين التمركز الحالي والموقع المقترح.</b> الطلبات المرسلة على
          ملف سابق تُفحص بطريقته.
        </small>
      </div>
      <Events w={w} list={w.events.filter((e) => e.ref === 'stationing_areas_requirement' || e.ref === 'max_restationing_footprint_area').slice().reverse()} />
    </section>
  );
}

/**
 * The later process for a stationing in force without deployment areas: an external decision registered by
 * MANAGE_STATIONING (D5). The two areas are drawn vertex by vertex and checked against the profile published now; the
 * decision's authority and number are recorded with the act.
 */
export function AreaRegistrar({ c, map, stationing, narrow }: { c: CardCtx; map: L.Map | null; stationing: string; narrow: boolean }) {
  const w = c.world;
  const s = w.stationings.find((x) => x.id === stationing)!;
  const site = siteOf(w, s.siteId)!;
  const prof = profileAt(w);
  const [rings, setRings] = useState<Partial<Record<AreaRole, Ring>>>({});
  const [target, setTarget] = useState<AreaRole>('PRIMARY_AREA');
  const [authority, setAuthority] = useState('');
  const [reference, setReference] = useState('');
  const check = checkAreaPair(w, prof, s.org, site.ring, rings, Math.max(w.now, s.from), s.plannedEnd);

  const vertexToggle = useAreaEngine(
    map,
    true,
    target,
    () => ({
      from: target === 'PRIMARY_AREA' ? site.ring : (rings.PRIMARY_AREA ?? null),
      range: target === 'PRIMARY_AREA' ? prof.siteToPrimaryArea : prof.primaryAreaToAlternativeArea,
      measure: prof.measure,
      ring: rings[target],
      symbol: symbolHtml(c.symbols.get(s.org)),
      busy: areaObstacles(w, s.org),
    }),
    (ring) => setRings((x) => ({ ...x, [target]: ring })),
  );

  // the stationing's site and the area not being edited, with its measured relation
  useEffect(() => {
    if (!map) return;
    const g = L.layerGroup().addTo(map);
    L.polygon(site.ring.map((p) => [p.lat, p.lng] as L.LatLngTuple), { color: '#2f6db0', weight: 3, fillOpacity: 0.16, interactive: false }).addTo(g);
    const tag = (at: { lat: number; lng: number }, html: string, cls: string) =>
      L.marker([at.lat, at.lng], { interactive: false, icon: L.divIcon({ className: 'md-tag-icon', html: '<span class="md-tag ' + cls + '">' + html + '</span>', iconSize: [0, 0] }) }).addTo(g);
    tag(site.ring.reduce((a, p) => (p.lat > a.lat ? p : a), site.ring[0]), 'التمركز · ' + site.name, 'perm up');
    const line = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, color: string, chip?: string, dash = '7 6', at = 0.5) => {
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color, weight: 2.4, dashArray: dash, interactive: false }).addTo(g);
      if (chip) tag({ lat: a.lat + (b.lat - a.lat) * at, lng: a.lng + (b.lng - a.lng) * at }, chip, 'chip');
    };
    drawPair(g, site.ring, rings, check, prof.measure, target, tag, line, narrow);
    return () => void g.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, rings, target, narrow]);

  useEffect(() => {
    if (map) map.flyToBounds(L.latLngBounds(site.ring.map((p) => [p.lat, p.lng] as L.LatLngTuple)).pad(8), { ...fitPadding(narrow), maxZoom: 13, duration: 0.3 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const complete = check.present === 'COMPLETE' && check.problems.length === 0;
  return (
    <section className="ux-card md-card" aria-label="تسجيل منطقتي الانتشار">
      <Head c={c} org={s.org} title="تسجيل منطقتي الانتشار للتمركز" sub={orgName(s.org) + ' · ' + site.name + ' · منذ ' + day(s.from)} onClose={() => c.select({ k: 'org', id: s.org })} />
      <div className="md-seg3 two" role="radiogroup" aria-label="ما يُرسم على الخريطة">
        {(['PRIMARY_AREA', 'ALTERNATIVE_AREA'] as const).map((r) => (
          <button key={r} role="radio" aria-checked={target === r} className={target === r ? 'on' : ''} disabled={r === 'ALTERNATIVE_AREA' && !rings.PRIMARY_AREA} onClick={() => setTarget(r)} data-target={r}>
            {AREA_LABEL[r]}
          </button>
        ))}
      </div>
      <p className="ux-hint">
        إجراء مستقل لتمركز نافذ بلا منطقتي انتشار: قرار خارجي يسجله صاحب صلاحية MANAGE_STATIONING. تُرسم المنطقتان معاً وتُفحصان بالملف المنشور الآن ({profileRef(prof)}، {MEASURE_LABEL[prof.measure]}) وبالإتاحة.
      </p>
      <p className="ux-hint" data-testid="area-hint">
        {rings[target] ? 'اسحب المنطقة كاملة من جسمها أو رمزها.' : 'انقر ستة رؤوس على الخريطة لرسم ' + AREA_LABEL[target] + '.'} تُقاس {target === 'PRIMARY_AREA' ? 'من موقع التمركز' : 'من منطقة الانتشار الرئيسية'}.
      </p>
      <VertexSwitch t={vertexToggle} />
      <AreaRelations c={check} required />
      <label className="md-field">
        الجهة المصدرة للقرار
        <input value={authority} onChange={(e) => setAuthority(e.target.value)} data-testid="decision-authority" />
      </label>
      <label className="md-field">
        رقم القرار
        <input value={reference} onChange={(e) => setReference(e.target.value)} data-testid="decision-reference" />
      </label>
      <div className="md-binding" role="group" aria-label="إجراءات نافذة">
        <div className="ux-actions">
          <Act
            c={c}
            a={{ t: 'REGISTER_AREAS', stationing: s.id, primary: rings.PRIMARY_AREA ?? [], alternative: rings.ALTERNATIVE_AREA ?? [], authority, reference, reason: '' }}
            label="تسجيل منطقتي الانتشار"
            kind="auth"
            dialog={{
              title: 'تسجيل منطقتي الانتشار للتمركز',
              record: orgName(s.org) + ' · ' + site.name + ' · قرار ' + reference + ' من «' + authority + '»',
              consequence: 'تُنشأ منطقة الانتشار الرئيسية ومنطقة الانتشار البديلة سجلين نشطين مرتبطين بهذا التمركز، وتمنعان التداخل من الآن (D4). تنتهيان بانتهاء التمركز ولا تنتقلان إلى تمركز آخر.',
              kind: 'auth',
              confirm: 'تسجيل',
            }}
          />
        </div>
      </div>
      {!complete && <p className="ux-note">الزر متاح حين تكتمل المنطقتان ضمن قيم الملف، ويُذكر القرار.</p>}
    </section>
  );
}
