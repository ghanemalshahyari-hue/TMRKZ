import { useState } from 'react';
import { api } from '../../api/client';
import type { Responsibility } from '../../api/types';
import { useApp } from '../../lib/app';
import { Dialog, DialogHead } from '../ui';
import { OrgPicker } from './PlacePicker';

/**
 * «المسؤوليات»: a duty, and who carries it for each part of the organisation. A rule on a unit covers everything under it,
 * and a rule nearer a unit wins, so a few rules cover any number of units.
 */
export function ResponsibilitiesDialog({ open, onClose, list, onList }: { open: boolean; onClose: () => void; list: Responsibility[]; onList: (r: Responsibility[]) => void }) {
  const app = useApp();
  const [name, setName] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { scope?: string; scopeName?: string; org?: string; orgName?: string }>>({});
  const run = async (work: Promise<Responsibility[]>) => {
    try {
      onList(await work);
      return true;
    } catch (e) {
      app.toast((e as Error).message);
      return false;
    }
  };
  const draft = (code: string) => drafts[code] ?? {};
  const setDraft = (code: string, patch: object) => setDrafts((d) => ({ ...d, [code]: { ...d[code], ...patch } }));
  return (
    <Dialog open={open} onClose={onClose} className="detail-dialog">
      <DialogHead title="المسؤوليات" small="من يقوم بكل مهمة في كل جزء من الهيكل" onClose={onClose} />
      <div className="dialog-content fs-resp">
        <p className="muted">
          تضيف مسؤولية مثل «الموافقة على المرافق»، ثم تحدد الجهة القائمة بها لكل فرع. القاعدة على جهة تشمل كل ما تحتها، والقاعدة الأقرب للوحدة هي التي تُطبَّق. وفي خطوات المخطط تختار «الجهة المسؤولة عن…».
        </p>
        <div className="fs-resp-add">
          <input aria-label="اسم المسؤولية" placeholder="اسم المسؤولية الجديدة" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="button"
            disabled={name.trim().length < 2}
            onClick={async () => {
              if (await run(api.addResponsibility(name))) setName('');
            }}
          >
            إضافة
          </button>
        </div>
        {!list.length && <p className="muted">لا توجد مسؤوليات بعد.</p>}
        {list.map((r) => {
          const d = draft(r.code);
          return (
            <section key={r.code} className="fs-resp-item">
              <h4>{r.name}</h4>
              {r.rules.length ? (
                <ul>
                  {r.rules.map((x) => (
                    <li key={x.scopeOrgId}>
                      <span>كل الوحدات تحت <b>{x.scopeOrgName}</b> ← المسؤول <b>{x.responsibleOrgName}</b></span>
                      <button className="link-button" onClick={() => run(api.removeResponsibilityRule(r.code, x.scopeOrgId))}>إزالة</button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">لا قواعد بعد: الخطوات التي تستخدمها تبقى مفتوحة لأي شخص يملك الدور.</p>
              )}
              <div className="fs-resp-rule">
                <label>لكل الوحدات تحت<OrgPicker label="الفرع" value={d.scope} name={d.scopeName} onChange={(scope, scopeName) => setDraft(r.code, { scope, scopeName })} /></label>
                <label>الجهة المسؤولة<OrgPicker label="الجهة المسؤولة" value={d.org} name={d.orgName} onChange={(org, orgName) => setDraft(r.code, { org, orgName })} /></label>
                <button
                  className="button compact"
                  disabled={!d.scope || !d.org}
                  onClick={async () => {
                    if (await run(api.setResponsibilityRule(r.code, d.scope!, d.org!))) setDraft(r.code, { scope: undefined, scopeName: undefined, org: undefined, orgName: undefined });
                  }}
                >
                  حفظ القاعدة
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
