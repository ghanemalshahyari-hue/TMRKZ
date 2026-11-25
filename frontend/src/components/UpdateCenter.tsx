import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type UpdateChange, type UpdateOverview, type UpdateSession } from '../api/client';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';
import { sha256File } from '../lib/sha256';

const STATE: Record<string, string> = {
  RECEIVED: 'استُلم الإصدار',
  VERIFYING: 'التحقق من التوقيع والمقارنة',
  COMPARED: 'قورن بالتثبيت — بانتظار الرفع والاعتماد',
  APPROVED: 'اعتُمد — بانتظار عامل الصيانة',
  ROLLBACK_REQUESTED: 'طُلب الرجوع — بانتظار عامل الصيانة',
  VALIDATING: 'التحقق قبل التطبيق (بناء الخادم بالمكتبات الموجودة)',
  APPLYING: 'نسخ احتياطي ثم تطبيق',
  VERIFYING_DEPLOY: 'التحقق من إعادة البناء والتشغيل',
  DONE: 'طُبق وتحقق',
  DONE_RESTART_REQUIRED: 'طُبق — يلزم إعادة تشغيل الحاويات مرة واحدة',
  ROLLING_BACK: 'الرجوع إلى الإصدار السابق',
  ROLLED_BACK: 'أُعيد الإصدار السابق',
  FAILED_ROLLED_BACK: 'فشل التحقق وأُعيد الإصدار السابق تلقائياً',
  REJECTED: 'رُفض — لم يُطبق شيء',
  ERROR: 'خطأ — راجع التشخيص',
};
const BUSY = new Set(['RECEIVED', 'VERIFYING', 'APPROVED', 'VALIDATING', 'APPLYING', 'VERIFYING_DEPLOY', 'ROLLBACK_REQUESTED', 'ROLLING_BACK']);
const CHANGE: Record<string, string> = { ADDED: 'مضاف', MODIFIED: 'معدّل', DELETED: 'محذوف', BLOCKED: 'ممنوع' };
const FLAG: Record<string, string> = {
  CONFIG: 'إعداد الحاويات (اختيار صريح)',
  NEEDS_RESTART: 'يحتاج إعادة تشغيل الحاويات',
  LOCALLY_MODIFIED: 'معدّل على هذا الجهاز بعد آخر تحديث',
  TOO_LARGE: 'أكبر من حد الرفع',
  NEW_DEPENDENCY: 'مكتبة جديدة',
  BUILD_CHECK: 'يُتحقق ببناء الخادم',
  PROTECTED: 'محمي',
  MASS_DELETION: 'حذف واسع غير معتاد (اختيار يدوي)',
};

type Local = { files: Map<string, File>; folder: string };
type Check = Record<string, 'ok' | 'missing' | 'changed'>;

/** Files of the chosen folder by path relative to it (the browser gives «TMRKZ/backend/…»). */
function folderFiles(list: FileList): Local {
  const files = new Map<string, File>();
  let folder = '';
  for (const f of Array.from(list)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const slash = rel.indexOf('/');
    folder = slash > 0 ? rel.slice(0, slash) : folder;
    files.set(slash > 0 ? rel.slice(slash + 1) : rel, f);
  }
  return { files, folder };
}

/**
 * «مركز التحديث» (ADR-104): choose the TMRKZ folder, see what differs from this installation, upload only that, approve, follow
 * the maintenance worker as it builds, backs up, applies and verifies — and roll back. The page never writes a file itself.
 */
