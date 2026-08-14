import { describe, expect, it } from 'vitest';
import { clarifyWhichQuestion, whichOneReply } from './copy';

/**
 * THE DISAMBIGUATION, AFTER THE MENU WENT (2026-08-13).
 *
 * A menu is a fine interface and a terrible thing to receive as a text. What replaced it
 * still has to let a parent pick — including when the choices share a label, and including
 * when they are not all the same kind of thing.
 */
describe('whichOneReply', () => {
  it('names the choices in one sentence, with no ordinal and no menu', () => {
    expect(whichOneReply(['move swim to tuesday', 'the 18-month checkup'])).toBe(
      'Which one - move swim to tuesday or the 18-month checkup?',
    );
  });

  it('serially comma-joins three', () => {
    expect(whichOneReply(['a', 'b', 'c'])).toBe('Which one - a, b or c?');
  });

  it('discloses an overflow and points nowhere', () => {
    const reply = whichOneReply(['a', 'b', 'c', 'd', 'e']);
    expect(reply).toContain('2 more behind those');
    expect(reply).not.toMatch(/https?:|the app/i);
  });

  it('refuses to render a choice between nothing', () => {
    // Unreachable from both callers. It throws rather than texting "Which one - undefined?"
    // — a thrown turn is re-driven; a nonsense one is read by a person.
    expect(() => whichOneReply([])).toThrow(/nothing to choose/i);
  });
});

describe('clarifyWhichQuestion', () => {
  const q = (kind: string, subject: string) => ({ kind, subject });

  it('always represents every kind, so a crowded approvals queue cannot bury the rest', () => {
    // The defect this closes: three drafted calendar adds would fill the sentence and the
    // introduction the parent was actually answering would be sliced off the end.
    const reply = clarifyWhichQuestion([
      q('approval', 'add to your calendar (the first)'),
      q('approval', 'add to your calendar (the second)'),
      q('approval', 'add to your calendar (the third)'),
      q('intro_proposal', 'meeting the family nearby'),
    ]);

    expect(reply).toContain('meeting the family nearby');
    expect(reply).toContain('add to your calendar (the first)');
    expect(reply).toContain('and 1 other');
  });

  it('names BOTH of two drafted changes - one per kind would drop the second', () => {
    expect(
      clarifyWhichQuestion([
        q('approval', 'move swim to tuesday'),
        q('approval', 'the 18-month checkup'),
      ]),
    ).toBe('Which one - move swim to tuesday or the 18-month checkup?');
  });

  it('never claims the rest are "behind those" - nothing queues behind an introduction', () => {
    const reply = clarifyWhichQuestion([
      q('approval', 'a'),
      q('approval', 'b'),
      q('approval', 'c'),
      q('approval', 'd'),
      q('plan_offer', 'the plan I offered'),
    ]);
    expect(reply).not.toMatch(/behind those/);
    // Honest about what it left out, and pointing nowhere.
    expect(reply).toContain('and 2 others');
    expect(reply).toContain('the plan I offered');
  });
});
