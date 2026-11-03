// The owner's final scenarios A–V (final brief §46) plus W (the distance-method comparison the owner must decide, §48)
// and X (site ↔ unit links, §39), as setups of the fictional world: each is a list of simulated actions, so the unit
// tests and the browser page run exactly the same steps. Open restationing.html#s=A … #s=X.
import { centroid, moveRigid, type Ring } from '../../../../frontend/src/lib/footprint';
import type { LatLng } from '../../../../frontend/src/lib/geo';
import { DAY, perform, permanentOf, presetScope, siteOf, type Action, type Content, type PolicyValues, type World } from './domain';
import { BASE_POLICY, NOW, baseWorld } from './fixtures';
import { circleRing } from './measure';

export type Step = 'SCOPE' | 'TYPE' | 'SITE' | 'PRIMARY' | 'ALTERNATIVE' | 'REVIEW';
export type Sel = { k: 'site'; id: string } | { k: 'org'; id: string } | { k: 'req'; id: string } | { k: 'edit'; id: string; step: Step } | { k: 'policy' } | { k: 'links' } | { k: 'compare' } | null;
export type Scenario = { code: string; title: string; actor: string; actions: [string, Action][]; sel: Sel; note: string; layer?: 'streets' | 'terrain' };

/** Fictional placement points (on land on the illustrative basemap). */
export const P = {
  newSite: { lat: 25.229, lng: 55.292 },
  primary: { lat: 25.262, lng: 55.336 },
  alternative: { lat: 25.29, lng: 55.31 },
  intoH: { lat: 25.2025, lng: 55.3095 },
  /** on registered site F (occupied): a deployment area here is blocked (O-08) */
  onSiteF: { lat: 25.239, lng: 55.3555 },
  /** straddles the fictional RUGGED zone's northern edge: the class is decided by the largest share (O-05) */
  straddle: { lat: 25.1475, lng: 55.304 },
  /** inside the RUGGED zone ~9.3 km from the new site: valid only with the +2 km allowance (5–8 → 5–10) */
  rugged: { lat: 25.145, lng: 55.29 },
  ruggedAlt: { lat: 25.17, lng: 55.27 },
  /** centred on the western edge of the square RUGGED zone tz-4: exactly 50 % FLAT / 50 % RUGGED */
  tie: { lat: 25.195, lng: 55.245 },
  tieAlt: { lat: 25.16, lng: 55.225 },
};

export const copyTo = (w: World, site: string, to: LatLng): Ring => moveRigid(siteOf(w, site)!.ring, to);

export function content(w: World, scope: string[], o: Partial<Content> & { at?: LatLng; from?: string; deploy?: [LatLng, LatLng] | null; radius?: number } = {}): Content {
  const from = o.from ?? permanentOf(w, scope[0])!.site;
  const at = o.at ?? P.newSite;
  const deploy = o.deploy === undefined ? [P.primary, P.alternative] : o.deploy;
  return {
    kind: o.kind ?? 'PERMANENT',
    start: o.start ?? NOW + 7 * DAY,
    end: o.end,
    scope,
    occupants: o.occupants ?? {},
    site: { ring: copyTo(w, from, at), copiedFrom: from, shape: 'COPY' },
    primary: deploy ? circleRing(deploy[0], o.radius ?? 600) : null,
    alternative: deploy ? circleRing(deploy[1], 500) : null,
    exceptions: o.exceptions ?? {},
    reason: o.reason ?? 'تجميع الوحدات في موقع واحد (سبب توضيحي)',
  };
}

export function run(actions: [string, Action][], w = baseWorld()): World {
  for (const [who, a] of actions) w = perform(w, who, a);
  return w;
}

