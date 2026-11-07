import type { FlowChain, FlowNode, FlowRecipient, HierarchyLevel, Responsibility, RoleDef, Rule, WfPlace } from '../../api/types';
import { NODE_TITLES, STOP_KINDS, newChain } from '../../lib/flowGraph';
import { describeRule, type RuleSubject } from '../../lib/rules';
import { NumberField } from '../NumberField';
import { RuleEditor } from '../rules/RuleEditor';
import { OrgPicker, PlacePicker } from './PlacePicker';

const EXPLAIN: Partial<Record<FlowNode['type'], string>> = {
  start: 'من هنا يبدأ كل طلب بعد إرساله.',
  parallel: 'كل الخطوط الخارجة من هنا تعمل في الوقت نفسه. يجب أن تلتقي في «انتظار انتهاء الجميع» قبل الموافقة النهائية.',
  join: 'ينتظر هنا الطلب حتى تنتهي كل المسارات الداخلة، ثم يكمل.',
  end_approved: 'ينتهي الطلب معتمداً: يُثبَّت القرار والحجز. لا يصل إليها مسار إلا بعد موافقة نهائية.',
  end_rejected: 'ينتهي الطلب مرفوضاً، ويُغلق أي مسار متوازٍ ما زال مفتوحاً.',
};

/** Levels to choose from: those the HR source has, never a fixed list. */
function LevelChecks({ levels, chosen, onChange, label }: { levels: HierarchyLevel[]; chosen: number[]; onChange: (v: number[]) => void; label: string }) {
  if (!levels.length) return <small className="muted">تظهر المستويات بعد استيراد الهيكل.</small>;
  return (
    <div className="fs-levels" role="group" aria-label={label}>
      {levels.map((l) => (
        <label key={l.level} className="fs-check">
          <input type="checkbox" checked={chosen.includes(l.level)} onChange={(e) => onChange(e.target.checked ? [...chosen, l.level] : chosen.filter((x) => x !== l.level))} />
          المستوى {l.level} <small className="muted">({l.units.toLocaleString('en-US')} وحدة)</small>
        </label>
      ))}
    </div>
  );
}

