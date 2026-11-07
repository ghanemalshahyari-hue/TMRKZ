import { useState } from 'react';
import type { TerrainExtra } from '../api/types';
import { NumberField } from './NumberField';

export type ExtraUnit = { id: string; word: string; factor: number };

/**
 * «إضافة طبيعة الأرض تنطبق»: one value that raises a maximum on any ground that is not flat, an amount in the chosen unit
 * or a percentage. It is decided by the ground of the place the shape is going to. Stored as metres, m² or percent.
 */
export function TerrainExtraField({ on, extra, units, label, onChange }: {
  on: boolean;
  extra: TerrainExtra | null;
  units: ExtraUnit[];
  label: string;
  onChange: (on: boolean, extra: TerrainExtra | null) => void;
}) {
  const [unitId, setUnitId] = useState(units[0].id);
  const percent = extra?.kind === 'PERCENT';
  const unit = units.find((u) => u.id === unitId) ?? units[0];
  const shown = extra == null ? null : percent ? extra.value : extra.value / unit.factor;
  return (
    <>
      <label>
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked, e.target.checked ? extra ?? { kind: 'ABSOLUTE', value: 0 } : null)} /> إضافة طبيعة الأرض تنطبق
      </label>
      {on && (
        <>
          <label>
            تزيد الحد الأقصى
            <NumberField
              label={'مقدار إضافة طبيعة الأرض: ' + label}
              value={shown}
              placeholder="—"
              onChange={(v) => onChange(true, { kind: percent ? 'PERCENT' : 'ABSOLUTE', value: percent ? v ?? 0 : Math.round((v ?? 0) * unit.factor) })}
            />
          </label>
          <select
            aria-label={'وحدة إضافة طبيعة الأرض: ' + label}
            value={percent ? 'percent' : unit.id}
            onChange={(e) => {
              const id = e.target.value;
              if (id === 'percent') return onChange(true, { kind: 'PERCENT', value: shown ?? 0 });
              const next = units.find((u) => u.id === id)!;
              setUnitId(id);
              if (percent) onChange(true, { kind: 'ABSOLUTE', value: Math.round((shown ?? 0) * next.factor) });
            }}
          >
            {units.map((u) => <option key={u.id} value={u.id}>{u.word}</option>)}
            <option value="percent">٪ من الحد الأقصى</option>
          </select>
          <span className="muted">على أي أرض غير مستوية في المكان الجديد؛ الأرض المستوية بلا إضافة.</span>
        </>
      )}
    </>
  );
}
