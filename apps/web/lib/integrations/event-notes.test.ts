import { describe, expect, it } from 'vitest';
import { extractEventNotes, sameEventNotes } from './event-notes';

describe('extractEventNotes', () => {
  it('reads labelled parking and what-to-bring lines', () => {
    expect(
      extractEventNotes(
        'Practice for U9.\nParking: Lot B behind the rink\nWhat to bring: skates, helmet, water bottle',
      ),
    ).toEqual({ parking: 'Lot B behind the rink', bring: 'skates, helmet, water bottle' });
  });

  it('handles Google HTML descriptions and bullets', () => {
    expect(
      extractEventNotes(
        '<p>Welcome!</p><ul><li>Parking info - street parking on Elm &amp; 3rd</li><li>Bring: a towel</li></ul>',
      ),
    ).toEqual({ parking: 'street parking on Elm & 3rd', bring: 'a towel' });
  });

  it('never infers from prose: no label, no fact', () => {
    expect(
      extractEventNotes('There is lots of parking nearby, bring snacks if you like.'),
    ).toBeNull();
    expect(extractEventNotes('')).toBeNull();
    expect(extractEventNotes(null)).toBeNull();
    expect(extractEventNotes('Parking:   ')).toBeNull();
  });

  it('keeps only the parking fact when bring is absent, and the first of each label', () => {
    expect(extractEventNotes('Parking: P1\nParking: P2')).toEqual({ parking: 'P1' });
  });

  it('caps a runaway value', () => {
    const notes = extractEventNotes(`Bring: ${'x'.repeat(400)}`);
    expect(notes?.bring?.length).toBe(160);
    expect(notes?.bring?.endsWith('…')).toBe(true);
  });
});

describe('sameEventNotes', () => {
  it('treats null and empty as the same and compares each key', () => {
    expect(sameEventNotes(null, undefined)).toBe(true);
    expect(sameEventNotes({ parking: 'A' }, { parking: 'A' })).toBe(true);
    expect(sameEventNotes({ parking: 'A' }, { parking: 'B' })).toBe(false);
    expect(sameEventNotes({ bring: 'A' }, null)).toBe(false);
  });
});
