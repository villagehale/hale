import { describe, expect, it } from 'vitest';
import { smsSegments } from '~/lib/channel/sms-segments';
import type { Nudge } from './nudge-decide.js';
import {
  MAX_NUDGE_SEGMENTS,
  NUDGE_OPT_OUT,
  nudgeFactSlots,
  nudgeVoiceContext,
  nudgeVoiceStrings,
  parseNudgeVoiceAnswer,
  renderNudgeDeterministically,
  usableNudgeMessage,
} from './nudge-voice.js';

/**
 * VIL-239 · M4 — COMPOSE's pure seam. Same contract as M3's, with one addition that
 * matters more here than anywhere else in the product: this message is UNSOLICITED,
 * so the CASL opt-out line is part of the shell and the model may not touch it.
 *
 * What is proved:
 *   - the model is handed the decision's facts and no internal identifiers;
 *   - a message that invents a time or a link, writes the opt-out line itself, or
 *     blows the segment budget once the opt-out is appended, is REJECTED;
 *   - the deterministic render is honest, grounded, in budget, and plain ASCII in
 *     every shape — so a model outage costs a parent warmth, never accuracy.
 */

const REGISTRATION: Nudge = {
  kind: 'registration',
  windowRef: {
    id: 'window-uuid-1',
    municipality: 'richmond_hill',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
  },
  opensAtLocal: 'Aug 5, 10:30 a.m.',
  kidNames: ['Maya', 'Leo'],
  residentNote: 'residents can register first',
  ageApproximate: false,
};

const SWAP: Nudge = {
  kind: 'weather_swap',
  candidateRef: { id: 'cand-uuid-1', title: 'Library story time', venueName: 'Riverdale Library' },
  day: 'saturday',
  kidNames: ['Maya'],
  weatherFact: 'the weekend forecast is wet',
  whyFacts: ['free', 'indoor'],
};

const BARE_SWAP: Nudge = {
  kind: 'weather_swap',
  candidateRef: { id: 'cand-uuid-2', title: 'Splash pad', venueName: null },
  day: 'sunday',
  kidNames: [],
  weatherFact: 'the forecast looks dry',
  whyFacts: [],
};

const ALL: Nudge[] = [REGISTRATION, SWAP, BARE_SWAP];

describe('nudgeVoiceContext', () => {
  it('hands the model the facts and no internal identifiers', () => {
    const context = JSON.stringify(nudgeVoiceContext(SWAP));
    expect(context).toContain('Library story time');
    expect(context).toContain('the weekend forecast is wet');
    expect(context).not.toContain('cand-uuid-1');
  });

  it('names the town rather than the internal municipality token', () => {
    const context = JSON.stringify(nudgeVoiceContext(REGISTRATION));
    expect(context).toContain('Richmond Hill');
    expect(context).not.toContain('richmond_hill');
  });

  it('tells the model which kind of nudge it is writing', () => {
    expect((nudgeVoiceContext(REGISTRATION) as { kind: string }).kind).toBe('registration');
    expect((nudgeVoiceContext(SWAP) as { kind: string }).kind).toBe('weather_swap');
  });
});

describe('nudgeFactSlots', () => {
  it('lists every renderable fact so the lint can ground the voice against them', () => {
    expect(nudgeFactSlots(REGISTRATION)).toEqual(
      expect.arrayContaining(['Richmond Hill', 'Fall 2026', 'Aug 5, 10:30 a.m.', 'Maya', 'Leo']),
    );
    expect(nudgeFactSlots(SWAP)).toEqual(
      expect.arrayContaining(['Library story time', 'Riverdale Library', 'the weekend forecast is wet']),
    );
  });

  it('carries no internal identifier a model could echo', () => {
    expect(nudgeFactSlots(SWAP)).not.toContain('cand-uuid-1');
    expect(nudgeFactSlots(REGISTRATION)).not.toContain('window-uuid-1');
    expect(JSON.stringify(nudgeVoiceContext(REGISTRATION))).not.toContain('window-uuid-1');
  });
});

