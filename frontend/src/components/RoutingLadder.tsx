import { useState } from 'react';
import type { HierarchyLevel, StationingFact, StationingPolicyValues } from '../api/types';
import { ladder, makeFinal, patchLevel, previewRoute, switchApproves, withoutDuplicates, type RoutingValue } from '../lib/stationingRoute';
import './routingLadder.css';

const FACTS: [StationingFact, string][] = [
  ['SCOPE', 'الوحدات المنتقلة'],
  ['CLASSIFICATION', 'النوع (دائم / مؤقت)'],
  ['DURATION', 'المدة'],
  ['SITE', 'الموقع المقترح'],
  ['DEPLOYMENT', 'الانتشار'],
  ['AVAILABILITY', 'الإتاحة'],
];

const n = (v: number) => v.toLocaleString('ar-AE');

/**
 * «مسار الاعتماد» on «سياسة التمركز» (owner redesign, 16 Nov 2026): the hierarchy's levels as a ladder in the order a request
 * climbs, one row per level (never typed, never repeated), each with «يعتمد», its stage name, «المرحلة النهائية» and what
 * re-opens its approval; under it, the route the server builds for a unit at a chosen level (RouteDerivation.derive).
 */
export function RoutingLadder({ routing, levels, stages, onChange }: {
  routing: RoutingValue;
  levels: HierarchyLevel[];
  stages?: StationingPolicyValues['approvalStages'];
  onChange: (next: RoutingValue) => void;
}) {
  const rows = ladder(routing, levels);
  const final = routing.levels.find((l) => l.finalStage)?.level ?? null;
  const repeated = rows.filter((r) => r.duplicates > 0).map((r) => r.level);
  const deepest = levels.length ? Math.max(...levels.map((l) => l.level)) : null;
  const [from, setFrom] = useState<number | null>(null);
  const fromLevel = from ?? deepest;
  const preview = fromLevel == null ? null : previewRoute(routing, levels.map((l) => l.level), fromLevel);
  const after = [stages?.unitOperations && 'اعتماد عمليات الوحدة', stages?.finalByPermission && 'الاعتماد النهائي'].filter(Boolean) as string[];

  return (
    <div className="rt" data-testid="policy-routing">
      <div className="rt-step">
        <span className="rt-num">1</span>
        <div className="rt-step-body">
          <b>من يعتمد أولاً؟</b>
          <div className="rt-seg" role="radiogroup" aria-label="بداية المسار">
            {([['SELF', 'معتمد الوحدة الطالبة', 'يبدأ المسار من الوحدة التي قدّمت الطلب'], ['PARENT', 'الجهة الأعلى للوحدة الطالبة', 'لا تعتمد الوحدة طلبها؛ يبدأ من الجهة فوقها']] as const).map(([v, label, hint]) => (
              <button key={v} type="button" role="radio" aria-checked={routing.startAt === v} data-start={v} className={routing.startAt === v ? 'on' : ''} onClick={() => onChange({ ...routing, startAt: v })}>
                <span>{label}</span>
                <small>{hint}</small>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rt-step">
        <span className="rt-num">2</span>
        <div className="rt-step-body">
          <b>المستويات التي تعتمد</b>
          <small className="muted">مستويات الهيكل كما يرسلها Oracle، بالترتيب الذي يصعد به الطلب. شغّل «يعتمد» للمستوى الذي يوقّع، واجعل مستوى واحداً «المرحلة النهائية»: عنده يقف المسار.</small>
          {final == null && levels.length > 0 && <div className="rt-alert" role="alert">لم تُحدَّد المرحلة النهائية بعد — لا تُنشر السياسة بدونها.</div>}
          {repeated.length > 0 && (
            <div className="rt-alert">
              مستوى مكرر في القيم الحالية: {repeated.map((l) => 'L' + l).join('، ')}. يؤخذ الصف الأول كما يفعل الخادم.
              <button type="button" className="chip" onClick={() => onChange(withoutDuplicates(routing))}>إزالة التكرار</button>
            </div>
          )}
          {levels.length === 0 && <p className="muted">تظهر المستويات بعد استيراد الوحدات من الموارد البشرية.</p>}
          <ol className="rt-ladder">
            <li className="rt-edge">الوحدات الأدنى — من هنا يبدأ الطلب ↑</li>
            {rows.map(({ level, cfg, info }) => {
              const approves = !!cfg?.approves;
              const isFinal = !!cfg?.finalStage;
              const above = final != null && level < final;
              const state = isFinal ? 'final' : above ? 'above' : approves ? 'on' : 'off';
              return (
                <li key={level} className={'rt-level ' + state} data-level={level}>
                  <span className="rt-dot" aria-hidden="true" />
                  <div className="rt-head">
                    <span className="rt-badge">L{level}</span>
                    <span className="rt-meta">
                      {info ? (
                        <>
                          <b>{n(info.units)} {info.units === 1 ? 'وحدة' : 'وحدات'}</b>
                          <span className="muted" title={info.examples.join('، ')}> · {info.examples.join('، ')}{info.units > info.examples.length ? '…' : ''}</span>
                        </>
                      ) : (
                        <span className="rs-bad">غير موجود في الهيكل الحالي</span>
                      )}
                    </span>
                    {above && !approves ? (
                      <span className="rt-note">فوق المرحلة النهائية — لا يصل إليه الطلب</span>
                    ) : (
                      <button type="button" role="switch" aria-checked={approves} aria-label={'المستوى L' + level + ' يعتمد'} data-approves={level} className={'rt-switch' + (approves ? ' on' : '')} onClick={() => onChange(switchApproves(routing, level, !approves))}>
                        <i aria-hidden="true" />
                        {approves ? 'يعتمد' : 'لا يعتمد'}
                      </button>
                    )}
                    {!isFinal && (
                      <button type="button" className="rt-make-final" data-final={level} onClick={() => onChange(makeFinal(routing, level))} title="يقف المسار عند هذا المستوى">
                        اجعلها المرحلة النهائية
                      </button>
                    )}
                    {!info && (
                      <button type="button" className="chip" aria-label={'حذف المستوى L' + level} onClick={() => onChange({ ...routing, levels: routing.levels.filter((l) => l.level !== level) })}>✕</button>
                    )}
                  </div>
                  {approves && (
                    <div className="rt-body">
                      <label className="rt-name">
                        <span>اسم المرحلة</span>
                        <input data-label={level} value={cfg?.label ?? ''} placeholder={'اعتماد المستوى L' + level} className={cfg?.label?.trim() ? '' : 'rt-missing'} onChange={(e) => onChange(patchLevel(routing, level, { label: e.target.value }))} />
                      </label>
                      {isFinal ? (
                        <div className="rt-final-tag" data-final-tag={level}>★ المرحلة النهائية · تُعاد موافقتها عند أي تغيير</div>
                      ) : (
                        <div className="rt-facts" role="group" aria-label={'ما يعيد موافقة L' + level}>
                          <span className="muted">تُعاد موافقتها إذا تغيّر بعدها:</span>
                          {FACTS.map(([f, label]) => {
                            const on = !!cfg?.dependsOn.includes(f);
                            return (
                              <button key={f} type="button" aria-pressed={on} data-fact={f} className={'rt-fact' + (on ? ' on' : '')} onClick={() => onChange(patchLevel(routing, level, { dependsOn: on ? cfg!.dependsOn.filter((x) => x !== f) : [...(cfg?.dependsOn ?? []), f] }))}>
                                {on ? '✓ ' : ''}{label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            <li className="rt-edge">أعلى الهيكل</li>
          </ol>
        </div>
      </div>

      <div className="rt-step">
        <span className="rt-num">3</span>
        <div className="rt-step-body" data-testid="routing-preview">
          <b>معاينة المسار</b>
          {fromLevel == null || !preview ? (
            <small className="muted">تظهر بعد استيراد الوحدات.</small>
          ) : (
            <>
              <label className="rt-from">
                طلب من وحدة في المستوى
                <select aria-label="مستوى الوحدة الطالبة في المعاينة" value={fromLevel} onChange={(e) => setFrom(Number(e.target.value))}>
                  {[...levels].sort((a, b) => b.level - a.level).map((l) => (
                    <option key={l.level} value={l.level}>L{l.level} ({n(l.units)})</option>
                  ))}
                </select>
              </label>
              <ol className="rt-chain">
                <li className="start">الوحدة الطالبة · L{fromLevel}</li>
                {preview.stages.map((s) => (
                  <li key={s.level} className={s.finalStage ? 'final' : ''}>
                    <small>L{s.level}</small> {s.label?.trim() || 'بلا اسم'}{s.finalStage ? ' ★' : ''}
                  </li>
                ))}
                {preview.stages.length === 0 && <li className="none">لا اعتماد من الهيكل</li>}
                {after.map((a) => <li key={a} className="after">{a}</li>)}
                <li className="end">التفعيل</li>
              </ol>
              {final != null && fromLevel < final && <small className="muted">هذه الوحدة فوق المرحلة النهائية، فلا يمر طلبها بها.</small>}
              <small className="muted">من يحمل كل مرحلة تحدده الصلاحيات، لا هذه الصفحة.</small>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
