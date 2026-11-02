import { useEffect, useState } from 'react';
import { Icon } from '../../../frontend/src/components/ui';
import { Workspace } from './Workspace';

const NAV: [string, string, string][] = [
  ['stationing', 'map', 'مساحة التمركز'],
  ['requests', 'file', 'الطلبات'],
  ['review', 'check', 'صندوق المراجعة'],
  ['calendar', 'clock', 'الإشغال والحجوزات'],
  ['org', 'tree', 'الهيكل التنظيمي'],
  ['workflow', 'layers', 'استوديو التدفقات'],
  ['forms', 'grid', 'استوديو النماذج'],
  ['permissions', 'shield', 'مركز الصلاحيات'],
  ['settings', 'filter', 'إعدادات النظام'],
  ['audit', 'clock', 'سجل الإجراءات'],
  ['docs', 'download', 'التوثيق والتشغيل'],
];

/**
 * The application frame of TMRKZ as it is today (same stylesheet and structure), with only «مساحة التمركز» working. The
 * frame is shown so the comparison with the real page measures the page, not a different frame; on tablets the sidebar
 * becomes an icon rail (a frame-level proposal that needs its own approval).
 */
export function App() {
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    document.body.classList.toggle('nav-open', navOpen);
  }, [navOpen]);
  return (
    <>
      <div className="demo-ribbon proto-ribbon">
        <span>
          <i /> نموذج أولي للمراجعة · بيانات وهمية · لا اتصال بالخادم
        </span>
        <span className="proto-ribbon-note">ليس الصفحة المعتمدة؛ لم يُدمج في التطبيق</span>
      </div>
      <aside id="sidebar" className="sidebar proto-sidebar">
        <a className="brand" href="#">
          <span className="brand-logo">
            <Icon name="map" />
          </span>
          <span>
            <strong>
              TMRKZ<span>.</span>
            </strong>
            <small>المواقع · المرافق · الإجراءات</small>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-icon">م</span>
          <span>
            <b>مجمع المؤسسة</b>
            <small>الخدمات المشتركة</small>
          </span>
          <span className="workspace-caret">⌄</span>
        </div>
        <span className="nav-section">مساحة العمل</span>
        <nav id="navigation" aria-label="القائمة الرئيسية">
          {NAV.map(([id, ico, label]) => (
            <span key={id}>
              {id === 'workflow' && <div className="nav-divider" />}
              <a className={'nav-item ' + (id === 'stationing' ? 'active' : '')} href={id === 'stationing' ? '#' : undefined} aria-disabled={id !== 'stationing'} title={label}>
                <Icon name={ico} />
                <span>{label}</span>
              </a>
            </span>
          ))}
        </nav>
      </aside>
      <button className="nav-shade" aria-label="إغلاق القائمة" onClick={() => setNavOpen(false)} hidden={!navOpen} />
      <div className="app-shell proto-shell">
        <header className="app-header">
          <button className="icon-button mobile-menu" onClick={() => setNavOpen((o) => !o)} aria-label="فتح القائمة">
            ☰
          </button>
          <div className="breadcrumb">
            <span>مجمع المؤسسة</span>
            <i>/</i>
            <b>مساحة التمركز</b>
          </div>
          <div className="header-actions">
            <span className="identity-name">مقدم طلب تجريبي</span>
            <span className="avatar">م ط</span>
          </div>
        </header>
        <main id="main" className="proto-main">
          <Workspace />
        </main>
      </div>
    </>
  );
}