const W0 = baseWorld();
const approveAll = (req: string, people: string[]): [string, Action][] => people.map((p) => [p, { t: 'APPROVE', req }]);
const publish = (values: PolicyValues, reason: string, reference: string): [string, Action] => ['p-admin', { t: 'PUBLISH_POLICY', values, effectiveFrom: NOW, reason, reference }];
const optional = publish({ ...structuredClone(BASE_POLICY), deployment: 'OPTIONAL' }, 'الانتشار اختياري (توضيحي)', 'POL-STN-DEMO-2');
const crossAllowed = publish({ ...structuredClone(BASE_POLICY), crossBranch: { allowed: true, authorities: ['OTHER_UNIT', 'OTHER_UNIT_PARENT'], independent: false } }, 'ضم وحدة من فرع آخر بموافقتين (توضيحي)', 'POL-STN-DEMO-3');
const crossShared = publish({ ...structuredClone(BASE_POLICY), crossBranch: { allowed: true, authorities: ['OTHER_UNIT', 'SITE_RESPONSIBLE'], independent: false } }, 'موافقة المسؤول عن الموقع تستوفيها المرحلة الهرمية نفسها (توضيحي)', 'POL-STN-DEMO-4');
const crossIndependent = publish({ ...structuredClone(BASE_POLICY), crossBranch: { allowed: true, authorities: ['OTHER_UNIT', 'SITE_RESPONSIBLE'], independent: true } }, 'موافقات مستقلة بإنسان مختلف (توضيحي)', 'POL-STN-DEMO-5');

const SCOPE_CO = presetScope(W0, 'u800', 'WITH_COLOCATED');
const EXCL = { u802: 'EXCLUDED' as const };
const SCOPE_G = presetScope(W0, 'u800', 'WHOLE_BRANCH').filter((o) => o !== 'u902');
const ROUTE_800 = ['p-a8', 'p-a7', 'p-a6'];

const create = (id: string, c: Content, by = 'p-req'): [string, Action] => [by, { t: 'CREATE', id, content: c }];
const submit = (id: string, by = 'p-req'): [string, Action] => [by, { t: 'SUBMIT', req: id }];
const temp = (start: number, end: number) => ({ kind: 'TEMPORARY' as const, start: NOW + start * DAY, end: NOW + end * DAY, occupants: EXCL });

