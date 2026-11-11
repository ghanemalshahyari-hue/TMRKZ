import { describe, expect, it } from 'vitest';
import { stampDate } from './ApprovalStamps';

// TNQL's stamps print the date and time in Arabic-Indic digits, UAE time (ADR-055)
describe('stamp date', () => {
  it('UTC 20:30 is the next day 00:30 in Dubai, in Arabic-Indic digits', () => {
    const { date, time } = stampDate('2026-11-10T20:30:00Z');
    expect(date).toMatch(/١١/);
    expect(date).toMatch(/٢٠٢٦/);
    expect(time).toMatch(/٠٠/);
    expect(time).toMatch(/٣٠/);
    expect(date + time).not.toMatch(/[0-9]/);
  });
});
