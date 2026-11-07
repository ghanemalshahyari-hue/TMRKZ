import { useEffect, useState } from 'react';
import { api, type AccessOfferRow } from '../../api/client';
import { useApp } from '../../lib/app';
import { ROLE_MEANING } from '../../pages/AccessRequestPage';
import { Dialog, DialogHead } from '../ui';

/** The system administrator decides what a new person sees on the page to ask, and what only the unit's access manager can add (ADR-044). */
export function AccessOfferDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [rows, setRows] = useState<AccessOfferRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.accessOffer().then(setRows).catch((e: Error) => app.toast(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = (code: string, audience: string) => setRows((rows ?? []).map((r) => (r.code === code ? { ...r, audience: audience || null } : r)));
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, string> = {};
      (rows ?? []).forEach((r) => {
        if (r.audience) body[r.code] = r.audience;
      });
      await api.saveAccessOffer(body);
      app.toast('حُفظت الصلاحيات المعروضة');
      onClose();
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} className="small-dialog">
      <DialogHead eyebrow="" title="الصلاحيات المعروضة للطلب" small="ماذا يرى أي شخص جديد، وماذا يضيفه مدير صلاحيات الوحدة" onClose={onClose} />
      <div className="dialog-content" data-testid="access-offer-dialog">
        {rows?.map((r) => (
          <label key={r.code} className="field" style={{ marginBottom: 10 }}>
            <span><b>{r.name}</b> <small className="muted">{ROLE_MEANING[r.code]}</small></span>
            <select aria-label={r.name} data-offer={r.code} value={r.audience ?? ''} onChange={(e) => set(r.code, e.target.value)}>
              <option value="">لا تظهر</option>
              <option value="EVERYONE">تظهر لأي شخص جديد</option>
              <option value="MANAGER">يضيفها مدير صلاحيات الوحدة فقط</option>
            </select>
          </label>
        ))}
      </div>
      <div className="dialog-actions">
        <button className="button primary" disabled={busy || !rows} onClick={save}>حفظ</button>
        <button className="button" onClick={onClose}>إلغاء</button>
      </div>
    </Dialog>
  );
}
