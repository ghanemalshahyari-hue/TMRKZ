import { describe, expect, it } from 'vitest';
import { addDays, dayLabel, dubaiISO, localDay, localInput, todayDubai } from './dates';

describe('date helpers (Asia/Dubai display, UTC storage)', () => {
  it('converts a Dubai calendar day to the UTC instant at local midnight', () => {
    expect(dubaiISO('2026-11-04')).toBe('2026-11-03T20:00:00.000Z');
  });

  it('converts a Dubai local time to UTC', () => {
    expect(dubaiISO('2026-11-02T09:00')).toBe('2026-11-02T05:00:00.000Z');
  });

  it('round-trips UTC back to Dubai local input values', () => {
    expect(localInput('2026-11-02T05:00:00.000Z')).toBe('2026-11-02T09:00');
    expect(localDay('2026-11-03T20:00:00Z')).toBe('2026-11-04');
  });

  it('treats a day end boundary as exclusive midnight', () => {
    // a 1–4 Nov booking ends at the start of 4 Nov in Dubai
    const end = dubaiISO('2026-11-04');
    expect(localInput(end)).toBe('2026-11-04T00:00');
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('computes the Dubai date even when UTC is still the previous day', () => {
    expect(todayDubai(new Date('2026-10-27T21:30:00Z'))).toBe('2026-10-28');
  });

  it('labels calendar days with a zero-padded day number', () => {
    expect(dayLabel('2026-11-03').startsWith('03 ')).toBe(true);
  });
});
