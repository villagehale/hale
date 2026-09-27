import { describe, expect, it } from 'vitest';
import {
  BOTH_FREE_NONE,
  BOTH_FREE_PROMPT,
  FIGURE_IT_OUT,
  WHO_TAKES_PROMPT,
  bothFreePollOptions,
  readSlotReply,
  readWhoTakesReply,
  whoTakesPollOptions,
  whoTakesPrompt,
} from './logistics-poll';
import { yearFindPollOptions } from './poll';

/**
 * Design locked (Sloane, 2026-09-26). French is ASCII. Year-find still needs two titles.
 */

function isAscii(line: string): boolean {
  return [...line].every((char) => char.charCodeAt(0) <= 127);
}

describe('logistics poll copy', () => {
  it('uses the locked strings verbatim, and French is ASCII', () => {
    expect(
      whoTakesPrompt('en', { kid: 'Maya', event: 'gymnastics', day: 'Fri', time: '15:00' }),
    ).toBe("Who's taking Maya's gymnastics, Fri at 15:00?");
    expect(
      whoTakesPrompt('fr', { kid: 'Maya', event: 'gymnastique', day: 'ven.', time: '15:00' }),
    ).toBe("Qui s'occupe de gymnastique pour Maya, ven. a 15:00?");
    expect(isAscii(WHO_TAKES_PROMPT.fr)).toBe(true);
    expect(FIGURE_IT_OUT).toEqual({ en: "We'll figure it out", fr: 'On verra' });
    expect(BOTH_FREE_PROMPT).toEqual({
      en: 'Which time works for both of you?',
      fr: 'Quel creneau vous arrange tous les deux?',
    });
    expect(BOTH_FREE_NONE).toEqual({ en: 'None of these', fr: 'Aucun de ceux-la' });
    for (const line of [
      WHO_TAKES_PROMPT.en,
      WHO_TAKES_PROMPT.fr,
      FIGURE_IT_OUT.en,
      FIGURE_IT_OUT.fr,
      BOTH_FREE_PROMPT.en,
      BOTH_FREE_PROMPT.fr,
      BOTH_FREE_NONE.en,
      BOTH_FREE_NONE.fr,
    ]) {
      expect(isAscii(line)).toBe(true);
    }
  });

  it('builds who-takes and both-free options, and does not poll a single slot', () => {
    const who = whoTakesPollOptions(
      'en',
      [
        { userId: 'a', name: 'Barton' },
        { userId: 'b', name: 'Sam' },
      ],
      'who-takes/start/title',
    );
    expect(who?.map((option) => option.text)).toEqual(['Barton', 'Sam', "We'll figure it out"]);
    expect(who?.[2]).toMatchObject({ choiceKind: 'figure_it_out', choiceValue: null });
    expect(
      whoTakesPollOptions('fr', [{ userId: 'a', name: 'Sam' }], 'key')?.map(
        (option) => option.text,
      ),
    ).toEqual(['Sam', 'On verra']);
    expect(whoTakesPollOptions('en', [{ userId: 'a', name: '' }], 'key')).toBeNull();
    expect(
      whoTakesPollOptions(
        'en',
        [
          { userId: 'a', name: 'Sam' },
          { userId: 'b', name: 'Sam' },
        ],
        'key',
      ),
    ).toBeNull();

    const slots = [
      { label: 'Thu, Sep 24, 15:00', startIso: '2026-09-24T19:00:00.000Z' },
      { label: 'Thu, Sep 24, 16:00', startIso: '2026-09-24T20:00:00.000Z' },
      { label: 'Fri, Sep 25, 15:00', startIso: '2026-09-25T19:00:00.000Z' },
      { label: 'Fri, Sep 25, 16:00', startIso: '2026-09-25T20:00:00.000Z' },
    ];
    const polled = bothFreePollOptions('en', slots, 'both-free/2026-09-24');
    expect(polled?.map((option) => option.text)).toEqual([
      'Thu, Sep 24, 15:00',
      'Thu, Sep 24, 16:00',
      'Fri, Sep 25, 15:00',
      'None of these',
    ]);
    expect(bothFreePollOptions('en', slots.slice(0, 1), 'key')).toBeNull();
    expect(bothFreePollOptions('fr', slots.slice(0, 2), 'key')?.at(-1)?.text).toBe(
      'Aucun de ceux-la',
    );
  });

  it('reads a clear taker or slot and ignores a question', () => {
    const parents = [
      { userId: 'a', name: 'Barton' },
      { userId: 'b', name: 'Sam' },
    ];
    expect(readWhoTakesReply("I'll take it", parents, 'b')).toEqual({ takerUserId: 'b' });
    expect(readWhoTakesReply('Sam will take Maya gymnastics', parents, 'a')).toEqual({
      takerUserId: 'b',
    });
    expect(readWhoTakesReply("We'll figure it out", parents, 'a')).toEqual({ declined: true });
    expect(readWhoTakesReply('On verra', parents, 'a')).toEqual({ declined: true });
    expect(readWhoTakesReply("Who's taking it?", parents, 'a')).toBeNull();
    const slots = [{ label: 'Thu, Sep 24, 15:00', startIso: '2026-09-24T19:00:00.000Z' }];
    expect(readSlotReply('Thu, Sep 24, 15:00', slots)).toEqual({ slot: slots[0] });
    expect(readSlotReply('None of these', slots)).toEqual({ declined: true });
    expect(readSlotReply('maybe Thursday?', slots)).toBeNull();
  });

  it('still withholds a year-find poll until there are two titles', () => {
    expect(yearFindPollOptions('en', ['Only one'])).toBeNull();
    expect(yearFindPollOptions('en', [])).toBeNull();
    expect(yearFindPollOptions('en', ['Swim', 'Storytime'])?.slice(0, 2)).toEqual([
      'Swim',
      'Storytime',
    ]);
  });
});