function ChainEditor({ chain, levels, onChange }: { chain: FlowChain; levels: HierarchyLevel[]; onChange: (c: FlowChain) => void }) {
  const kind = STOP_KINDS.find((k) => k.value === chain.stop);
  return (
    <div className="fs-place" data-testid="chain">
      <label>
        يبدأ من
        <select aria-label="يبدأ من" value={chain.from} onChange={(e) => onChange({ ...chain, from: e.target.value as FlowChain['from'] })}>
          <option value="PARENT">الجهة الأعلى من مقدم الطلب</option>
          <option value="SELF">وحدة مقدم الطلب نفسها</option>
        </select>
      </label>
      <label>
        يتوقف عند
        <select aria-label="يتوقف عند" value={chain.stop} onChange={(e) => onChange({ ...chain, stop: e.target.value as FlowChain['stop'] })}>
          {STOP_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </label>
      {kind && <small className="muted">{kind.hint}</small>}
      {chain.stop === 'LEVELS' && <LevelChecks label="مستويات التوقف" levels={levels} chosen={chain.levels ?? []} onChange={(v) => onChange({ ...chain, levels: v })} />}
      {chain.stop === 'COUNT' && (
        <label>
          عدد الموافقات
          <NumberField label="عدد الموافقات" value={chain.count ?? null} onChange={(v) => onChange({ ...chain, count: v == null ? undefined : Math.trunc(v) })} />
        </label>
      )}
      {chain.stop === 'ORG' && <OrgPicker label="جهة التوقف" value={chain.orgId} name={chain.orgName} onChange={(orgId, orgName) => onChange({ ...chain, orgId, orgName })} />}
      <label className="fs-check">
        <input type="checkbox" checked={!!chain.onlyLevels} onChange={(e) => onChange({ ...chain, onlyLevels: e.target.checked ? [] : undefined })} /> يوافق في مستويات محددة فقط
      </label>
      {chain.onlyLevels && <LevelChecks label="المستويات التي توافق" levels={levels} chosen={chain.onlyLevels} onChange={(v) => onChange({ ...chain, onlyLevels: v })} />}
      <label className="fs-check">
        <input type="checkbox" checked={!!chain.skipEmpty} onChange={(e) => onChange({ ...chain, skipEmpty: e.target.checked })} /> تخطَّ الجهة التي لا يوجد فيها معتمد (بدونه يُرفض الإرسال حتى يُعيَّن)
      </label>
    </div>
  );
}

export function NodeInspector({ node, roles, levels, responsibilities, subjects, noSignature, onChange, onDelete, onManage }: {
  noSignature?: boolean;
  node: FlowNode;
  roles: RoleDef[];
  levels: HierarchyLevel[];
  responsibilities: Responsibility[];
  subjects: RuleSubject[];
  onChange: (patch: Partial<FlowNode>) => void;
  onDelete: () => void;
  onManage: () => void;
}) {
  const approvers = node.final ? roles.filter((r) => r.permissions.includes('APPROVE')) : roles;
  const places = node.assignees ?? [];
  const recipients = node.recipients ?? [];
  const tellsRequester = recipients.some((r) => r.kind === 'REQUESTER');
  const setPlace = (i: number, p: WfPlace) => onChange({ assignees: places.map((x, j) => (j === i ? p : x)) });
  const setRecipient = (i: number, p: WfPlace) => onChange({ recipients: recipients.map((x, j) => (j === i ? { kind: 'PLACE' as const, ...p } : x)) });
  const blank: WfPlace = { role: '', orgFrom: 'REQUEST_ORG' };
  return (
    <div className="fs-inspector" data-testid="inspector">
      <div className="fs-inspector-head">
        <span>{NODE_TITLES[node.type]}</span>
        {node.type !== 'start' && <button className="link-button fs-danger" onClick={onDelete}>حذف الخطوة</button>}
      </div>
      {EXPLAIN[node.type] && <p className="muted">{EXPLAIN[node.type]}</p>}
      {node.type !== 'start' && node.type !== 'parallel' && node.type !== 'join' && (
        <label>
          الاسم
          <input aria-label="اسم الخطوة" value={node.name} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
      )}
      {node.type === 'approval' && (
        <>
          <label>
            طريقة الموافقة
            <select
              aria-label="طريقة الموافقة"
              value={node.chain ? 'chain' : 'one'}
              onChange={(e) =>
                onChange(e.target.value === 'chain'
                  ? { chain: newChain(), final: false, requiresSignature: false, mode: 'ALL', assignees: [{ role: places[0]?.role ?? '', orgFrom: 'REQUEST_ORG' }] }
                  : { chain: null, mode: 'ANY' })
              }
            >
              <option value="one">جهة واحدة</option>
              <option value="chain">تصعد مستوى بعد مستوى</option>
            </select>
          </label>
          {node.chain ? (
            <>
              <p className="muted">بطاقة واحدة تصعد في الهيكل جهة بعد جهة، ويحسب النظام السلسلة لكل طلب حسب وحدة مقدمه.</p>
              <label>
                الدور في كل جهة
                <select aria-label="الدور في كل جهة" value={places[0]?.role ?? ''} onChange={(e) => onChange({ assignees: [{ role: e.target.value, orgFrom: 'REQUEST_ORG' }] })}>
                  <option value="">— اختر —</option>
                  {roles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
                </select>
              </label>
              <ChainEditor chain={node.chain} levels={levels} onChange={(chain) => onChange({ chain })} />
            </>
          ) : (
            <>
              <h4>من يوافق؟</h4>
              {places.map((p, i) => (
                <PlacePicker key={i} place={p} roles={approvers} levels={levels} responsibilities={responsibilities} onChange={(x) => setPlace(i, x)} onRemove={() => onChange({ assignees: places.filter((_, j) => j !== i) })} onManage={onManage} />
              ))}
              <button className="button compact" onClick={() => onChange({ assignees: [...places, blank] })}>＋ جهة موافقة</button>
              <label>
                كم موافقة تكفي؟
                <select aria-label="كم موافقة تكفي" value={node.mode ?? 'ANY'} onChange={(e) => onChange({ mode: e.target.value as 'ALL' | 'ANY' })}>
                  <option value="ANY">تكفي موافقة واحدة</option>
                  <option value="ALL">يجب أن يوافق الجميع</option>
                </select>
              </label>
            </>
          )}
          {!noSignature && (
            <label>
              المهلة بالأيام
              <NumberField label="المهلة بالأيام" value={node.slaDays ?? 3} onChange={(v) => onChange({ slaDays: Math.trunc(v ?? 0) })} />
            </label>
          )}
          {!node.chain && (
            <label className="fs-check">
              <input type="checkbox" checked={!!node.final} onChange={(e) => onChange({ final: e.target.checked, requiresSignature: e.target.checked })} /> هذه هي الموافقة النهائية
            </label>
          )}
          {node.final && !noSignature && (
            <label className="fs-check">
              <input type="checkbox" checked={!!node.requiresSignature} onChange={(e) => onChange({ requiresSignature: e.target.checked })} /> تتطلب توقيعاً
            </label>
          )}
          <p className="muted">
            عند الرفض: إن وصلت خط «عند الرفض» يكمل الطلب عبره، وإلا ينتهي مرفوضاً. وإعادة الطلب للتصحيح متاحة دائماً وترجعه إلى مقدم الطلب.
          </p>
        </>
      )}
      {node.type === 'decision' && (
        <>
          <RuleEditor title="الشرط" empty="أضف شرطاً" value={node.condition ?? null} subjects={subjects} onChange={(condition: Rule | null) => onChange({ condition })} />
          {node.condition && <p className="fs-sentence">نعم إذا: {describeRule(node.condition, subjects)}</p>}
        </>
      )}
      {node.type === 'notify' && (
        <>
          <h4>من يصله الإشعار؟</h4>
          <label className="fs-check">
            <input
              type="checkbox"
              checked={tellsRequester}
              onChange={(e) => onChange({ recipients: e.target.checked ? [{ kind: 'REQUESTER' }, ...recipients] : recipients.filter((r) => r.kind !== 'REQUESTER') })}
            />{' '}
            مقدم الطلب
          </label>
          {recipients.map((r: FlowRecipient, i) =>
            r.kind === 'REQUESTER' ? null : (
              <PlacePicker key={i} place={r} roles={roles} levels={levels} responsibilities={responsibilities} onChange={(x) => setRecipient(i, x)} onRemove={() => onChange({ recipients: recipients.filter((_, j) => j !== i) })} onManage={onManage} />
            ),
          )}
          <button className="button compact" onClick={() => onChange({ recipients: [...recipients, { kind: 'PLACE', ...blank }] })}>＋ جهة</button>
          <label>
            نص الإشعار
            <textarea aria-label="نص الإشعار" value={node.message ?? ''} onChange={(e) => onChange({ message: e.target.value })} />
          </label>
          <p className="muted">الإشعار للعلم فقط، ولا يوقف الطلب ولا يطلب قراراً.</p>
        </>
      )}
    </div>
  );
}
