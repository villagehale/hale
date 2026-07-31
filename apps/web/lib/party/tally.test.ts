import { describe, expect, it } from 'vitest';
import { renderTally, tallyRsvps } from './tally';

/**
 * VIL-245 · M10 — "who's coming?" has exactly one right answer, and getting it wrong
 * costs a real household real money (cake, loot bags, a booked room). The expectations
 * below are derived from what a host is actually asking: how many PEOPLE will be in the
 * room, not how many links were clicked.
 */

const guest = (
  displayName: string,
  response: 'yes' | 'no' | 'maybe',
  headcount = 1,
): { displayName: string; response: 'yes' | 'no' | 'maybe'; headcount: number } => ({
  displayName,
  response,
  headcount,
});

describe('tallyRsvps', () => {
  it('counts HEADS for yes, not replies — a family of four is four people', () => {
    const tally = tallyRsvps([guest('Priya', 'yes', 4), guest('Sam', 'yes', 2)]);
    expect(tally.yesGuests).toBe(2);
    expect(tally.yesHeads).toBe(6);
  });

  it('keeps maybe separate from both yes and no', () => {
    const tally = tallyRsvps([guest('A', 'yes', 2), guest('B', 'maybe', 3), guest('C', 'no')]);
    expect(tally.yesHeads).toBe(2);
    expect(tally.maybeHeads).toBe(3);
    expect(tally.noGuests).toBe(1);
    // A "no" contributes no heads to any total — that is the whole point of asking.
    expect(tally.yesHeads + tally.maybeHeads).toBe(5);
  });

  it('is empty, not broken, when nobody has answered yet', () => {
    const tally = tallyRsvps([]);
    expect(tally).toEqual({
      yesGuests: 0,
      yesHeads: 0,
      maybeGuests: 0,
      maybeHeads: 0,
      noGuests: 0,
      names: [],
    });
  });

  it('lists the names of everyone coming or maybe, in reply order, and no one else', () => {
    const tally = tallyRsvps([
      guest('Priya', 'yes'),
      guest('Dev', 'no'),
      guest('Sam', 'maybe'),
      guest('Rae', 'yes'),
    ]);
    expect(tally.names).toEqual(['Priya', 'Sam', 'Rae']);
  });
});

describe('renderTally', () => {
  it('reports heads and guest counts, and names who is coming', () => {
    const line = renderTally(tallyRsvps([guest('Priya', 'yes', 4), guest('Sam', 'maybe', 2)]));
    expect(line).toContain('4 coming');
    expect(line).toContain('2 maybe');
    expect(line).toContain('Priya');
    expect(line).toContain('Sam');
  });

  it('says so plainly when nobody has replied — never a bare "0"', () => {
    expect(renderTally(tallyRsvps([]))).toBe('No RSVPs yet.');
  });

  it('omits the maybe clause entirely when there are none', () => {
    const line = renderTally(tallyRsvps([guest('Priya', 'yes', 3)]));
    expect(line).toContain('3 coming');
    expect(line).not.toContain('maybe');
  });
});
