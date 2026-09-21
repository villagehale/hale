import { describe, expect, it } from 'vitest';
import { voiceTells } from './coach-channel-voice-tells.mjs';

/**
 * The red pass for the register's four classes found NO fixture in the committed cache
 * that says any of it. That is a good corpus and a useless piece of evidence on its own:
 * a regex that never matches and a corpus that never offends produce the same run. So
 * every class below is fed the sentence it exists to catch, and every carve-out is fed
 * the sentence it must not catch.
 */
describe('the register tells', () => {
  it('catches Hale introducing itself as an assistant', () => {
    expect(voiceTells("I'm Hale, the assistant that keeps your family's week straight.")).toContain(
      'introduces itself as an assistant (the register is a friend, not a service)',
    );
  });

  it('catches the possessive positioning too', () => {
    expect(voiceTells('Your family assistant has the swim time.')).toContain(
      'positions Hale as an assistant',
    );
  });

  /** THE CARVE-OUT. A parent asking who is behind the number gets the true answer. */
  it('clears the honest answer on a doubt turn', () => {
    expect(voiceTells("Fair to ask. I'm an AI assistant, not a person. STOP ends these.")).toEqual(
      [],
    );
  });

  it('catches the account pointer', () => {
    expect(voiceTells('Your account has the full history.')).toContain(
      'sends the parent to an account they never opened',
    );
  });

  it('catches the settings pointer', () => {
    expect(voiceTells('You can turn that off in settings.')).toContain(
      'points at a settings screen from inside the thread',
    );
  });

  it('catches the opener frames', () => {
    expect(voiceTells("Here's an update on Thursday: swim moved to 4:30.")).toContain(
      'opens on a frame instead of the fact',
    );
    expect(voiceTells('Just letting you know swim moved to 4:30.')).toContain(
      'opens on a frame instead of the fact',
    );
  });

  it('still catches the let-me-know family it was written with', () => {
    expect(voiceTells('Swim is at 4:30. Let me know if that works.')).toContain(
      'ends on a generic "let me know"',
    );
  });

  /**
   * THE POSITIVE CONTROL for the corpus. Every one of these is a real reply shape the
   * eval passes today; a gate that flagged any of them would be a gate that makes the
   * corpus worse, and the empty red list above would have meant nothing.
   */
  it('clears the replies the corpus already passes', () => {
    for (const reply of [
      'Swim moved to Tue 4:30? YES to confirm.',
      "Thursday has swim at 4:30 and the dentist at 6. Want the dentist moved?",
      'Halton Hills fall registration opens Tue 7:00 a.m. Want me watching it?',
      'Ordering groceries is past what I can do.',
      "That's on your calendar for Saturday morning.",
    ]) {
      expect(voiceTells(reply)).toEqual([]);
    }
  });
});
