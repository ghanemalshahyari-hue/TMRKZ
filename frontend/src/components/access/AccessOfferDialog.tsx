import { useEffect, useState } from 'react';
import { api, type AccessOfferRow, type ScopeMode } from '../../api/client';
import type { RoleDef } from '../../api/types';
import { withoutEmptyRoles } from '../../lib/rolePicker';
import { useApp } from '../../lib/app';
import { SCOPE_MODES } from '../../lib/accessScopes';
import { ROLE_MEANING } from '../../pages/AccessRequestPage';
import { Dialog, DialogHead } from '../ui';

/**
 * «الصلاحيات المتاحة للطلب»: the system administrator decides what a new person sees on the page to ask, what only the unit's
 * access manager can add (ADR-044), and — since 16 Nov 2026 (owner, LDAP first login) — how each role is described there and
 * with which scopes it may be asked, so none of it is fixed in the code.
 */
export function AccessOfferDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [rows, setRows] = useState<AccessOfferRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // a role with no permissions is never offered (ADR-078): the server's list leaves it out, and the catalogue confirms it here
    Promise.all([api.accessOffer(), api.roles().catch((): RoleDef[] | null => null)])
      .then(([offer, catalogue]) => setRows(withoutEmptyRoles(offer, catalogue)))
      .catch((e: Error) => app.toast(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const patch = (code: string, change: Partial<AccessOfferRow>) => setRows((rows ?? []).map((r) => (r.code === code ? { ...r, ...change } : r)));
  const toggleMode = (r: AccessOfferRow, m: ScopeMode) => {
    const all = SCOPE_MODES.map(([x]) => x);
    const now = r.scopeModes?.length ? r.scopeModes : all;
    const next = now.includes(m) ? now.filter((x) => x !== m) : all.filter((x) => now.includes(x) || x === m);
    patch(r.code, { scopeModes: next, defaultScope: r.defaultScope && next.includes(r.defaultScope) ? r.defaultScope : next[0] ?? null });
  };
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, { audience: string; description?: string | null; scopeModes?: ScopeMode[] | null; defaultScope?: ScopeMode | null }> = {};
      (rows ?? []).forEach((r) => {
        if (r.audience) body[r.code] = { audience: r.audience, description: r.description?.trim() || null, scopeModes: r.scopeModes?.length ? r.scopeModes : null, defaultScope: r.defaultScope ?? null };
      });
      await api.saveAccessOffer(body);
      app.toast('حُفظت الصلاحيات المتاحة للطلب');
      onClose();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} className="small-dialog">
      <DialogHead eyebrow="" title="الصلاحيات المتاحة للطلب" small="ماذا يرى أي شخص جديد، وماذا يضيفه مدير صلاحيات الوحدة، وكيف يُطلب كل دور" onClose={onClose} />
      <div className="dialog-content" data-testid="access-offer-dialog">
        {rows?.map((r) => {
          const modes = r.scopeModes?.length ? r.scopeModes : SCOPE_MODES.map(([m]) => m);
          return (
            <div key={r.code} className="offer-row" data-offer-row={r.code}>
              <label className="field">
                <span><b>{r.name}</b></span>
                <select aria-label={r.name} data-offer={r.code} value={r.audience ?? ''} onChange={(e) => patch(r.code, { audience: e.target.value || null })}>
                  <option value="">لا تظهر</option>
                  <option value="EVERYONE">تظهر لأي شخص جديد</option>
                  <option value="MANAGER">يضيفها مدير صلاحيات الوحدة فقط</option>
                </select>
              </label>
              {r.audience && (
                <>
                  <label className="field">
                    <span>الوصف الذي يراه الطالب</span>
                    <input data-offer-description={r.code} value={r.description ?? ''} placeholder={ROLE_MEANING[r.code] ?? ''} maxLength={300}
                      onChange={(e) => patch(r.code, { description: e.target.value })} />
                  </label>
                  <fieldset className="offer-scopes">
                    <legend>النطاقات المسموح طلبها</legend>
                    {SCOPE_MODES.map(([m, label]) => (
                      <label key={m} className="check-label">
                        <input type="checkbox" data-offer-scope={r.code + ':' + m} checked={modes.includes(m)} disabled={modes.length === 1 && modes.includes(m)} onChange={() => toggleMode(r, m)} /> {label}
                      </label>
                    ))}
                    <label className="field">
                      <span>النطاق الافتراضي</span>
                      <select data-offer-default={r.code} value={r.defaultScope ?? modes[0]} onChange={(e) => patch(r.code, { scopeModes: modes, defaultScope: e.target.value as ScopeMode })}>
                        {SCOPE_MODES.filter(([m]) => modes.includes(m)).map(([m, label]) => <option key={m} value={m}>{label}</option>)}
                      </select>
                    </label>
                  </fieldset>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="dialog-actions">
        <button className="button primary" disabled={busy || !rows} onClick={save}>حفظ</button>
        <button className="button" onClick={onClose}>إلغاء</button>
      </div>
    </Dialog>
  );
}
