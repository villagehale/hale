import { describe, expect, it } from 'vitest';
import { clarifyWhichQuestion, whichOneReply } from './copy';

/**
 * THE DISAMBIGUATION, WITH BOTH WAYS TO ANSWER IT (VIL-304).
 *
 * The menu came back — the numbers, not the form. What the 2026-08-13 rewrite got right
 * is untouched: the choices are NAMED, and "the swim one" is a real answer. What it
 * removed by accident was the cheap answer, and what nobody noticed for eleven days is
 * that neither answer was actually being READ, because no row anywhere said these options
 * had been offered. So the sentence now offers both and hands back the list it printed, in
 * print order, for the caller to mint against the message that carries it.
 */
describe('whichOneReply', () => {
  it('numbers the choices AND invites the parents own words', () => {
    expect(whichOneReply(['move swim to tuesday', 'the 18-month checkup'], true)).toBe(
      'Which one - 1) move swim to tuesday, 2) the 18-month checkup? Reply 1 or 2, or just say which.',
    );
  });

  it('serially comma-joins the numbers it offers', () => {
    expect(whichOneReply(['a', 'b', 'c'], true)).toBe(
      'Which one - 1) a, 2) b, 3) c? Reply 1, 2 or 3, or just say which.',
    );
  });

  it('never makes the number the only way in', () => {
    // The 2026-08-13 principle, kept: a parent who answers in words is understood, and the
    // sentence says so rather than handing out a grammar to learn.
    expect(whichOneReply(['a', 'b'], true)).toContain('or just say which');
  });

  it('discloses an overflow and points nowhere', () => {
    const reply = whichOneReply(['a', 'b', 'c', 'd', 'e'], true);
    expect(reply).toContain('2 more behind those');
    expect(reply).not.toMatch(/https?:|the app/i);
  });

  it('promises no numbers when no menu is going to exist', () => {
    // The row is only minted when the polarity could be read for free. Without one,
    // "Reply 1 or 2" invites a digit that nothing is standing behind — and the approvals
    // queue's own ordering is what would answer it (verifier, 2026-08-26). The sentence
    // still asks, still by name.
    expect(whichOneReply(['move swim to tuesday', 'the 18-month checkup'], false)).toBe(
      'Which one - move swim to tuesday or the 18-month checkup?',
    );
    expect(whichOneReply(['a', 'b', 'c'], false)).toBe('Which one - a, b or c?');
    // The overflow is still disclosed and still points nowhere.
    expect(whichOneReply(['a', 'b', 'c', 'd', 'e'], false)).toContain('2 more behind those');
  });

  it('refuses to render a choice between nothing', () => {
    // Unreachable from both callers. It throws rather than texting "Which one - undefined?"
    // — a thrown turn is re-driven; a nonsense one is read by a person.
    expect(() => whichOneReply([], true)).toThrow(/nothing to choose/i);
  });
});

describe('clarifyWhichQuestion', () => {
  const q = (kind: string, subject: string) => ({ kind, subject });

  it('always represents every kind, so a crowded approvals queue cannot bury the rest', () => {
    // The defect this closes: three drafted calendar adds would fill the sentence and the
    // introduction the parent was actually answering would be sliced off the end.
    const { reply } = clarifyWhichQuestion(
      [
        q('approval', 'add to your calendar (the first)'),
        q('approval', 'add to your calendar (the second)'),
        q('approval', 'add to your calendar (the third)'),
        q('intro_proposal', 'meeting the family nearby'),
      ],
      true,
    );

    expect(reply).toContain('meeting the family nearby');
    expect(reply).toContain('add to your calendar (the first)');
    expect(reply).toContain('and 1 other');
  });

  it('hands back exactly the options it printed, in printed order', () => {
    // The mint reads this list and the parent reads that sentence, so an ordinal only
    // means anything if the two are the same list. One call, one array — see copy.ts.
    const intro = q('intro_proposal', 'meeting the family nearby');
    const first = q('approval', 'add to your calendar (the first)');
    const second = q('approval', 'add to your calendar (the second)');
    const { reply, shown } = clarifyWhichQuestion([first, second, intro], true);

    expect(shown).toEqual([first, intro, second]);
    expect(reply).toBe(
      'Which one - 1) add to your calendar (the first), 2) meeting the family nearby, 3) add to your calendar (the second)? Reply 1, 2 or 3, or just say which.',
    );
  });

  it('names BOTH of two drafted changes - one per kind would drop the second', () => {
    expect(
      clarifyWhichQuestion(
        [q('approval', 'move swim to tuesday'), q('approval', 'the 18-month checkup')],
        true,
      ).reply,
    ).toBe(
      'Which one - 1) move swim to tuesday, 2) the 18-month checkup? Reply 1 or 2, or just say which.',
    );
  });

  it('never claims the rest are "behind those" - nothing queues behind an introduction', () => {
    const { reply } = clarifyWhichQuestion(
      [
        q('approval', 'a'),
        q('approval', 'b'),
        q('approval', 'c'),
        q('approval', 'd'),
        q('plan_offer', 'the plan I offered'),
      ],
      true,
    );
    expect(reply).not.toMatch(/behind those/);
    // Honest about what it left out, and pointing nowhere.
    expect(reply).toContain('and 2 others');
    expect(reply).toContain('the plan I offered');
  });
});
