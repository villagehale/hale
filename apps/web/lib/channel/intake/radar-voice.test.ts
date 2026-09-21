import type { Database, Municipality } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { smsSegments } from '~/lib/channel/sms-segments';
import { REGISTRATION_WINDOWS } from '~/lib/registration/registration-windows-data';
import { type ActionMove, FIRST_REPLY_ACTION_LINE_ENV, renderActionLine } from './action-line.js';
import { WATCH_OFFER } from './copy.js';
import { asciiCopy } from './radar-decide.js';
import type { RadarDecision } from './radar-decide.js';
import {
  FIRST_FIND_BEAT,
  composeRadarMessage,
  MAX_PAYLOAD_SEGMENTS,
  radarMessageFault,
  parseRadarVoiceAnswer,
  radarFactSlots,
  radarVoiceContext,
  radarVoiceStrings,
  renderRadarDeterministically,
  townLabel,
  usableRadarMessage,
} from './radar-voice.js';

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
    candidateRef: { id: 'cand-uuid-1', title: 'Riverdale Farm drop-in', venueName: 'Riverdale Farm' },
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
    cycleRef: { municipality: 'halton_hills', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
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

describe('parseRadarVoiceAnswer', () => {
  it('reads the message out of a clean JSON object', () => {
    expect(parseRadarVoiceAnswer('{"message":"Saturday looks good."}')).toEqual({
      message: 'Saturday looks good.',
    });
  });

  it('reads it out of an object wrapped in prose', () => {
    expect(parseRadarVoiceAnswer('Here you go:\n{"message":"ok"}\nhope that helps')).toEqual({
      message: 'ok',
    });
  });

  it('rejects an extra field — the schema is strict', () => {
    expect(parseRadarVoiceAnswer('{"message":"ok","link":"https://x.test"}')).toBeNull();
  });

  it('rejects a non-object, an empty message, and no answer at all', () => {
    expect(parseRadarVoiceAnswer('no json here')).toBeNull();
    expect(parseRadarVoiceAnswer('{"message":"   "}')).toBeNull();
    expect(parseRadarVoiceAnswer(null)).toBeNull();
  });
});

describe('usableRadarMessage', () => {
  it('accepts a grounded, short message', () => {
    expect(
      usableRadarMessage('Riverdale Farm drop-in on Saturday looks good for Maya and Leo.', BOTH, ''),
    ).toBe(true);
  });

  it('rejects a message that invents a time nobody gave it', () => {
    expect(usableRadarMessage('Riverdale Farm drop-in starts at 9:15 on Saturday.', BOTH, '')).toBe(false);
  });

  it('rejects a message that invents a link', () => {
    expect(usableRadarMessage('Sign up at https://riverdale.example.com today.', BOTH, '')).toBe(false);
  });

  it('rejects a message that re-asks the watch question the shell is about to append', () => {
    expect(usableRadarMessage(`Saturday looks good. ${WATCH_OFFER}`, BOTH, '')).toBe(false);
  });

  it('rejects a checkpoint message that turns an administrative window into a claim about the child', () => {
    // Hale has never seen a child's record. "Maya is behind" is a diagnosis, and M8's
    // framing lint is what keeps a model from writing one into the third block.
    expect(usableRadarMessage('Maya is behind on her 18-month visit.', CHECKPOINT_ONLY, '')).toBe(false);
    expect(usableRadarMessage('You must book the 18-month visit.', CHECKPOINT_ONLY, '')).toBe(false);
    expect(
      usableRadarMessage('Ontario runs a longer 18-month well-baby visit for Maya.', CHECKPOINT_ONLY, ''),
    ).toBe(true);
  });

  it('rejects a message that blows the segment budget once the offer is appended', () => {
    const long = `${'Saturday looks good for Maya. '.repeat(20)}`;
    expect(smsSegments(`${long}\n\n${WATCH_OFFER}`)).toBeGreaterThan(MAX_PAYLOAD_SEGMENTS);
    expect(usableRadarMessage(long, BOTH, '')).toBe(false);
  });
});

describe('renderRadarDeterministically', () => {
  it('names the pick, its day, and the kids it fits — nothing else', () => {
    const message = renderRadarDeterministically(PICK_ONLY, '');
    expect(message).toContain('Riverdale Farm drop-in');
    expect(message).toContain('Saturday');
    expect(message).toContain('Maya');
    expect(message).toContain('Leo');
  });

  it('names the registration open date and the kid it is for', () => {
    const message = renderRadarDeterministically(BOTH, '');
    expect(message).toContain('Aug 11, 6:30 a.m.');
    expect(message).toContain('Markham');
  });

  it('says Hale is still learning rather than inventing a pick', () => {
    const message = renderRadarDeterministically({ ...BOTH, weekendPick: null }, '');
    expect(message.toLowerCase()).toContain('still learning');
  });

  it('leads with the registration date, then the pick — the cascade, not the field order', () => {
    const message = renderRadarDeterministically(BOTH, '');
    expect(message.indexOf('Markham')).toBeLessThan(message.indexOf('Riverdale Farm drop-in'));
  });

  it('leads on the checkpoint when geography is empty, and still promises the pick', () => {
    const message = renderRadarDeterministically(CHECKPOINT_ONLY, '');
    expect(message).toContain('Maya');
    expect(message).toContain('18-month well-baby visit');
    expect(message.toLowerCase()).toContain('still learning');
  });

  it('never shrugs: with nothing at all it maps, and says when the first find lands', () => {
    const message = renderRadarDeterministically(NOTHING, '');
    expect(message).toContain('Your first weekend find lands in a day or two.');
    expect(message.toLowerCase()).not.toContain('still getting to know');
  });

  it('never writes the watch question — the shell appends it exactly once', () => {
    for (const decision of [PICK_ONLY, BOTH, NOTHING, CHECKPOINT_ONLY, ALL_THREE]) {
      expect(renderRadarDeterministically(decision, '')).not.toContain(WATCH_OFFER);
    }
  });

  it('is itself grounded and within budget in every shape', () => {
    for (const decision of [PICK_ONLY, BOTH, NOTHING, CHECKPOINT_ONLY, ALL_THREE]) {
      expect(usableRadarMessage(renderRadarDeterministically(decision, ''), decision, '')).toBe(true);
    }
  });

  it('stays plain ASCII so the payload is billed as GSM-7, not UCS-2', () => {
    for (const decision of [PICK_ONLY, BOTH, NOTHING, CHECKPOINT_ONLY, ALL_THREE]) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range check IS the assertion
      expect(renderRadarDeterministically(decision, '')).toMatch(/^[\x0A\x20-\x7E]*$/);
    }
  });
});

