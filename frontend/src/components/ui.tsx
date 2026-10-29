import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react';
import { ICONS } from '../icons';
import { STATUS } from '../lib/labels';
import type { RequestStatus } from '../api/types';

/** Same SVG wrapper as the prototype's icon() helper; path fragments are static, trusted constants. */
export function Icon({ name }: { name: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICONS[name] ?? ICONS.file }}
    />
  );
}

export function Heading({ en, title, description, actions }: { en: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{en}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="heading-actions">{actions}</div>
    </div>
  );
}

export function Stat({ value, label, icon }: { value: ReactNode; label: string; icon: string }) {
  return (
    <div className="card stat-card">
      <div>
        <b>{value}</b>
        <span>{label}</span>
      </div>
      <i className="stat-icon">
        <Icon name={icon} />
      </i>
    </div>
  );
}

export function Pill({ tone = '', dot = false, children }: { tone?: string; dot?: boolean; children: ReactNode }) {
  return (
    <span className={'pill ' + tone}>
      {dot && <i className="dot" />}
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: RequestStatus }) {
  const [label, tone] = STATUS[status] ?? [status, ''];
  return (
    <span className={'pill ' + tone}>
      <i className="dot" />
      {label}
    </span>
  );
}

export function Dot({ color, title }: { color: string; title?: string }) {
  return <i className="dot" style={{ color }} title={title} />;
}

export function NoAccess({ message }: { message?: string }) {
  return (
    <section className="card permission-denied">
      <Icon name="shield" />
      <h2>هذا القسم خارج صلاحياتك الحالية</h2>
      <p>{message ?? 'تُحدد الصلاحيات في الخادم حسب عضويتك ودورك ونطاقك. تواصل مع مدير النظام إذا احتجت الوصول.'}</p>
      <a className="button primary" href="#map">
        العودة إلى الخريطة
      </a>
    </section>
  );
}

export function Loading({ label = 'جارٍ التحميل…' }: { label?: string }) {
  return <div className="empty">{label}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="note red">{message}</div>;
}

/** Native <dialog> controlled by React; keeps the prototype's dialog classes. */
export function Dialog({
  open,
  onClose,
  className,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  className: 'large-dialog' | 'detail-dialog' | 'small-dialog';
  children: ReactNode;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && children}
    </dialog>
  );
}

export function DialogHead({ eyebrow, title, small, onClose }: { eyebrow?: string; title: string; small?: string; onClose: () => void }) {
  return (
    <div className="dialog-head">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {small && <small>{small}</small>}
      </div>
      <button className="icon-button" onClick={onClose} aria-label="إغلاق">
        <Icon name="close" />
      </button>
    </div>
  );
}

export function KeyValue({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="key-value">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

export function download(name: string, data: string, type = 'application/json') {
  const u = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 700);
}

/** Keeps a failure inside one screen: the rest of the workspace stays usable and nothing is silently retried. */
export class ScreenBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('screen error', error, info.componentStack);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="card padding" role="alert">
        <h2>تعذر عرض هذه الشاشة</h2>
        <p className="micro muted">لم يُحفظ أي إجراء جزئي. أعد تحميل الصفحة؛ إن تكرر الخطأ فأبلغ الدعم الفني مع الوقت.</p>
        <p className="micro latin">{this.state.error.message}</p>
        <button className="button" onClick={() => window.location.reload()}>
          إعادة تحميل الصفحة
        </button>
      </section>
    );
  }
}
