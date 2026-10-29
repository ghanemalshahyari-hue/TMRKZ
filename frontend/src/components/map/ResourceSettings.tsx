import { useState } from 'react';
import { api } from '../../api/client';
import type { Resource, SiteDetail } from '../../api/types';
import { useApp } from '../../lib/app';
import { Dialog, DialogHead, Icon } from '../ui';

type Edit = { name: string; kind: string; handoverMinutes: string; childBlocking: boolean; sharedLimit: string };
type New = Edit & { code: string; policy: 'EXCLUSIVE' | 'SHARED'; parentResourceId: string };

const relationText = (r: Resource) => (r.childBlocking ? 'حجزه يمنع موارده الفرعية، وحجز أي منها يمنعه' : 'مستقل عن موارده الفرعية');

/**
 * Resource settings of one site for its facility manager: booking policy, handover time, relation to sub-resources
 * (blocking or independent) and, for shared resources only, an optional limit of simultaneous approved uses. A change
 * the existing approved bookings cannot satisfy is refused by the server with nothing changed.
 */
export function ResourceSettings({ site, onClose }: { site: SiteDetail; onClose: () => void }) {
  const app = useApp();
  const [resources, setResources] = useState<Resource[]>(site.resources);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [adding, setAdding] = useState<New | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const byId = new Map(resources.map((r) => [r.id, r]));
  const hasChildren = (id: string) => resources.some((r) => r.parentResourceId === id);
  const depth = (r: Resource): number => (r.parentResourceId && byId.get(r.parentResourceId) ? 1 + depth(byId.get(r.parentResourceId)!) : 0);

  const start = (r: Resource) => {
    setAdding(null);
    setError(null);
    setEditing(r.id);
    setEdit({ name: r.name, kind: r.kind, handoverMinutes: String(r.handoverMinutes), childBlocking: r.childBlocking, sharedLimit: r.sharedLimit ? String(r.sharedLimit) : '' });
  };

  const save = async (r: Resource) => {
    if (!edit) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateResource(r.id, {
        name: edit.name,
        kind: edit.kind,
        handoverMinutes: Number(edit.handoverMinutes) || 0,
        childBlocking: edit.childBlocking,
        sharedLimit: r.policy === 'SHARED' ? Number(edit.sharedLimit) || 0 : undefined,
      });
      setResources(resources.map((x) => (x.id === r.id ? updated : x)));
      setEditing(null);
      app.toast('حُفظ المورد «' + updated.name + '»؛ أعيد بناء أقفال الحجوزات المتأثرة');
      app.bump();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!adding) return;
    if (!adding.code.trim() || !adding.name.trim()) return setError('اكتب رمز المورد واسمه.');
    setBusy(true);
    setError(null);
    try {
      const created = await api.createResource({
        siteId: site.id,
        code: adding.code.trim(),
        name: adding.name.trim(),
        kind: adding.kind.trim() || 'مورد',
        policy: adding.policy,
        parentResourceId: adding.parentResourceId || null,
        handoverMinutes: Number(adding.handoverMinutes) || 0,
        childBlocking: adding.childBlocking,
        sharedLimit: adding.policy === 'SHARED' && adding.sharedLimit ? Number(adding.sharedLimit) : null,
      });
      setResources([...resources, created]);
      setAdding(null);
      app.toast('أضيف المورد «' + created.name + '»');
      app.bump();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const relationChoice = (value: boolean, onChange: (v: boolean) => void, name: string) => (
    <fieldset className="scope-mode">
      <legend>العلاقة مع الموارد الفرعية</legend>
      <label className="check-label">
        <input type="radio" name={name} checked={value} onChange={() => onChange(true)} />
        حجزه يمنع موارده الفرعية، وحجز أي منها يمنعه (افتراضي)
      </label>
      <label className="check-label">
        <input type="radio" name={name} checked={!value} onChange={() => onChange(false)} />
        مستقل: يُحجز هو وموارده الفرعية كل على حدة
      </label>
    </fieldset>
  );

  return (
    <Dialog open onClose={onClose} className="large-dialog">
      <DialogHead eyebrow="FACILITY / RESOURCES" title={'موارد «' + site.name + '»'} small="الإعداد يسري على الحجوزات المعتمدة القائمة والجديدة" onClose={onClose} />
      <div className="dialog-content resource-settings">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>المورد</th>
                <th>السياسة</th>
                <th>التسليم</th>
                <th>العلاقة مع الفرعية</th>
                <th>حد الاستخدام المتزامن</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {resources.map((r) => (
                <tr key={r.id}>
                  <td style={{ paddingInlineStart: 12 + depth(r) * 18 }}>
                    {r.name}
                    <br />
                    <span className="latin tiny muted">{r.code}</span>
                  </td>
                  <td>
                    <span className={'pill ' + (r.policy === 'EXCLUSIVE' ? '' : 'green')}>{r.policy === 'EXCLUSIVE' ? 'حصري' : 'مشترك'}</span>
                  </td>
                  <td className="micro">{r.handoverMinutes ? r.handoverMinutes + ' دقيقة' : '—'}</td>
                  <td className="micro">{hasChildren(r.id) ? relationText(r) : <span className="muted">لا موارد فرعية</span>}</td>
                  <td className="micro">{r.policy === 'SHARED' ? (r.sharedLimit ? r.sharedLimit + ' استخدامات' : 'بلا حد') : '—'}</td>
                  <td>
                    <button className="button compact" disabled={busy} onClick={() => start(r)} aria-label={'تعديل ' + r.name}>
                      تعديل
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {editing && edit && byId.get(editing) && (
          <section className="rule-editor resource-form" aria-label={'تعديل ' + byId.get(editing)!.name}>
            <h4>تعديل «{byId.get(editing)!.name}»</h4>
            <div className="form-grid">
              <label className="field">
                <span>الاسم</span>
                <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </label>
              <label className="field">
                <span>التصنيف</span>
                <input value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} />
              </label>
              <label className="field">
                <span>فترة التسليم (دقيقة)</span>
                <input type="number" min={0} value={edit.handoverMinutes} onChange={(e) => setEdit({ ...edit, handoverMinutes: e.target.value })} />
              </label>
              {byId.get(editing)!.policy === 'SHARED' && (
                <label className="field">
                  <span>حد الاستخدام المتزامن — فارغ = بلا حد</span>
                  <input type="number" min={1} value={edit.sharedLimit} onChange={(e) => setEdit({ ...edit, sharedLimit: e.target.value })} />
                </label>
              )}
            </div>
            {hasChildren(editing) && relationChoice(edit.childBlocking, (v) => setEdit({ ...edit, childBlocking: v }), 'edit-relation')}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="button primary" disabled={busy} onClick={() => save(byId.get(editing)!)}>
                حفظ المورد
              </button>
              <button className="button" onClick={() => setEditing(null)}>
                إلغاء
              </button>
            </div>
          </section>
        )}

        {adding ? (
          <section className="rule-editor resource-form" aria-label="مورد جديد">
            <h4>مورد جديد في «{site.name}»</h4>
            <div className="form-grid">
              <label className="field">
                <span>الرمز</span>
                <input className="latin" value={adding.code} onChange={(e) => setAdding({ ...adding, code: e.target.value })} />
              </label>
              <label className="field">
                <span>الاسم</span>
                <input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
              </label>
              <label className="field">
                <span>التصنيف</span>
                <input value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value })} />
              </label>
              <label className="field">
                <span>سياسة الحجز</span>
                <select value={adding.policy} onChange={(e) => setAdding({ ...adding, policy: e.target.value as 'EXCLUSIVE' | 'SHARED' })}>
                  <option value="EXCLUSIVE">حصري: لا يتداخل حجزان</option>
                  <option value="SHARED">مشترك: يستخدمه أكثر من جهة</option>
                </select>
              </label>
              <label className="field">
                <span>داخل المورد</span>
                <select value={adding.parentResourceId} onChange={(e) => setAdding({ ...adding, parentResourceId: e.target.value })}>
                  <option value="">— مورد رئيسي في الموقع —</option>
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>فترة التسليم (دقيقة)</span>
                <input type="number" min={0} value={adding.handoverMinutes} onChange={(e) => setAdding({ ...adding, handoverMinutes: e.target.value })} />
              </label>
              {adding.policy === 'SHARED' && (
                <label className="field">
                  <span>حد الاستخدام المتزامن — فارغ = بلا حد</span>
                  <input type="number" min={1} value={adding.sharedLimit} onChange={(e) => setAdding({ ...adding, sharedLimit: e.target.value })} />
                </label>
              )}
            </div>
            {relationChoice(adding.childBlocking, (v) => setAdding({ ...adding, childBlocking: v }), 'new-relation')}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="button primary" disabled={busy} onClick={create}>
                إضافة المورد
              </button>
              <button className="button" onClick={() => setAdding(null)}>
                إلغاء
              </button>
            </div>
          </section>
        ) : (
          <button
            className="button compact"
            onClick={() => (
              setEditing(null),
              setError(null),
              setAdding({ code: '', name: '', kind: '', policy: 'EXCLUSIVE', parentResourceId: '', handoverMinutes: '0', childBlocking: true, sharedLimit: '' })
            )}
          >
            <Icon name="plus" /> إضافة مورد
          </button>
        )}
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <p className="micro muted">
          لا يُفترض حد سعة: المورد المشترك بلا حد ما لم يحدده مدير المرافق. تغيير العلاقة أو فترة التسليم يعيد بناء أقفال الحجوزات المعتمدة
          المتأثرة في المعاملة نفسها؛ إن تعارضت وفق القاعدة الجديدة يُرفض التغيير ولا يتغير شيء.
        </p>
      </div>
    </Dialog>
  );
}
