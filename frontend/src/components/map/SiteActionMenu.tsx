import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type L from 'leaflet';
import type { SiteRequestActionCode, SiteRequestActions } from '../../api/types';
import type { StateStyle } from '../../lib/mapState';

/** What the site's request actions are anchored to: a point on the map (marker or the clicked boundary), or a row. */
export type MenuAnchor = { kind: 'map'; latlng: L.LatLngExpression; offset: number } | { kind: 'element'; el: HTMLElement };

export type SiteActionsState = { siteId: string; data: SiteRequestActions | null; error: string | null };

/**
 * The two administrative use actions of one site, decided by the server: temporary use and, where a published type
 * permits it, open-ended use. When several published types fit an action the person picks one; nothing is chosen
 * silently. Unavailable actions stay visible with the reason and what fixes it. Used by the on-map menu and the site
 * panel alike, so every entry path runs the same command.
 */
export function SiteRequestActionList({
  state,
  onChoose,
  autoFocus = false,
}: {
  state: SiteActionsState | null;
  onChoose: (action: SiteRequestActionCode, typeCode: string) => void;
  autoFocus?: boolean;
}) {
  const [step, setStepState] = useState<SiteRequestActionCode | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const data = state?.data ?? null;
  useEffect(() => setStepState(null), [state?.siteId]);
  const setStep = (s: SiteRequestActionCode | null) => {
    moved.current = true;
    setStepState(s);
  };
  // after a choice the list starts again from the two actions (the panel stays mounted)
  const choose = (action: SiteRequestActionCode, code: string) => {
    setStepState(null);
    onChoose(action, code);
  };
  // the pressed button is replaced by the type list (or back): keep keyboard focus inside the actions
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [step]);

  // keyboard opening: focus the first usable action once the server has answered
  useEffect(() => {
    if (!autoFocus || !data) return;
    const first = box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus({ preventScroll: true });
  }, [autoFocus, data, step]);

  if (!state || (!data && !state.error))
    return (
      <div className="site-actions" ref={box} aria-busy="true">
        <button type="button" className="button primary" disabled>
          طلب استخدام مؤقت
        </button>
        <p className="micro muted">جارٍ التحقق من الطلبات المتاحة لك على هذا الموقع…</p>
      </div>
    );
  if (state.error)
    return (
      <div className="site-actions" ref={box}>
        <p className="micro note red">تعذر التحقق من الطلبات المتاحة: {state.error}</p>
      </div>
    );
  if (!data!.actions.length)
    return (
      <div className="site-actions" ref={box}>
        <p className="micro muted">لا يوجد نوع طلب إداري منشور لاستخدام المواقع.</p>
      </div>
    );

  const chosen = step ? data!.actions.find((a) => a.action === step) : null;
  if (chosen)
    return (
      <div className="site-actions types" ref={box} role="group" aria-label={'نوع الطلب — ' + chosen.label}>
        <p className="site-actions-q">
          <b>{chosen.label}</b>
          <small>اختر نوع الطلب الإداري المنشور:</small>
        </p>
        {chosen.types.map((t) => (
          <button key={t.code} type="button" className="button" disabled={!t.ready} title={t.reason ?? undefined} onClick={() => choose(chosen.action, t.code)}>
            {t.name}
            {!t.ready && <small>{t.reason}</small>}
          </button>
        ))}
        <button type="button" className="link-button text-link" onClick={() => setStep(null)}>
          رجوع
        </button>
      </div>
    );

  return (
    <div className="site-actions" ref={box}>
      <div className="site-actions-row">
        {data!.actions.map((a) => {
          const ready = a.types.filter((t) => t.ready);
          const hint = a.reason ? 'site-action-reason-' + a.action + '-' + data!.siteId : undefined;
          return (
            <button
              key={a.action}
              type="button"
              className={'button site-action ' + (a.action === 'TEMPORARY' ? 'primary' : '')}
              disabled={!a.available}
              aria-describedby={hint}
              onClick={() => (ready.length === 1 ? choose(a.action, ready[0].code) : setStep(a.action))}
            >
              <span aria-hidden="true">{a.action === 'TEMPORARY' ? '◷' : '∞'}</span>
              {a.label}
            </button>
          );
        })}
      </div>
      {data!.actions
        .filter((a) => a.reason)
        .slice(0, 1)
        .map((a) => (
          <p key={a.action} id={'site-action-reason-' + a.action + '-' + data!.siteId} className="micro note">
            {a.reason}
          </p>
        ))}
      {data!.canCreate && data!.actions.some((a) => a.available) && (
        <p className="micro muted">
          {data!.resourceCount > 1 ? 'في الموقع ' + data!.resourceCount + ' موارد؛ تختار المطلوب منها في النموذج.' : 'تكمل الفترة والبيانات في النموذج؛ لا يُنشأ طلب قبل الحفظ.'}
        </p>
      )}
    </div>
  );
}

