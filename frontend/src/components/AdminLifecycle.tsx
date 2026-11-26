import { useEffect, useState } from 'react';
import { ApiError, api, type AdminCandidate, type AdminLookup, type AdminLookupOptions, type Administrator } from '../api/client';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';

const LOOKUPS: { key: AdminLookup; label: string; hint: string; placeholder: string }[] = [
  { key: 'EMPLOYEE_NUMBER', label: 'الرقم الوظيفي (الموارد البشرية)', hint: 'يُسأل مصدر الموارد البشرية مباشرة؛ سجل نشط واحد فقط.', placeholder: 'الرقم الوظيفي' },
  { key: 'DIRECTORY_ACCOUNT', label: 'حساب الدليل المؤسسي', hint: 'حساب تحقق منه الدليل عند دخول سابق، أو يُبحث عنه في الدليل الآن.', placeholder: 'u1234567' },
];

const VERIFIED: Record<AdminCandidate['verifiedBy'], string> = {
  ORACLE_HR: 'تحقق منه مصدر الموارد البشرية الآن',
  DIRECTORY_SIGN_IN: 'تحقق منه الدليل المؤسسي عند دخول سابق',
  DIRECTORY_SERVICE_LOOKUP: 'وُجد في الدليل المؤسسي الآن (حساب الخدمة للقراءة)',
  DIRECTORY_OWN_ACCOUNT_LOOKUP: 'وُجد في الدليل المؤسسي الآن (بحثٌ بحسابك)',
};

/**
 * «مديرو النظام» (ADR-103): find one person by a verified lookup, see who it is, then grant with a reason. Nothing is granted
 * from the search alone; the confirmation sent back must match the identity shown. Removal needs a reason; the last effective
 * administrator and permanent platform accounts cannot be removed here.
 */
