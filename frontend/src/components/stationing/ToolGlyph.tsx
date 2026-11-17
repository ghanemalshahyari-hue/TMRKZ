/**
 * «أدوات الرسم والتحكم (مثل Word)» (owner brief §7, reference image panel 5): the toolbar's small drawings, one per tool.
 */
/** The toolbar's small drawings, as Word's shapes (reference image panel 5). */
export function ToolGlyph({ k }: { k: string }) {
  const c = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  const g: Record<string, React.ReactNode> = {
    select: <path {...c} d="M6 3l12 9-5.5 1.2L15 20l-2.4 1-2.6-6.6L6 18z" />,
    move: <path {...c} d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />,
    CIRCLE: <circle {...c} cx="12" cy="12" r="8" />,
    ELLIPSE: <ellipse {...c} cx="12" cy="12" rx="10" ry="6" />,
    SQUARE: <rect {...c} x="4.5" y="4.5" width="15" height="15" rx="1" />,
    RECTANGLE: <rect {...c} x="2.5" y="6.5" width="19" height="11" rx="1" />,
    draw: <path {...c} d="M4 18l4-11 6 4 6-7M4 18l16-2" />,
    COPY: <><rect {...c} x="3.5" y="7.5" width="11" height="11" rx="1" /><rect {...c} x="9.5" y="3.5" width="11" height="11" rx="1" strokeDasharray="2.5 2" /></>,
    vertices: <><path {...c} d="M5 17L8 6l10 3-2 9z" /><circle cx="5" cy="17" r="2" fill="currentColor" /><circle cx="8" cy="6" r="2" fill="currentColor" /><circle cx="18" cy="9" r="2" fill="currentColor" /><circle cx="16" cy="18" r="2" fill="currentColor" /></>,
    undo: <path {...c} d="M9 7L4 12l5 5M4 12h10a6 6 0 010 12" transform="translate(0 -3)" />,
    redo: <path {...c} d="M15 7l5 5-5 5M20 12H10a6 6 0 000 12" transform="translate(0 -3)" />,
    reset: <path {...c} d="M4 12a8 8 0 108-8M4 4v5h5" />,
    delete: <path {...c} d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
    pick: <><circle {...c} cx="12" cy="12" r="6" /><path {...c} d="M12 2v5M12 17v5M2 12h5M17 12h5" /></>,
  };
  return <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">{g[k]}</svg>;
}