describe('radarVoiceStrings', () => {
  it('exposes the one user-facing string for the lint', () => {
    expect(radarVoiceStrings({ message: 'hello' })).toEqual(['hello']);
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

  it('renders the reason rather than the shrug — the defect, in one assertion', () => {
    const message = renderRadarDeterministically(BETWEEN_CYCLES, '');
    expect(message).toContain('Halton Hills');
    expect(message).toContain('Fall 2026');
    expect(message).toContain('Sep 1, 7:00 a.m.');
    expect(message).toContain('Winter 2027');
    expect(message).not.toContain('Nothing has a registration date coming up just yet.');
    expect(message).not.toContain('no registration date coming up');
  });

  it('leads on the town fact, not on the mapping line — it is the one real thing known', () => {
    const message = renderRadarDeterministically(BETWEEN_CYCLES, '');
    expect(message.indexOf('Halton Hills')).toBeLessThan(message.indexOf('mapping'));
  });

  it('still says when the first find lands — the absence replaces no promise', () => {
    expect(renderRadarDeterministically(BETWEEN_CYCLES, '')).toContain(
      'Your first weekend find lands in a day or two.',
    );
  });

  it('names no season it was not given, and promises no text about one', () => {
    const message = renderRadarDeterministically(PICK_BETWEEN_CYCLES, '');
    expect(message).toContain('Toronto');
    expect(message).not.toMatch(/Winter|Spring|Summer/);
    expect(message).not.toMatch(/I'll (text|let you know|tell you)/i);
  });

  it('pads a lone pick with the reason, where the bare no-window line used to go', () => {
    const message = renderRadarDeterministically(PICK_BETWEEN_CYCLES, '');
    expect(message).toContain('Riverdale Farm drop-in');
    expect(message).toContain('already opened');
    expect(message).not.toContain('Nothing has a registration date coming up just yet.');
  });

  it('keeps the plain no-window line when there is no absence to explain', () => {
    expect(renderRadarDeterministically(PICK_ONLY, '')).toContain(
      'Nothing has a registration date coming up just yet.',
    );
  });

  /**
   * The budget is arithmetic, not style: `usableRadarMessage` silently discards a
   * payload over MAX_PAYLOAD_SEGMENTS and falls back to THIS render, so a fallback that
   * does not fit is a message no family ever receives. The worst case is the longest
   * town, the longest cycle label the dataset actually carries, a dated open with a
   * year on it, a watched next cycle, AND a weekend pick above it.
   *
   * Both superlatives are DERIVED from the seed rather than pasted, because a label
   * pasted here goes stale the day a town publishes a longer one — and a hand-picked
   * label was already 15 characters short of the real maximum. A longer label landing
   * in the data now fails this test instead of quietly buying a fourth segment.
   */
  it('fits the segment budget with WATCH_OFFER in its very richest shape', () => {
    const longestCycleLabel = asciiCopy(
      [...REGISTRATION_WINDOWS].sort((a, b) => b.cycleLabel.length - a.cycleLabel.length)[0]
        ?.cycleLabel ?? '',
    );
    const longestTown = [...new Set(REGISTRATION_WINDOWS.map((seed) => seed.municipality))].sort(
      (a, b) => townLabel(b).length - townLabel(a).length,
    )[0] as Municipality;
    const richest: RadarDecision = {
      ...PICK_ONLY,
      registrationAbsence: {
        cycleRef: {
          municipality: longestTown,
          programDomain: 'rec_program',
          cycleLabel: longestCycleLabel,
        },
        lastOpenedAtLocal: 'Sep 15, 2025, 11:30 a.m.',
        nextCycleLabel: 'Winter 2027',
        stillOpen: null,
      },
    };
    const message = renderRadarDeterministically(richest, '');
    // The positive control: a derivation that quietly yielded an empty label would make
    // every assertion below pass on a message that costs nothing to send.
    expect(longestCycleLabel.length).toBeGreaterThan(60);
    expect(message).toContain(longestCycleLabel);
    expect(message).toContain(townLabel(longestTown));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: GSM-7 is the whole point
    expect(message).toMatch(/^[\x0A\x20-\x7E]*$/);
    expect(smsSegments(`${message}\n\n${WATCH_OFFER}`)).toBeLessThanOrEqual(MAX_PAYLOAD_SEGMENTS);
    expect(usableRadarMessage(message, richest, '')).toBe(true);
  });

  it('is grounded, question-free and ASCII in every between-cycles shape', () => {
    for (const decision of [BETWEEN_CYCLES, PICK_BETWEEN_CYCLES]) {
      const message = renderRadarDeterministically(decision, '');
      expect(usableRadarMessage(message, decision, '')).toBe(true);
      expect(message).not.toContain(WATCH_OFFER);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range check IS the assertion
      expect(message).toMatch(/^[\x0A\x20-\x7E]*$/);
    }
  });
});

/**
 * The open-now TENSE on the same rung. A cycle that opened five days ago is not a
 * season that has gone, and "the next dates are not posted yet" invites a parent to
 * wait for a cycle they should be registering for today.
 */
describe('the still-open absence', () => {
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
  const PICK_STILL_OPEN: RadarDecision = {
    ...PICK_ONLY,
    registrationAbsence: STILL_OPEN.registrationAbsence,
  };

  it('claims a town, a cycle and a date — and drops the sentence that says they missed it', () => {
    const message = renderRadarDeterministically(STILL_OPEN, '');
    expect(message).toContain('Toronto Fall 2026 registration opened Sep 15, 7:00 a.m.');
    expect(message).not.toContain('already');
    expect(message).not.toContain('not posted yet');
    expect(message).not.toContain('Winter 2027');
  });

  /** R7 — Hale has never read the page, so it may never speak about what is left on it. */
  it('never claims availability, spots or urgency', () => {
    for (const decision of [STILL_OPEN, PICK_STILL_OPEN]) {
      const message = renderRadarDeterministically(decision, '').toLowerCase();
      for (const claim of ['still room', 'spots', 'spaces left', 'fills up', 'before it', 'hurry']) {
        expect(message).not.toContain(claim);
      }
    }
  });

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
  it('is byte-identical to the between-cycles render once the cycle is no longer open', () => {
    const gone: RadarDecision = {
      ...STILL_OPEN,
      registrationAbsence: { ...STILL_OPEN.registrationAbsence!, stillOpen: null },
    };
    expect(renderRadarDeterministically(gone, '')).toBe(
      [
        'Toronto Fall 2026 registration already opened Sep 15, 7:00 a.m. - Winter 2027 dates are not posted yet.',
        "I'm mapping what's near you now - nothing to point you to yet.",
        'Your first weekend find lands in a day or two.',
      ].join(' '),
    );
  });

  /**
   * R10, as an invariant rather than a case: whenever the decision knows a cycle this
   * town opened, the sent body names the town AND the date it opened — in every shape
   * and in both tenses. This is what stops a rung that did not render from erasing the
   * one true thing Hale knows about a stranger's town.
   */
  it('names the town and the date it opened in every shape that knows one', () => {
    // Every shape the INTAKE composer can produce with an absence in it. The checkpoint
    // rung is not among them: radar.ts forces `checkpoint: null` on this surface,
    // because the first find is pre-consent and health content may not ride it. (A
    // checkpoint WITHOUT a pick already drops the absence for STILL_LEARNING on main,
    // in both tenses alike — pre-existing, unreachable here, and not this change's.)
    const shapes: RadarDecision[] = [
      BETWEEN_CYCLES,
      PICK_BETWEEN_CYCLES,
      STILL_OPEN,
      PICK_STILL_OPEN,
    ];
    for (const decision of shapes) {
      const absence = decision.registrationAbsence;
      if (!absence) throw new Error('every R10 shape must carry an absence');
      const message = renderRadarDeterministically(decision, '');
      expect(message).toContain(townLabel(absence.cycleRef.municipality));
      expect(message).toContain(absence.lastOpenedAtLocal);
    }
  });

  it('is grounded, question-free, ASCII and inside the budget in both tenses', () => {
    for (const decision of [STILL_OPEN, PICK_STILL_OPEN]) {
      const message = renderRadarDeterministically(decision, '');
      expect(usableRadarMessage(message, decision, '')).toBe(true);
      expect(message).not.toContain(WATCH_OFFER);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range check IS the assertion
      expect(message).toMatch(/^[\x0A\x20-\x7E]*$/);
    }
  });
});

/**
 * THE TAIL: the one deterministic action line the shell appends under the message.
 *
 * It is measured here rather than only in action-line.test.ts because the thing that
 * can go wrong is arithmetic, not copy: a payload over MAX_PAYLOAD_SEGMENTS is silently
 * discarded and the parent gets nothing, so the render has to spend a block to make
 * room for a line it does not itself print.
 */
describe('the appended action line and the block budget', () => {
  /** The longest url the seeded dataset actually carries, derived rather than pasted so
   * a longer one landing in the data fails this file instead of a parent's handset. */
  const LONGEST_SEED_URL = [...REGISTRATION_WINDOWS]
    .map((seed) => seed.sourceUrl)
    .sort((a, b) => b.length - a.length)[0] as string;
  const TAIL = `\n\nThe page is here: ${LONGEST_SEED_URL}`;

  it('never prints the tail itself — the caller owns the payload shape', () => {
    for (const decision of [PICK_ONLY, BOTH, NOTHING, BETWEEN_CYCLES]) {
      expect(renderRadarDeterministically(decision, TAIL)).not.toContain(LONGEST_SEED_URL);
    }
  });

  /** R8a — a tail costs a block. A parent handed a registration morning AND the page has
   * one thing to do; the Saturday storytime underneath it is noise. */
  it('spends a block to make room for the tail, and keeps both without one', () => {
    const withTail = renderRadarDeterministically(ALL_THREE, TAIL);
    const without = renderRadarDeterministically(ALL_THREE, '');
    expect(withTail.split('\n\n')).toHaveLength(1);
    expect(without.split('\n\n')).toHaveLength(2);
    // The block that survives is the one the cascade puts first, either way.
    expect(withTail).toBe(without.split('\n\n')[0]);
  });

  /**
   * R8b — on the 0-block path there is no block to spend, and MAX_BLOCKS never governs
   * that return at all. The honest thing to drop is the mapping clause: the parent HAS
   * been pointed at something. FIRST_FIND_BEAT stays unconditionally, because
   * `emptyHanded` is what the commitments ledger keys on and a beat dropped at render
   * with a debt recorded at send is the told-marker defect in a new costume.
   */
  it('spends the mapping clause instead, where there is no block to spend', () => {
    const withTail = renderRadarDeterministically(BETWEEN_CYCLES, TAIL);
    expect(withTail).not.toContain("I'm mapping what's near you now");
    expect(withTail).toContain(FIRST_FIND_BEAT);
    // …and without a tail it is byte-identical to what main sends today.
    expect(renderRadarDeterministically(BETWEEN_CYCLES, '')).toContain(
      "I'm mapping what's near you now - nothing to point you to yet.",
    );
  });

  /**
   * THE WORST CASE, DERIVED. For EVERY row the seeded dataset carries, build the
   * decision it produces and render it with the longest seed url riding, then assert the
   * whole payload fits. A new town with a 70-character cycle label or a 140-character
   * url fails HERE — this is the only thing that will catch it, and a hand-picked
   * "richest decision" literal would have passed while production sent 487 septets.
   */
  it('fits the budget for every seeded registration row, with the longest url riding', () => {
    // The positive control: the derivation really found a long url, so the assertions
    // below are not passing on an empty tail.
    expect(LONGEST_SEED_URL.length).toBeGreaterThan(100);

    for (const seed of REGISTRATION_WINDOWS) {
      const absence: RadarDecision = {
        ...PICK_ONLY,
        registrationAbsence: {
          cycleRef: {
            municipality: seed.municipality,
            programDomain: seed.programDomain,
            cycleLabel: asciiCopy(seed.cycleLabel),
          },
          lastOpenedAtLocal: 'Sep 15, 2025, 11:30 a.m.',
          nextCycleLabel: 'Winter 2027',
          stillOpen: { registerUrl: LONGEST_SEED_URL, kidNames: ['Maya'] },
        },
      };
      for (const decision of [absence, { ...absence, weekendPick: null }]) {
        const body = `${renderRadarDeterministically(decision, TAIL)}${TAIL}`;
        expect(
          smsSegments(`${body}\n\n${WATCH_OFFER}`),
          `${seed.municipality} ${seed.cycleLabel} went over budget`,
        ).toBeLessThanOrEqual(MAX_PAYLOAD_SEGMENTS);
        expect(usableRadarMessage(renderRadarDeterministically(decision, TAIL), decision, TAIL)).toBe(
          true,
        );
      }
    }
  });

  /** R10 again, now in BOTH tail states: the town and the date survive either way. */
  it('names the town and the date it opened whether or not a tail rides', () => {
    const stillOpenDecision: RadarDecision = {
      ...NOTHING,
      registrationAbsence: {
        cycleRef: { municipality: 'toronto', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
        lastOpenedAtLocal: 'Sep 15, 7:00 a.m.',
        nextCycleLabel: 'Winter 2027',
        stillOpen: { registerUrl: LONGEST_SEED_URL, kidNames: ['Maya'] },
      },
    };
    for (const decision of [BETWEEN_CYCLES, PICK_BETWEEN_CYCLES, stillOpenDecision]) {
      for (const tail of ['', TAIL]) {
        const absence = decision.registrationAbsence;
        if (!absence) throw new Error('every R10 shape must carry an absence');
        const message = renderRadarDeterministically(decision, tail);
        expect(message).toContain(townLabel(absence.cycleRef.municipality));
        expect(message).toContain(absence.lastOpenedAtLocal);
      }
    }
  });

  it('rejects a composed message that only fits because the tail was not counted', () => {
    // The skill's own 250-character ceiling, which the eval gates independently. No
    // clock time and no link in it: those are the GROUNDING check's business, and this
    // test is about the arithmetic one.
    const atCeiling = 'There is plenty on around you this weekend and I will keep looking. '
      .repeat(4)
      .slice(0, 250);
    expect(atCeiling.length).toBe(250);
    expect(usableRadarMessage(atCeiling, NOTHING, '')).toBe(true);
    expect(usableRadarMessage(atCeiling, NOTHING, TAIL)).toBe(false);
  });

  /** The two failures share one console line on main. Splitting them is how the probe
   * tells "the model fabricated" from "the link did not fit" — opposite problems with
   * opposite fixes (rule #11). */
  it('names WHICH check a composed message lost on', () => {
    expect(radarMessageFault('Riverdale Farm drop-in on Saturday for Maya and Leo.', BOTH, '')).toBeNull();
    expect(radarMessageFault('Sign up at https://riverdale.example.com today.', BOTH, '')).toBe(
      'grounding',
    );
    expect(radarMessageFault(`Saturday looks good. ${WATCH_OFFER}`, BOTH, '')).toBe('grounding');
    expect(radarMessageFault('x'.repeat(400), BOTH, '')).toBe('budget');
  });
});

/**
 * THE SUBJECT OF THE APPENDED LINE IS IN THE MESSAGE, in every shape that emits one.
 *
 * R8a costs a block and R10 decides which block survives it, so the two rules together
 * can leave a receipt pointing at a thing the body never names. That is not a case to
 * remember at the render; it is a property of the pair, and it is asserted as one.
 */
describe('the appended line and the block it is about', () => {
  const CIVIC_URL = 'https://www.toronto.ca/community-people/children-parenting/earlyon/';
  const CIVIC_PICK: RadarDecision['weekendPick'] = {
    candidateRef: {
      id: 'cand-uuid-9',
      title: 'Saturday family drop-in',
      venueName: 'Queen West EarlyON',
    },
    day: 'saturday',
    kidNames: ['Maya'],
    whyFacts: ['free', 'indoor'],
    access: 'drop_in',
    when: '9:30 a.m.-11:00 a.m.',
    verifiedUrl: CIVIC_URL,
  };

  const SHAPES: Array<{ id: string; decision: RadarDecision }> = [
    { id: 'civic pick alone', decision: { ...PICK_ONLY, weekendPick: CIVIC_PICK } },
    {
      id: 'civic pick over a town between cycles',
      decision: { ...PICK_BETWEEN_CYCLES, weekendPick: CIVIC_PICK },
    },
    {
      id: 'civic pick over a town whose cycle is still open',
      decision: {
        ...PICK_BETWEEN_CYCLES,
        weekendPick: CIVIC_PICK,
        registrationAbsence: {
          ...PICK_BETWEEN_CYCLES.registrationAbsence!,
          stillOpen: { registerUrl: 'https://www.toronto.ca/example/fall', kidNames: ['Maya'] },
        },
      },
    },
    { id: 'an upcoming registration morning', decision: BOTH },
    { id: 'a town between cycles with nothing else', decision: BETWEEN_CYCLES },
  ];

  it('never appends a line about a block the rendered body does not carry', () => {
    const movesSeen: ActionMove[] = [];
    for (const { id, decision } of SHAPES) {
      const action = renderActionLine(decision, 'en');
      if (action.line === null) continue;
      movesSeen.push(action.move);
      const tail = `\n\n${action.line}`;
      const body = renderRadarDeterministically(decision, tail);
      const subject =
        action.move === 'sign_up' || action.move === 'just_go'
          ? (decision.weekendPick?.candidateRef.title as string)
          : townLabel(
              (decision.registrationAbsence?.cycleRef ?? decision.registrationLine?.windowRef)
                ?.municipality as Municipality,
            );
      expect(body, `${id}: the line names something the body never says`).toContain(subject);
    }
    // The positive control. An invariant asserted over a loop that emitted only
    // registration lines would pass on a renderActionLine that held every pick forever,
    // which is the failure mode the hold itself could become.
    expect(movesSeen).toContain('just_go');
    expect(movesSeen).toContain('register_open');
    expect(movesSeen).toContain('register_later');
  });
});

/**
 * The whole payload, assembled: the model's words (or the grounded render), the one
 * appended line, and the named reason when there is none. `client: null` is a
 * first-class outcome here — there is no model in this path at all, so nothing is
 * mocked (rule #8) and what is asserted is the shell's own arithmetic.
 */
describe('composeRadarMessage — the payload and its named outcomes', () => {
  const CIVIC_URL = 'https://www.toronto.ca/community-people/children-parenting/earlyon/';
  const PICK_OVER_A_GONE_SEASON: RadarDecision = {
    ...PICK_BETWEEN_CYCLES,
    weekendPick: {
      candidateRef: {
        id: 'cand-uuid-9',
        title: 'Saturday family drop-in',
        venueName: 'Queen West EarlyON',
      },
      day: 'saturday',
      kidNames: ['Maya'],
      whyFacts: ['free', 'indoor'],
      access: 'drop_in',
      when: '9:30 a.m.-11:00 a.m.',
      verifiedUrl: CIVIC_URL,
    },
  };

  /** No query runs on this path: a null client returns the grounded render before the
   *  skill is loaded, let alone a trace written. */
  const deps = (language: 'en' | 'fr' = 'en') => ({
    familyId: 'fam-1',
    database: null as unknown as Database,
    client: null,
    language,
  });

  it('holds the pick line, by name, rather than pointing at a find it had to drop', async () => {
    vi.stubEnv(FIRST_REPLY_ACTION_LINE_ENV, 'true');
    const radar = await composeRadarMessage(PICK_OVER_A_GONE_SEASON, deps());
    expect(radar.actionMove).toBeNull();
    expect(radar.actionHeld).toBe('pick_displaced');
    expect(radar.body).not.toContain('http');
    // R10 survives the hold, and so does the find: with no tail the render keeps both.
    expect(radar.body).toContain('Toronto Fall 2026 registration already opened Sep 8, 7:00 a.m.');
    expect(radar.body).toContain('Saturday family drop-in');
  });

  /**
   * M9 — the flag is read with STRICT equality on the literal, and nothing pinned it.
   * `vercel env add` from a piped `echo` stores a TRAILING NEWLINE, so a value that
   * prints as `true` is really 'true\n' and a truthiness check reads that as ON: the
   * dark launch would have been live from the moment the variable was set.
   */
  it('reads the flag strictly, so a trailing newline is OFF and not ON', async () => {
    const stillOpen: RadarDecision = {
      ...NOTHING,
      registrationAbsence: {
        cycleRef: { municipality: 'toronto', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
        lastOpenedAtLocal: 'Sep 15, 7:00 a.m.',
        nextCycleLabel: 'Winter 2027',
        stillOpen: { registerUrl: 'https://www.toronto.ca/example/fall', kidNames: ['Maya'] },
      },
    };
    for (const value of ['true\n', ' true', 'True', 'TRUE', '1', 'yes', '']) {
      vi.stubEnv(FIRST_REPLY_ACTION_LINE_ENV, value);
      const radar = await composeRadarMessage(stillOpen, deps());
      expect(radar.actionHeld, `${JSON.stringify(value)} must not turn the flag on`).toBe('flag_off');
      expect(radar.actionMove).toBe('register_open');
      expect(radar.body).not.toContain('http');
    }
    // The positive control: the one literal that IS on.
    vi.stubEnv(FIRST_REPLY_ACTION_LINE_ENV, 'true');
    const on = await composeRadarMessage(stillOpen, deps());
    expect(on.actionHeld).toBeNull();
    expect(on.body).toContain('The page is here: https://www.toronto.ca/example/fall');
  });
});
