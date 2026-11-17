import { describe, expect, it } from 'vitest';
import { DEFAULT_BOARD, boardProblem, moveNote, newNote, visibleNotes } from './signInNotes';

describe('«إرشادات الدخول» kept in the settings (owner, 17 Nov 2026)', () => {
  it('starts from the three notes the sign-in page shows today', () => {
    expect(DEFAULT_BOARD.notes.map((n) => n.meta)).toEqual(['الدخول الآلي', 'الإدخال اليدوي', 'الصلاحيات والحماية']);
    expect(boardProblem(DEFAULT_BOARD)).toBe('');
  });

  it('shows what is not hidden and inside its dates, the important notices first', () => {
    const notice = { ...newNote('NOTICE'), title: 'صيانة', text: 'توقف مجدول', from: '2026-11-20', to: '2026-11-21' };
    const hidden = { ...newNote(), title: 'مخفي', text: 'نص', hidden: true };
    const notes = [...DEFAULT_BOARD.notes, notice, hidden];
    expect(visibleNotes(notes, '2026-11-17').map((n) => n.title)).toEqual(DEFAULT_BOARD.notes.map((n) => n.title));
    expect(visibleNotes(notes, '2026-11-20')[0].title).toBe('صيانة');
    expect(visibleNotes(notes, '2026-11-22').some((n) => n.title === 'صيانة')).toBe(false);
  });

  it('moves a note up or down, and nothing past either end', () => {
    const ids = (l: { id: string }[]) => l.map((n) => n.id).join(',');
    expect(ids(moveNote(DEFAULT_BOARD.notes, 'manual', -1))).toBe('manual,auto,rights');
    expect(ids(moveNote(DEFAULT_BOARD.notes, 'auto', -1))).toBe('auto,manual,rights');
    expect(ids(moveNote(DEFAULT_BOARD.notes, 'rights', 1))).toBe('auto,manual,rights');
  });

  it('refuses an empty note, a reversed date range and an empty heading', () => {
    expect(boardProblem({ ...DEFAULT_BOARD, notes: [...DEFAULT_BOARD.notes, newNote()] })).toContain('الإرشاد 4');
    expect(boardProblem({ ...DEFAULT_BOARD, notes: [{ ...DEFAULT_BOARD.notes[0], from: '2026-11-21', to: '2026-11-20' }] })).toContain('قبل البداية');
    expect(boardProblem({ ...DEFAULT_BOARD, heading: ' ' })).toContain('عنوان');
  });
});
