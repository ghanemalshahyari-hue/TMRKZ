import { useEffect, useState } from 'react';

/** Arabic-Indic and Persian digits and the Arabic decimal mark as a person may type them, as plain digits and a point. */
export function cleanNumberText(s: string): string {
  const latin = s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, '.')
    .replace(/[^0-9.]/g, '');
  const dot = latin.indexOf('.');
  return dot < 0 ? latin : latin.slice(0, dot + 1) + latin.slice(dot + 1).replace(/\./g, '');
}

export const parseNumberText = (t: string): number | null => (t === '' || t === '.' ? null : Number(t));

/**
 * A number a person can really type: the field can be emptied (a number input snaps back to the value it is given),
 * takes Arabic digits from an Arabic keyboard, and selects its content on focus so typing replaces it.
 */
export function NumberField({ value, onChange, placeholder, disabled, label }: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
}) {
  const shown = (v: number | null) => (v == null ? '' : String(v));
  const [text, setText] = useState(shown(value));
  // a value from outside (a file imported, a version loaded); an emptied field stays empty while its value reads as 0
  useEffect(() => {
    if ((parseNumberText(text) ?? 0) !== (value ?? 0)) setText(shown(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      inputMode="decimal"
      dir="ltr"
      aria-label={label}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const t = cleanNumberText(e.target.value);
        setText(t);
        onChange(parseNumberText(t));
      }}
    />
  );
}
