import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RadarDecision } from './radar-decide.js';
import { radarFactSlots, radarVoiceContext, townLabel } from './radar-voice.js';

/**
 * The COMPOSE stage's pure seam. The model writes only the WORDS — every fact is
 * injected — so what is proved here is the contract that makes that safe:
 *
 *   - the context handed to the model carries the decision's facts and NOTHING else
 *     (no candidate uuid, no internal follow-up flag);
 *   - a model message that invents a fact, re-asks the watch question the shell is
 *     about to append, or blows the segment budget is REJECTED, and the deterministic
 *     render — which is grounded by construction — goes out instead;
 *   - the deterministic render is honest in every degraded shape (no pick, no window,
 *     neither).
 */

const PICK_ONLY: RadarDecision = {
  weekendPick: {
    candidateRef: {
      id: 'cand-uuid-1',
      title: 'Riverdale Farm drop-in',
      venueName: 'Riverdale Farm',
    },
    day: 'saturday',
    kidNames: ['Maya', 'Leo'],
    whyFacts: ['free', 'outdoor', 'the forecast looks dry'],
    access: 'unknown',
    when: null,
    verifiedUrl: null,
  },
  registrationLine: null,
  registrationAbsence: null,
  checkpoint: null,
  offerQuestion: true,
  followUpNeeded: false,
};

