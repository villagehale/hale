import { describe, expect, it } from 'vitest';
import {
  bothFreePollOptions,
  bothFreePrompt,
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
  it('uses the locked strings verbatim, and French is ASCII', async () => {
    const whoEn = await whoTakesPrompt('en', {
      kid: 'Maya',
      event: 'gymnastics',
      day: 'Fri',
      time: '15:00',
    });
    const whoFr = await whoTakesPrompt('fr', {
      kid: 'Maya',
      event: 'gymnastique',
      day: 'ven.',
      time: '15:00',
    });
    expect(whoEn).toBe("Who's taking Maya's gymnastics, Fri at 15:00?");
    expect(whoFr).toBe("Qui s'occupe de gymnastique pour Maya, ven. a 15:00?");
    const figureEn = (await whoTakesPollOptions('en', [{ userId: 'a', name: 'Sam' }], 'key'))?.at(
      -1,
    );
    const figureFr = (await whoTakesPollOptions('fr', [{ userId: 'a', name: 'Sam' }], 'key'))?.at(
      -1,
    );
    expect(figureEn).toMatchObject({ text: "We'll figure it out", choiceKind: 'figure_it_out' });
    expect(figureFr).toMatchObject({ text: 'On verra', choiceKind: 'figure_it_out' });
    const bothEn = await bothFreePrompt('en');
    const bothFr = await bothFreePrompt('fr');
    expect(bothEn).toBe('Which time works for both of you?');
    expect(bothFr).toBe('Quel creneau vous arrange tous les deux?');
    const noneEn = (
      await bothFreePollOptions(
        'en',
        [
          { label: 'Thu 15:00', startIso: 'a' },
          { label: 'Fri 16:00', startIso: 'b' },
        ],
        'key',
      )
    )?.at(-1)?.text;
    const noneFr = (
      await bothFreePollOptions(
        'fr',
        [
          { label: 'Thu 15:00', startIso: 'a' },
          { label: 'Fri 16:00', startIso: 'b' },
        ],
        'key',
      )
    )?.at(-1)?.text;
    expect(noneEn).toBe('None of these');
    expect(noneFr).toBe('Aucun de ceux-la');
    for (const line of [
      whoEn,
      whoFr,
      figureEn?.text,
      figureFr?.text,
      bothEn,
      bothFr,
      noneEn,
      noneFr,
    ]) {
      expect(isAscii(line ?? '')).toBe(true);
    }
  });

  it('builds who-takes and both-free options, and does not poll a single slot', async () => {
    const who = await whoTakesPollOptions(
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
      (await whoTakesPollOptions('fr', [{ userId: 'a', name: 'Sam' }], 'key'))?.map(
        (option) => option.text,
      ),
    ).toEqual(['Sam', 'On verra']);
    expect(await whoTakesPollOptions('en', [{ userId: 'a', name: '' }], 'key')).toBeNull();
    expect(
      await whoTakesPollOptions(
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
    const polled = await bothFreePollOptions('en', slots, 'both-free/2026-09-24');
    expect(polled?.map((option) => option.text)).toEqual([
      'Thu, Sep 24, 15:00',
      'Thu, Sep 24, 16:00',
      'Fri, Sep 25, 15:00',
      'None of these',
    ]);
    expect(polled?.at(-1)).toMatchObject({ choiceKind: 'none', choiceValue: null });
    expect(await bothFreePollOptions('en', slots.slice(0, 1), 'key')).toBeNull();
    expect((await bothFreePollOptions('fr', slots.slice(0, 2), 'key'))?.at(-1)).toMatchObject({
      text: 'Aucun de ceux-la',
      choiceKind: 'none',
    });
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

  it('still withholds a year-find poll until there are two titles', async () => {
    expect(await yearFindPollOptions('en', ['Only one'])).toBeNull();
    expect(await yearFindPollOptions('en', [])).toBeNull();
    const options = await yearFindPollOptions('en', ['Swim', 'Storytime']);
    expect(options?.slice(0, 2)).toEqual([{ text: 'Swim' }, { text: 'Storytime' }]);
    expect(options?.at(-1)).toMatchObject({ text: 'None of these', choiceKind: 'none' });
  });
});
