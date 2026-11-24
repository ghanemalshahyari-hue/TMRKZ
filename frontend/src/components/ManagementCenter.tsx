import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { SystemManagement } from '../api/types';
import { useApp } from '../lib/app';
import { fullTime } from '../lib/dates';

export function ManagementCenter() {
  const app = useApp();
  const [mgmt, setMgmt] = useState<SystemManagement | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [newOrigin, setNewOrigin] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.systemManagement().then((m) => {
      setMgmt(m);
      setOrigins(m.embeddingAllowedOrigins);
    }).catch((e: Error) => app.toast(e.message));
  }, []);

  const saveOrigins = async () => {
    setBusy(true);
    try {
      const r = await api.setEmbedding(origins);
      setOrigins(r.allowedOrigins);
      app.toast('حُفظت أصول التضمين المسموحة');
    } catch (e) {
      app.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addOrigin = () => {
    const o = newOrigin.trim();
    if (!o) return;
    if (!o.match(/^https:\/\/[a-zA-Z0-9._-]+(:[0-9]+)?$/)) {
      app.toast('المصدر يجب أن يكون https://host أو https://host:port فقط');
      return;
    }
    if (origins.includes(o)) return;
    setOrigins([...origins, o]);
    setNewOrigin('');
  };

  const removeOrigin = (o: string) => setOrigins(origins.filter((x) => x !== o));

  if (!mgmt) return <p className="micro muted">جارٍ تحميل بيانات الإدارة…</p>;

  return (
    <>
      <section className="card padding" data-testid="mgmt-status">
        <h2>حالة النظام</h2>
        <div className="key-value"><span>الإصدار</span><b>{mgmt.version}</b></div>
        <div className="key-value"><span>قاعدة البيانات</span><b><span className={'pill ' + (mgmt.database === 'UP' ? 'green' : 'red')}>{mgmt.database === 'UP' ? 'متصلة' : 'غير متصلة'}</span></b></div>
        <div className="key-value"><span>إصدار المخطط</span><b>V{mgmt.schemaVersion}</b></div>
        <div className="key-value"><span>وقت الخادم</span><b>{fullTime(mgmt.serverTime)}</b></div>
        <div className="key-value"><span>حزم الخرائط</span><b>{mgmt.mapPackages}</b></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginTop: 12 }}>
          <div className="card padding" style={{ textAlign: 'center' }}><div style={{ fontSize: 24, fontWeight: 700 }}>{mgmt.organizations}</div><div className="micro muted">وحدة</div></div>
          <div className="card padding" style={{ textAlign: 'center' }}><div style={{ fontSize: 24, fontWeight: 700 }}>{mgmt.people}</div><div className="micro muted">شخص</div></div>
          <div className="card padding" style={{ textAlign: 'center' }}><div style={{ fontSize: 24, fontWeight: 700 }}>{mgmt.requests}</div><div className="micro muted">طلب</div></div>
          <div className="card padding" style={{ textAlign: 'center' }}><div style={{ fontSize: 24, fontWeight: 700 }}>{mgmt.sites}</div><div className="micro muted">مرفق</div></div>
        </div>
      </section>

      <section className="card padding" data-testid="mgmt-tls">
        <h2>شهادة HTTPS</h2>
        {mgmt.tlsConfigured ? (
          <>
            <div className="key-value"><span>الموضوع</span><b dir="ltr">{mgmt.tlsSubject}</b></div>
            <div className="key-value"><span>المُصدر</span><b dir="ltr">{mgmt.tlsIssuer}</b></div>
            <div className="key-value"><span>صالحة حتى</span><b>{mgmt.tlsExpiry ? fullTime(mgmt.tlsExpiry) : '—'}</b></div>
            {mgmt.tlsSAN && mgmt.tlsSAN.length > 0 && (
              <div className="key-value"><span>الأسماء البديلة (SAN)</span><b dir="ltr">{mgmt.tlsSAN.join(', ')}</b></div>
            )}
            {mgmt.tlsError && <div className="note red">{mgmt.tlsError}</div>}
            <p className="micro muted" style={{ marginTop: 10 }}>
              تُدار الشهادة من سطر الأوامر: <code dir="ltr">sh ops/tls/make-csr.sh</code> لإنشاء طلب التوقيع، ثم <code dir="ltr">sh ops/tls/install-cert.sh</code> لتثبيت الشهادة المصدرة.
            </p>
          </>
        ) : (
          <div>
            <p className="micro muted">HTTPS غير مهيأ — يعمل النظام عبر HTTP فقط.</p>
            <p className="micro muted" style={{ marginTop: 6 }}>
              لتفعيل HTTPS: <code dir="ltr">sh ops/tls/make-csr.sh</code> ← <code dir="ltr">sh ops/tls/install-cert.sh &lt;cert&gt; &lt;chain&gt;</code> ← <code dir="ltr">sh ops/tls/enable.sh</code>
            </p>
          </div>
        )}
      </section>

      <section className="card padding" data-testid="mgmt-embedding">
        <h2>التضمين في مواقع أخرى</h2>
        <p className="micro muted" style={{ marginBottom: 12 }}>
          بشكل افتراضي لا يُسمح بتضمين التطبيق في إطار (iframe). أضف أصول HTTPS المسموحة هنا. كل أصل يجب أن يكون بالصيغة <code dir="ltr">https://host</code> أو <code dir="ltr">https://host:port</code>.
        </p>
        {origins.length > 0 && (
          <ul style={{ margin: '0 0 10px', padding: '0 20px' }}>
            {origins.map((o) => (
              <li key={o} style={{ marginBottom: 4 }}>
                <code dir="ltr">{o}</code>
                <button className="button small" style={{ marginInlineStart: 8 }} onClick={() => removeOrigin(o)}>إزالة</button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex" style={{ gap: 8 }}>
          <input dir="ltr" placeholder="https://portal.example.local" value={newOrigin} onChange={(e) => setNewOrigin(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addOrigin()} style={{ flex: 1 }} />
          <button className="button" onClick={addOrigin}>إضافة</button>
        </div>
        <button className="button primary" style={{ marginTop: 10 }} disabled={busy} onClick={saveOrigins}>
          حفظ أصول التضمين
        </button>
        {origins.length === 0 && <p className="micro muted" style={{ marginTop: 6 }}>لا أصول مسموحة — التضمين محظور (الإعداد الافتراضي).</p>}
      </section>

      <section className="card padding" data-testid="mgmt-backups">
        <h2>النسخ الاحتياطية</h2>
        <div className="key-value"><span>عدد النسخ المحفوظة</span><b>{mgmt.backupCount}</b></div>
        {mgmt.backupsPath && <div className="key-value"><span>المسار</span><b dir="ltr">{mgmt.backupsPath}</b></div>}
        <p className="micro muted" style={{ marginTop: 10 }}>
          لإنشاء نسخة احتياطية: <code dir="ltr">sh ops/tmrkzctl.sh backup</code> أو <code dir="ltr">sh ops/backup.sh</code>
          <br />
          للتحقق: <code dir="ltr">sh ops/verify-restore.sh</code>
          <br />
          للاستعادة: <code dir="ltr">sh ops/tmrkzctl.sh rollback &lt;backup-dir&gt;</code>
        </p>
      </section>

      <section className="card padding" data-testid="mgmt-cli">
        <h2>أوامر الطوارئ</h2>
        <p className="micro muted" style={{ marginBottom: 8 }}>هذه الأوامر متاحة على الخادم للتشخيص والاسترداد في حالة الطوارئ فقط.</p>
        <dl className="int-env">
          <div><dt>التشخيص</dt><dd dir="ltr">sh ops/tmrkzctl.sh doctor</dd></div>
          <div><dt>الحالة</dt><dd dir="ltr">sh ops/tmrkzctl.sh status</dd></div>
          <div><dt>التحقق</dt><dd dir="ltr">sh ops/tmrkzctl.sh verify</dd></div>
          <div><dt>الإعداد</dt><dd dir="ltr">sh ops/tmrkzctl.sh setup</dd></div>
          <div><dt>التحديث</dt><dd dir="ltr">sh ops/tmrkzctl.sh update &lt;bundle.tar.gz&gt;</dd></div>
          <div><dt>النسخ الاحتياطي</dt><dd dir="ltr">sh ops/tmrkzctl.sh backup</dd></div>
          <div><dt>الاستعادة</dt><dd dir="ltr">sh ops/tmrkzctl.sh rollback &lt;backup-dir&gt;</dd></div>
          <div><dt>جرد التثبيت</dt><dd dir="ltr">sh ops/tmrkzctl.sh inventory</dd></div>
        </dl>
      </section>
    </>
  );
}
