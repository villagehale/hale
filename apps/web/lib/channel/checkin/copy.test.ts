import { describe, expect, it } from 'vitest';
import { withOptOut } from '~/lib/channel/opt-out';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import {
  NEAR_DUPLICATE_THRESHOLD,
  bareYesNoQuestions,
  nearDuplicatePairs,
} from '~/lib/testing/pool-copy';
import {
  CHECK_IN_DAILY_ACK,
  CHECK_IN_NOTED_ACK_POOL,
  CHECK_IN_NOT_KEPT_ACK,
  CHECK_IN_OFF_ACK,
  CHECK_IN_STEP_DOWN,
  CHECK_IN_WEEKLY_ACK,
  GENERIC_CHILD_PHRASE,
  checkInNotedAck,
  childPhrase,
  composeCheckInAsk,
} from './copy';

/** The cadence acks, which are single strings and stay single strings: a household sees
 * each of them at most two or three times, ever. */
const ACKS = [CHECK_IN_WEEKLY_ACK, CHECK_IN_OFF_ACK, CHECK_IN_DAILY_ACK, CHECK_IN_NOT_KEPT_ACK];

const FAMILY = 'fam-c0ffee';

/** Every member of the later-evening pool, read through the production entry point rather
 * than off the array: the rotation visits all five in five steps (variant.test.ts), so
 * five consecutive occasions ARE the pool, and a member the composer can never reach is
 * not in this list. */
function laterAsks(childNames: readonly string[] = ['Mia', 'Leo']): string[] {
  return [0, 1, 2, 3, 4].map((occasion) =>
    composeCheckInAsk({ first: false, childNames, familyId: FAMILY, occasion }),
  );
}

const notedAcks = (language: 'en' | 'fr') =>
  [0, 1, 2, 3, 4].map((occasion) => checkInNotedAck(language, FAMILY, occasion));