/** Row button that opens the site's request menu next to a tree or list row (same menu and command as the map). */
export function RowActionsButton({ name, onOpen, open }: { name: string; onOpen: (el: HTMLElement, keyboard: boolean) => void; open: boolean }) {
  return (
    <button
      type="button"
      className="button compact ghost row-actions"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={'طلب استخدام «' + name + '»'}
      title="طلب استخدام لهذا الموقع"
      onClick={(e) => onOpen(e.currentTarget, e.detail === 0)}
    >
      طلب
    </button>
  );
}

function useNarrow(): boolean {
  const q = '(max-width: 640px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return !!narrow;
}

const clamp = (v: number, a: number, z: number) => Math.max(a, Math.min(z, v));

/**
 * Compact menu anchored at the selected site. It follows the site while the map pans or zooms, stays inside the map
 * (or the window for a row), and closes on Escape, a click elsewhere, a different selection or once an action is
 * chosen. On a phone it is a bottom sheet with the two labelled buttons. Opening and closing it writes nothing.
 */
export function SiteActionMenu({
  map,
  anchor,
  title,
  subtitle,
  state,
  availability,
  actions,
  keyboard,
  onChoose,
  onClose,
}: {
  map: L.Map | null;
  anchor: MenuAnchor;
  title: string;
  subtitle: string;
  state: StateStyle | null;
  availability: string;
  actions: SiteActionsState | null;
  keyboard: boolean;
  onChoose: (action: SiteRequestActionCode, typeCode: string) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const [pos, setPos] = useState<{ x: number; y: number; arrow: number | null; below: boolean } | null>(null);
  // on the map (not on a phone) the two actions first appear as a ring around the site: use on one side, moving the
  // premises on the other; «طلب استخدام» then opens the card with the published use types
  const data = actions?.data ?? null;
  const relocate = data?.actions.find((a) => a.action === 'RELOCATE') ?? null;
  const useActions = data?.actions.filter((a) => a.action !== 'RELOCATE') ?? [];
  const [card, setCard] = useState(false);
  const ring = anchor.kind === 'map' && !narrow && !card && (!data || (!!relocate && useActions.length > 0));
  const R = 100;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // position: recomputed on every map move/zoom and on window scroll/resize; never leaves the map (or the window)
  useLayoutEffect(() => {
    if (narrow) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let px: number, py: number, box: DOMRect;
      if (anchor.kind === 'map') {
        if (!map) return;
        box = map.getContainer().getBoundingClientRect();
        const p = map.latLngToContainerPoint(anchor.latlng);
        px = box.left + p.x;
        py = box.top + p.y;
        if (ring) {
          // centred on the marker's head (or the clicked boundary point), kept inside the map
          const cx = clamp(px, box.left + R + 6, box.right - R - 6);
          const cy = clamp(py - (anchor.offset > 20 ? 13 : 0), box.top + R + 30, box.bottom - R - 30);
          setPos({ x: cx - R, y: cy - R, arrow: null, below: false });
          return;
        }
      } else {
        if (!anchor.el.isConnected) return onCloseRef.current(false);
        const r = anchor.el.getBoundingClientRect();
        box = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
        px = r.left + r.width / 2;
        py = r.bottom;
      }
      // a marker is drawn around its point (head above, name below): keep the whole pin visible
      const gap = anchor.kind === 'map' ? anchor.offset : 6;
      const x = clamp(px - w / 2, box.left + 8, box.right - w - 8);
      let below = anchor.kind === 'element';
      let y = below ? py + gap : py - h - gap;
      if (!below && y < box.top + 8) {
        below = true;
        y = py + gap;
      }
      if (below && y + h > box.bottom - 8 && anchor.kind === 'element') y = Math.max(box.top + 8, py - h - 30);
      y = clamp(y, box.top + 8, Math.max(box.top + 8, box.bottom - h - 8));
      const inside = px >= box.left && px <= box.right && py >= box.top && py <= box.bottom;
      setPos({ x, y, arrow: inside ? clamp(px - x, 18, w - 18) : null, below });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    map?.on('move zoom resize viewreset', place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro.disconnect();
      map?.off('move zoom resize viewreset', place);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [map, anchor, narrow, ring]);

  // Escape closes and returns focus; a press outside the menu and the map closes (map clicks are handled by the map)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCloseRef.current(true);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t)) return;
      if (map?.getContainer().contains(t)) return;
      if (anchor.kind === 'element' && anchor.el.contains(t)) return;
      onCloseRef.current(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [map, anchor]);

  useEffect(() => {
    if (!keyboard) ref.current?.focus({ preventScroll: true });
    else if (ring) ref.current?.querySelector<HTMLButtonElement>('.ring-seg:not(:disabled)')?.focus({ preventScroll: true });
  }, [keyboard, ring, data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (ring) {
    const readyRelocate = relocate?.types.filter((t) => t.ready) ?? [];
    return createPortal(
      <div
        ref={ref}
        className="site-ring"
        style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}
        role="dialog"
        aria-modal="false"
        aria-label={'إجراءات «' + title + '»'}
        tabIndex={-1}
      >
        <span className="site-ring-title">
          <b>{title}</b>
          {state && (
            <small>
              {' '}
              · {state.symbol} {state.label}
            </small>
          )}
        </span>
        <button
          type="button"
          className="ring-seg right"
          disabled={!data || !useActions.some((a) => a.available)}
          title={useActions.find((a) => a.reason)?.reason ?? undefined}
          onClick={() => setCard(true)}
        >
          <span aria-hidden="true">◷</span>
          طلب استخدام
        </button>
        <button
          type="button"
          className="ring-seg left"
          disabled={!relocate?.available}
          title={relocate?.reason ?? undefined}
          onClick={() => (readyRelocate.length === 1 ? onChoose('RELOCATE', readyRelocate[0].code) : setCard(true))}
        >
          <span aria-hidden="true">⇄</span>
          نقل المقر
        </button>
        <i className="ring-hole" aria-hidden="true" />
        <button type="button" className="ring-close icon-button" onClick={() => onClose(true)} aria-label="إغلاق قائمة الموقع">
          ✕
        </button>
        {!data && <span className="ring-note">جارٍ التحقق من الإجراءات…</span>}
        {data && relocate?.reason && <span className="ring-note">{relocate.reason}</span>}
      </div>,
      document.body,
    );
  }

  const style: CSSProperties | undefined = narrow ? undefined : pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 };
  return createPortal(
    <div
      ref={ref}
      className={'site-menu ' + (narrow ? 'sheet ' : '') + (pos?.below ? 'below' : 'above')}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-label={'طلبات استخدام «' + title + '»'}
      tabIndex={-1}
    >
      {!narrow && pos?.arrow != null && <i className="site-menu-arrow" style={{ left: pos.arrow }} aria-hidden="true" />}
      <div className="site-menu-head">
        <div>
          <b>{title}</b>
          <small>{subtitle}</small>
        </div>
        <button type="button" className="icon-button" onClick={() => onClose(true)} aria-label="إغلاق قائمة الموقع">
          ✕
        </button>
      </div>
      <p className={'site-menu-state ' + (state?.pill ?? '')}>
        <span aria-hidden="true">{state?.symbol ?? '?'}</span>
        <span>
          {state?.label ?? 'جارٍ تحديث الإتاحة'} <small>· {availability}</small>
        </span>
      </p>
      <SiteRequestActionList state={actions} onChoose={onChoose} autoFocus={keyboard} />
    </div>,
    document.body,
  );
}