const BOTH: RadarDecision = {
  ...PICK_ONLY,
  registrationLine: {
    windowRef: { municipality: 'markham', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
    opensAtLocal: 'Aug 11, 6:30 a.m.',
    kidNames: ['Maya'],
    residentNote: 'residents can register first',
    ageApproximate: false,
    registerUrl: 'https://www.markham.ca/example',
    previewUp: false,
  },
};

const NOTHING: RadarDecision = {
  weekendPick: null,
  registrationLine: null,
  registrationAbsence: null,
  checkpoint: null,
  offerQuestion: true,
  followUpNeeded: true,
};

/** Geography empty, age never is: the third rung, alone. */
const CHECKPOINT_ONLY: RadarDecision = {
  ...NOTHING,
  checkpoint: {
    checkpointRef: { id: 'well_baby_18_months' },
    ref: 'well_baby_18_months:kid-1:0',
    task: 'Ontario runs a longer 18-month well-baby visit with your family doctor.',
    kidNames: ['Maya'],
  },
};

const ALL_THREE: RadarDecision = { ...BOTH, checkpoint: CHECKPOINT_ONLY.checkpoint };

/** The 2026-09-16 shape: the town's fall cycle has gone and winter is not posted. */
const BETWEEN_CYCLES: RadarDecision = {
  ...NOTHING,
  registrationAbsence: {
    cycleRef: {
      municipality: 'halton_hills',
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026',
    },
    lastOpenedAtLocal: 'Sep 1, 7:00 a.m.',
    nextCycleLabel: 'Winter 2027',
    stillOpen: null,
  },
};

/** The same, with a weekend pick above it and no cycle named to wait for. */
const PICK_BETWEEN_CYCLES: RadarDecision = {
  ...PICK_ONLY,
  registrationAbsence: {
    cycleRef: { municipality: 'toronto', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
    lastOpenedAtLocal: 'Sep 8, 7:00 a.m.',
    nextCycleLabel: null,
    stillOpen: null,
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('radarVoiceContext', () => {
  it('hands the model the decision facts and no internal identifiers', () => {
    const context = JSON.stringify(radarVoiceContext(BOTH));
    expect(context).toContain('Riverdale Farm drop-in');
    expect(context).toContain('Aug 11, 6:30 a.m.');
    expect(context).not.toContain('cand-uuid-1');
    expect(context).not.toContain('followUpNeeded');
  });

  it('marks the absent blocks as absent rather than omitting them silently', () => {
    const context = radarVoiceContext(NOTHING) as Record<string, unknown>;
    expect(context.weekendPick).toBeNull();
    expect(context.registration).toBeNull();
    expect(context.checkpoint).toBeNull();
    expect(context.offerQuestion).toBe(true);
  });

  it('hands over the forward promise as a FACT, and only when there is nothing else', () => {
    // The 48h sweep is real, but the model cannot know that — a promise it writes from
    // its own head is a fabrication the fact lint has no slot to check. So it is
    // injected, exactly like a venue or an opening time, and only in the one shape it
    // is true of.
    const empty = radarVoiceContext(NOTHING) as Record<string, unknown>;
    expect(empty.firstFindBeat).toBe('Your first weekend find lands in a day or two.');
    expect(radarFactSlots(NOTHING)).toContain('Your first weekend find lands in a day or two.');

    for (const decision of [PICK_ONLY, BOTH, CHECKPOINT_ONLY, ALL_THREE]) {
      expect((radarVoiceContext(decision) as Record<string, unknown>).firstFindBeat).toBeNull();
    }
  });

  it('hands over the checkpoint as words and names — never the row id', () => {
    const context = radarVoiceContext(CHECKPOINT_ONLY) as { checkpoint: Record<string, unknown> };
    expect(context.checkpoint.task).toBe(
      'Ontario runs a longer 18-month well-baby visit with your family doctor.',
    );
    expect(context.checkpoint.kidNames).toEqual(['Maya']);
    expect(JSON.stringify(context)).not.toContain('well_baby_18_months');
  });
});

describe('radarFactSlots', () => {
  it('lists every renderable fact, so the lint can ground the voice against them', () => {
    const slots = radarFactSlots(BOTH);
    expect(slots).toContain('Riverdale Farm drop-in');
    expect(slots).toContain('Aug 11, 6:30 a.m.');
    expect(slots).toContain('Maya');
  });

  it('grounds the checkpoint too, so its words can be reused but not extended', () => {
    expect(radarFactSlots(CHECKPOINT_ONLY)).toContain(
      'Ontario runs a longer 18-month well-baby visit with your family doctor.',
    );
  });

  it('carries only the forward promise when there is nothing else to say', () => {
    expect(radarFactSlots(NOTHING)).toEqual(['Your first weekend find lands in a day or two.']);
  });
});

describe('townLabel', () => {
  it('opens a multi-word token out into the town a parent recognises', () => {
    expect(townLabel('richmond_hill')).toBe('Richmond Hill');
    expect(townLabel('halton_hills')).toBe('Halton Hills');
    expect(townLabel('toronto')).toBe('Toronto');
  });

  it('derives the five York towns without an exception entry', () => {
    // The exceptions map is for towns whose token does NOT open out. None of these
    // qualify, and an entry for one would be a second place a town can be spelled.
    expect(townLabel('newmarket')).toBe('Newmarket');
    expect(townLabel('king')).toBe('King');
    expect(townLabel('east_gwillimbury')).toBe('East Gwillimbury');
    expect(townLabel('georgina')).toBe('Georgina');
    expect(townLabel('uxbridge')).toBe('Uxbridge');
  });

  it('says Stouffville, the name the Town prints on its own Play Book cover', () => {
    // Title-casing the token gives "Whitchurch Stouffville", which is neither the
    // legal name (hyphenated) nor what a parent in L4A ever says.
    expect(townLabel('whitchurch_stouffville')).toBe('Stouffville');
  });
});

describe('the between-cycles absence', () => {
  it('reaches the model as facts it may say, town included', () => {
    const context = JSON.stringify(radarVoiceContext(BETWEEN_CYCLES));
    expect(context).toContain('Halton Hills');
    expect(context).toContain('Fall 2026');
    expect(context).toContain('Sep 1, 7:00 a.m.');
    expect(context).toContain('Winter 2027');
  });

  it('is a fact slot, so a message that says the town is not treated as inventing it', () => {
    const slots = radarFactSlots(BETWEEN_CYCLES);
    expect(slots).toContain('Halton Hills');
    expect(slots).toContain('Fall 2026');
    expect(slots).toContain('Sep 1, 7:00 a.m.');
    expect(slots).toContain('Winter 2027');
  });

  it('offers no next cycle when the decision named none', () => {
    expect(radarFactSlots(PICK_BETWEEN_CYCLES)).not.toContain('Winter 2027');
  });

  const STILL_OPEN: RadarDecision = {
    ...NOTHING,
    registrationAbsence: {
      cycleRef: { municipality: 'toronto', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
      lastOpenedAtLocal: 'Sep 15, 7:00 a.m.',
      nextCycleLabel: 'Winter 2027',
      stillOpen: {
        registerUrl:
          'https://www.toronto.ca/news/city-of-toronto-releases-listings-for-fall-recreation-activities/',
        kidNames: ['Maya'],
      },
    },
  };

  /** R7 — Hale has never read the page, so it may never speak about what is left on it. */

  /**
   * R3 — whatever the composer is eventually told about the tense, the LINK is not part
   * of it. The model writes words; the shell writes the one URL, and the fact lint is
   * what makes that a guarantee rather than an intention.
   */
  it('never puts the page in front of the model, in the context or in the slots', () => {
    expect(JSON.stringify(radarVoiceContext(STILL_OPEN))).not.toContain('http');
    expect(radarFactSlots(STILL_OPEN).join(' ')).not.toContain('http');
  });

  /**
   * B1 — the MODEL is told the tense, or its sentence contradicts the line underneath.
   *
   * Without this key the composer is handed a byte-identical context in both tenses,
   * and the skill's instruction for a bare `registrationAbsence` is verbatim the
   * missed-it sentence: "already opened ... the next dates are not posted yet". Shipped
   * over a link to the page that is open, that is a message arguing with its own
   * receipt. A boolean and nothing else, because the model already has the date and the
   * link is the one fact it may never write (R3).
   */
  it('tells the composer which tense this is, and still not the page', () => {
    const gone: RadarDecision = {
      ...STILL_OPEN,
      // biome-ignore lint/style/noNonNullAssertion: STILL_OPEN is defined with an absence just above.
      registrationAbsence: { ...STILL_OPEN.registrationAbsence!, stillOpen: null },
    };
    const open = radarVoiceContext(STILL_OPEN) as {
      registrationAbsence: Record<string, unknown>;
    };
    const past = radarVoiceContext(gone) as { registrationAbsence: Record<string, unknown> };

    expect(open.registrationAbsence.stillOpenPage).toBe(true);
    expect(past.registrationAbsence.stillOpenPage).toBe(false);
    // The whole point, stated as the thing that was true on main and must not be again.
    expect(JSON.stringify(open)).not.toBe(JSON.stringify(past));
    expect(JSON.stringify(open)).not.toContain('http');
  });

  /**
   * THE POSITIVE CONTROL for the unflagged half (B2). Past the age bound the decision
   * carries no `stillOpen`, and the render must be what main sends today, to the byte.
   * Without this, "the season has gone" could be silently deleted from every town.
   */

  /**
   * R10, as an invariant rather than a case: whenever the decision knows a cycle this
   * town opened, the sent body names the town AND the date it opened — in every shape
   * and in both tenses. This is what stops a rung that did not render from erasing the
   * one true thing Hale knows about a stranger's town.
   */
});

/**
 * The whole payload, assembled: the model's words (or the grounded render), the one
 * appended line, and the named reason when there is none. `client: null` is a
 * first-class outcome here — there is no model in this path at all, so nothing is
 * mocked (rule #8) and what is asserted is the shell's own arithmetic.
 */
