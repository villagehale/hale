import { describe, expect, it, vi } from 'vitest';
import { type RegistrationNoteFacts, noteRefusals, registrationNoteWriter } from './note-compose';

const NOW = { date: 'Monday, September 14, 2026', time: '6:00 p.m.' };
const CHECK_IN: RegistrationNoteFacts = {
  kind: 'check_in_ask',
  now: NOW,
  window: 'Springfield Fall 2026 swim lessons',
};
const CARD_LINK = 'https://example.org/register';
const CARD = {
  kind: 'approval_card',
  now: NOW,
  window: 'Springfield Fall 2026 swim lessons',
  opensOn: 'Tuesday, September 15, 2026',
  opensAt: '6:30 a.m.',
  link: CARD_LINK,
  residentsFirstDays: null,
  who: 'Max',
  ageBand: { published: false },
  texts: [{ text: 'evening_before' }],
  courseLinkTip: false,
} satisfies RegistrationNoteFacts;

describe('VIL-543 · noteRefusals', () => {
  it('refuses an empty draft', () => {
    expect(noteRefusals('  ', CHECK_IN)).toEqual(['empty']);
  });

  it('refuses any link on a note that was handed none', () => {
    expect(noteRefusals('How did it go? https://example.org/x', CHECK_IN)).toEqual(['other_link']);
  });

  it('passes the handed link on the card, and refuses any other', () => {
    expect(noteRefusals(`Opens Tuesday. Register here: ${CARD_LINK}`, CARD)).toEqual([]);
    expect(noteRefusals('Opens Tuesday: https://elsewhere.example.org', CARD)).toEqual([
      'other_link',
    ]);
  });

  it('passes a plain note', () => {
    expect(noteRefusals('How did Springfield swim go this morning?', CHECK_IN)).toEqual([]);
  });
});

describe('VIL-543 · registrationNoteWriter', () => {
  it('writes nothing and names the miss when no client is configured (rule #11)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const write = registrationNoteWriter(null);
      await expect(write({} as never, 'fam-1', CHECK_IN)).resolves.toBeNull();
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'registration_note_unwritten',
          reason: 'client_unavailable',
          kind: 'check_in_ask',
        }),
        expect.any(String),
      );
    } finally {
      error.mockRestore();
    }
  });
});