describe('parseNudgeVoiceAnswer', () => {
  it('reads the message out of a clean JSON object', () => {
    expect(parseNudgeVoiceAnswer('{"message":"Saturday looks good."}')).toEqual({
      message: 'Saturday looks good.',
    });
  });

  it('reads it out of an object wrapped in prose', () => {
    expect(parseNudgeVoiceAnswer('Sure:\n{"message":"ok"}\nhope that helps')).toEqual({
      message: 'ok',
    });
  });

  it('rejects an extra field — the schema is strict', () => {
    expect(parseNudgeVoiceAnswer('{"message":"ok","link":"https://x.test"}')).toBeNull();
  });

  it('rejects a non-object, an empty message, and no answer at all', () => {
    expect(parseNudgeVoiceAnswer('no json here')).toBeNull();
    expect(parseNudgeVoiceAnswer('{"message":"   "}')).toBeNull();
    expect(parseNudgeVoiceAnswer(null)).toBeNull();
  });
});

describe('usableNudgeMessage', () => {
  it('accepts a grounded, short message', () => {
    expect(
      usableNudgeMessage('Library story time at Riverdale Library on Saturday suits Maya.', SWAP),
    ).toBe(true);
  });

  it('rejects a message that invents a time nobody gave it', () => {
    expect(usableNudgeMessage('Library story time starts at 9:15 on Saturday.', SWAP)).toBe(false);
  });

  it('rejects a message that invents a link', () => {
    expect(usableNudgeMessage('Register at https://richmondhill.example.ca now.', REGISTRATION)).toBe(
      false,
    );
  });

  it('rejects a message that writes the opt-out line the shell appends', () => {
    expect(usableNudgeMessage(`Saturday looks good. ${NUDGE_OPT_OUT}`, SWAP)).toBe(false);
  });

  it('rejects a message that blows the segment budget once the opt-out is appended', () => {
    const long = 'Library story time suits Maya. '.repeat(20);
    expect(smsSegments(`${long}\n\n${NUDGE_OPT_OUT}`)).toBeGreaterThan(MAX_NUDGE_SEGMENTS);
    expect(usableNudgeMessage(long, SWAP)).toBe(false);
  });
});

describe('renderNudgeDeterministically', () => {
  it('names the town, the cycle, when it opens, and the kids it is for', () => {
    const message = renderNudgeDeterministically(REGISTRATION);
    expect(message).toContain('Richmond Hill');
    expect(message).toContain('Fall 2026');
    expect(message).toContain('Aug 5, 10:30 a.m.');
    expect(message).toContain('Maya');
    expect(message).toContain('Leo');
    expect(message).toContain('residents can register first');
  });

  it('hedges an approximate age fit rather than asserting the band', () => {
    const message = renderNudgeDeterministically({ ...REGISTRATION, ageApproximate: true } as Nudge);
    expect(message.toLowerCase()).toContain('if');
  });

  it('names the swap, its day, its weather reason, and the kids it fits', () => {
    const message = renderNudgeDeterministically(SWAP);
    expect(message).toContain('Library story time');
    expect(message).toContain('Riverdale Library');
    expect(message).toContain('Saturday');
    expect(message).toContain('the weekend forecast is wet');
    expect(message).toContain('Maya');
  });

  it('says nothing about a venue or kids it was not given', () => {
    const message = renderNudgeDeterministically(BARE_SWAP);
    expect(message).toContain('Splash pad');
    expect(message).not.toContain(' at ');
    expect(message).not.toContain(' for ');
  });

  it('never writes the opt-out line — the shell appends it exactly once', () => {
    for (const nudge of ALL) {
      expect(renderNudgeDeterministically(nudge)).not.toContain(NUDGE_OPT_OUT);
    }
  });

  it('is itself grounded and within budget in every shape', () => {
    for (const nudge of ALL) {
      expect(usableNudgeMessage(renderNudgeDeterministically(nudge), nudge)).toBe(true);
    }
  });

  it('stays plain ASCII so the payload is billed as GSM-7, not UCS-2', () => {
    for (const nudge of ALL) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range check IS the assertion
      expect(renderNudgeDeterministically(nudge)).toMatch(/^[\x0A\x20-\x7E]*$/);
    }
  });
});

describe('nudgeVoiceStrings', () => {
  it('exposes the one user-facing string for the lint', () => {
    expect(nudgeVoiceStrings({ message: 'hello' })).toEqual(['hello']);
  });
});