describe('the evening asks', () => {
  it('name the children the first time and print both ways out', () => {
    // UNCHANGED, and it is the positive control that the pool work did not eat the one
    // message that must not vary: the first ask is once in a lifetime, so it has no
    // repetition to cure, and it is the only one that teaches the keywords.
    for (const occasion of [0, 1, 2, 3, 4, 5]) {
      expect(
        composeCheckInAsk({
          first: true,
          childNames: ['Mia', 'Leo'],
          familyId: FAMILY,
          occasion,
        }),
      ).toBe(
        "Quick one before the day's gone: how did today go with Mia and Leo? One line is plenty. Reply LESS for weekly, or NO to skip these.",
      );
    }
  });

  it('are five different questions, one per evening, never the same two nights running', () => {
    const asks = laterAsks();
    expect(new Set(asks).size).toBe(5);
    // The shipped sentence is still one of them, so a reviewer reading this diff sees real
    // copy and not only properties.
    expect(asks).toContain('How did today go with Mia and Leo? One line is plenty.');
    // Consecutive evenings, through the composer, for a second family too — the property
    // the rotation exists for, asserted where a parent would feel it.
    for (const familyId of [FAMILY, 'fam-0de1', 'fam-9a7b']) {
      for (let day = 200; day < 240; day++) {
        const tonight = composeCheckInAsk({
          first: false,
          childNames: ['Mia'],
          familyId,
          occasion: day,
        });
        const tomorrow = composeCheckInAsk({
          first: false,
          childNames: ['Mia'],
          familyId,
          occasion: day + 1,
        });
        expect(tomorrow, `${familyId} day=${day}`).not.toBe(tonight);
      }
    }
  });

  it('say "the kids" when there is nobody the message may name', () => {
    // An empty list is what a household of teenagers looks like from here — the names
    // are stripped at the source (sweep.ts), so this sentence cannot tell the two apart.
    for (const ask of laterAsks([])) {
      expect(ask, ask).toContain(GENERIC_CHILD_PHRASE);
      expect(ask, ask).not.toMatch(/undefined|\{\}/);
    }
    expect(childPhrase([])).toBe(GENERIC_CHILD_PHRASE);
  });

  it('drop the names rather than the segment when they will not fit', () => {
    const long = ['Alexandrina', 'Bartholomew', 'Constantina'];
    // The names fit the short asks and not the first one, so the SAME family gets named on
    // an ordinary evening and unnamed on their first — measured, never guessed.
    for (const ask of laterAsks(long)) {
      expect(ask, ask).toContain('Alexandrina');
    }
    expect(
      composeCheckInAsk({ first: true, childNames: long, familyId: FAMILY, occasion: 0 }),
    ).toContain(GENERIC_CHILD_PHRASE);
  });

  it('refuse a name Hale cannot spell on the wire', () => {
    expect(childPhrase(['Zoë'])).toBe(GENERIC_CHILD_PHRASE);
  });

  it('fit one GSM-7 segment with the full opt-out line on them', () => {
    const bodies = [
      composeCheckInAsk({
        first: true,
        childNames: ['Mia', 'Leo'],
        familyId: FAMILY,
        occasion: 0,
      }),
      composeCheckInAsk({ first: true, childNames: [], familyId: FAMILY, occasion: 0 }),
      ...laterAsks(),
      ...laterAsks([]),
      ...laterAsks(['Alexandrina', 'Bartholomew', 'Constantina']),
      CHECK_IN_STEP_DOWN,
    ];
    for (const body of bodies) {
      const wire = withOptOut(body, 'full');
      expect(isGsm7(wire), body).toBe(true);
      expect(smsSegments(wire), body).toBe(1);
    }
  });

  it('ask exactly one thing, and nothing a bare yes or no answers', () => {
    // D14's two halves. The second is mechanical BECAUSE of readCadenceWord: a whole-string
    // "no" is read as cadence OFF before anything else looks at the reply, so a parent
    // answering "Did she make it to swim?" honestly unsubscribes from the evening.
    for (const ask of [...laterAsks(), ...laterAsks([])]) {
      expect((ask.match(/\?/g) ?? []).length, ask).toBe(1);
      expect(bareYesNoQuestions(ask), ask).toEqual([]);
    }
    // The mutation control: the shape rule 11 forbids, which must be caught.
    expect(bareYesNoQuestions('Did Mia make it to swim today?')).toEqual([
      'Did Mia make it to swim today?',
    ]);
  });

  it('are five sentences and not one sentence five ways', () => {
    // The overlap detector the landing copy is already held to, at its measured 0.65.
    expect(nearDuplicatePairs(laterAsks([]))).toEqual([]);
    // The mutation: two members that are the same sentence with one word swapped.
    const faked = [
      'How was today with the kids? Even a word helps.',
      'How was today with the children? Even a word helps.',
    ];
    const pairs = nearDuplicatePairs(faked);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.overlap).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
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
    const lines = [
      CHECK_IN_STEP_DOWN,
      ...ACKS.flatMap((ack) => Object.values(ack)),
      ...notedAcks('en'),
      ...notedAcks('fr'),
    ];
    for (const line of lines) {
      // The exception, and the only one: the off ack's "text me whenever you like" is
      // about reaching Hale at all, which never expires.
      if (line === CHECK_IN_OFF_ACK.en || line === CHECK_IN_OFF_ACK.fr) continue;
      expect(line, line).not.toMatch(promises);
    }
    // The positive control: the words themselves are still printed on EVERY member, or
    // this test would pass on a pool where four evenings in five stopped telling parents
    // how to leave.
    for (const ack of notedAcks('en')) expect(ack, ack).toContain('NO');
    for (const ack of notedAcks('fr')) expect(ack, ack).toContain('NO');
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

describe('the noted-ack pool', () => {
  it('is five thank-yous per language, and the two languages never collide', () => {
    for (const language of ['en', 'fr'] as const) {
      expect(CHECK_IN_NOTED_ACK_POOL[language]).toHaveLength(5);
      expect(new Set(notedAcks(language)).size, language).toBe(5);
    }
    expect(
      notedAcks('en').filter((ack) => (notedAcks('fr') as string[]).includes(ack)),
    ).toEqual([]);
  });

  it('never asks anything', () => {
    // An ack is Hale's last word after a parent's diary line. A question here would be a
    // second ask on a lane whose keywords a bare answer already claims (rule 11) — which
    // is why this pool carries ZERO "?" where the ask pools carry exactly one.
    for (const ack of [...notedAcks('en'), ...notedAcks('fr')]) {
      expect(ack, ack).not.toContain('?');
      expect(bareYesNoQuestions(ack), ack).toEqual([]);
    }
  });

  it('opens with none of the words rule 3 bans', () => {
    // *noted* as a bare opener is on the list, and this lane was the last place using it.
    for (const ack of notedAcks('en')) {
      expect(ack, ack).not.toMatch(/^(?:Noted|Filed|Logged|Processed)\b/);
    }
  });

  it('fits one GSM-7 segment in both languages, measured with the full opt-out on it', () => {
    // The ack rides a REPLY, which carries no CASL line — so this is the conservative
    // bound rather than the real one, and it stays that way so a member can never be
    // moved onto a proactive path and split in two.
    for (const ack of [...notedAcks('en'), ...notedAcks('fr')]) {
      const wire = withOptOut(ack, 'full');
      expect(isGsm7(wire), ack).toBe(true);
      expect(smsSegments(wire), ack).toBe(1);
    }
  });

  it('is five thank-yous and not one thank-you five ways, in each language', () => {
    for (const language of ['en', 'fr'] as const) {
      expect(nearDuplicatePairs(notedAcks(language)), language).toEqual([]);
    }
  });

  it('does not move in lockstep with the evening ask', () => {
    // Both pools are read on the same family-local day. Without the pool name in the
    // offset, a household would read the same pairing every evening of their life.
    const sample = Array.from({ length: 60 }, (_, i) => `pairing-${i}`);
    const differentIndex = sample.filter((familyId) => {
      const ask = composeCheckInAsk({
        first: false,
        childNames: ['Mia'],
        familyId,
        occasion: 9,
      });
      const askIndex = laterAsks(['Mia']).indexOf(ask);
      const ackIndex = CHECK_IN_NOTED_ACK_POOL.en.indexOf(checkInNotedAck('en', familyId, 9));
      return askIndex !== ackIndex;
    });
    expect(differentIndex.length).toBeGreaterThanOrEqual(36);
  });
});
