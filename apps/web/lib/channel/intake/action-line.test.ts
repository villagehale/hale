import { describe, expect, it } from 'vitest';
import { isGsm7, isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import { type ActionMove, renderActionLine } from './action-line.js';
import type { RadarDecision } from './radar-decide.js';

/**
 * The one deterministic line the shell appends under the radar message.
 *
 * Expected strings are the approved copy table, written out here rather than derived
 * from the module: a test that builds its expectation the same way the code does proves
 * only that the code is self-consistent.
 */

const MUNICIPAL_URL = 'https://www.toronto.ca/example/fall-2026';
const VENUE_URL = 'https://www.torontopubliclibrary.ca/events/abc';

const NOTHING: RadarDecision = {
  weekendPick: null,
  registrationLine: null,
  registrationAbsence: null,
  checkpoint: null,
  offerQuestion: true,
  followUpNeeded: true,
};

function pick(over: Partial<NonNullable<RadarDecision['weekendPick']>> = {}): RadarDecision {
  return {
    ...NOTHING,
    weekendPick: {
      candidateRef: { id: 'c1', title: 'Family Storytime', venueName: 'Armour Heights' },
      day: 'saturday',
      kidNames: ['Maya'],
      whyFacts: ['free', 'indoor'],
      access: 'drop_in',
      when: '9:30 a.m.-11:00 a.m.',
      verifiedUrl: VENUE_URL,
      ...over,
    },
  };
}

function upcoming(previewUp: boolean): RadarDecision {
  return {
    ...NOTHING,
    registrationLine: {
      windowRef: { municipality: 'toronto', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
      opensAtLocal: 'Sep 15, 7:00 a.m.',
      kidNames: ['Maya'],
      residentNote: null,
      ageApproximate: false,
      registerUrl: MUNICIPAL_URL,
      previewUp,
    },
  };
}

function stillOpen(registerUrl = MUNICIPAL_URL): RadarDecision {
  return {
    ...NOTHING,
    registrationAbsence: {
      cycleRef: { municipality: 'toronto', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
      lastOpenedAtLocal: 'Sep 15, 7:00 a.m.',
      nextCycleLabel: 'Winter 2027',
      stillOpen: { registerUrl, kidNames: ['Maya'] },
    },
  };
}

describe('renderActionLine — the copy, move by move', () => {
  const cases: Array<{ move: ActionMove; decision: RadarDecision; en: string; fr: string }> = [
    {
      move: 'register_open',
      decision: stillOpen(),
      en: `The page is here: ${MUNICIPAL_URL}`,
      fr: `La page est ici : ${MUNICIPAL_URL}`,
    },
    {
      move: 'register_later_preview',
      decision: upcoming(true),
      en: `The listings are up already if you want a look: ${MUNICIPAL_URL}`,
      fr: `Les programmes sont deja en ligne si vous voulez voir : ${MUNICIPAL_URL}`,
    },
    {
      move: 'register_later',
      decision: upcoming(false),
      en: `Here's the page: ${MUNICIPAL_URL}`,
      fr: `Voici la page : ${MUNICIPAL_URL}`,
    },
    {
      move: 'sign_up',
      decision: pick({ access: 'register_at_venue' }),
      en: `Sign-up needed for this one: ${VENUE_URL}`,
      fr: `Il faut s'inscrire pour celle-la : ${VENUE_URL}`,
    },
    {
      move: 'just_go',
      decision: pick(),
      en: `No sign-up needed, 9:30 a.m.-11:00 a.m.: ${VENUE_URL}`,
      fr: `Pas d'inscription, 9:30 a.m.-11:00 a.m. : ${VENUE_URL}`,
    },
  ];

  for (const { move, decision, en, fr } of cases) {
    it(`writes the ${move} line in both languages`, () => {
      expect(renderActionLine(decision, 'en')).toEqual({ line: en, url: expect.any(String), move });
      expect(renderActionLine(decision, 'fr')).toEqual({ line: fr, url: expect.any(String), move });
    });
  }

  it('is billable as GSM-7 in every move and both languages, or the whole SMS doubles', () => {
    for (const { decision } of cases) {
      for (const language of ['en', 'fr'] as const) {
        const rendered = renderActionLine(decision, language);
        if (rendered.line === null) throw new Error('every case above emits a line');
        expect(isGsm7(rendered.line)).toBe(true);
        // The half Hale wrote is stricter still: no newline opens a second line under
        // its name, and no escape-table character costs two septets.
        expect(isPrintableGsm7Basic(rendered.line.replace(rendered.url, ''))).toBe(true);
      }
    }
  });

  it('drops the time clause rather than printing an empty one', () => {
    expect(renderActionLine(pick({ when: null }), 'en')).toEqual({
      line: `No sign-up needed: ${VENUE_URL}`,
      url: VENUE_URL,
      move: 'just_go',
    });
  });
});

describe('renderActionLine — what it refuses, and why', () => {
  it('holds when nothing in the decision implies a move at all', () => {
    expect(renderActionLine(NOTHING, 'en')).toEqual({ line: null, held: 'no_move' });
  });

  /** R4 — a guess here sends a family to a door that turns them away. */
  it('holds a pick whose access nobody recorded', () => {
    expect(renderActionLine(pick({ access: 'unknown' }), 'en')).toEqual({
      line: null,
      held: 'access_unknown',
    });
  });

  it('holds a pick that carries no page', () => {
    expect(renderActionLine(pick({ verifiedUrl: null }), 'en')).toEqual({
      line: null,
      held: 'no_url',
    });
  });

  /**
   * THE SUBJECT OF THE LINE HAS TO BE IN THE MESSAGE.
   *
   * A tail costs a block (R8a) and R10 decides which block survives it: whenever this
   * family's town has a past cycle, the town sentence is the one that stays. So a
   * `just_go` / `sign_up` line under that sentence is a receipt for a thing the message
   * never names - "No sign-up needed, 9:30 a.m.-11:00 a.m.: <url>" directly beneath an
   * apology about the season having gone, with the pick nowhere in sight.
   *
   * The registration moves do not have this problem and must not be held by it: their
   * subject IS the sentence that survives.
   */
  it('holds a pick move when the town sentence takes the block the pick would have had', () => {
    const betweenCycles: RadarDecision = {
      ...pick(),
      registrationAbsence: { ...stillOpen().registrationAbsence!, stillOpen: null },
    };
    expect(renderActionLine(betweenCycles, 'en')).toEqual({ line: null, held: 'pick_displaced' });
    expect(
      renderActionLine({ ...betweenCycles, weekendPick: pick({ access: 'register_at_venue' }).weekendPick }, 'en'),
    ).toEqual({ line: null, held: 'pick_displaced' });
  });

  /** The positive control the hold above cannot do without: the SAME pick, in a town
   *  with no past cycle, still rides. Without it the rule could hold every pick move
   *  and this file would not notice. */
  it('still sends the pick page when no town sentence is competing for the block', () => {
    expect(renderActionLine(pick(), 'en')).toEqual({
      line: `No sign-up needed, 9:30 a.m.-11:00 a.m.: ${VENUE_URL}`,
      url: VENUE_URL,
      move: 'just_go',
    });
  });

  /**
   * R5, with the positive control it cannot do without. Every seeded URL is printable
   * GSM-7 basic today, so an absence test here would pass on a renderer that emitted
   * nothing at all — the control is an ASCII URL of the SAME LENGTH, which must be
   * emitted whole.
   *
   * The offending character is `ê` and NOT `é`, which is the trap: `é`, `è`, `à`, `ù`,
   * `ì` and `ò` are all IN the GSM-7 basic alphabet and a url carrying one is perfectly
   * sendable. Only the characters outside it — `ê`, `î`, lowercase `ç`, `œ` — are the
   * ones worth holding a link over, and an "accented url" test written the obvious way
   * asserts the opposite of the truth.
   */
  it('holds a url outside the printable basic alphabet, and never folds it', () => {
    const accented = 'https://www.ville.qc.ca/fête/automne';
    const ascii = 'https://www.ville.qc.ca/fete/automne';
    expect(accented.length).toBe(ascii.length);

    expect(renderActionLine(stillOpen(accented), 'en')).toEqual({ line: null, held: 'not_gsm7' });

    const control = renderActionLine(stillOpen(ascii), 'en');
    expect(control.line).toBe(`The page is here: ${ascii}`);
    // …and the held one was not folded into a different, working-looking address.
    expect(JSON.stringify(renderActionLine(stillOpen(accented), 'en'))).not.toContain('fete');
  });

  /** The companion half of the same rule, stated positively: a url whose accents ARE in
   * the basic alphabet is sent WHOLE, never folded down to look tidier. */
  it('sends an accented url the alphabet does carry, unchanged', () => {
    const inAlphabet = 'https://www.ville.qc.ca/activités/automne';
    expect(renderActionLine(stillOpen(inAlphabet), 'en')).toEqual({
      line: `The page is here: ${inAlphabet}`,
      url: inAlphabet,
      move: 'register_open',
    });
  });
});

/**
 * R2 — ONE Hale-chosen URL per message. Two links plus the privacy URL in a stranger's
 * first text is the shape carrier filtering is tuned for, and a parent handed two pages
 * has been handed a decision rather than a next step.
 */
describe('renderActionLine — one url, chosen by the cascade', () => {
  const both: RadarDecision = {
    ...stillOpen(),
    weekendPick: pick({ access: 'register_at_venue' }).weekendPick,
  };

  it('sends the registration page, not the venue, when the decision carries both', () => {
    const rendered = renderActionLine(both, 'en');
    expect(rendered.line).toBe(`The page is here: ${MUNICIPAL_URL}`);
    expect(rendered.line).not.toContain(VENUE_URL);
  });

  it('emits exactly one http token in every shape it speaks in', () => {
    const shapes = [stillOpen(), upcoming(true), upcoming(false), pick(), both];
    for (const decision of shapes) {
      const rendered = renderActionLine(decision, 'en');
      if (rendered.line === null) throw new Error('every shape above emits a line');
      expect(rendered.line.match(/https?:\/\//g)).toHaveLength(1);
    }
  });

  /** R9 — no action line is a promise. The ledger has no row for one made here. */
  it('promises nothing in any move or language', () => {
    const shapes = [stillOpen(), upcoming(true), upcoming(false), pick(), pick({ access: 'register_at_venue' })];
    for (const decision of shapes) {
      for (const language of ['en', 'fr'] as const) {
        const rendered = renderActionLine(decision, language);
        if (rendered.line === null) throw new Error('every shape above emits a line');
        const lower = rendered.line.toLowerCase();
        for (const promise of ["i'll text", "i'll watch", "i'll keep", 'je vais', 'je vous']) {
          expect(lower).not.toContain(promise);
        }
        // R7: Hale has not read the page, so it says nothing about what is left on it.
        for (const claim of ['spots', 'still room', 'fills', 'hurry', 'places restantes']) {
          expect(lower).not.toContain(claim);
        }
      }
    }
  });
});
