import { describe, expect, it } from 'vitest';
import { PARTY_GUEST_LINE_FIXTURES, partyGuestLineMisses } from './party-guest-line-fixtures.mjs';

const byId = (id) => PARTY_GUEST_LINE_FIXTURES.find((fixture) => fixture.id === id);

describe('party guest line eval fixtures', () => {
  it('covers both texts in English and in French, with unique ids', () => {
    const ids = PARTY_GUEST_LINE_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(['reminder-en', 'cancel-en', 'reminder-fr', 'cancel-fr']),
    );
  });

  it('passes a text that says who, what and why (positive control)', () => {
    expect(
      partyGuestLineMisses(
        "It's Hale, with the reminder you asked for: Nora's 5th birthday is tomorrow, Saturday, December 12 at 2:00 PM at 14 Elm St.",
        byId('reminder-en'),
      ),
    ).toEqual([]);
    expect(
      partyGuestLineMisses(
        "C'est Hale, avec le rappel demandé : l'anniversaire de Léa est demain, samedi 12 décembre à 14 h, au Parc Laurier, Montréal.",
        byId('reminder-fr'),
      ),
    ).toEqual([]);
  });

  it('scores a text that teaches a keyword as a miss', () => {
    const misses = partyGuestLineMisses(
      "It's Hale. You asked: Nora's 5th birthday is tomorrow at 2 PM at 14 Elm St. Reply STOP to opt out.",
      byId('reminder-en'),
    );
    expect(misses.some((miss) => miss.startsWith('forbidden:'))).toBe(true);
  });

  it('scores a changed time as an invented number', () => {
    expect(
      partyGuestLineMisses(
        "It's Hale. You asked: Nora's 5th birthday is tomorrow at 3 PM and 2 PM at 14 Elm St.",
        byId('reminder-en'),
      ),
    ).toEqual(['invented_number']);
  });

  it('scores an English reply to a French title as a miss', () => {
    const misses = partyGuestLineMisses(
      "It's Hale. Léa's party is tomorrow, Saturday at 2:00 PM at Parc Laurier, Montréal.",
      byId('reminder-fr'),
    );
    expect(misses).toContain('missing:demain');
  });
});