export function AdminLifecycle() {
  const app = useApp();
  const [admins, setAdmins] = useState<Administrator[]>([]);
  const [adding, setAdding] = useState(false);
  const [method, setMethod] = useState<AdminLookup>('EMPLOYEE_NUMBER');
  const [value, setValue] = useState('');
  const [candidate, setCandidate] = useState<AdminCandidate | null>(null);
  const [reason, setReason] = useState('');
  const [ending, setEnding] = useState<Administrator | null>(null);
  const [endReason, setEndReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<AdminLookupOptions | null>(null);
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);
  const [notice, setNotice] = useState('');
  const [roles, setRoles] = useState<('SYSTEM_ADMIN' | 'DEVELOPER')[]>(['SYSTEM_ADMIN']);
  const toggleRole = (r: 'SYSTEM_ADMIN' | 'DEVELOPER') =>
    setRoles((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));
  const wantsDeveloper = roles.includes('DEVELOPER');

  const load = () => api.listAdministrators().then(setAdmins).catch((e: Error) => app.toast(e.message));
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (adding && !options) api.adminLookupOptions().then(setOptions).catch(() => setOptions(null)); }, [adding]);

  const reset = () => { setValue(''); setCandidate(null); setReason(''); setPassword(''); setNeedPassword(false); setNotice(''); setRoles(['SYSTEM_ADMIN']); };
  const effectiveCount = admins.filter((a) => a.effective).length;

  const find = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setCandidate(null);
    setNotice('');
    try {
      setCandidate(await api.resolveAdministrator(method, value.trim(), method === 'DIRECTORY_ACCOUNT' ? password : undefined));
      setPassword(''); // used for that one search only
      setNeedPassword(false);
    } catch (e) {
      const lookup = e instanceof ApiError ? (e.details?.lookup as string | undefined) : undefined;
      if (lookup === 'PASSWORD_REQUIRED' || lookup === 'PASSWORD_REFUSED') {
        setNeedPassword(true);
        setPassword('');
      }
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const grant = async () => {
    if (!candidate || reason.trim().length < 3 || roles.length === 0) return;
    setBusy(true);
    try {
      await api.addAdministrator(candidate, reason.trim(), roles);
      reset();
      setAdding(false);
      await load();
      app.toast('مُنحت الصلاحية (مسجلة في التدقيق)');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    if (!ending || endReason.trim().length < 3) return;
    setBusy(true);
    try {
      await api.endAdministrator(ending.personId, endReason.trim());
      setEnding(null);
      setEndReason('');
      await load();
      app.toast('سُحبت صلاحية مدير النظام (مسجلة في التدقيق)');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const lookup = LOOKUPS.find((l) => l.key === method)!;
  return (
    <section className="card padding" data-testid="admin-lifecycle" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h2>مديرو النظام والمطوّرون</h2>
        <button className="button small" onClick={() => { setAdding(!adding); reset(); }}>{adding ? 'إلغاء' : '＋ منح صلاحية'}</button>
      </div>
      <p className="micro muted" style={{ margin: '6px 0 12px' }}>
        يُعثر على الشخص بطريقة متحقق منها، وتُعرض هويته، ثم تُمنح بسبب مسجل في التدقيق. «مدير النظام»: تهيئة النظام وإدارة الصلاحيات.
        «مطوّر النظام»: صلاحية كاملة على كل شيء، ولا يمنحها إلا مطوّر.
      </p>

      {adding && (
        <div className="card padding" data-testid="admin-add" style={{ marginBottom: 12 }}>
          <div className="flex" role="radiogroup" aria-label="طريقة التحقق" style={{ gap: 12, flexWrap: 'wrap' }}>
            {LOOKUPS.map((l) => (
              <label key={l.key} className="flex" style={{ gap: 6 }}>
                <input type="radio" name="admin-lookup" checked={method === l.key} onChange={() => { setMethod(l.key); setCandidate(null); }} />
                {l.label}
              </label>
            ))}
          </div>
          <p className="micro muted" style={{ margin: '6px 0' }}>{lookup.hint}</p>
          {options && (
            <p className="micro" data-testid="admin-lookup-options" data-mode={method === 'DIRECTORY_ACCOUNT' ? options.directoryMode : 'HR'}>
              {method === 'DIRECTORY_ACCOUNT' ? options.directoryMessage : options.employeeNumberMessage}
            </p>
          )}
          <div className="flex" style={{ gap: 8 }}>
            <input
              dir="ltr"
              data-testid="admin-lookup-value"
              placeholder={lookup.placeholder}
              value={value}
              onChange={(e) => { setValue(e.target.value); setCandidate(null); }}
              onKeyDown={(e) => e.key === 'Enter' && find()}
              style={{ flex: 1 }}
              autoFocus
            />
            <button className="button" disabled={busy || !value.trim()} onClick={find}>عرض الهوية</button>
          </div>
          {method === 'DIRECTORY_ACCOUNT' && (needPassword || options?.directoryNeedsPassword) && (
            <div className="flex" style={{ gap: 8, marginTop: 8 }}>
              <input
                type="password"
                autoComplete="current-password"
                data-testid="admin-directory-password"
                placeholder="كلمة مرورك في الدليل (للبحث عمن لم يدخل بعد؛ لا تُحفظ)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && find()}
                style={{ flex: 1 }}
              />
            </div>
          )}
          {notice && <p className="micro" role="alert" data-testid="admin-lookup-notice">{notice}</p>}

          {candidate && (
            <div data-testid="admin-candidate" style={{ marginTop: 12 }}>
              <div className="key-value"><span>الاسم</span><b>{candidate.displayName}</b></div>
              <div className="key-value"><span>الرقم الوظيفي</span><span dir="ltr">{candidate.employeeNumber ?? '—'}</span></div>
              <div className="key-value"><span>حساب الدليل</span><span dir="ltr">{candidate.account ?? '—'}</span></div>
              <div className="key-value"><span>الوحدة</span><span>{candidate.unitName ?? '—'}</span></div>
              {candidate.hrStatus && <div className="key-value"><span>حالة الموارد البشرية</span><span>{candidate.hrStatus}</span></div>}
              <div className="key-value"><span>التحقق</span><span>{VERIFIED[candidate.verifiedBy]}</span></div>
              {!candidate.personId && (
                <p className="micro muted">
                  {candidate.verifiedBy === 'ORACLE_HR'
                    ? 'ليس في تمركز بعد: يُستورد من سجله في الموارد البشرية عند التأكيد، بلا أي صلاحية أخرى.'
                    : 'لم يدخل تمركز بعد: يُنشأ سجله عند التأكيد كما ينشئه دخوله الأول (مرتبطاً بمعرّفه الثابت في الدليل)، بلا أي صلاحية أخرى.'}
                </p>
              )}
              <div className="flex" aria-label="الصلاحيات الممنوحة" style={{ gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
                <span className="micro muted">امنح:</span>
                <label className="flex" style={{ gap: 6 }}>
                  <input type="checkbox" checked={roles.includes('SYSTEM_ADMIN')} onChange={() => toggleRole('SYSTEM_ADMIN')} />
                  مدير النظام
                </label>
                <label className="flex" style={{ gap: 6 }}>
                  <input type="checkbox" data-testid="admin-role-developer" checked={roles.includes('DEVELOPER')} onChange={() => toggleRole('DEVELOPER')} />
                  مطوّر النظام
                </label>
              </div>
              {wantsDeveloper && (
                <p className="micro" role="alert" style={{ color: 'var(--danger, #b42318)' }}>
                  مطوّر النظام صلاحية كاملة على كل شيء (كل الصلاحيات في كل الوحدات)، ولا يمنحها إلا مطوّر. امنحها لمن يلزمه ذلك فقط.
                </p>
              )}
              {candidate.alreadyAdmin && roles.includes('SYSTEM_ADMIN') && (
                <p className="micro muted">هذا الشخص مدير نظام بالفعل؛ لن تُكرَّر. يُضاف ما لا يملكه من الصلاحيات المختارة.</p>
              )}
              <input
                data-testid="admin-reason"
                placeholder="سبب المنح (يُسجل في التدقيق)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{ width: '100%', marginTop: 8 }}
              />
              <button className="button primary" style={{ marginTop: 8 }} disabled={busy || reason.trim().length < 3 || roles.length === 0} onClick={grant}>
                {roles.length === 0
                  ? 'اختر صلاحية واحدة على الأقل'
                  : roles.length === 2
                    ? 'تأكيد منح صلاحيتي مدير النظام ومطوّر النظام لهذا الشخص'
                    : wantsDeveloper
                      ? 'تأكيد منح صلاحية مطوّر النظام لهذا الشخص'
                      : 'تأكيد منح صلاحية مدير النظام لهذا الشخص'}
              </button>
            </div>
          )}
        </div>
      )}

      {admins.length === 0 && <p className="micro muted">لا يوجد مديرو نظام حالياً.</p>}

      {admins.map((a) => (
        <div key={a.personId} className="key-value" data-testid="admin-row" style={{ alignItems: 'center' }}>
          <span>
            <b>{a.displayName}</b>
            {a.role === 'DEVELOPER' && <small className="muted" data-testid="admin-role-badge"> · مطوّر نظام</small>}
            {a.platform && <small className="muted"> · حساب منصة</small>}
            {!a.effective && <small> · غير فعّال (وحدته أو حسابه موقوف)</small>}
            <br />
            <small className="muted" dir="ltr">{a.username}</small>
            {a.employeeNumber && <small className="muted"> · {a.employeeNumber}</small>}
            {a.grantedAt && <small className="muted"> · منذ {fullTime(a.grantedAt)}</small>}
            {a.grantedBy && <small className="muted"> · بواسطة {a.grantedBy}</small>}
          </span>
          {!a.platform && (
            <button
              className="button small"
              disabled={busy || (a.effective && effectiveCount <= 1)}
              title={a.effective && effectiveCount <= 1 ? 'لا يُسحب آخر مدير نظام فعّال' : 'سحب صلاحية مدير النظام'}
              onClick={() => { setEnding(a); setEndReason(''); }}
            >
              سحب
            </button>
          )}
        </div>
      ))}

      {ending && (
        <div className="card padding" data-testid="admin-end" style={{ marginTop: 12 }}>
          <p>سحب صلاحية {ending.role === 'DEVELOPER' ? 'مطوّر النظام' : 'مدير النظام'} عن <b>{ending.displayName}</b>؟</p>
          <input placeholder="سبب السحب (يُسجل في التدقيق)" value={endReason} onChange={(e) => setEndReason(e.target.value)} style={{ width: '100%' }} />
          <div className="flex" style={{ gap: 8, marginTop: 8 }}>
            <button className="button danger" disabled={busy || endReason.trim().length < 3} onClick={end}>تأكيد السحب</button>
            <button className="button" onClick={() => setEnding(null)}>إلغاء</button>
          </div>
        </div>
      )}
    </section>
  );
}
