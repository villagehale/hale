import type { Municipality } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { smsSegments } from '~/lib/channel/sms-segments';
import { REGISTRATION_WINDOWS } from '~/lib/registration/registration-windows-data';
import { WATCH_OFFER } from './copy.js';
import { asciiCopy } from './radar-decide.js';
import type { RadarDecision } from './radar-decide.js';
import {
  MAX_PAYLOAD_SEGMENTS,
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
  },
};

/** The same, with a weekend pick above it and no cycle named to wait for. */
const PICK_BETWEEN_CYCLES: RadarDecision = {
  ...PICK_ONLY,
  registrationAbsence: {
    cycleRef: { municipality: 'toronto', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
    lastOpenedAtLocal: 'Sep 8, 7:00 a.m.',
    nextCycleLabel: null,
  },
};

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
      usableRadarMessage('Riverdale Farm drop-in on Saturday looks good for Maya and Leo.', BOTH),
    ).toBe(true);
  });

  it('rejects a message that invents a time nobody gave it', () => {
    expect(usableRadarMessage('Riverdale Farm drop-in starts at 9:15 on Saturday.', BOTH)).toBe(false);
  });

  it('rejects a message that invents a link', () => {
    expect(usableRadarMessage('Sign up at https://riverdale.example.com today.', BOTH)).toBe(false);
  });

  it('rejects a message that re-asks the watch question the shell is about to append', () => {
    expect(usableRadarMessage(`Saturday looks good. ${WATCH_OFFER}`, BOTH)).toBe(false);
  });

  it('rejects a checkpoint message that turns an administrative window into a claim about the child', () => {
    // Hale has never seen a child's record. "Maya is behind" is a diagnosis, and M8's
    // framing lint is what keeps a model from writing one into the third block.
    expect(usableRadarMessage('Maya is behind on her 18-month visit.', CHECKPOINT_ONLY)).toBe(false);
    expect(usableRadarMessage('You must book the 18-month visit.', CHECKPOINT_ONLY)).toBe(false);
    expect(
      usableRadarMessage('Ontario runs a longer 18-month well-baby visit for Maya.', CHECKPOINT_ONLY),
    ).toBe(true);
  });

  it('rejects a message that blows the segment budget once the offer is appended', () => {
    const long = `${'Saturday looks good for Maya. '.repeat(20)}`;
    expect(smsSegments(`${long}\n\n${WATCH_OFFER}`)).toBeGreaterThan(MAX_PAYLOAD_SEGMENTS);
    expect(usableRadarMessage(long, BOTH)).toBe(false);
  });
});

