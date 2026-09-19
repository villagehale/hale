import { describe, expect, it } from 'vitest';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  CHECK_IN_DAILY_ACK,
  CHECK_IN_NOTED_ACK,
  CHECK_IN_NOT_KEPT_ACK,
  CHECK_IN_OFF_ACK,
  CHECK_IN_STEP_DOWN,
  CHECK_IN_WEEKLY_ACK,
  GENERIC_CHILD_PHRASE,
  childPhrase,
  composeCheckInAsk,
} from './copy';

const ACKS = [
  CHECK_IN_WEEKLY_ACK,
  CHECK_IN_OFF_ACK,
  CHECK_IN_DAILY_ACK,
  CHECK_IN_NOTED_ACK,
  CHECK_IN_NOT_KEPT_ACK,
];

describe('the evening asks', () => {
  it('name the children the first time and print both ways out', () => {
    expect(composeCheckInAsk({ first: true, childNames: ['Mia', 'Leo'] })).toBe(
      "Quick one before the day's gone: how did today go with Mia and Leo? One line is plenty. Reply LESS for weekly, or NO to skip these.",
    );
  });

  it('are nine words and no keywords every evening after', () => {
    expect(composeCheckInAsk({ first: false, childNames: ['Mia', 'Leo'] })).toBe(
      'How did today go with Mia and Leo? One line is plenty.',
    );
  });

  it('say "the kids" when there is nobody the message may name', () => {
    // An empty list is what a household of teenagers looks like from here — the names
    // are stripped at the source (sweep.ts), so this sentence cannot tell the two apart.
    expect(composeCheckInAsk({ first: false, childNames: [] })).toBe(
      'How did today go with the kids? One line is plenty.',
    );
    expect(childPhrase([])).toBe(GENERIC_CHILD_PHRASE);
  });

  it('drop the names rather than the segment when they will not fit', () => {
    const long = ['Alexandrina', 'Bartholomew', 'Constantina'];
    // The names fit the short ask and not the long one, so the SAME family gets named on
    // an ordinary evening and unnamed on their first — measured, never guessed.
    expect(composeCheckInAsk({ first: false, childNames: long })).toContain('Alexandrina');
    expect(composeCheckInAsk({ first: true, childNames: long })).toContain(
      GENERIC_CHILD_PHRASE,
    );
  });

  it('refuse a name Hale cannot spell on the wire', () => {
    expect(childPhrase(['Zoë'])).toBe(GENERIC_CHILD_PHRASE);
  });

  it('fit one GSM-7 segment with the full opt-out line on them', () => {
    const bodies = [
      composeCheckInAsk({ first: true, childNames: ['Mia', 'Leo'] }),
      composeCheckInAsk({ first: true, childNames: [] }),
      composeCheckInAsk({ first: false, childNames: ['Mia', 'Leo'] }),
      composeCheckInAsk({ first: false, childNames: [] }),
      CHECK_IN_STEP_DOWN,
    ];
    for (const body of bodies) {
      const wire = withOptOut(body, 'full');
      expect(isGsm7(wire), body).toBe(true);
      expect(smsSegments(wire), body).toBe(1);
    }
  });
});

describe('the acknowledgments', () => {
  it('exist in both languages and cost one segment in each', () => {
    for (const ack of ACKS) {
      for (const body of Object.values(ack)) {
        expect(isGsm7(body), body).toBe(true);
        expect(smsSegments(body), body).toBe(1);
      }
      expect(ack.fr).not.toBe(ack.en);
    }
  });

  it('offer the keywords without promising a window the rule does not keep', () => {
    // A taught word is this lane's for thirty days after it last spoke and no longer
    // (CHECK_IN_REOFFER_DAYS), so a sentence saying "anytime" is a sentence Hale stops
    // honouring while the parent still believes it. The instruction stays; the duration
    // goes. The opt-out that IS unconditional is STOP, and it rides on the wire.
    const promises = /anytime|any evening|whenever you like|quand vous voulez/i;
    for (const line of [CHECK_IN_STEP_DOWN, ...ACKS.flatMap((ack) => Object.values(ack))]) {
      // The exception, and the only one: the off ack's "text me whenever you like" is
      // about reaching Hale at all, which never expires.
      if (line === CHECK_IN_OFF_ACK.en || line === CHECK_IN_OFF_ACK.fr) continue;
      expect(line, line).not.toMatch(promises);
    }
    // The positive control: the words themselves are still printed, or this test would
    // pass on a lane that stopped telling parents how to leave.
    expect(CHECK_IN_NOTED_ACK.en).toContain('NO');
    expect(CHECK_IN_STEP_DOWN).toContain('DAILY');
  });

  it('never repeats the sensitive thing back at the parent', () => {
    // The refusal says what happened and names no category — the one sentence in this
    // lane that could otherwise put the withheld subject on a lock screen.
    for (const body of Object.values(CHECK_IN_NOT_KEPT_ACK)) {
      expect(body.toLowerCase()).not.toMatch(/health|custody|medical|money|religio/);
    }
  });
});
