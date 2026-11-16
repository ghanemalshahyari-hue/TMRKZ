import { useState } from 'react';
import { api, type UnitMemberCard } from '../../api/client';
import { Dialog, DialogHead } from '../ui';

type Way = 'HR' | 'DIRECT';

/** The login as the server stores it (UnitMemberService.normalLogin): no DOMAIN\ prefix or @domain, lower case. */
export function normalLogin(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  const slash = s.lastIndexOf('\\');
  if (slash >= 0) s = s.slice(slash + 1);
  const at = s.indexOf('@');
  if (at > 0) s = s.slice(0, at);
  return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(s) ? s : null;
}

/**
 * «إضافة مستخدم», as in TNQL's access workspace (owner, 11 Nov 2026; ADR-049): search by military number or User ID and read the
 * HR card, or add a User ID without HR. Saving places the person in the unit with no permission; the matrix then shows their
 * empty row, highlighted, for the cells to be ticked. The server decides who may be found and added. A person not yet in TMRKZ
 * is found live in HR (card without personId) and saving imports that one person (ADR-065, as MOVER).
 */
export function AddUserDialog({ unit, onClose, onAdded }: { unit: { id: string; name: string }; onClose: () => void; onAdded: (personId: string, key: string, already: boolean) => void }) {
  const [way, setWay] = useState<Way>('HR');
  const [key, setKey] = useState('');
  const [card, setCard] = useState<UnitMemberCard | null>(null);
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = () => {
    if (key.trim().length < 2) return setError('اكتب الرقم العسكري أو رقم المستخدم.');
    setBusy(true);
    setError(null);
    setCard(null);
    api
      .unitMemberLookup(unit.id, key.trim())
      .then(setCard)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const login = normalLogin(userId);
  const canSave = !busy && (way === 'HR' ? !!card : !!login);
  const save = () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    api
      .addUnitMember(
        way === 'HR'
          ? card!.personId
            ? { organizationId: unit.id, personId: card!.personId }
            : { organizationId: unit.id, employeeNo: card!.employeeNo }
          : { organizationId: unit.id, userId: login, displayName: name.trim() || null },
      )
      .then((r) => onAdded(r.personId, way === 'HR' ? card!.employeeNo : login!, r.already))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onClose={onClose} className="small-dialog">
      <DialogHead eyebrow="USER / NEW" title="إضافة مستخدم" small={'إضافة مستخدم إلى «' + unit.name + '»'} onClose={onClose} />
      <div className="dialog-content au-form" data-testid="add-user-dialog">
        <div className="au-ways" role="radiogroup" aria-label="طريقة الإضافة">
          <label className={'au-way' + (way === 'HR' ? ' on' : '')}>
            <input type="radio" name="au-way" checked={way === 'HR'} onChange={() => (setWay('HR'), setError(null))} />
            بحث بالرقم العسكري أو رقم المستخدم
          </label>
          <label className={'au-way' + (way === 'DIRECT' ? ' on' : '')}>
            <input type="radio" name="au-way" checked={way === 'DIRECT'} onChange={() => (setWay('DIRECT'), setError(null))} />
            إضافة رقم المستخدم بدون ربط الموارد
          </label>
        </div>

        {way === 'HR' ? (
          <>
            <label className="field">
              <span>ابحث بالرقم العسكري أو User ID</span>
              <div className="au-search">
                <input
                  aria-label="الرقم العسكري أو رقم المستخدم"
                  placeholder="الرقم الوظيفي أو User ID"
                  value={key}
                  onChange={(e) => (setKey(e.target.value), setCard(null))}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), search())}
                  autoFocus
                />
                <button className="button compact" type="button" disabled={busy} onClick={search}>بحث</button>
              </div>
            </label>
            {card && (
              <div className="au-card" data-testid="add-user-card">
                <b className="au-card-head">⬅ بيانات مسحوبة من الموارد البشرية</b>
                <dl>
                  <div><dt>الرقم الوظيفي</dt><dd className="latin">{card.employeeNo}</dd></div>
                  <div><dt>الاسم</dt><dd>{card.displayName}</dd></div>
                  {card.positionTitle && <div><dt>المنصب</dt><dd>{card.positionTitle}</dd></div>}
                  {card.jobTitle && <div><dt>الوظيفة</dt><dd>{card.jobTitle}</dd></div>}
                  <div><dt>الوحدة</dt><dd>{card.unitName ?? '—'}</dd></div>
                  {card.hrStatus && <div><dt>حالة الموظف</dt><dd>{card.hrStatus}</dd></div>}
                  {card.userId && <div><dt>رقم المستخدم</dt><dd className="latin">{card.userId}</dd></div>}
                </dl>
                {!card.personId && (
                  <p className="au-note" data-testid="add-user-import">
                    غير موجود في تمركز بعد: عند الحفظ يُستورد سجله وحده من الموارد البشرية، بلا أي صلاحية.
                  </p>
                )}
                {card.inUnit ? (
                  <p className="au-note">هذا الموظف من مستخدمي «{unit.name}» بالفعل؛ الحفظ يعرض صفه في المصفوفة.</p>
                ) : card.acting ? (
                  <p className="au-note">يعمل في «{card.unitName}»؛ يُضاف إلى «{unit.name}» بالإنابة، ولا تتغير وحدته في الموارد البشرية.</p>
                ) : (
                  <p className="au-note">يُضاف إلى مستخدمي «{unit.name}» بلا أي صلاحية؛ لا يظهر موظفو الوحدة في القائمة إلا بإضافتهم أو بطلب صلاحيات معتمد.</p>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <label className="field">
              <span>رقم المستخدم (User ID)</span>
              <input aria-label="رقم المستخدم" className="latin" placeholder="u1234567" value={userId} onChange={(e) => setUserId(e.target.value)} autoFocus />
            </label>
            {userId.trim() && !login && <p className="error-text">رقم المستخدم: أحرف لاتينية وأرقام فقط، مثل u1234567.</p>}
            <label className="field">
              <span>الاسم (اختياري — يُجلب من الدليل عند أول دخول)</span>
              <input aria-label="الاسم" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </label>
            <p className="au-note">يدخل بحسابه في الدليل عند أول تسجيل دخول، ولا يملك أي صلاحية حتى تحددها في المصفوفة.</p>
          </>
        )}
        {error && <div className="error-text" role="alert">{error}</div>}
      </div>
      <div className="dialog-actions">
        <button className="button primary" disabled={!canSave} onClick={save} data-testid="add-user-save">حفظ</button>
        <button className="button" onClick={onClose}>إلغاء</button>
      </div>
    </Dialog>
  );
}