export const SCENARIOS: Scenario[] = [
  { code: 'A', title: 'هيكل Oracle من L6 إلى L10', actor: 'p-req', actions: [], sel: { k: 'org', id: 'u1000' }, note: 'وحدة صيانة المباني (L10) ← الشعبة (L9) ← القسم (L8) ← الإدارة (L7) ← الإدارة العامة (L6): من روابط الأب في Oracle، بلا مستوى مكتوب في الكود.' },
  { code: 'B', title: 'أب وأبناء في مواقع مختلفة', actor: 'p-req', actions: [], sel: { k: 'org', id: 'u800' }, note: 'القسم في A، والشعبة في B، ووحدة المباني في C: الارتباط التنظيمي ظاهر بخطوط منقطة، والمواقع لا تتراكب.' },
  { code: 'C', title: 'موقع مشترك', actor: 'p-req', actions: [], sel: { k: 'site', id: 'SITE-0101' }, note: 'كائن واحد للموقع A: متمركزون (القسم وتابعاه، وقسم الشبكات غير التابع)، ووحدات مرتبطة بالموقع غير متمركزة فيه — مفهومان منفصلان.' },
  { code: 'D', title: 'وحدة من فرع آخر في الموقع', actor: 'p-req', actions: [create('rD', content(W0, SCOPE_CO))], sel: { k: 'edit', id: 'rD', step: 'SCOPE' }, note: 'قسم الشبكات (إدارة تقنية المعلومات) لا يُنقل تلقائياً، ولا يُرسل الطلب قبل قرار صريح بشأنه.' },
  { code: 'E', title: 'نقل وحدات مختارة في الموقع نفسه بسحب واحد', actor: 'p-req', actions: [create('rE', content(W0, SCOPE_CO, { occupants: EXCL }))], sel: { k: 'edit', id: 'rE', step: 'SITE' }, note: 'القسم وشعبة النقل ووحدة الصيانة الكهربائية ينتقلون معاً بسحب نسخة الموقع A مرة واحدة.' },
  { code: 'F', title: 'تجميع وحدات من مواقع متعددة في موقع واحد', actor: 'p-req9', actions: [create('rF', content(W0, ['u900', 'u1000', 'u1001'], { from: 'SITE-0102' }), 'p-req9')], sel: { k: 'edit', id: 'rF', step: 'REVIEW' }, note: 'الطلب من الشعبة (وحدة تابعة): الشعبة (B) ووحدة المباني (C) ووحدة الصيانة الكهربائية (A) إلى موقع مقترح واحد.' },
  { code: 'G', title: 'استبعاد وحدة تابعة', actor: 'p-req', actions: [create('rG', content(W0, SCOPE_G, { occupants: EXCL }))], sel: { k: 'edit', id: 'rG', step: 'SCOPE' }, note: 'الفرع كاملاً عدا شعبة المستودعات: تبقى في الموقع D.' },
  {
    code: 'H',
    title: 'ضم وحدة من فرع آخر بموافقات مهيأة',
    actor: 'p-req',
    actions: [crossAllowed, create('rH', content(W0, [...SCOPE_CO, 'u802'], { occupants: { u802: 'INCLUDED' } }))],
    sel: { k: 'edit', id: 'rH', step: 'REVIEW' },
    note: 'الإعداد (نسخة 2) يسمح بالضم ويطلب موافقتين: معتمد الوحدة من الفرع الآخر ومعتمد أبيها. تظهر مرحلتاهما في المسار.',
  },
  {
    code: 'I',
    title: 'إعادة تمركز دائمة',
    actor: 'p-act',
    actions: [create('rI', content(W0, SCOPE_CO, { occupants: EXCL })), submit('rI'), ...approveAll('rI', ROUTE_800), ['p-act', { t: 'ACTIVATE', req: 'rI' }]],
    sel: { k: 'req', id: 'rI' },
    note: 'بعد التفعيل المستقل يصبح الموقع الجديد التمركز الحالي، ويبقى السابق في السجل. روابط المواقع والمسؤولية لم تتغير.',
  },
  {
    code: 'J',
    title: 'إعادة تمركز مؤقتة نافذة',
    actor: 'p-req',
    actions: [create('rJ', content(W0, SCOPE_CO, temp(1, 30))), submit('rJ'), ...approveAll('rJ', ROUTE_800), ['p-act', { t: 'ACTIVATE', req: 'rJ' }], ['p-req', { t: 'TICK', ms: 2 * DAY }]],
    sel: { k: 'req', id: 'rJ' },
    note: 'المؤقت نافذ، والتمركز الأصلي في A محفوظ كما هو تحته.',
  },
  {
    code: 'K',
    title: 'العودة التلقائية عند انتهاء المؤقت',
    actor: 'p-req',
    actions: [create('rK', content(W0, SCOPE_CO, temp(2, 32))), submit('rK'), ...approveAll('rK', ROUTE_800), ['p-act', { t: 'ACTIVATE', req: 'rK' }], ['p-req', { t: 'TICK', ms: 3 * DAY }], ['p-req', { t: 'TICK', ms: 30 * DAY }]],
    sel: { k: 'req', id: 'rK' },
    note: 'عند النهاية المعتمدة عادت الوحدات إلى تمركزها الأصلي المحفوظ دون طلب.',
  },
  {
    code: 'L',
    title: 'تمديد المؤقت',
    actor: 'p-act',
    actions: [
      create('rL', content(W0, SCOPE_CO, temp(1, 20))),
      submit('rL'),
      ...approveAll('rL', ROUTE_800),
      ['p-act', { t: 'ACTIVATE', req: 'rL' }],
      ['p-req', { t: 'TICK', ms: 2 * DAY }],
      ['p-req', { t: 'REQUEST_EXTENSION', req: 'rL', newEnd: NOW + 40 * DAY, reason: 'استمرار الأعمال (توضيحي)' }],
      ['p-a8', { t: 'APPROVE_EXTENSION', req: 'rL' }],
      ['p-a6', { t: 'APPROVE_EXTENSION', req: 'rL' }],
      ['p-act', { t: 'ACTIVATE_EXTENSION', req: 'rL' }],
      ['p-req', { t: 'TICK', ms: 20 * DAY }],
    ],
    sel: { k: 'req', id: 'rL' },
    note: 'التمديد يراجعه من يعتمد قراره على المدة، ويُفعَّل مستقلاً؛ بعده تجاوز الوقت النهاية الأصلية وبقي المؤقت نافذاً.',
  },
  {
    code: 'M',
    title: 'إرجاع للتعديل: الطلب نفسه',
    actor: 'p-req',
    actions: [create('rM', content(W0, SCOPE_CO, { occupants: EXCL })), submit('rM'), ['p-a8', { t: 'APPROVE', req: 'rM' }], ['p-a7', { t: 'RETURN', req: 'rM', reason: 'قرّبوا الموقع المقترح من الطريق الرئيسي (توضيحي)' }]],
    sel: { k: 'edit', id: 'rM', step: 'SITE' },
    note: 'يعدّل مقدم الطلب الموقع في الطلب نفسه؛ يبقى قرار القسم (لا يعتمد على الموقع) ويُعاد ما يعتمد عليه.',
  },
  {
    code: 'N',
    title: 'المسار من الوحدة الطالبة صعوداً',
    actor: 'p-req9',
    actions: [create('rN', content(W0, ['u900', 'u1000'], { from: 'SITE-0102' }), 'p-req9')],
    sel: { k: 'edit', id: 'rN', step: 'REVIEW' },
    note: 'الوحدة الطالبة الشعبة (L9): الشعبة ← القسم ← الإدارة ← النهائي. L10 لا يعتمد في الإعداد فلا مرحلة فارغة له.',
  },
  {
    code: 'O',
    title: 'تغيّر الهيكل أثناء الطلب: إيقاف وإعادة',
    actor: 'p-req',
    actions: [
      create('rO', content(W0, SCOPE_CO, { occupants: EXCL })),
      submit('rO'),
      ['p-a8', { t: 'APPROVE', req: 'rO' }],
      ['oracle', { t: 'ORACLE_SYNC', rows: [{ oracleId: '800', parentOracleId: '701', level: 8, name: 'قسم الخدمات الفنية' }] }],
    ],
    sel: { k: 'req', id: 'rO' },
    note: 'نقل Oracle القسم تحت إدارة تقنية المعلومات بعد الإرسال: أُوقف الطلب وأُعيد لمقدمه للتأكيد، والمسار السابق وقراراته محفوظة.',
  },
  { code: 'P', title: 'الانتشار مطلوب', actor: 'p-req', actions: [create('rP', content(W0, SCOPE_CO, { occupants: EXCL, deploy: null }))], sel: { k: 'edit', id: 'rP', step: 'REVIEW' }, note: 'السياسة REQUIRED: لا إرسال حتى تُحدد المنطقتان الرئيسية والبديلة.' },
  { code: 'Q', title: 'الانتشار اختياري بلا مناطق', actor: 'p-req', actions: [optional, create('rQ', content(W0, SCOPE_CO, { occupants: EXCL, deploy: null }))], sel: { k: 'edit', id: 'rQ', step: 'REVIEW' }, note: 'السياسة OPTIONAL (نسخة 2): الموقع وحده صالح. منطقة واحدة فقط مرفوضة.' },
  {
    code: 'R',
    title: 'منطقة انتشار فوق أرض مشغولة: منع',
    actor: 'p-req',
    actions: [create('rR', content(W0, SCOPE_CO, { occupants: EXCL, deploy: [P.onSiteF, { lat: 25.27, lng: 55.335 }] }))],
    sel: { k: 'edit', id: 'rR', step: 'PRIMARY' },
    note: 'المنطقة الرئيسية على الموقع F المشغول: منع نهائي (O-08)، يجب نقلها إلى أرض خالية.',
  },
  {
    code: 'S',
    title: 'فئة الأرض بأكبر مساحة',
    actor: 'p-req',
    actions: [create('rS', content(W0, SCOPE_CO, { occupants: EXCL, deploy: [P.straddle, P.ruggedAlt], radius: 900 }))],
    sel: { k: 'edit', id: 'rS', step: 'PRIMARY' },
    layer: 'terrain',
    note: 'المنطقة تمس فئتين: تُحسب نسبة كل فئة من مساحتها، والفئة الحاكمة هي الأكبر مساحة (O-05).',
  },
  {
    code: 'T',
    title: 'النطاق 5–8 كم مع إضافة +2 كم = 5–10 كم',
    actor: 'p-req',
    actions: [create('rT', content(W0, SCOPE_CO, { occupants: EXCL, deploy: [P.rugged, P.ruggedAlt] }))],
    sel: { k: 'edit', id: 'rT', step: 'PRIMARY' },
    layer: 'terrain',
    note: 'المنطقة في أرض «وعرة» (+2 كم في الإعداد) على بعد 9.3 كم: الحد الأدنى ثابت 5 كم والأقصى 10 كم (O-06).',
  },
  {
    code: 'T2',
    title: 'تعادل فئتين: ترتيب الأولوية يحسم',
    actor: 'p-req',
    actions: [create('rT2', content(W0, SCOPE_CO, { occupants: EXCL, deploy: [P.tie, P.tieAlt] }))],
    sel: { k: 'edit', id: 'rT2', step: 'PRIMARY' },
    layer: 'terrain',
    note: '50٪ مستوية و50٪ وعرة: الأولوية المهيأة (متموجة > مستوية > وعرة) تجعل «مستوية» الحاكمة — لا الأكبر إضافة (O-05b).',
  },
  { code: 'U', title: 'وضع «الشوارع»', actor: 'p-req', actions: [], sel: { k: 'site', id: 'SITE-0101' }, note: 'تدرج الطرق وأسماؤها بالعربية من مصدر محلي غير رسمي (OSM، ODbL)؛ الأسماء الرسمية بعد تأكيد ترخيصها.' },
  { code: 'V', title: 'وضع «طبيعة الأرض»', actor: 'p-req', actions: [], sel: { k: 'site', id: 'SITE-0105' }, layer: 'terrain', note: 'تظليل وكنتور وفئات أرض — من حقل مولّد للتوضيح فقط، لا للإنتاج.' },
  {
    code: 'Y',
    title: 'تغيّر الهيكل بعد الاعتماد وقبل التفعيل',
    actor: 'p-act',
    actions: [
      create('rY', content(W0, SCOPE_CO, { occupants: EXCL })),
      submit('rY'),
      ...approveAll('rY', ROUTE_800),
      ['oracle', { t: 'ORACLE_SYNC', rows: [{ oracleId: '800', parentOracleId: '701', level: 8, name: 'قسم الخدمات الفنية' }] }],
    ],
    sel: { k: 'req', id: 'rY' },
    note: 'اعتُمد الطلب كاملاً ثم غيّر Oracle أب القسم: التفعيل ممنوع، والطلب موقوف ومعاد للتأكيد، وتُعاد الاعتمادات على المسار الجديد (O-16).',
  },
  {
    code: 'Z',
    title: 'مرحلة واحدة تستوفي شرطين، أو موافقات مستقلة',
    actor: 'p-req',
    actions: [crossShared, create('rZ', content(W0, [...SCOPE_CO, 'u802'], { occupants: { u802: 'INCLUDED' } }))],
    sel: { k: 'edit', id: 'rZ', step: 'REVIEW' },
    note: 'المسؤول عن الموقع A هو القسم نفسه: مرحلة «معتمد القسم» تستوفي الاعتماد الهرمي وموافقة المسؤول عن الموقع معاً، ويظهر ذلك في المسار والسجل (O-03b).',
  },
  { code: 'W', title: 'طريقة قياس مسافة الانتشار (قرار المالك: مركز ← مركز)', actor: 'p-req', actions: [], sel: { k: 'compare' }, note: 'المضلعان نفسهما بطريقتين. قرر المالك (أ) من المركز إلى المركز، للعلاقتين.' },
  {
    code: 'X',
    title: 'روابط المواقع مستقلة عن التمركز وعن Oracle',
    actor: 'p-admin',
    actions: [
      ['p-admin', { t: 'LINK_SITE', org: 'u903', site: 'SITE-0101', reason: 'تستخدم الشعبة قاعة في الموقع A (توضيحي)' }],
      ['p-admin', { t: 'SET_RESPONSIBILITY', site: 'SITE-0103', org: 'u1000', reason: 'نقل المسؤولية عن المرفق إجراء مستقل (توضيحي)' }],
      ['oracle', { t: 'ORACLE_SYNC', rows: [{ oracleId: '902', parentOracleId: '801', level: 9, name: 'شعبة المستودعات' }] }],
    ],
    sel: { k: 'links' },
    note: 'ربط وحدة بموقع لا يجعلها متمركزة فيه؛ المسؤولية مستقلة؛ تغيير أب في Oracle لا يمس الروابط ولا التمركز.',
  },
];

export const POLICIES = { crossShared, crossIndependent };
export const scenarioOf = (code: string) => SCENARIOS.find((s) => s.code === code) ?? null;
export const anchorOf = (ring: Ring) => centroid(ring);