describe('renderRadarDeterministically', () => {
  it('names the pick, its day, and the kids it fits — nothing else', () => {
    const message = renderRadarDeterministically(PICK_ONLY);
    expect(message).toContain('Riverdale Farm drop-in');
    expect(message).toContain('Saturday');
    expect(message).toContain('Maya');
    expect(message).toContain('Leo');
  });

  it('names the registration open date and the kid it is for', () => {
    const message = renderRadarDeterministically(BOTH);
    expect(message).toContain('Aug 11, 6:30 a.m.');
    expect(message).toContain('Markham');
  });

  it('says Hale is still learning rather than inventing a pick', () => {
    const message = renderRadarDeterministically({ ...BOTH, weekendPick: null });
    expect(message.toLowerCase()).toContain('still learning');
  });

  it('leads with the registration date, then the pick — the cascade, not the field order', () => {
    const message = renderRadarDeterministically(BOTH);
    expect(message.indexOf('Markham')).toBeLessThan(message.indexOf('Riverdale Farm drop-in'));
  });

  it('leads on the checkpoint when geography is empty, and still promises the pick', () => {
    const message = renderRadarDeterministically(CHECKPOINT_ONLY);
    expect(message).toContain('Maya');
    expect(message).toContain('18-month well-baby visit');
    expect(message.toLowerCase()).toContain('still learning');
  });

  it('never shrugs: with nothing at all it maps, and says when the first find lands', () => {
    const message = renderRadarDeterministically(NOTHING);
    expect(message).toContain('Your first weekend find lands in a day or two.');
    expect(message.toLowerCase()).not.toContain('still getting to know');
  });

  it('never writes the watch question — the shell appends it exactly once', () => {
    for (const decision of [PICK_ONLY, BOTH, NOTHING, CHECKPOINT_ONLY, ALL_THREE]) {
      expect(renderRadarDeterministically(decision)).not.toContain(WATCH_OFFER);
    }
  });

  it('is itself grounded and within budget in every shape', () => {
    for (const decision of [PICK_ONLY, BOTH, NOTHING, CHECKPOINT_ONLY, ALL_THREE]) {
      expect(usableRadarMessage(renderRadarDeterministically(decision), decision)).toBe(true);
    }
  });

  it('stays plain ASCII so the payload is billed as GSM-7, not UCS-2', () => {
    for (const decision of [PICK_ONLY, BOTH, NOTHING, CHECKPOINT_ONLY, ALL_THREE]) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range check IS the assertion
      expect(renderRadarDeterministically(decision)).toMatch(/^[\x0A\x20-\x7E]*$/);
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
    const message = renderRadarDeterministically(BETWEEN_CYCLES);
    expect(message).toContain('Halton Hills');
    expect(message).toContain('Fall 2026');
    expect(message).toContain('Sep 1, 7:00 a.m.');
    expect(message).toContain('Winter 2027');
    expect(message).not.toContain('Nothing has a registration date coming up just yet.');
    expect(message).not.toContain('no registration date coming up');
  });

  it('leads on the town fact, not on the mapping line — it is the one real thing known', () => {
    const message = renderRadarDeterministically(BETWEEN_CYCLES);
    expect(message.indexOf('Halton Hills')).toBeLessThan(message.indexOf('mapping'));
  });

  it('still says when the first find lands — the absence replaces no promise', () => {
    expect(renderRadarDeterministically(BETWEEN_CYCLES)).toContain(
      'Your first weekend find lands in a day or two.',
    );
  });

  it('names no season it was not given, and promises no text about one', () => {
    const message = renderRadarDeterministically(PICK_BETWEEN_CYCLES);
    expect(message).toContain('Toronto');
    expect(message).not.toMatch(/Winter|Spring|Summer/);
    expect(message).not.toMatch(/I'll (text|let you know|tell you)/i);
  });

  it('pads a lone pick with the reason, where the bare no-window line used to go', () => {
    const message = renderRadarDeterministically(PICK_BETWEEN_CYCLES);
    expect(message).toContain('Riverdale Farm drop-in');
    expect(message).toContain('already opened');
    expect(message).not.toContain('Nothing has a registration date coming up just yet.');
  });

  it('keeps the plain no-window line when there is no absence to explain', () => {
    expect(renderRadarDeterministically(PICK_ONLY)).toContain(
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
      },
    };
    const message = renderRadarDeterministically(richest);
    // The positive control: a derivation that quietly yielded an empty label would make
    // every assertion below pass on a message that costs nothing to send.
    expect(longestCycleLabel.length).toBeGreaterThan(60);
    expect(message).toContain(longestCycleLabel);
    expect(message).toContain(townLabel(longestTown));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: GSM-7 is the whole point
    expect(message).toMatch(/^[\x0A\x20-\x7E]*$/);
    expect(smsSegments(`${message}\n\n${WATCH_OFFER}`)).toBeLessThanOrEqual(MAX_PAYLOAD_SEGMENTS);
    expect(usableRadarMessage(message, richest)).toBe(true);
  });

  it('is grounded, question-free and ASCII in every between-cycles shape', () => {
    for (const decision of [BETWEEN_CYCLES, PICK_BETWEEN_CYCLES]) {
      const message = renderRadarDeterministically(decision);
      expect(usableRadarMessage(message, decision)).toBe(true);
      expect(message).not.toContain(WATCH_OFFER);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range check IS the assertion
      expect(message).toMatch(/^[\x0A\x20-\x7E]*$/);
    }
  });
});