export function UpdateCenter() {
  const app = useApp();
  const [overview, setOverview] = useState<UpdateOverview | null>(null);
  const [session, setSession] = useState<UpdateSession | null>(null);
  const [local, setLocal] = useState<Local | null>(null);
  const [check, setCheck] = useState<Check>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [offline, setOffline] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const loadOverview = () => api.updatesOverview().then(setOverview).catch((e: Error) => app.toast(e.message));
  useEffect(() => { void loadOverview(); }, []);

  // follow the worker while it works; the backend may restart in between (a new build), so errors are expected for a while
  useEffect(() => {
    if (!session || !BUSY.has(session.state)) return;
    const t = window.setTimeout(() => {
      api.updateSession(session.id).then((s) => { setOffline(false); setSession(s); if (!BUSY.has(s.state)) void loadOverview(); })
        .catch(() => { setOffline(true); setSession({ ...session }); });
    }, 1500);
    return () => window.clearTimeout(t);
  }, [session]);

  const changes = session?.compare?.changes ?? [];
  const needed = useMemo(() => changes.filter((c) => !c.blocked && (c.change === 'ADDED' || c.change === 'MODIFIED')), [session]);

  // the local copy of each needed file must be the signed one
  useEffect(() => {
    if (!local || !session?.compare) return;
    let stop = false;
    (async () => {
      const out: Check = {};
      for (const c of needed) {
        const f = local.files.get(c.path);
        out[c.path] = !f ? 'missing' : (await sha256File(f)) === c.sha256 ? 'ok' : 'changed';
        if (stop) return;
      }
      setCheck(out);
      const pick = new Set<string>();
      for (const c of changes) {
        const flagged = c.flags.includes('CONFIG') || c.flags.includes('LOCALLY_MODIFIED') || c.flags.includes('MASS_DELETION');
        if (!c.blocked && !flagged && (c.change === 'DELETED' || out[c.path] === 'ok')) pick.add(c.path);
      }
      setSelected(pick);
    })();
    return () => { stop = true; };
  }, [local, session?.compare]);

  const choose = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const l = folderFiles(list);
    const rel = l.files.get('release/RELEASE.json');
    const sig = l.files.get('release/RELEASE.sig');
    const man = l.files.get('release/MANIFEST.tsv');
    if (!rel || !sig || !man) {
      app.toast('لا يوجد إصدار موقّع في هذا المجلد: شغّل فيه  sh ops/update/make-release.sh  ثم اختره من جديد.');
      return;
    }
    setBusy('قراءة الإصدار …');
    setLocal(l);
    setCheck({});
    try {
      setSession(await api.createUpdate(await rel.text(), await sig.text(), await man.text()));
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const upload = async () => {
    if (!session || !local) return;
    const todo = needed.filter((c) => selected.has(c.path) && !c.uploaded && check[c.path] === 'ok');
    try {
      for (let i = 0; i < todo.length; i++) {
        setBusy(`رفع ${i + 1} من ${todo.length}: ${todo[i].path}`);
        await api.uploadUpdateFile(session.id, todo[i].path, local.files.get(todo[i].path)!);
      }
      setSession(await api.updateSession(session.id));
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const approve = async () => {
    if (!session) return;
    setBusy('اعتماد …');
    try {
      setSession(await api.approveUpdate(session.id, Array.from(selected), reason.trim()));
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const rollback = async (id: string) => {
    const why = window.prompt('سبب الرجوع إلى الإصدار السابق؟');
    if (!why || !why.trim()) return;
    try {
      setSession(await api.rollbackUpdate(id, why.trim()));
    } catch (e) {
      app.toast((e as Error).message);
    }
  };

  const toggle = (c: UpdateChange) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(c.path)) n.delete(c.path); else n.add(c.path);
    return n;
  });

  const missingUploads = needed.filter((c) => selected.has(c.path) && !c.uploaded);
  const badLocal = needed.filter((c) => selected.has(c.path) && check[c.path] && check[c.path] !== 'ok');
  const w = overview?.worker;
  return (
    <section className="card padding" data-testid="update-center" style={{ gridColumn: '1 / -1' }}>
      <div className="flex spread">
        <h2>مركز التحديث</h2>
        <span className="micro" data-testid="update-worker">
          {!w ? 'التحقق من عامل الصيانة …' : w.alive ? `عامل الصيانة يعمل (${w.version})` : 'عامل الصيانة لا يعمل — التهيئة الأولى مطلوبة'}
          {w && !w.trustInstalled && ' · مفتاح الثقة غير مثبت'}
        </span>
      </div>
      <p className="micro muted" style={{ margin: '6px 0 12px' }}>
        اختر مجلد TMRKZ نفسه (من سطح المكتب مثلاً) بعد تشغيل ops/update/make-release.sh فيه. يُتحقق من توقيعه، ويُقارن بالتثبيت، ويُرفع
        المختلف فقط. البيانات والشهادات والخرائط وملف .env وإعدادات هذا الجهاز لا تُمس.
      </p>

      <input
        ref={picker}
        type="file"
        data-testid="update-folder"
        style={{ display: 'none' }}
        multiple
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => { void choose(e.target.files); e.target.value = ''; }}
      />
      <button className="button primary" disabled={!!busy || (!!session && BUSY.has(session.state))} onClick={() => picker.current?.click()}>
        اختيار مجلد TMRKZ
      </button>
      {busy && <p className="micro" data-testid="update-busy">{busy}</p>}

      {session && (
        <div className="card padding" data-testid="update-session" style={{ marginTop: 12 }}>
          <div className="key-value"><span>الإصدار</span><b dir="ltr">{session.release ?? '—'}</b></div>
          <div className="key-value"><span>الحالة</span><b data-testid="update-state" data-state={session.state}>{STATE[session.state] ?? session.state}</b></div>
          {session.message && <p className="micro" data-testid="update-message">{session.message}</p>}
          {offline && <p className="micro muted">الخادم يعيد التشغيل بالبناء الجديد …</p>}

          {session.compare && session.state === 'COMPARED' && (
            <>
              <p className="micro" data-testid="update-counts">
                مضاف {session.compare.counts.ADDED ?? 0} · معدّل {session.compare.counts.MODIFIED ?? 0} · محذوف {session.compare.counts.DELETED ?? 0}
                {' '}· ممنوع {session.compare.counts.BLOCKED ?? 0} · بلا تغيير {session.compare.unchanged}
                {session.compare.release.localChanges && ' · يشمل تعديلات لم تُحفظ في git'}
              </p>
              <table className="table" data-testid="update-changes">
                <thead><tr><th /><th>الملف</th><th>التغيير</th><th>ملاحظات</th></tr></thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.path} data-path={c.path} data-change={c.change}>
                      <td>
                        <input type="checkbox" aria-label={c.path} disabled={c.blocked || (c.change !== 'DELETED' && check[c.path] !== 'ok')}
                          checked={selected.has(c.path)} onChange={() => toggle(c)} />
                      </td>
                      <td dir="ltr" style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.path}</td>
                      <td>{CHANGE[c.change]}</td>
                      <td className="micro">
                        {[...c.flags.map((f) => FLAG[f] ?? f), c.reason, check[c.path] === 'changed' ? 'تغير بعد التوقيع' : null,
                          check[c.path] === 'missing' ? 'غير موجود في المجلد' : null, c.uploaded ? 'مرفوع' : null].filter(Boolean).join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {badLocal.length > 0 && <p className="micro">ملفات تختلف عن الإصدار الموقع أو مفقودة: أعد تشغيل make-release.sh.</p>}
              <div className="flex" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button className="button" data-testid="update-upload" disabled={!!busy || missingUploads.length === 0 || badLocal.length > 0} onClick={upload}>
                  رفع الملفات المختلفة ({missingUploads.length})
                </button>
                <input data-testid="update-reason" placeholder="سبب التحديث (يُسجل في التدقيق)" value={reason} onChange={(e) => setReason(e.target.value)}
                  style={{ flex: 1, minWidth: 220 }} />
                <button className="button primary" data-testid="update-approve"
                  disabled={!!busy || selected.size === 0 || missingUploads.length > 0 || badLocal.length > 0 || reason.trim().length < 3} onClick={approve}>
                  اعتماد وتطبيق ({selected.size})
                </button>
              </div>
            </>
          )}

          {session.progress.length > 0 && (
            <ol className="micro" data-testid="update-progress" style={{ marginTop: 8, maxHeight: 220, overflow: 'auto' }}>
              {session.progress.map((p, i) => <li key={i}><span className="muted">{p.at ? fullTime(p.at) : ''}</span> {p.text}</li>)}
            </ol>
          )}
          {(session.state === 'DONE' || session.state === 'DONE_RESTART_REQUIRED') && (
            <button className="button" data-testid="update-rollback" onClick={() => rollback(session.id)}>الرجوع إلى الإصدار السابق</button>
          )}
        </div>
      )}

      {overview && overview.sessions.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>التحديثات السابقة</h3>
          {overview.sessions.map((s) => (
            <div key={s.id} className="key-value" data-testid="update-history-row">
              <span><b dir="ltr">{s.release ?? s.id}</b> <small className="muted">· {s.createdBy} · {s.createdAt ? fullTime(s.createdAt) : ''}</small></span>
              <span className="flex" style={{ gap: 8 }}>
                <span>{STATE[s.state] ?? s.state}</span>
                <button className="button small" onClick={() => api.updateSession(s.id).then(setSession).catch((e: Error) => app.toast(e.message))}>عرض</button>
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
