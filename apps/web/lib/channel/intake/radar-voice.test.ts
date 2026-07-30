import { describe, expect, it } from 'vitest';
import { smsSegments } from '~/lib/channel/sms-segments';
import { WATCH_OFFER } from './copy.js';
import type { RadarDecision } from './radar-decide.js';
import {
  MAX_PAYLOAD_SEGMENTS,
  parseRadarVoiceAnswer,
  radarFactSlots,
  radarVoiceContext,
  radarVoiceStrings,
  renderRadarDeterministically,
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
  offerQuestion: true,
  followUpNeeded: true,
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
    expect(context.offerQuestion).toBe(true);
  });
});

describe('radarFactSlots', () => {
  it('lists every renderable fact, so the lint can ground the voice against them', () => {
    const slots = radarFactSlots(BOTH);
    expect(slots).toContain('Riverdale Farm drop-in');
    expect(slots).toContain('Aug 11, 6:30 a.m.');
    expect(slots).toContain('Maya');
  });

  it('is empty of anything when there is nothing to say', () => {
    expect(radarFactSlots(NOTHING)).toEqual([]);
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
    const message = renderRadarDeterministically(NOTHING);
    expect(message.toLowerCase()).toContain('still learning');
  });

  it('never writes the watch question — the shell appends it exactly once', () => {
    for (const decision of [PICK_ONLY, BOTH, NOTHING]) {
      expect(renderRadarDeterministically(decision)).not.toContain(WATCH_OFFER);
    }
  });

  it('is itself grounded and within budget in every shape', () => {
    for (const decision of [PICK_ONLY, BOTH, NOTHING]) {
      expect(usableRadarMessage(renderRadarDeterministically(decision), decision)).toBe(true);
    }
  });

  it('stays plain ASCII so the payload is billed as GSM-7, not UCS-2', () => {
    for (const decision of [PICK_ONLY, BOTH, NOTHING]) {
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
