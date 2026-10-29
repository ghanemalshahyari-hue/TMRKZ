import { useState } from 'react';
import { AuthzStatusPanel } from '../components/access/AuthzStatusPanel';
import { ExplainPanel } from '../components/access/ExplainPanel';
import { GrantsStudio } from '../components/access/GrantsStudio';
import { PolicyStudio } from '../components/access/PolicyStudio';
import { IdentityIssues } from '../components/IdentityIssues';
import { Heading } from '../components/ui';
import { useApp } from '../lib/app';

type Tab = 'policy' | 'grants' | 'explain' | 'service' | 'identity';

const TABS: [Tab, string][] = [
  ['policy', 'الأدوار والإصدارات'],
  ['grants', 'المنح والنطاقات'],
  ['explain', 'المعاينة والاختبار'],
  ['service', 'خدمة القرار'],
  ['identity', 'قضايا الربط'],
];

/**
 * Permissions studio (ADR-018): versioned role policy, scoped grants with their wording, a "what can this person do
 * and why" preview, and the state of the decision service. Every action is still enforced by the server.
 */
export function PermissionsPage() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>(() => {
    const t = location.hash.split('/')[1] as Tab | undefined;
    return TABS.some(([id]) => id === t) ? (t as Tab) : 'policy';
  });
  const global = app.me.grants.some((g) => g.permissions.includes('MANAGE_ACCESS') && (g.all || g.scope === 'ALL'));

  const select = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', '#permissions/' + t);
  };

  return (
    <>
      <Heading
        en="ACCESS / POLICY STUDIO"
        title="مركز الصلاحيات"
        description="الإجراء المسموح ونطاق البيانات يُحددان بصورة مستقلة، وكل قرار يُفرض في الخادم وتؤكده خدمة قرارات الصلاحيات."
        actions={<span className="pill">{global ? 'مدير صلاحيات عام' : 'مدير صلاحيات ضمن نطاق منحته'}</span>}
      />
      <div className="tabs access-tabs" role="tablist" aria-label="أقسام مركز الصلاحيات">
        {TABS.map(([id, name]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => select(id)}>
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'policy' && <PolicyStudio global={global} />}
        {tab === 'grants' && <GrantsStudio />}
        {tab === 'explain' && <ExplainPanel />}
        {tab === 'service' && <AuthzStatusPanel global={global} />}
        {tab === 'identity' && (app.can('MANAGE_ACCESS') ? <IdentityIssues /> : null)}
      </div>
    </>
  );
}
