import { schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAFETY_REPLY, SAFETY_REPLY_BY_LANGUAGE } from '~/lib/channel/off-domain/copy';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { matchHealthCheckpoints } from '~/lib/health/match';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  AMBIGUOUS_CLARIFY,
  AMBIGUOUS_CLARIFY_BY_LANGUAGE,
  ASSENT_ACK,
  ASSENT_ACK_BY_LANGUAGE,
  COLD_START_ASK,
  DECLINE_ACK,
  DECLINE_ACK_BY_LANGUAGE,
  HELP_REPLY,
  HELP_REPLY_BY_LANGUAGE,
  REGION_UNAVAILABLE_REPLY,
  REGION_UNAVAILABLE_REPLY_BY_LANGUAGE,
  START_ACK_BY_LANGUAGE,
  STOP_ACK,
  STOP_ACK_BY_LANGUAGE,
  WATCH_OFFER,
  WATCH_OFFER_ASK,
  detailsBlocked,
  greeting,
} from './copy';
import type { IntakeCollected } from './extract';
import {
  FakeAnswerComposer,
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeAckComposer,
  fakeRadar,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from './fakes';
import type { IntentReading } from './intent';
import { type IntakeDeps, handleInboundSms } from './machine';
import { FakeTransport } from './transport';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const NOW = new Date('2026-07-30T12:00:00.000Z');

const MAYA_AND_LEO: IntakeCollected = {
  children: [
    { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
    { name: 'Leo', ageMonths: 12, agePrecision: 'years' },
  ],
  postalCode: 'M5V 2T6',
};

const NO_POSTAL: IntakeCollected = { children: MAYA_AND_LEO.children, postalCode: null };

function assent(reply: string): IntentReading {
  return { intent: 'assent', verbatim: reply, interpretation: 'plain yes' };
}
function decline(reply: string): IntentReading {
  return { intent: 'decline', verbatim: reply, interpretation: 'plain no' };
}
function ambiguous(reply: string): IntentReading {
  return { intent: 'ambiguous', verbatim: reply, interpretation: 'a question back' };
}

/** The M5V (downtown Toronto) FSA centroid the fake geocoder returns, so the
 * seeding assertions can tell "placed here" from "could not be placed". */
const M5V_CENTRE = { lat: 43.6426, lng: -79.3871 };

function harness(options: {
  extractions?: IntakeCollected[];
  intents?: IntentReading[];
  limiter?: FakeRateLimiter;
  resolveCenter?: IntakeDeps['resolveCenter'];
  identityAsk?: FakeIdentityAsk;
  /** Defaults to the composer that finds nothing to answer — every test written before
   * the escape existed is asserting the script, and that is the script. */
  answerComposer?: IntakeDeps['answerComposer'];
  capture?: IntakeDeps['capture'];
}): {
  fake: FakeDb;
  transport: FakeTransport;
  deps: IntakeDeps;
  identityAsk: FakeIdentityAsk;
  /** Every seeding/compose step, in the order the machine ran them. */
  steps: string[];
  /** Every message that landed in the parent's own coach thread (channel/thread.ts). */
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
} {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const steps: string[] = [];
  const identityAsk = options.identityAsk ?? new FakeIdentityAsk();
  const threaded: Array<{ familyId: string; parentUserId: string; body: string }> = [];
  return {
    fake,
    transport,
    steps,
    identityAsk,
    threaded,
    deps: {
      transport,
      threadMessage: async (_db, input) => {
        threaded.push(input);
        return 'conv-1';
      },
      extractor: new FakeExtractor(options.extractions ?? [MAYA_AND_LEO]),
      intentReader: new FakeIntentReader(options.intents ?? [assent('yes')]),
      radar: {
        async compose(input) {
          steps.push(`radar:${input.areaCoarse}`);
          return fakeRadar.compose(input);
        },
      },
      ackComposer: fakeAckComposer,
      answerComposer: options.answerComposer ?? fakeSilentAnswerComposer,
      identityAsk,
      seedCivic: async (_db, familyId, areaCoarse, center) => {
        const placed = center === null ? 'unplaced' : `${center.lat},${center.lng}`;
        steps.push(`civic:${familyId ? 'family' : 'none'}:${areaCoarse}:${placed}`);
        return 0;
      },
      resolveCenter: options.resolveCenter ?? (async () => M5V_CENTRE),
      discoveryTrigger: (familyId) => {
        steps.push(`discovery:${familyId ? 'family' : 'none'}`);
      },
      limiter: options.limiter ?? new FakeRateLimiter(() => NOW.getTime()),
      ...(options.capture ? { capture: options.capture } : {}),
      now: NOW,
    },
  };
}

/** A transport whose every send is refused — the provider leg failing, not the machine. */
function refusingTransport(error: unknown): IntakeDeps['transport'] {
  return {
    async send(): Promise<{ providerMessageId: string }> {
      throw error;
    },
  };
}

/** Drive one inbound text through the machine. */
function text(
  fake: FakeDb,
  transport: FakeTransport,
  deps: IntakeDeps,
  body: string,
  override?: IntakeDeps,
) {
  return handleInboundSms(fake.db, transport.inbound(PHONE, body), override ?? deps);
}

function inserts(fake: FakeDb, table: unknown) {
  return fake.writes.filter((w) => w.op === 'insert' && w.table === table).map((w) => w.payload);
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
});

describe('intake · happy path', () => {
  it('greets, provisions the family field-by-field, offers the watch, and records assent', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes please')] });

    expect(await text(fake, transport, deps, 'hi')).toEqual({ status: 'greeted' });
    expect(transport.bodies()[0]).toContain('an AI that quietly runs the family week');
    // v2: the disclosure is IN the greeting, so the first reply is ONE paragraph and
    // spends no characters on a trailing parenthetical.
    expect(transport.bodies()[0]).not.toContain('\n\n');

    const provisioned = await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    expect(provisioned.status).toBe('provisioned');

    // ── the family, field by field ──
    const [family] = inserts(fake, schema.families);
    expect(family).toMatchObject({
      displayName: "Maya's family",
      onboardingStage: 'sms_intake', // NOT sms_active — the watch offer is unanswered
      country: 'Canada',
      postalCode: 'M5V 2T6',
      areaCoarse: 'M5V',
    });

    // ── the parent: no email, and the raw number nowhere in plaintext ──
    const [user] = inserts(fake, schema.users);
    expect(user?.email).toBeNull();
    expect(user?.externalAuthId).toMatch(/^sms:[0-9a-f]{64}$/);
    const everythingWritten = JSON.stringify(fake.writes.map((w) => w.payload));
    expect(everythingWritten).not.toContain(PHONE);
    expect(everythingWritten).not.toContain('4165551234');

    // ── the children: DOB derived from the stated age, and stamped as derived ──
    const kids = inserts(fake, schema.children);
    expect(kids).toEqual([
      // Both ages were stated in bare YEARS ("Maya is 4, Leo is 1"), so each covers a
      // 12-month band and the stored date is its midpoint: 48 + 6 and 12 + 6 back.
      {
        familyId: expect.any(String),
        name: 'Maya',
        dateOfBirth: '2022-01-30',
        dobPrecision: 'derived',
      },
      {
        familyId: expect.any(String),
        name: 'Leo',
        dateOfBirth: '2025-01-30',
        dobPrecision: 'derived',
      },
    ]);

    // ── the channel: verified by origination, hashed + encrypted ──
    const [channel] = inserts(fake, schema.parentChannels);
    expect(channel).toMatchObject({ kind: 'sms', verifiedAt: NOW });
    expect(channel?.phoneE164Hash).toMatch(/^[0-9a-f]{64}$/);
    expect(channel?.phoneE164Encrypted).not.toContain('416');

    // ── the watch offer went out ──
    expect(transport.bodies().at(-1)).toContain(WATCH_OFFER);

    const answered = await text(fake, transport, deps, 'yes please');
    expect(answered).toEqual({
      status: 'watch_recorded',
      intent: 'assent',
      granted: true,
      nameAsked: true,
    });
    expect(transport.bodies().at(-1)).toBe(`${ASSENT_ACK} ASK`);
  });

  /**
   * The consent turn ends on a real question - the composed identity ask - and then
   * CLOSES the session, so the answer to it always lands after intake is over.
   * That is deliberate, not a gap: the reply belongs to the coach, and the machine's job
   * is to decline it cleanly so A3 can record it and queue it (twilio/inbound.ts
   * handOffToConversation). The bug this guards against is the machine answering it
   * itself with a canned intake line, which would teach a parent that the question was
   * rhetorical.
   */
  it('hands the answer to its own closing question to the coach, rather than replying', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes please')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    await text(fake, transport, deps, 'yes please');
    // The ack, plus the composed identity ask appended to it — the turn's one question.
    expect(transport.bodies().at(-1)).toBe(`${ASSENT_ACK} ASK`);
    const sentDuringIntake = transport.bodies().length;

    // The parent answers the question the consent turn just asked. The session is
    // complete, so the machine must not answer it itself.
    const answer = await text(fake, transport, deps, 'bedtime, honestly. it takes two hours');

    expect(answer).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    // Nothing was sent back HERE — the reply is the coach's turn to take, and a second
    // intake message would be Hale talking over its own question.
    expect(transport.bodies()).toHaveLength(sentDuringIntake);
  });

  /**
   * Inbound rows the machine writes are born marked handed off. The reconciler treats
   * an unmarked inbound row as a text C1 was never given and re-drives it — which for
   * an intake turn meant the coach answering a parent's onboarding messages a second
   * time, minutes later and out of context. The machine consumed the text in this very
   * request; the ledger must say so from the start.
   */
  it('marks its inbound rows consumed at birth, so the reconciler never re-drives them', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes please')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    await text(fake, transport, deps, 'yes please');

    const inbound = inserts(fake, schema.channelMessages).filter((r) => r.direction === 'in');
    expect(inbound.length).toBeGreaterThan(0);
    for (const row of inbound) {
      expect(row.handedOffAt).toBeInstanceOf(Date);
    }
  });

  /**
   * THE NAME ASK. Nothing in the SMS product ever collected a parent's own name — intake
   * writes `users.name = null` and the only writers are the mobile onboarding body and the
   * authed web settings form — so a text-born family stayed nameless forever, which is
   * what the introduction email could not greet.
   */
  describe('the identity ask on the consent turn', () => {
    async function consent(h: ReturnType<typeof harness>) {
      await text(h.fake, h.transport, h.deps, 'hi');
      await text(h.fake, h.transport, h.deps, 'Maya is 4, Leo is 1. M5V 2T6');
      return text(h.fake, h.transport, h.deps, 'yes please');
    }

    it("asks for a name once, appended to the acknowledgment as the turn's one question", async () => {
      const h = harness({ intents: [assent('yes please')] });

      await consent(h);

      expect(h.identityAsk.calls).toEqual([{ reason: 'getting_started', missing: ['name'] }]);
      expect(h.transport.bodies().at(-1)).toBe(`${ASSENT_ACK} ASK`);
      // ONE text, not two: a parent who has just agreed to something and gets two replies
      // has been answered by a system.
      expect(h.transport.bodies().filter((b) => b.startsWith('Done -'))).toHaveLength(1);
    });

    /**
     * The stamp is the whole reason the answer is findable. Intake's messages are
     * otherwise anonymous — the transcript is their record — and a capture handler running
     * on a later, separate turn cannot read a transcript.
     */
    it('stamps the ledger row so the name capture can find the question', async () => {
      const h = harness({ intents: [assent('yes please')] });

      await consent(h);

      const asks = inserts(h.fake, schema.channelMessages).filter(
        (row) => row.templateKey === 'parent_name_ask',
      );
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ direction: 'out', status: 'queued' });
    });

    /**
     * A deferral costs the name, never the acknowledgment. The parent is covered and was
     * told so; the intros gap-fill asks again later if it ever actually needs one.
     */
    it('sends a whole acknowledgment with no question when the composer defers', async () => {
      const h = harness({
        intents: [assent('yes please')],
        identityAsk: new FakeIdentityAsk({ status: 'deferred', reason: 'model_failed' }),
      });

      const answered = await consent(h);

      expect(answered).toEqual({
        status: 'watch_recorded',
        intent: 'assent',
        granted: true,
        nameAsked: false,
      });
      expect(h.transport.bodies().at(-1)).toBe(ASSENT_ACK);
      // Nothing was stamped, so no stray word is captured as a name later.
      expect(
        inserts(h.fake, schema.channelMessages).filter((r) => r.templateKey === 'parent_name_ask'),
      ).toEqual([]);
    });

    it('never asks a parent who declined the watch - there is no turn to ask on', async () => {
      const h = harness({
        intents: [{ intent: 'decline', verbatim: 'no thanks', interpretation: 'declined' }],
      });

      await consent(h);

      expect(h.identityAsk.calls).toEqual([]);
      expect(h.transport.bodies().at(-1)).toBe(DECLINE_ACK);
    });
  });

  it('records the consent evidence BEFORE the family is flipped to sms_active', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes!')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    await text(fake, transport, deps, 'yes!');

    const consentIndex = fake.writes.findIndex(
      (w) =>
        w.op === 'insert' &&
        w.table === schema.consentRecords &&
        w.payload.consentType === 'proactive_watch',
    );
    const flipIndex = fake.writes.findIndex(
      (w) =>
        w.op === 'update' &&
        w.table === schema.families &&
        w.payload.onboardingStage === 'sms_active',
    );
    expect(consentIndex).toBeGreaterThanOrEqual(0);
    expect(flipIndex).toBeGreaterThan(consentIndex);

    const consent = fake.writes[consentIndex]?.payload as Record<string, unknown>;
    expect(consent.granted).toBe(true);
    expect(consent.evidence).toMatchObject({
      question: WATCH_OFFER,
      verbatimReply: 'yes!',
      interpretation: 'plain yes',
      channelMessageId: expect.any(String),
    });
  });

  it('records a DECLINE as a granted=false consent row, not as an absent one', async () => {
    const { fake, transport, deps } = harness({ intents: [decline('no thanks')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const result = await text(fake, transport, deps, 'no thanks');

    expect(result).toEqual({
      status: 'watch_recorded',
      intent: 'decline',
      granted: false,
      nameAsked: false,
    });
    expect(transport.bodies().at(-1)).toBe(DECLINE_ACK);
    const watch = inserts(fake, schema.consentRecords).find(
      (c) => c.consentType === 'proactive_watch',
    );
    expect(watch?.granted).toBe(false);
  });
});

/**
 * VIL-260 · WS1 — the age a parent SPOKE has to be the age Hale reads back.
 *
 * A stated age is a band, and only a bare year count ("she's four") is 12 months wide.
 * "18 months" is a point the parent already narrowed for us, so aging it by another
 * half-year is not a midpoint, it is an error — and an unrecoverable one, because every
 * downstream consumer re-derives the age OUT of the stored date.
 */
describe("intake · the handoff into the parent's own thread", () => {
  /**
   * The seam this closes. Intake answers its own questions right up until it stops:
   * the moment the session closes, the NEXT text is a coach turn, and the coach reads
   * `messages` and only `messages` (`channel_messages` stores `body: null`, rule #1).
   * So every sentence intake says AFTER provisioning — the radar, the consent ask, and
   * the name ask it hands over on — has to be in the thread, or the coach picks up a
   * conversation whose last five turns it cannot see.
   */
  it('threads every sentence it says once the family exists', async () => {
    const { fake, transport, deps, threaded } = harness({});

    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4 and Leo is 1, M5V');
    await text(fake, transport, deps, 'yes please');

    // The radar + watch offer, then the consent ack carrying the name ask — the exact
    // question the parent's first coach turn answers.
    expect(threaded.map((t) => t.body)).toEqual([
      transport.bodies().at(-2),
      transport.bodies().at(-1),
    ]);
    expect(threaded.at(-1)?.body).toBe(`${ASSENT_ACK} ASK`);
    expect(threaded.every((t) => t.familyId.length > 0 && t.parentUserId.length > 0)).toBe(true);
  });

  it('threads nothing before the family exists, because there is no thread to write to', async () => {
    // Not a silent skip — a structural one. `conversations` is family-scoped, and a
    // number that has only said "hi" has no family row yet. The pre-account transcript
    // lives encrypted on the intake session, and provisioning replays it into
    // channel_messages; what the coach needs is everything from the radar on, which the
    // test above pins.
    const { fake, transport, deps, threaded } = harness({});

    await text(fake, transport, deps, 'hi');

    expect(transport.bodies()).toHaveLength(1);
    expect(threaded).toEqual([]);
  });
});

describe('intake · the age the parent stated', () => {
  /** Read a child row back the way production does: age out of the stored date. */
  function storedAge(fake: FakeDb, index = 0): number {
    const row = inserts(fake, schema.children)[index] as { dateOfBirth: string };
    return ageInMonths(row.dateOfBirth, NOW);
  }

  it('stores "18 months" as eighteen months, and the 18-month checkpoints fire for her', async () => {
    const { fake, transport, deps } = harness({
      extractions: [
        {
          children: [{ name: 'Mia', ageMonths: 18, agePrecision: 'months' }],
          postalCode: 'L3R',
        },
      ],
    });
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'Mia is 18 months, L3R');
    expect(result.status).toBe('provisioned');

    expect(storedAge(fake)).toBe(18);

    // The reason it matters: both 18-month rows are minMonths 18 / maxMonths 23, and
    // the matcher never widens the LATE edge. A child stored at 24 can never be shown
    // Ontario's Enhanced 18-month well-baby visit, and only ages further past it.
    const matches = matchHealthCheckpoints({
      children: [
        {
          id: 'child-1',
          name: 'Mia',
          ageMonths: storedAge(fake),
          dobPrecision: 'derived',
          isTeen: false,
        },
      ],
      areaCoarse: 'L3R',
      suppressedRefs: new Set<string>(),
      now: NOW,
    });
    expect(matches.map((m) => m.checkpoint.id).sort()).toEqual([
      'immunization_18_months',
      'well_baby_18_months',
    ]);
  });

  it('leaves a bare year statement on its band midpoint, where the half-year IS the estimate', async () => {
    const { fake, transport, deps } = harness({
      extractions: [
        { children: [{ name: 'Ines', ageMonths: 48, agePrecision: 'years' }], postalCode: 'L3R' },
      ],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Ines is 4, L3R');
    // "she's four" is anywhere in [48, 60): 54 is the read with the smallest worst case.
    expect(storedAge(fake)).toBe(54);
  });

  it('does not age a six-week-old into a seven-month-old', async () => {
    const { fake, transport, deps } = harness({
      extractions: [
        { children: [{ name: null, ageMonths: 1, agePrecision: 'months' }], postalCode: 'L7G' },
      ],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'just one, she was born 6 weeks ago. L7G');
    expect(storedAge(fake)).toBe(1);
  });

  it('keeps a preschooler a toddler: "3 and a half" does not cross the 48-month stage line', async () => {
    const { fake, transport, deps } = harness({
      extractions: [
        { children: [{ name: 'Ben', ageMonths: 42, agePrecision: 'months' }], postalCode: 'L3R' },
      ],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Ben is 3 and a half, L3R');
    expect(storedAge(fake)).toBe(42);
    expect(storedAge(fake)).toBeLessThan(48);
  });
});

/**
 * VIL-260 · WS1 — a child whose age we were never told.
 *
 * The old path invented one (`deriveDateOfBirth(0)` — a six-month-old), which is the
 * one thing this module refuses to do everywhere else: it will not complete a postal
 * code, will not guess a country, and will not invent a name. An age is no different,
 * and it is worse in consequence, because the invented date is what every checkpoint,
 * stage and registration band is computed from afterwards.
 */
describe('intake · a child with no age', () => {
  const NAMES_ONLY: IntakeCollected = {
    children: [
      { name: 'Nora', ageMonths: null, agePrecision: null },
      { name: 'Ben', ageMonths: null, agePrecision: null },
    ],
    postalCode: 'M5V 2T6',
  };

  it('provisions NOTHING and spends the one follow-up asking for the ages', async () => {
    const { fake, transport, deps } = harness({ extractions: [NAMES_ONLY] });
    await text(fake, transport, deps, 'hi');

    const asked = await text(fake, transport, deps, 'Nora and Ben, M5V');
    expect(asked).toEqual({ status: 'follow_up_asked' });
    expect(transport.bodies().at(-1)).toBe('Got it - Nora and Ben. Last thing: how old are they?');
    expect(inserts(fake, schema.children)).toHaveLength(0);
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });

  it('provisions once the ages arrive, with the ages the parent actually gave', async () => {
    const { fake, transport, deps } = harness({
      extractions: [
        NAMES_ONLY,
        {
          children: [
            { name: 'Nora', ageMonths: 48, agePrecision: 'years' },
            { name: 'Ben', ageMonths: 18, agePrecision: 'months' },
          ],
          postalCode: 'M5V 2T6',
        },
      ],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Nora and Ben, M5V');
    const provisioned = await text(fake, transport, deps, '4 and 18 months');

    expect(provisioned.status).toBe('provisioned');
    expect(inserts(fake, schema.children)).toEqual([
      {
        familyId: expect.any(String),
        name: 'Nora',
        dateOfBirth: '2022-01-30',
        dobPrecision: 'derived',
      },
      {
        familyId: expect.any(String),
        name: 'Ben',
        dateOfBirth: '2025-01-30',
        dobPrecision: 'derived',
      },
    ]);
  });

  it('states the blocker once and then goes quiet, exactly as a missing postal code does', async () => {
    const { fake, transport, deps } = harness({ extractions: [NAMES_ONLY] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Nora and Ben, M5V');
    const before = transport.bodies().length;

    const second = await text(fake, transport, deps, "they're little");
    expect(second).toEqual({ status: 'details_blocked', missing: ['ages'] });
    expect(transport.bodies()).toHaveLength(before + 1);
    expect(transport.bodies().at(-1)).toBe(detailsBlocked(['ages']));

    const third = await text(fake, transport, deps, 'still little');
    expect(third).toEqual({ status: 'details_blocked', missing: ['ages'] });
    expect(transport.bodies()).toHaveLength(before + 1);
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });

  it('holds the venue-QR single-message path too, where the area needs no asking', async () => {
    // A QR first message carries the venue's own area, so the ONLY thing outstanding is
    // the ages — and that path reached provisioning in one message before this gate.
    const { fake, transport, deps } = harness({
      extractions: [{ children: NAMES_ONLY.children, postalCode: null }],
    });
    await text(fake, transport, deps, 'HALE LIBRARY');

    const asked = await text(fake, transport, deps, 'Nora and Ben');
    expect(asked).toEqual({ status: 'follow_up_asked' });
    expect(transport.bodies().at(-1)).toBe('Got it - Nora and Ben. Last thing: how old are they?');
    expect(inserts(fake, schema.children)).toHaveLength(0);
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });

  it('asks for both in ONE message when the ages and the postal code are missing', async () => {
    const { fake, transport, deps } = harness({
      extractions: [{ children: NAMES_ONLY.children, postalCode: null }],
    });
    await text(fake, transport, deps, 'hi');

    const asked = await text(fake, transport, deps, 'Nora and Ben');
    expect(asked).toEqual({ status: 'follow_up_asked' });
    expect(transport.bodies().at(-1)).toBe(
      "Got it - Nora and Ben. Last thing: how old are they, and what's your postal code?",
    );
  });
});

/**
 * VIL-260 · WS1 — the first reply is the one message a stranger is guaranteed to read,
 * and a family four milliseconds old has nothing on file for it to be built from.
 */
describe('intake · seeding the first radar', () => {
  it('places the family near its civic sessions BEFORE composing, and kicks discovery', async () => {
    const { fake, transport, deps, steps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    // Order is the assertion: an inline projection composed AFTER the radar could not
    // have reached it, which is exactly the bug. The centroid rides along, so the
    // FIRST radar is distance-filtered like every later one (VIL-260 · WS5).
    expect(steps).toEqual([
      `civic:family:M5V:${M5V_CENTRE.lat},${M5V_CENTRE.lng}`,
      'discovery:family',
      'radar:M5V',
    ]);
  });

  it('still seeds — unplaced — when the coarse area cannot be geocoded', async () => {
    // A Places miss must cost this family PROXIMITY, not their first radar: an
    // unplaced projection still has its municipality gate to fall back on.
    const { fake, transport, deps, steps } = harness({ resolveCenter: async () => null });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    expect(steps).toEqual(['civic:family:M5V:unplaced', 'discovery:family', 'radar:M5V']);
  });

  it('seeds unplaced rather than dying when the geocoder itself throws', async () => {
    const { fake, transport, deps, steps } = harness({
      resolveCenter: async () => {
        throw new Error('places quota exhausted');
      },
    });
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    expect(result.status).toBe('provisioned');
    expect(steps).toEqual(['civic:family:M5V:unplaced', 'discovery:family', 'radar:M5V']);
  });

  it('never lets a seeding failure cost a family their intake', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6', {
      ...deps,
      seedCivic: async () => {
        throw new Error('civic sessions table is unreachable');
      },
      discoveryTrigger: () => {
        throw new Error('no request scope');
      },
    });

    expect(result.status).toBe('provisioned');
    expect(transport.bodies().at(-1)).toContain(WATCH_OFFER);
  });

  it('does not seed anything for a conversation that never provisioned', async () => {
    const { fake, transport, deps, steps } = harness({
      extractions: [{ children: MAYA_AND_LEO.children, postalCode: '10001' }],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya 4, Leo 1, 10001');
    expect(steps).toEqual([]);
  });
});

describe('intake · the one follow-up', () => {
  it('asks exactly one targeted follow-up when only the postal code is missing', async () => {
    const { fake, transport, deps } = harness({ extractions: [NO_POSTAL, MAYA_AND_LEO] });
    await text(fake, transport, deps, 'hi');

    const asked = await text(fake, transport, deps, 'Maya is 4 and Leo is 1');
    expect(asked).toEqual({ status: 'follow_up_asked' });
    expect(transport.bodies().at(-1)).toBe(
      "Got it - Maya (4) and Leo (1). Last thing: what's your postal code?",
    );

    const provisioned = await text(fake, transport, deps, 'M5V 2T6');
    expect(provisioned.status).toBe('provisioned');
  });

  it('never asks a second time — it states the blocker once, then goes quiet', async () => {
    const { fake, transport, deps } = harness({ extractions: [NO_POSTAL] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4 and Leo is 1');
    const before = transport.bodies().length;

    const second = await text(fake, transport, deps, "I'd rather not say");
    expect(second).toEqual({ status: 'details_blocked', missing: ['location'] });
    // One blocker line, and it is NOT the follow-up question again.
    expect(transport.bodies()).toHaveLength(before + 1);
    expect(transport.bodies().at(-1)).toBe(detailsBlocked(['location']));
    expect(transport.bodies().at(-1)).not.toContain("What's your postal code?");

    const third = await text(fake, transport, deps, 'still not saying');
    expect(third).toEqual({ status: 'details_blocked', missing: ['location'] });
    expect(transport.bodies()).toHaveLength(before + 1); // silence, not a third ask
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });
});

describe('intake · a bare FSA', () => {
  it('provisions on an FSA alone, as the coarse area with no full postal code (D2)', async () => {
    const { fake, transport, deps } = harness({
      extractions: [{ children: MAYA_AND_LEO.children, postalCode: 'l3r' }],
    });
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'Maya is 4, Leo is 1, we are over in l3r');

    expect(result.status).toBe('provisioned');
    expect(inserts(fake, schema.families)[0]).toMatchObject({
      country: 'Canada',
      postalCode: null,
      areaCoarse: 'L3R',
    });
    // The two wrong answers this fixture exists to rule out: asking for the postal
    // code we were just given, and refusing a Markham family as out-of-region.
    expect(transport.bodies()).not.toContain(detailsBlocked(['location']));
    expect(transport.bodies()).not.toContain(REGION_UNAVAILABLE_REPLY);
  });
});

describe('intake · the region gate', () => {
  it('refuses a non-Canadian postal code and provisions NOTHING', async () => {
    const { fake, transport, deps } = harness({
      extractions: [{ children: MAYA_AND_LEO.children, postalCode: '10001' }],
    });
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'Maya 4, Leo 1, 10001');

    expect(result).toEqual({ status: 'region_unavailable' });
    expect(transport.bodies().at(-1)).toBe(REGION_UNAVAILABLE_REPLY);
    expect(inserts(fake, schema.families)).toHaveLength(0);
    expect(inserts(fake, schema.children)).toHaveLength(0);
    expect(inserts(fake, schema.parentChannels)).toHaveLength(0);
  });
});

describe('intake · ambiguity', () => {
  it('clarifies once, then records a conservative NO rather than guessing yes', async () => {
    const { fake, transport, deps } = harness({
      intents: [ambiguous('what would you even watch?'), ambiguous('hmm')],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const clarified = await text(fake, transport, deps, 'what would you even watch?');
    expect(clarified).toEqual({ status: 'clarified' });
    expect(transport.bodies().at(-1)).toBe(AMBIGUOUS_CLARIFY);

    const resolved = await text(fake, transport, deps, 'hmm');
    expect(resolved).toEqual({
      status: 'watch_recorded',
      intent: 'ambiguous',
      granted: false,
      nameAsked: false,
    });
    // Only ONE clarification, ever.
    expect(transport.bodies().filter((b) => b === AMBIGUOUS_CLARIFY)).toHaveLength(1);

    const watch = inserts(fake, schema.consentRecords).find(
      (c) => c.consentType === 'proactive_watch',
    );
    expect(watch?.granted).toBe(false);
    expect((watch?.evidence as Record<string, unknown>).interpretation).toContain('recorded as no');
  });
});

describe('intake · a question mid-signup gets an answer', () => {
  /**
   * THE LIVE INCIDENT (founder's test, 2026-08-12). Three texts in, consent outstanding,
   * the parent asked "Does Sebastian needs eye exam?" and Hale replied with its own
   * question again. Nobody answered them.
   *
   * The composed body is deliberately not a plausible sentence: what Hale SAYS is the
   * gates' job (answer.test.ts) and the eval's (rule #8). What this file owns is that the
   * turn is ANSWERED, that Hale's question comes back with it, and that the step holds.
   */
  const ANSWER = 'ANSWER';
  const RETURN = 'RETURN?';

  it('answers the question, returns to the ask, and does not move the step', async () => {
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: `${ANSWER} ${RETURN}`,
    });
    const { fake, transport, deps } = harness({
      intents: [ambiguous('Does Sebastian needs eye exam?')],
      answerComposer: composer,
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const answered = await text(fake, transport, deps, 'Does Sebastian needs eye exam?');
    expect(answered).toEqual({ status: 'question_answered', source: 'composed' });

    // BOTH halves in the one text: their answer, and Hale's question back — and never
    // the sentence the machine would have re-asked with.
    const reply = transport.bodies().at(-1) as string;
    expect(reply).toContain(ANSWER);
    expect(reply).toContain(RETURN);
    expect(reply).not.toBe(AMBIGUOUS_CLARIFY);

    // The composer saw the parent's words and Hale's own ask — and no session state,
    // no postal code, no family id (rule #1).
    expect(composer.calls).toEqual([
      {
        parentWords: 'Does Sebastian needs eye exam?',
        pendingAsk: WATCH_OFFER_ASK,
        children: MAYA_AND_LEO.children,
      },
    ]);

    // THE STEP HELD: still awaiting the watch reply, no clarification spent, and not one
    // consent row written out of a question.
    const [session] = fake.rows(schema.smsIntakeSessions);
    expect(session).toMatchObject({ state: 'awaiting_watch_reply', clarifyCount: 0 });
    expect(
      inserts(fake, schema.consentRecords).filter((c) => c.consentType === 'proactive_watch'),
    ).toHaveLength(0);
  });

  it('still clarifies once when the reply is a wobble rather than a question', async () => {
    // Same seam, composer finding nothing to answer: the pre-existing behaviour, intact.
    const { fake, transport, deps } = harness({ intents: [ambiguous('hmm, maybe')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    expect(await text(fake, transport, deps, 'hmm, maybe')).toEqual({ status: 'clarified' });
    expect(transport.bodies().at(-1)).toBe(AMBIGUOUS_CLARIFY);
  });

  it('answers a question asked before the family exists, keeping the follow-up unspent', async () => {
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: `${ANSWER} ${RETURN}`,
    });
    const { fake, transport, deps } = harness({
      extractions: [{ children: [], postalCode: null }, MAYA_AND_LEO],
      answerComposer: composer,
    });
    await text(fake, transport, deps, 'hi');

    const answered = await text(fake, transport, deps, 'who is this exactly?');
    expect(answered).toEqual({ status: 'question_answered', source: 'composed' });
    expect(transport.bodies().at(-1)).not.toBe(HELP_REPLY);
    expect(composer.calls[0]?.pendingAsk).toBe(COLD_START_ASK);

    // Nothing was consumed by answering: the ask is still open and still provisions.
    const [session] = fake.rows(schema.smsIntakeSessions);
    expect(session).toMatchObject({ state: 'awaiting_details', followUpCount: 0 });
    expect((await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6')).status).toBe(
      'provisioned',
    );
  });

  it('sends the fixed safety line alone - no signup question after it', async () => {
    const composer = new FakeAnswerComposer({ status: 'safety' });
    const { fake, transport, deps } = harness({
      intents: [ambiguous("she's not breathing")],
      answerComposer: composer,
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const answered = await text(fake, transport, deps, "she's not breathing");
    expect(answered).toEqual({ status: 'question_answered', source: 'safety' });
    expect(transport.bodies().at(-1)).toBe(SAFETY_REPLY);
  });
});

describe('intake · CASL keywords', () => {
  it('STOP before provisioning acks and provisions nothing', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'STOP');

    expect(result).toEqual({ status: 'stopped' });
    expect(transport.bodies().at(-1)).toBe(STOP_ACK);
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });

  it('STOP after provisioning revokes the channel and appends a consent withdrawal', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const result = await text(fake, transport, deps, 'unsubscribe');
    expect(result).toEqual({ status: 'stopped' });

    const revoke = fake.writes.find(
      (w) => w.op === 'update' && w.table === schema.parentChannels && w.payload.revokedAt,
    );
    expect(revoke).toBeDefined();
    const withdrawal = inserts(fake, schema.consentRecords).find(
      (c) => c.consentType === 'sms_service_messages' && c.granted === false,
    );
    expect(withdrawal).toBeDefined();
  });

  it('records the STOP even when Twilio permanently refuses the ack (21610 — the carrier already told them)', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const result = await text(fake, transport, deps, 'STOP', {
      ...deps,
      transport: refusingTransport(new TwilioSendError('21610', 400)),
    });

    // The unsubscribe is the thing that must survive: an undeliverable courtesy line is
    // not a reason to leave a parent subscribed and the conversation open.
    expect(result).toEqual({ status: 'stopped' });
    const closed = fake.writes.find(
      (w) =>
        w.op === 'update' && w.table === schema.smsIntakeSessions && w.payload.state === 'stopped',
    );
    expect(closed).toBeDefined();
    const revoke = fake.writes.find(
      (w) => w.op === 'update' && w.table === schema.parentChannels && w.payload.revokedAt,
    );
    expect(revoke).toBeDefined();
  });

  it('positive control: a provider OUTAGE on the same ack still fails the turn — only a permanent refusal counts as delivered', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    await expect(
      text(fake, transport, deps, 'STOP', {
        ...deps,
        transport: refusingTransport(new TwilioSendError('20500', 503)),
      }),
    ).rejects.toBeInstanceOf(TwilioSendError);
    // Still recorded first — the STOP does not wait on the ack to become durable.
    expect(
      fake.writes.some(
        (w) =>
          w.op === 'update' &&
          w.table === schema.smsIntakeSessions &&
          w.payload.state === 'stopped',
      ),
    ).toBe(true);
  });

  it('never routes a keyword through the model', async () => {
    const extractor = new FakeExtractor([MAYA_AND_LEO]);
    const intentReader = new FakeIntentReader([assent('yes')]);
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const deps: IntakeDeps = {
      transport,
      threadMessage: async () => 'conv-1',
      extractor,
      intentReader,
      radar: fakeRadar,
      ackComposer: fakeAckComposer,
      answerComposer: fakeSilentAnswerComposer,
      identityAsk: new FakeIdentityAsk(),
      limiter: new FakeRateLimiter(() => NOW.getTime()),
      now: NOW,
    };
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'STOP');
    // The greeting turn never extracts either — only the details turn does.
    expect(extractor.calls).toHaveLength(0);
    expect(intentReader.calls).toHaveLength(0);
  });

  it('HELP answers with the capability line without ending the conversation', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    const helped = await text(fake, transport, deps, 'HELP');
    expect(helped).toEqual({ status: 'helped' });
    expect(transport.bodies().at(-1)).toBe(HELP_REPLY);

    // Still mid-intake: the next real answer still provisions.
    const provisioned = await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    expect(provisioned.status).toBe('provisioned');
  });

  it('START after a STOP re-enrols on the keyword itself, keeping the revoked row', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    await text(fake, transport, deps, 'STOP');

    const restarted = await text(fake, transport, deps, 'START');
    expect(restarted).toEqual({ status: 'restarted' });

    const channels = inserts(fake, schema.parentChannels);
    expect(channels).toHaveLength(2); // a NEW row, never an un-revoke of the old one
    const consents = inserts(fake, schema.consentRecords).filter(
      (c) => c.consentType === 'sms_service_messages' && c.granted === true,
    );
    expect(consents.at(-1)?.evidence).toMatchObject({
      verbatimReply: 'START',
      interpretation: 'CASL START keyword sent from the number itself',
    });
  });
});

describe('intake · guards', () => {
  it('goes silent over the per-number rate limit — never replies to a flood', async () => {
    const limiter = new FakeRateLimiter(() => NOW.getTime());
    const { fake, transport, deps } = harness({ limiter });
    // Burn the hourly allowance on this number.
    for (let i = 0; i < 30; i += 1) {
      await limiter.check(
        // The machine keys on the blind index; any consistent key exercises the window.
        (await import('~/lib/crypto/blind-index')).phoneBlindIndex(PHONE),
        'sms-inbound',
        { limit: 30, windowSec: 3600 },
      );
    }

    const result = await text(fake, transport, deps, 'hi');
    expect(result).toEqual({ status: 'rate_limited' });
    expect(transport.sent).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
  });

  it('still unsubscribes a rate-limited ARRET — a CASL keyword is never throttled away', async () => {
    const limiter = new FakeRateLimiter(() => NOW.getTime());
    const { fake, transport, deps } = harness({ limiter });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const hash = phoneBlindIndex(PHONE);
    for (let i = 0; i < RATE_LIMITS['sms-inbound'].limit; i += 1) {
      await limiter.check(hash, 'sms-inbound', RATE_LIMITS['sms-inbound']);
    }

    // The control: ordinary traffic through the SAME exhausted limiter is still silenced,
    // so the assertion below is about the keyword and not about a limiter that stopped
    // limiting.
    expect(await text(fake, transport, deps, 'what about swimming lessons?')).toEqual({
      status: 'rate_limited',
    });

    const result = await text(fake, transport, deps, 'ARRET');

    expect(result).toEqual({ status: 'stopped' });
    expect(transport.bodies().at(-1)).toBe(STOP_ACK_BY_LANGUAGE.fr);
    const revoke = fake.writes.find(
      (w) => w.op === 'update' && w.table === schema.parentChannels && w.payload.revokedAt,
    );
    expect(revoke).toBeDefined();
  });

  it('treats a carrier retry of the same provider id as a no-op', async () => {
    const { fake, transport, deps } = harness({});
    const first = transport.inbound(PHONE, 'hi');
    await handleInboundSms(fake.db, first, deps);
    const sentAfterFirst = transport.sent.length;
    const writesAfterFirst = fake.writes.length;

    const retry = await handleInboundSms(fake.db, { ...first }, deps);
    expect(retry).toEqual({ status: 'duplicate' });
    expect(transport.sent).toHaveLength(sentAfterFirst);
    expect(fake.writes).toHaveLength(writesAfterFirst);
  });

  it('ignores a number it cannot canonicalize (there is nobody to answer)', async () => {
    const { fake, transport, deps } = harness({});
    const result = await handleInboundSms(fake.db, transport.inbound('12345', 'hi'), deps);
    expect(result).toEqual({ status: 'ignored', reason: 'invalid_number' });
    expect(transport.sent).toHaveLength(0);
  });
});

/**
 * THE FRENCH ROUTING, proven through the machine rather than through the table.
 *
 * copy.test.ts pins the words; this pins that a parent who wrote French actually
 * RECEIVES them — the detector is read at the send site, off the body that just arrived.
 * Every assertion has its English twin beside it, because a table that always returned
 * French would pass the first half of each of these on its own.
 */
describe('intake · answers in the language the parent wrote in', () => {
  it('greets a French first message in French, and an English one in English', async () => {
    const fr = harness({});
    expect(await text(fr.fake, fr.transport, fr.deps, 'Bonjour')).toEqual({ status: 'greeted' });
    expect(fr.transport.bodies()[0]).toBe(greeting(null, 'fr'));

    const en = harness({});
    await text(en.fake, en.transport, en.deps, 'hi');
    expect(en.transport.bodies()[0]).toBe(greeting(null, 'en'));
  });

  it('refuses an out-of-region French family in French, and provisions nothing', async () => {
    const { fake, transport, deps } = harness({
      extractions: [{ children: MAYA_AND_LEO.children, postalCode: '75008' }],
    });
    await text(fake, transport, deps, 'Bonjour');
    const result = await text(fake, transport, deps, 'Mes enfants ont 4 ans et 1 an, 75008');

    expect(result).toEqual({ status: 'region_unavailable' });
    expect(transport.bodies().at(-1)).toBe(REGION_UNAVAILABLE_REPLY_BY_LANGUAGE.fr);
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });

  it('clarifies a wobbly French answer in French', async () => {
    const { fake, transport, deps } = harness({
      intents: [ambiguous('vous surveillez quoi au juste?')],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const clarified = await text(fake, transport, deps, 'vous surveillez quoi au juste?');
    expect(clarified).toEqual({ status: 'clarified' });
    expect(transport.bodies().at(-1)).toBe(AMBIGUOUS_CLARIFY_BY_LANGUAGE.fr);
  });

  it('takes a French no in French and an English no in English', async () => {
    const fr = harness({ intents: [decline('non merci')] });
    await text(fr.fake, fr.transport, fr.deps, 'hi');
    await text(fr.fake, fr.transport, fr.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    await text(fr.fake, fr.transport, fr.deps, 'non merci');
    expect(fr.transport.bodies().at(-1)).toBe(DECLINE_ACK_BY_LANGUAGE.fr);

    const en = harness({ intents: [decline('no thanks')] });
    await text(en.fake, en.transport, en.deps, 'hi');
    await text(en.fake, en.transport, en.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    await text(en.fake, en.transport, en.deps, 'no thanks');
    expect(en.transport.bodies().at(-1)).toBe(DECLINE_ACK);
  });

  /**
   * The consent acknowledgment, and the one place the French turn deliberately gives
   * something up. `identityAsk` composes in English and is handed no way to know what the
   * parent wrote, so the French ack goes out WHOLE and unasked rather than with an English
   * question stapled to it. `nameAsked: false` is the same outcome a deferred compose
   * produces, and the intros sweep asks again later if it ever actually needs a name.
   */
  it('confirms a French yes in French, and sends no English tail with it', async () => {
    const fr = harness({ intents: [assent('oui')] });
    await text(fr.fake, fr.transport, fr.deps, 'hi');
    await text(fr.fake, fr.transport, fr.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const recorded = await text(fr.fake, fr.transport, fr.deps, 'oui');

    expect(recorded).toMatchObject({ status: 'watch_recorded', granted: true, nameAsked: false });
    expect(fr.transport.bodies().at(-1)).toBe(ASSENT_ACK_BY_LANGUAGE.fr);
    expect(fr.transport.bodies().at(-1)).not.toContain('ASK');

    // The English twin still gets its tail, so the assertion above is about French and not
    // about the name ask having quietly stopped working for everybody.
    const en = harness({ intents: [assent('yes')] });
    await text(en.fake, en.transport, en.deps, 'hi');
    await text(en.fake, en.transport, en.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const enRecorded = await text(en.fake, en.transport, en.deps, 'yes');

    expect(enRecorded).toMatchObject({ nameAsked: true });
    expect(en.transport.bodies().at(-1)).toBe(`${ASSENT_ACK} ASK`);
  });

  /**
   * The safety line, on the intake path that reaches it: a mid-intake question the
   * composer reads as being about a hurt child. This is the message where the language
   * matters most, and both numbers have to survive the translation.
   */
  it('sends the safety line in French when the French question is about a hurt child', async () => {
    const { fake, transport, deps } = harness({
      extractions: [{ children: [], postalCode: null }],
      answerComposer: new FakeAnswerComposer({ status: 'safety' }),
    });
    await text(fake, transport, deps, 'hi');
    const out = await text(fake, transport, deps, 'Mon fils est tombé, je ne sais pas quoi faire');

    expect(out).toEqual({ status: 'question_answered', source: 'safety' });
    expect(transport.bodies().at(-1)).toBe(SAFETY_REPLY_BY_LANGUAGE.fr);
    expect(transport.bodies().at(-1)).toContain('811');
    expect(transport.bodies().at(-1)).toContain('911');
  });
});

/**
 * THE FRENCH CARRIER KEYWORDS, end to end — the CTA v2.1 §3.1 obligation proven as
 * behaviour rather than as a table entry.
 *
 * These are the turns `replyLanguage` structurally could not get right: the body IS the
 * token, so AIDE and DEBUT carry no sentence to read French out of. Each assertion is
 * therefore about the KEYWORD's language reaching the send site, and each has its
 * English twin beside it so a table that always answered French would fail.
 */
describe('intake · the French CASL keywords', () => {
  it('unsubscribes on ARRET exactly as on STOP, and confirms in French', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const result = await text(fake, transport, deps, 'ARRÊT');

    expect(result).toEqual({ status: 'stopped' });
    expect(transport.bodies().at(-1)).toBe(STOP_ACK_BY_LANGUAGE.fr);
    // The legal half: the same revocation and the same withdrawal record an English STOP
    // writes. A French unsubscribe that only answered politely would be the CASL failure.
    const revoke = fake.writes.find(
      (w) => w.op === 'update' && w.table === schema.parentChannels && w.payload.revokedAt,
    );
    expect(revoke).toBeDefined();
    const withdrawal = inserts(fake, schema.consentRecords).find(
      (c) => c.consentType === 'sms_service_messages' && c.granted === false,
    );
    expect(withdrawal).toBeDefined();
  });

  it('answers AIDE with the French capability line and HELP with the English one', async () => {
    const fr = harness({});
    await text(fr.fake, fr.transport, fr.deps, 'hi');
    expect(await text(fr.fake, fr.transport, fr.deps, 'AIDE')).toEqual({ status: 'helped' });
    expect(fr.transport.bodies().at(-1)).toBe(HELP_REPLY_BY_LANGUAGE.fr);

    const en = harness({});
    await text(en.fake, en.transport, en.deps, 'hi');
    await text(en.fake, en.transport, en.deps, 'HELP');
    expect(en.transport.bodies().at(-1)).toBe(HELP_REPLY);
  });

  it('re-enrols on DEBUT after an ARRET, and welcomes the parent back in French', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    await text(fake, transport, deps, 'ARRET');

    const restarted = await text(fake, transport, deps, 'DEBUT');

    expect(restarted).toEqual({ status: 'restarted' });
    expect(transport.bodies().at(-1)).toBe(START_ACK_BY_LANGUAGE.fr);
    // Re-consent is the keyword itself, and the record has to hold what was actually sent.
    const consents = inserts(fake, schema.consentRecords).filter(
      (c) => c.consentType === 'sms_service_messages' && c.granted === true,
    );
    expect(consents.at(-1)?.evidence).toMatchObject({ verbatimReply: 'DEBUT' });
  });
});

/**
 * THE F14 FUNNEL. Texting the number is the only way into this product, so the pair
 * below is the conversion the whole business turns on — and it is measured on a surface
 * where the identifier closest to hand is a phone number (hard rule #1).
 */
describe('intake · the funnel milestones', () => {
  function recorder() {
    const calls: Array<{
      event: string;
      distinctId: string;
      properties: Record<string, unknown>;
    }> = [];
    const capture: IntakeDeps['capture'] = async (event, distinctId, properties = {}) => {
      calls.push({ event, distinctId, properties });
      return 'sent';
    };
    return { calls, capture };
  }

  it('records the greeting as intake_started and the family as intake_completed', async () => {
    const { calls, capture } = recorder();
    const { fake, transport, deps } = harness({ capture });

    await text(fake, transport, deps, 'hi');
    expect(calls.map((c) => c.event)).toEqual(['intake_started']);

    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    expect(calls.map((c) => c.event)).toEqual(['intake_started', 'intake_completed']);
  });

  it('keys both ends on the same intake session, so they join into one funnel', async () => {
    const { calls, capture } = recorder();
    const { fake, transport, deps } = harness({ capture });

    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const [started, completed] = calls;
    expect(started?.distinctId).toBe(completed?.distinctId);
    expect(started?.distinctId).toBeTruthy();
  });

  it('never keys the funnel on the phone number, or names a child in it', async () => {
    const { calls, capture } = recorder();
    const { fake, transport, deps } = harness({ capture });

    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain('6475551234');
    expect(serialized).not.toContain('Maya');
    expect(serialized).not.toContain('M5V');
  });

  it('attributes the completed intake to the card that produced it', async () => {
    const { calls, capture } = recorder();
    const { fake, transport, deps } = harness({ capture });

    // The `(via …)` token the QR card pre-writes into the parent's first message.
    await text(fake, transport, deps, 'Hi (via earlyon-richmondhill)');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    expect(calls.at(-1)?.properties).toEqual({ source_code: 'earlyon-richmondhill' });
  });

  it('leaves source_code ABSENT when nobody handed out a card', async () => {
    const { calls, capture } = recorder();
    const { fake, transport, deps } = harness({ capture });

    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    // Null, not the string 'direct': a bucket meaning "no card" must not be able to
    // look like a card that exists. buildEvent drops it on the way out.
    expect(calls.at(-1)?.properties).toEqual({ source_code: null });
  });

  it('does not lose the parent their reply when analytics is down', async () => {
    const { fake, transport, deps } = harness({
      capture: async () => {
        throw new Error('posthog unreachable');
      },
    });

    await expect(text(fake, transport, deps, 'hi')).resolves.toEqual({ status: 'greeted' });
    expect(transport.bodies()).toHaveLength(1);
  });
});
