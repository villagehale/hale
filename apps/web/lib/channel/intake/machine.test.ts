import { schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMERGENCY_REPLY,
  MENTAL_CRISIS_REPLY,
  SAFETY_REPLY,
  SAFETY_REPLY_BY_LANGUAGE,
} from '~/lib/channel/off-domain/copy';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
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
  UNREADABLE_INTAKE_REPLY,
  WATCH_OFFER,
  WATCH_OFFER_ASK,
  detailsBlocked,
  followUpQuestion,
  greeting,
  intakeConnectorOffer,
} from './copy';
import { INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY, connectorOfferDedupeKey } from './connector-offer';
import type { IntakeCollected } from './extract';
import {
  FakeAnswerComposer,
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeAckComposer,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from './fakes';
import type { IntentReading } from './intent';
import { CHEER_UP_REPLY, NO_CURRENT_SOURCE_YET } from './live-lookup';
import { type IntakeDeps, handleInboundSms } from './machine';
import { NOT_POSTED_YET, OFFICIAL_PAGE_RETURN_ASK } from './official-page';
import { INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY } from './radar';
import { FakeTransport } from './transport';
import { claimIntakeTurn } from './turn-claim';
import { CONTACT_CARD_URL, WELCOME_CARD_BODY, WELCOME_CARD_TEMPLATE_KEY } from './welcome-card';

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
  /** VIL-360 — whether the first radar's DECISION carried a weekend pick. */
  weekendPickOffered?: boolean;
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
      openQuestions: fakeNoOpenQuestions,
      extractor: new FakeExtractor(options.extractions ?? [MAYA_AND_LEO]),
      intentReader: new FakeIntentReader(options.intents ?? [assent('yes')]),
      radar: {
        async compose(input) {
          steps.push(`radar:${input.areaCoarse}`);
          const payload = await fakeRadar.compose(input);
          return { ...payload, weekendPickOffered: options.weekendPickOffered ?? false };
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
    expect(transport.bodies()[0]).toBe(
      "Hi, I'm Hale. I find activities that fit your little one, keep sign-up mornings from sneaking up, and check in on how it goes - the whole parenting chaos. Reply with your kids' names, ages, and postal code and I'll text back what's coming.",
    );
    expect(transport.bodies()[0]).not.toContain('an AI that quietly runs the family week');
    expect(transport.bodies()[0]).not.toMatch(/I'm an AI/i);
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

    // ── the watch offer went out, with the contact card as its postscript ──
    expect(transport.bodies().at(-2)).toContain(WATCH_OFFER);
    expect(transport.bodies().at(-1)).toBe(WELCOME_CARD_BODY);

    const answered = await text(fake, transport, deps, 'yes please');
    expect(answered).toEqual({
      status: 'watch_recorded',
      intent: 'assent',
      granted: true,
      nameAsked: true,
      connectorOffer: 'sent',
    });
    // The ack carrying the name ask, then the optional connector offer behind it.
    expect(transport.bodies().at(-2)).toBe(`${ASSENT_ACK} ASK`);
    expect(transport.bodies().at(-1)).toContain('/connect?t=');
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
    // The connector offer follows it as its own message (connector-offer.ts).
    expect(transport.bodies().at(-2)).toBe(`${ASSENT_ACK} ASK`);
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
      expect(h.transport.bodies().at(-2)).toBe(`${ASSENT_ACK} ASK`);
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
        connectorOffer: 'sent',
      });
      expect(h.transport.bodies().at(-2)).toBe(ASSENT_ACK);
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
      connectorOffer: 'not_offered',
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

    // The radar + watch offer, the contact card's own line, the consent ack carrying the
    // name ask — the exact question the parent's first coach turn answers — and the
    // connector offer behind it, which a parent may well ask about next.
    expect(threaded.map((t) => t.body)).toEqual([
      transport.bodies().at(-4),
      WELCOME_CARD_BODY,
      transport.bodies().at(-2),
      transport.bodies().at(-1),
    ]);
    expect(threaded.at(-2)?.body).toBe(`${ASSENT_ACK} ASK`);
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

describe('intake · the contact card', () => {
  /**
   * The SMS-native equivalent of sharing a profile: one MMS carrying Hale's own vCard,
   * so the parent taps Add once and every later text arrives under a name and a face
   * instead of a 289 number nobody recognises.
   *
   * ITS OWN MESSAGE, immediately after the radar — never media hung on the radar itself.
   * Verified live against the prod messaging service: a MediaUrl Twilio cannot fetch
   * fails the WHOLE message (error_code 11200), body included, so attaching the card
   * would put the one message a stranger is guaranteed to read — and the consent ask
   * carrying the privacy link — behind the availability of a static file.
   */
  it('follows the first radar with one MMS carrying its own vCard', async () => {
    const { fake, transport, deps } = harness({});

    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4 and Leo is 1, M5V');

    const [greeting, radar, card] = transport.sent;
    expect(greeting?.mediaUrls).toBeUndefined();
    expect(radar?.body).toContain(WATCH_OFFER);
    expect(radar?.mediaUrls).toBeUndefined();
    expect(card).toEqual({
      to: PHONE,
      body: WELCOME_CARD_BODY,
      mediaUrls: [CONTACT_CARD_URL],
    });
  });

  it('carries the card exactly once across the whole conversation', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes please')] });

    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4 and Leo is 1, M5V');
    await text(fake, transport, deps, 'yes please');

    expect(transport.media()).toEqual([[CONTACT_CARD_URL]]);
    const cardRows = inserts(fake, schema.channelMessages).filter(
      (r) => r.templateKey === WELCOME_CARD_TEMPLATE_KEY,
    );
    expect(cardRows).toHaveLength(1);
  });

  /**
   * The reason the card is a separate send, stated as a test: the radar is already on
   * the parent's phone as plain text before the card is attempted, so a provider that
   * refuses the MMS costs the card and nothing else. The refusal is counted — the
   * claimed ledger row flips to `failed` with the code — never silently dropped.
   */
  it('loses only the card when the provider refuses media, and writes down why', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => errors.push(...args));
    const { fake, transport, deps } = harness({});
    const mediaRefusing: IntakeDeps['transport'] = {
      async send(input) {
        if (input.mediaUrls) throw new TwilioSendError('21620', 400);
        return transport.send(input);
      },
    };

    await text(fake, transport, deps, 'hi', { ...deps, transport: mediaRefusing });
    const provisioned = await text(fake, transport, deps, 'Maya is 4 and Leo is 1, M5V', {
      ...deps,
      transport: mediaRefusing,
    });

    // The intake completed and the radar landed as plain text.
    expect(provisioned.status).toBe('provisioned');
    expect(transport.bodies().at(-1)).toContain(WATCH_OFFER);
    expect(transport.media()).toEqual([]);
    // Counted, not dropped: the row that claimed the send says the provider refused it.
    expect(
      fake.writes
        .filter((w) => w.op === 'update' && w.table === schema.channelMessages)
        .map((w) => w.payload),
    ).toContainEqual({ status: 'failed', errorCode: '21620' });
    expect(JSON.stringify(errors)).toContain('21620');
    vi.restoreAllMocks();
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
    expect(transport.bodies().at(-2)).toContain(WATCH_OFFER);
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
      connectorOffer: 'not_offered',
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

    // The composer saw the parent's words, Hale's own ask, and the postal already
    // collected (rec-morning routing). No session state or family id (rule #1).
    // The model context still omits the postal — see intakeAnswerContext.
    expect(composer.calls).toEqual([
      {
        parentWords: 'Does Sebastian needs eye exam?',
        pendingAsk: WATCH_OFFER_ASK,
        children: MAYA_AND_LEO.children,
        postalCode: MAYA_AND_LEO.postalCode,
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
    expect(transport.bodies().at(-1)).toBe(EMERGENCY_REPLY);
    expect(transport.bodies().at(-1)).toBe('Call 911 now.');
    expect(transport.bodies().at(-1)).not.toContain('811');
    expect(transport.bodies().at(-1)).not.toContain('Health811');
    expect(transport.bodies().at(-1)).not.toContain('988');
    expect(transport.bodies().at(-1)).not.toContain('?');
    expect(transport.bodies().at(-1)).not.toBe(SAFETY_REPLY);
    expect(transport.bodies().at(-1)).not.toBe(MENTAL_CRISIS_REPLY);
  });

  it('never sends HELP_REPLY alone when a mid-signup rec question is declined', async () => {
    const { fake, transport, deps } = harness({
      extractions: [{ children: [], postalCode: null }],
    });
    await text(fake, transport, deps, 'hi');
    const answered = await text(fake, transport, deps, 'When do winter-break camps open?');
    expect(answered).toEqual({ status: 'question_answered', source: 'composed' });
    expect(transport.bodies().at(-1)).not.toBe(HELP_REPLY);
    expect(transport.bodies().at(-1)).toContain(NOT_POSTED_YET);
    expect(transport.bodies().at(-1)).not.toContain(COLD_START_ASK);
  });

  it('never sends HELP_REPLY alone when a mid-signup raising-kids question is declined', async () => {
    const { fake, transport, deps } = harness({
      extractions: [{ children: [], postalCode: null }],
    });
    await text(fake, transport, deps, 'hi');
    const answered = await text(fake, transport, deps, 'How do I potty train?');
    expect(answered).toEqual({ status: 'question_answered', source: 'composed' });
    expect(transport.bodies().at(-1)).not.toBe(HELP_REPLY);
    expect(transport.bodies().at(-1)).toContain(NO_CURRENT_SOURCE_YET);
    expect(transport.bodies().at(-1)).not.toContain(COLD_START_ASK);
  });
});

/**
 * VIL-322 · the greet hole. A first inbound that is a question used to open a
 * session and send greeting() only — the words were ignored. Off-script answer
 * already existed on turn 2. Site chips send the question as turn 1.
 */
describe('intake · a first-text question is answered', () => {
  const ANSWER = 'ANSWER';
  const RETURN = 'RETURN?';

  function recorder() {
    const calls: Array<{ event: string }> = [];
    const capture: IntakeDeps['capture'] = async (event) => {
      calls.push({ event });
      return 'sent';
    };
    return { calls, capture };
  }

  it('answers a rec/camp first inbound instead of the bare greeting-only path', async () => {
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: `${ANSWER} ${RETURN}`,
    });
    const { calls, capture } = recorder();
    const { fake, transport, deps } = harness({ answerComposer: composer, capture });

    const answered = await text(fake, transport, deps, 'When does swim registration open near me?');

    expect(answered).toEqual({ status: 'question_answered', source: 'composed' });
    expect(transport.bodies()).toEqual([`${ANSWER} ${RETURN}`]);
    expect(transport.bodies()[0]).not.toBe(greeting(null, 'en'));
    expect(composer.calls).toEqual([
      {
        parentWords: 'When does swim registration open near me?',
        pendingAsk: COLD_START_ASK,
        children: [],
        postalCode: null,
      },
    ]);

    const [session] = fake.rows(schema.smsIntakeSessions);
    expect(session).toMatchObject({ state: 'awaiting_details', followUpCount: 0 });
    expect(calls.map((c) => c.event)).toEqual(['intake_started']);
  });

  it("still sends greeting() for a first inbound 'hi'", async () => {
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: `${ANSWER} ${RETURN}`,
    });
    const { fake, transport, deps } = harness({ answerComposer: composer });

    expect(await text(fake, transport, deps, 'hi')).toEqual({ status: 'greeted' });
    expect(transport.bodies()).toEqual([greeting(null, 'en')]);
    expect(composer.calls).toHaveLength(0);
  });

  it('still sends the venue greeting for a QR / HALE tag', async () => {
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: `${ANSWER} ${RETURN}`,
    });
    const { fake, transport, deps } = harness({ answerComposer: composer });

    expect(await text(fake, transport, deps, 'HALE LIBRARY')).toEqual({ status: 'greeted' });
    expect(transport.bodies()).toEqual([greeting('library', 'en')]);
    expect(composer.calls).toHaveLength(0);

    const via = harness({ answerComposer: composer });
    expect(await text(via.fake, via.transport, via.deps, 'Hi (via earlyon-richmondhill)')).toEqual({
      status: 'greeted',
    });
    expect(via.transport.bodies()).toEqual([greeting('family centre', 'en')]);
    expect(composer.calls).toHaveLength(0);
  });

  it('sends the safety line alone on a first inbound - no signup ask stacked after it', async () => {
    const composer = new FakeAnswerComposer({ status: 'safety' });
    const { fake, transport, deps } = harness({ answerComposer: composer });

    const answered = await text(fake, transport, deps, "she's not breathing");
    expect(answered).toEqual({ status: 'question_answered', source: 'safety' });
    expect(transport.bodies()).toEqual([EMERGENCY_REPLY]);
    expect(transport.bodies()[0]).toBe('Call 911 now.');
    expect(transport.bodies()[0]).not.toContain('811');
    expect(transport.bodies()[0]).not.toContain('Health811');
    expect(transport.bodies()[0]).not.toContain('988');
    expect(transport.bodies()[0]).not.toContain('?');
    expect(transport.bodies()[0]).not.toContain(COLD_START_ASK);
    expect(transport.bodies()[0]).not.toBe(greeting(null, 'en'));
    expect(transport.bodies()[0]).not.toBe(SAFETY_REPLY);
  });

  it('never sends greeting() alone when a first-text rec question is declined or unavailable', async () => {
    // VIL-326: the leak. Composer finds nothing / is unusable → greet used to
    // send the locked greeting and ignore the question.
    const silent = harness({});
    const declined = await text(
      silent.fake,
      silent.transport,
      silent.deps,
      'When does swim registration open near me?',
    );
    expect(declined).toEqual({ status: 'question_answered', source: 'composed' });
    expect(silent.transport.bodies()[0]).not.toBe(greeting(null, 'en'));
    expect(silent.transport.bodies()[0]).toContain(NOT_POSTED_YET);
    expect(silent.transport.bodies()[0]).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(silent.transport.bodies()[0]).not.toContain(COLD_START_ASK);

    const composer = new FakeAnswerComposer({ status: 'unavailable', reason: 'unusable' });
    const unusable = harness({ answerComposer: composer });
    const answered = await text(
      unusable.fake,
      unusable.transport,
      unusable.deps,
      'When do winter-break camps open?',
    );
    expect(answered).toEqual({ status: 'question_answered', source: 'composed' });
    expect(unusable.transport.bodies()[0]).not.toBe(greeting(null, 'en'));
    expect(unusable.transport.bodies()[0]).toContain(NOT_POSTED_YET);
    expect(unusable.transport.bodies()[0]).not.toContain(COLD_START_ASK);
  });

  it('never sends greeting() alone when a first-text raising-kids question is declined', async () => {
    const silent = harness({});
    const declined = await text(
      silent.fake,
      silent.transport,
      silent.deps,
      'How do I get him to nap?',
    );
    expect(declined).toEqual({ status: 'question_answered', source: 'composed' });
    expect(silent.transport.bodies()[0]).not.toBe(greeting(null, 'en'));
    expect(silent.transport.bodies()[0]).toContain(NO_CURRENT_SOURCE_YET);
    expect(silent.transport.bodies()[0]).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(silent.transport.bodies()[0]).not.toContain(COLD_START_ASK);
  });

  it('never sends greeting() alone when a first-text leftover fact is declined', async () => {
    const silent = harness({});
    const declined = await text(
      silent.fake,
      silent.transport,
      silent.deps,
      'Who is the US president?',
    );
    expect(declined).toEqual({ status: 'question_answered', source: 'composed' });
    expect(silent.transport.bodies()[0]).not.toBe(greeting(null, 'en'));
    expect(silent.transport.bodies()[0]).toContain(NO_CURRENT_SOURCE_YET);
    expect(silent.transport.bodies()[0]).not.toContain(COLD_START_ASK);
  });

  it('sends the reviewed 988 line alone on a first-text crisis - no return ask', async () => {
    const silent = harness({});
    const answered = await text(silent.fake, silent.transport, silent.deps, 'I want to die');
    expect(answered).toEqual({ status: 'question_answered', source: 'safety' });
    expect(silent.transport.bodies()).toEqual([MENTAL_CRISIS_REPLY]);
    expect(silent.transport.bodies()[0]).not.toContain(COLD_START_ASK);
    expect(silent.transport.bodies()[0]).not.toContain('?');
    expect(silent.transport.bodies()[0]).not.toContain('811');
    expect(silent.transport.bodies()[0]).not.toContain('not something I should advise on');
    expect(silent.transport.bodies()[0]).not.toBe(SAFETY_REPLY);
    expect(silent.transport.bodies()[0]).not.toBe(EMERGENCY_REPLY);
    expect(silent.transport.bodies()[0]).not.toBe('Call 911 now.');
  });

  it('answers a first-text cheer-up with warmth, not the bare greeting', async () => {
    const silent = harness({});
    const answered = await text(silent.fake, silent.transport, silent.deps, 'cheer me up');
    expect(answered).toEqual({ status: 'question_answered', source: 'composed' });
    expect(silent.transport.bodies()[0]).toContain(CHEER_UP_REPLY);
    expect(silent.transport.bodies()[0]).not.toBe(greeting(null, 'en'));
    expect(silent.transport.bodies()[0]).not.toContain(COLD_START_ASK);
  });
});

/**
 * Site Text Hale prefills the first SMS as names / ages / postal. After VIL-322,
 * greet() treated anything that was not a bare hello as a question — so this
 * send got an answer + COLD_START_ASK instead of extraction. One send should
 * run intake.
 */
describe('intake · a first-text details prefill is extracted', () => {
  const SITE_PREFILL = 'Maya is 4, Theo is 18 months, L3R';
  const MAYA_AND_THEO: IntakeCollected = {
    children: [
      { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
      { name: 'Theo', ageMonths: 18, agePrecision: 'months' },
    ],
    postalCode: 'L3R',
  };

  it('extracts kids + postal on first inbound and does not greet or answer as a question', async () => {
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: `ANSWER ${COLD_START_ASK}`,
    });
    const { fake, transport, deps } = harness({
      extractions: [MAYA_AND_THEO],
      answerComposer: composer,
    });

    const result = await text(fake, transport, deps, SITE_PREFILL);

    expect(result.status).toBe('provisioned');
    expect(composer.calls).toHaveLength(0);
    expect(transport.bodies()[0]).not.toBe(greeting(null, 'en'));
    expect(transport.bodies()[0]).not.toContain('ANSWER');
    expect(transport.bodies().some((b) => b.includes(COLD_START_ASK))).toBe(false);

    const kids = inserts(fake, schema.children);
    expect(kids.map((k) => k.name)).toEqual(['Maya', 'Theo']);
    expect(inserts(fake, schema.families)[0]).toMatchObject({
      country: 'Canada',
      postalCode: null,
      areaCoarse: 'L3R',
    });
  });
});

/**
 * A first text that is nothing but a postal code — live, 2026-08-28, a brand-new
 * number whose whole first message was "M4B 2B1". It is not a hello and not a
 * question: it is half the cold-start ask, already answered. It used to be read for
 * NOTHING — greet sent the cold ask back, and the one follow-up then asked for the
 * postal code the parent had already sent.
 */
describe('intake · a first text that is only a postal code', () => {
  const MAYA_AND_LEO_IN_M4B: IntakeCollected = {
    children: MAYA_AND_LEO.children,
    postalCode: 'M4B 2B1',
  };

  it('keeps the postal from the first text and asks only for names and ages', async () => {
    const { fake, transport, deps } = harness({});
    const extractor = new FakeExtractor([MAYA_AND_LEO_IN_M4B]);
    const withExtractor: IntakeDeps = { ...deps, extractor };

    expect(await text(fake, transport, withExtractor, 'M4B 2B1')).toEqual({ status: 'greeted' });

    const greeted = transport.bodies()[0] as string;
    expect(greeted).toContain('M4B');
    expect(greeted).toContain("Kids' names and ages");
    expect(greeted).not.toContain(COLD_START_ASK);
    expect(greeted).not.toMatch(/postal/i);

    // The second turn is what proves the postal was STORED rather than echoed: it
    // comes back out of the session as what the extractor is told is already known.
    const provisioned = await text(fake, transport, withExtractor, 'Maya is 4 and Leo is 1');
    expect(provisioned.status).toBe('provisioned');
    expect(extractor.calls.map((c) => c.alreadyKnown.postalCode)).toEqual(['M4B 2B1']);
    expect(transport.bodies().some((b) => b.includes(followUpQuestion(['location'])))).toBe(false);
    expect(inserts(fake, schema.families)[0]).toMatchObject({
      country: 'Canada',
      postalCode: 'M4B 2B1',
      areaCoarse: 'M4B',
    });
  });

  it('still asks for the postal code alone when the first text is names and ages', async () => {
    const { fake, transport, deps } = harness({ extractions: [NO_POSTAL] });

    const asked = await text(fake, transport, deps, 'Maya is 4 and Leo is 1');

    expect(asked).toEqual({ status: 'follow_up_asked' });
    expect(transport.bodies().at(-1)).toContain(followUpQuestion(['location']));
    expect(transport.bodies().at(-1)).not.toContain('how old are they');
  });
});

describe('intake · CASL keywords', () => {
  it('STOP before provisioning acks and provisions nothing', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'STOP');

    expect(result).toEqual({ status: 'stopped', ack: 'sent' });
    expect(transport.bodies().at(-1)).toBe(STOP_ACK);
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });

  it('STOP after provisioning revokes the channel and appends a consent withdrawal', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const result = await text(fake, transport, deps, 'unsubscribe');
    expect(result).toEqual({ status: 'stopped', ack: 'sent' });

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
    expect(result).toEqual({ status: 'stopped', ack: 'sent' });
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

  it('STOP after provisioning ledgers the ack it sends (rule #6)', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const channel = inserts(fake, schema.parentChannels)[0];
    if (!channel) throw new Error('provisioning wrote no parent channel');

    const before = fake.rows(schema.channelMessages).length;
    await text(fake, transport, deps, 'STOP');

    // Positive control: the ack actually left.
    expect(transport.bodies().at(-1)).toBe(STOP_ACK);
    const added = fake.rows(schema.channelMessages).slice(before);
    const ack = added.find((r) => r.direction === 'out' && r.category === 'intake');
    expect(ack).toMatchObject({
      familyId: channel.familyId,
      parentUserId: channel.userId,
      channel: 'sms',
      status: 'queued',
      body: null,
    });
    expect(ack?.providerMessageId).toMatch(/^fake-out-/);
  });

  it('START after a STOP ledgers the re-enrol ack against the re-enrolled owner (rule #6)', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    await text(fake, transport, deps, 'STOP');
    const channel = inserts(fake, schema.parentChannels)[0];
    if (!channel) throw new Error('provisioning wrote no parent channel');

    const before = fake.rows(schema.channelMessages).length;
    await text(fake, transport, deps, 'START');

    // Positive control: the ack actually left.
    expect(transport.bodies().at(-1)).toBe(START_ACK_BY_LANGUAGE.en);
    const added = fake.rows(schema.channelMessages).slice(before);
    const ack = added.find((r) => r.direction === 'out' && r.category === 'intake');
    expect(ack).toMatchObject({
      familyId: channel.familyId,
      parentUserId: channel.userId,
      channel: 'sms',
      status: 'queued',
      body: null,
    });
    expect(ack?.providerMessageId).toMatch(/^fake-out-/);
  });

  /**
   * VIL-355 · departure revokes the seat AND the channel, so the revoked
   * `parent_channels` row keeps pointing at a family the person no longer belongs to.
   * START read that row and re-enrolled them into it — an active channel and a granted
   * consent for a household with no seat, minutes after Hale promised to stop texting
   * them about it. The keyword is express consent to be TEXTED; it is not a claim on a
   * family, so the re-enrol has to be membership-gated and a seatless number is a
   * stranger.
   */
  it('START from a number whose seat is gone does NOT re-enrol it into that family', async () => {
    const { fake, transport, deps } = harness({});
    const familyId = '00000000-0000-4000-8000-0000000000f2';
    const userId = '00000000-0000-4000-8000-0000000000u2';
    await fake.db.insert(schema.parentChannels).values({
      userId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: NOW,
      revokedAt: NOW,
    } as never);

    const result = await text(fake, transport, deps, 'START');

    expect(result.status).not.toBe('restarted');
    expect(transport.bodies().at(-1)).not.toBe(START_ACK_BY_LANGUAGE.en);
    expect(fake.rows(schema.parentChannels).filter((r) => r.revokedAt === null)).toHaveLength(0);
    expect(fake.rows(schema.consentRecords)).toHaveLength(0);
  });

  /** The positive control for the gate above: the ordinary parent who texted STOP and
   * then START still keeps their seat, so the re-enrol is exactly as it was. */
  it('START from a number whose seat is intact still re-enrols it', async () => {
    const { fake, transport, deps } = harness({});
    const familyId = '00000000-0000-4000-8000-0000000000f3';
    const userId = '00000000-0000-4000-8000-0000000000u3';
    await fake.db.insert(schema.parentChannels).values({
      userId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: NOW,
      revokedAt: NOW,
    } as never);
    await fake.db
      .insert(schema.familyMembers)
      .values({ familyId, userId, role: 'primary_parent' } as never);

    const result = await text(fake, transport, deps, 'START');

    expect(result).toEqual({ status: 'restarted', ack: 'sent' });
    expect(transport.bodies().at(-1)).toBe(START_ACK_BY_LANGUAGE.en);
    expect(fake.rows(schema.parentChannels).filter((r) => r.revokedAt === null)).toHaveLength(1);
  });

  it('HELP with no open conversation still ledgers the reply when the number is an enrolled parent (rule #6)', async () => {
    const { fake, transport, deps } = harness({});
    // An enrolled household whose intake session is long gone: the no-session HELP
    // branch used to answer with no ledger row at all.
    const familyId = '00000000-0000-4000-8000-0000000000f1';
    const userId = '00000000-0000-4000-8000-0000000000u1';
    await fake.db.insert(schema.parentChannels).values({
      userId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: NOW,
    } as never);

    const result = await text(fake, transport, deps, 'HELP');

    expect(result).toEqual({ status: 'helped', ack: 'sent' });
    expect(transport.bodies().at(-1)).toBe(HELP_REPLY);
    const ack = fake.rows(schema.channelMessages).find((r) => r.direction === 'out');
    expect(ack).toMatchObject({
      familyId,
      parentUserId: userId,
      channel: 'sms',
      category: 'intake',
      status: 'queued',
      body: null,
    });
    expect(ack?.providerMessageId).toMatch(/^fake-out-/);
  });

  it("HELP from an unknown number stays unledgered — channel_messages has no family row to hold it", async () => {
    const { fake, transport, deps } = harness({});

    const result = await text(fake, transport, deps, 'HELP');

    // Positive control: the reply itself still goes out.
    expect(result).toEqual({ status: 'helped', ack: 'sent' });
    expect(transport.bodies().at(-1)).toBe(HELP_REPLY);
    expect(fake.rows(schema.channelMessages)).toHaveLength(0);
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
      openQuestions: fakeNoOpenQuestions,
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
    expect(helped).toEqual({ status: 'helped', ack: 'sent' });
    expect(transport.bodies().at(-1)).toBe(HELP_REPLY);

    // Still mid-intake: the next real answer still provisions.
    const provisioned = await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    expect(provisioned.status).toBe('provisioned');
  });

  it('answers an unreadable details reply with its own door, never the frozen HELP line', async () => {
    // Doctrine G7/L2: the HELP keyword's reply is CASL-frozen; the conversational
    // "couldn't read that" moment split off it and owns its own words.
    const { fake, transport, deps } = harness({
      extractions: [{ children: [], postalCode: null }, MAYA_AND_LEO],
    });
    await text(fake, transport, deps, 'hi');
    const helped = await text(fake, transport, deps, 'qwerty asdf');
    expect(helped).toEqual({ status: 'helped', ack: 'sent' });
    expect(transport.bodies().at(-1)).toBe(UNREADABLE_INTAKE_REPLY);
    expect(transport.bodies().at(-1)).not.toBe(HELP_REPLY);

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
    expect(restarted).toEqual({ status: 'restarted', ack: 'sent' });

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

    expect(result).toEqual({ status: 'stopped', ack: 'sent' });
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
    expect(fr.transport.bodies().at(-2)).toBe(ASSENT_ACK_BY_LANGUAGE.fr);
    expect(fr.transport.bodies().at(-2)).not.toContain('ASK');

    // The English twin still gets its tail, so the assertion above is about French and not
    // about the name ask having quietly stopped working for everybody.
    const en = harness({ intents: [assent('yes')] });
    await text(en.fake, en.transport, en.deps, 'hi');
    await text(en.fake, en.transport, en.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const enRecorded = await text(en.fake, en.transport, en.deps, 'yes');

    expect(enRecorded).toMatchObject({ nameAsked: true });
    expect(en.transport.bodies().at(-2)).toBe(`${ASSENT_ACK} ASK`);
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

    expect(result).toEqual({ status: 'stopped', ack: 'sent' });
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
    expect(await text(fr.fake, fr.transport, fr.deps, 'AIDE')).toEqual({ status: 'helped', ack: 'sent' });
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

    expect(restarted).toEqual({ status: 'restarted', ack: 'sent' });
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

/**
 * VIL-332 — createSession commits before send. A crash or a refused first
 * send must not leave an open awaiting_details row that swallows the retry
 * as details / a duplicate and never greets.
 */
describe('intake · VIL-332 first-hello cannot die after createSession', () => {
  function seedOpenSession(
    fake: FakeDb,
    over: {
      lastProviderId?: string | null;
      transcript?: Array<{
        direction: 'in' | 'out';
        body: string;
        providerId: string | null;
        at: string;
      }>;
    } = {},
  ): void {
    fake.db.insert(schema.smsIntakeSessions).values({
      phoneHash: phoneBlindIndex(PHONE),
      phoneEncrypted: encryptString(PHONE),
      state: 'awaiting_details',
      dataEncrypted: encryptString(
        JSON.stringify({
          collected: { children: [], postalCode: null },
          transcript: over.transcript ?? [],
        }),
      ),
      lastProviderId: over.lastProviderId === undefined ? 'SMin' : over.lastProviderId,
    });
  }

  it('closes the new session when the first send fails, so a retry can greet', async () => {
    const { fake, deps } = harness({});
    await expect(
      handleInboundSms(
        fake.db,
        { from: PHONE, body: 'hi', providerId: 'SM-first', receivedAt: NOW },
        { ...deps, transport: refusingTransport(new Error('provider down')) },
      ),
    ).rejects.toThrow('provider down');

    expect(fake.rows(schema.smsIntakeSessions)[0]).toMatchObject({
      closedAt: NOW,
      state: 'awaiting_details',
    });

    const { transport } = harness({});
    const retry = await handleInboundSms(
      fake.db,
      { from: PHONE, body: 'hi', providerId: 'SM-retry', receivedAt: NOW },
      { ...deps, transport },
    );
    expect(retry).toEqual({ status: 'greeted' });
    expect(transport.bodies()).toEqual([greeting(null, 'en')]);
  });

  it('sends the locked first-hello for an open session that has a SID and no outbound', async () => {
    const { fake, transport, deps } = harness({});
    seedOpenSession(fake, { lastProviderId: 'SMprior' });

    const result = await handleInboundSms(
      fake.db,
      { from: PHONE, body: 'hi', providerId: 'SMnext', receivedAt: NOW },
      deps,
    );

    expect(result).toEqual({ status: 'greeted' });
    expect(transport.bodies()).toEqual([greeting(null, 'en')]);
    expect(transport.bodies()[0]).toContain(COLD_START_ASK);
  });

  it('still treats a carrier retry as a no-op once outbound exists', async () => {
    const { fake, transport, deps } = harness({});
    const first = transport.inbound(PHONE, 'hi');
    await handleInboundSms(fake.db, first, deps);
    const sentAfterFirst = transport.sent.length;

    const retry = await handleInboundSms(fake.db, { ...first }, deps);
    expect(retry).toEqual({ status: 'duplicate' });
    expect(transport.sent).toHaveLength(sentAfterFirst);
  });
});

/**
 * P1-4 — the turn CLAIM. `lastProviderId` is saved only at the END of a turn, so the
 * old duplicate check could not see a resend racing a turn still running (Twilio
 * resends at 15s while a model-bound turn is mid-flight — the race migration 0085's
 * comment records firing in production), and it remembered only the LAST id, so a
 * delayed redelivery of an older message re-ran an already-answered turn. The claim
 * (turn-claim.ts) is inserted at step 4, before anything acts; the fake models its
 * unique index for the same reason it models the other four (a fake that let both
 * racers in would pass a test the deployed code fails), and the real DDL is proven in
 * turn-claim.pglite.test.ts.
 *
 * Mutation proof: disable the claimIntakeTurn gate inside claimedTurn (the pre-fix
 * shape) and both tests fail — the resend greets a second time.
 */
describe('intake · P1-4 the turn claim', () => {
  it('refuses a resend racing a turn that is STILL RUNNING (nothing saved to read)', async () => {
    const { fake, transport, deps } = harness({});
    // The first delivery is mid-turn: it holds the claim, and the session write that
    // the old check read — lastProviderId — does not exist yet.
    expect(await claimIntakeTurn(fake.db, 'SM-racing', NOW)).toBe(true);

    const resend = await handleInboundSms(
      fake.db,
      { from: PHONE, body: 'hi', providerId: 'SM-racing', receivedAt: NOW },
      deps,
    );

    expect(resend).toEqual({ status: 'duplicate' });
    // The resend spent nothing: no greeting, no session, no model-bound turn.
    expect(transport.sent).toHaveLength(0);
    expect(fake.rows(schema.smsIntakeSessions)).toHaveLength(0);
  });

  it('refuses an out-of-order redelivery of an OLDER message after a newer turn moved on', async () => {
    const { fake, transport, deps } = harness({});
    await handleInboundSms(
      fake.db,
      { from: PHONE, body: 'hi', providerId: 'SM-a', receivedAt: NOW },
      deps,
    );
    const sentAfterFirst = transport.sent.length;
    // A later turn completed since: the session's one-id memory now names SM-b, which
    // is exactly the world where the old check waved a delayed SM-a copy through.
    const session = fake.rows(schema.smsIntakeSessions)[0];
    if (!session) throw new Error('test seed: expected an open session');
    session.lastProviderId = 'SM-b';

    const redelivered = await handleInboundSms(
      fake.db,
      { from: PHONE, body: 'hi', providerId: 'SM-a', receivedAt: NOW },
      deps,
    );

    expect(redelivered).toEqual({ status: 'duplicate' });
    expect(transport.sent).toHaveLength(sentAfterFirst);
  });
});

/**
 * THE DAY-ONE CONNECTOR OFFER (2026-09-17). A family that has just said yes to being
 * watched is the one moment Hale has earned the right to ask for the inbox and the
 * calendar the daycare notices actually arrive in — so the ask rides that turn, once,
 * as its own message, and ignoring it IS the skip.
 *
 * ITS OWN MESSAGE rather than a tail on the acknowledgment, for the reason the welcome
 * card is: one message asks one question, and the acknowledgment's question is already
 * spoken for by the name ask. It may never cost the turn — the consent is recorded and
 * the ack has already gone out by the time this runs, so every way it declines is a
 * named outcome on the return value and a line in the log.
 */
describe('intake · the connector offer on the consent turn', () => {
  async function consent(
    h: ReturnType<typeof harness>,
    reply = 'yes please',
    override?: IntakeDeps,
  ) {
    await text(h.fake, h.transport, h.deps, 'hi');
    await text(h.fake, h.transport, h.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    return text(h.fake, h.transport, h.deps, reply, override);
  }

  it('sends the tap-to-connect link as a second message after the acknowledgment', async () => {
    const h = harness({ intents: [assent('yes please')] });

    const recorded = await consent(h);

    expect(recorded).toEqual({
      status: 'watch_recorded',
      intent: 'assent',
      granted: true,
      nameAsked: true,
      connectorOffer: 'sent',
    });
    // Two sends on this turn, in this order: the ack carrying the name ask, then the
    // offer. Not one joined body — the ack's question budget is already spent.
    expect(h.transport.bodies().at(-2)).toBe(`${ASSENT_ACK} ASK`);
    const offerBody = h.transport.bodies().at(-1) as string;
    expect(offerBody).toContain('/connect?t=');
    expect(offerBody).toContain('ignore this to skip');

    const offerRow = inserts(h.fake, schema.channelMessages).find(
      (row) => row.templateKey === INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY,
    );
    expect(offerRow).toMatchObject({
      direction: 'out',
      category: 'intake',
      dedupeKey: connectorOfferDedupeKey(String(offerRow?.familyId)),
      status: 'queued',
    });
    // Rule #6: the sign-in capability this text carries has its own audit row.
    expect(inserts(h.fake, schema.auditLog).map((a) => a.actionTaken)).toContain(
      'connector_link_minted',
    );
  });

  /** A parent Hale already has a name for gets no tail on the ack — and still gets the
   * offer, because the offer is not the tail. */
  it('still sends the offer when the acknowledgment carries no name ask', async () => {
    const h = harness({
      intents: [assent('yes please')],
      identityAsk: new FakeIdentityAsk({ status: 'deferred', reason: 'model_failed' }),
    });

    const recorded = await consent(h);

    expect(recorded).toMatchObject({ nameAsked: false, connectorOffer: 'sent' });
    expect(h.transport.bodies().at(-2)).toBe(ASSENT_ACK);
    expect(h.transport.bodies().at(-1)).toContain('/connect?t=');
  });

  /**
   * A parent who declined the watch is not asked to open their inbox. There is no turn
   * to ask on: they just said no to being watched, and following that with a link to
   * connect their mail would be Hale asking the same question louder.
   */
  it('asks nothing of a parent who declined the watch', async () => {
    const h = harness({ intents: [decline('no thanks')] });

    const recorded = await consent(h, 'no thanks');

    expect(recorded).toEqual({
      status: 'watch_recorded',
      intent: 'decline',
      granted: false,
      nameAsked: false,
      connectorOffer: 'not_offered',
    });
    expect(h.transport.bodies().at(-1)).toBe(DECLINE_ACK);
    expect(h.transport.bodies().some((b) => b.includes('/connect?t='))).toBe(false);
    expect(inserts(h.fake, schema.auditLog).map((a) => a.actionTaken)).not.toContain(
      'connector_link_minted',
    );
  });

  /**
   * A yes at 22:30 still gets its acknowledgment — it answers a text the parent just
   * sent — but the offer beside it is an unprompted extra, and an extra at 22:30 is
   * Hale making noise. Held and named, and the session closes anyway: the turn is not
   * the offer's to hold open.
   */
  it('holds the offer through quiet hours and closes the session all the same', async () => {
    const h = harness({ intents: [assent('yes please')] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 22:30 in America/Toronto, the timezone every intake-born parent row defaults to.
    const late = new Date('2026-09-18T02:30:00.000Z');

    const recorded = await consent(h, 'yes please', { ...h.deps, now: late });

    expect(recorded).toMatchObject({ granted: true, connectorOffer: 'suppressed_quiet_hours' });
    expect(h.transport.bodies().at(-1)).toBe(`${ASSENT_ACK} ASK`);
    expect(h.transport.bodies().some((b) => b.includes('/connect?t='))).toBe(false);
    expect(
      inserts(h.fake, schema.channelMessages).find(
        (row) => row.templateKey === INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY,
      ),
    ).toMatchObject({ status: 'suppressed_quiet_hours', dedupeKey: null });

    // The session closed on the ack, so the next text is the coach's turn — the held
    // offer does not reopen intake and does not go out on a replayed yes.
    const sent = h.transport.sent.length;
    const replay = await text(h.fake, h.transport, h.deps, 'yes');
    expect(replay).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(h.transport.sent).toHaveLength(sent);
    expect(h.fake.rows(schema.smsIntakeSessions)[0]).toMatchObject({ state: 'complete' });
  });

  /**
   * The provider refusing the offer may not cost the parent their consent turn. The ack
   * is already delivered, the consent is already written, and the session must still
   * close — a thrown offer would hand the carrier a retry of a turn that is done.
   */
  it('closes the turn cleanly when the provider refuses the offer', async () => {
    const h = harness({ intents: [assent('yes please')] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const inner = h.transport;
    const refusesTheOffer: IntakeDeps['transport'] = {
      async send(input) {
        if (input.body.includes('/connect?t=')) throw new TwilioSendError('21610', 400);
        return inner.send(input);
      },
    };

    const recorded = await consent(h, 'yes please', { ...h.deps, transport: refusesTheOffer });

    expect(recorded).toMatchObject({ granted: true, connectorOffer: 'send_failed' });
    expect(h.transport.bodies().at(-1)).toBe(`${ASSENT_ACK} ASK`);
    expect(h.fake.rows(schema.smsIntakeSessions)[0]).toMatchObject({ state: 'complete' });
    // The claimed row carries the refusal, so a family with no offer is a query rather
    // than a guess - and the dedupe key stays spent, as a failed send must.
    const failed = h.fake.writes.filter(
      (w) =>
        w.op === 'update' && w.table === schema.channelMessages && w.payload.status === 'failed',
    );
    expect(failed.map((w) => w.payload.errorCode)).toEqual(['21610']);
  });

  it('offers in French to a parent who answered in French', async () => {
    const h = harness({ intents: [assent('oui')] });

    const recorded = await consent(h, 'oui');

    expect(recorded).toMatchObject({ connectorOffer: 'sent' });
    const offerBody = h.transport.bodies().at(-1) as string;
    const [calendarUrl, gmailUrl] = offerBody.match(/https:\/\/\S+/g) as RegExpMatchArray;
    expect(offerBody).toBe(intakeConnectorOffer('fr', calendarUrl as string, gmailUrl as string));
  });
});

/**
 * VIL-348 — WHO ANSWERS THE KEYWORD.
 *
 * The provider's own opt-out handling may match STOP/START/HELP, reply to the sender
 * itself, and forward the inbound tagged with which one it answered. Nothing in Hale can
 * see whether that handling is configured — the comment that claimed to know went false
 * three days after it was written — so the machine has to be right under either answer,
 * and both are pinned here.
 *
 * THE LEDGER IS NEVER SUPPRESSED. Only Hale's own acknowledgment is: a provider's opt-out
 * list is not Hale's consent record, and a STOP that revoked nothing because a carrier
 * answered it first is the CASL failure the extra text is not.
 */
describe('intake · the provider answered the keyword first (VIL-348)', () => {
  async function enrolled() {
    const h = harness({});
    await text(h.fake, h.transport, h.deps, 'hi');
    await text(h.fake, h.transport, h.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    return h;
  }

  const revoked = (fake: FakeDb) =>
    fake.writes.find(
      (w) => w.op === 'update' && w.table === schema.parentChannels && w.payload.revokedAt,
    );
  const withdrawal = (fake: FakeDb) =>
    inserts(fake, schema.consentRecords).find(
      (c) => c.consentType === 'sms_service_messages' && c.granted === false,
    );
  /** How many outbound rows the ledger holds. Counted rather than matched on the body:
   * an outbound row stores `body: null` by design (rule #1), so only the COUNT can tell
   * a suppressed send from one that was ledgered as if it had gone. */
  const outRows = (fake: FakeDb) =>
    inserts(fake, schema.channelMessages).filter((m) => m.direction === 'out').length;

  it('does every consent write and sends nothing when the provider already confirmed the STOP', async () => {
    const { fake, transport, deps } = await enrolled();
    const sentBefore = transport.sent.length;
    const outBefore = outRows(fake);

    const result = await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'ARRET', { providerAnsweredKeyword: 'stop' }),
      deps,
    );

    expect(result).toEqual({ status: 'stopped', ack: 'provider_answered' });
    expect(transport.sent).toHaveLength(sentBefore);
    expect(revoked(fake)).toBeDefined();
    expect(withdrawal(fake)).toBeDefined();
    // A suppressed send must not be ledgered as sent: no new outbound row, and therefore
    // no line in the parent's receipts for a message Hale never put on the wire.
    expect(outRows(fake)).toBe(outBefore);
  });

  // The positive control for the three suppression cases — absence tests fail open, so
  // the same ARRET with nothing on the inbound has to produce the ack and its row.
  it('answers the same ARRET itself when the provider answered nothing', async () => {
    const { fake, transport, deps } = await enrolled();
    const outBefore = outRows(fake);

    const result = await handleInboundSms(fake.db, transport.inbound(PHONE, 'ARRET'), deps);

    expect(result).toEqual({ status: 'stopped', ack: 'sent' });
    expect(transport.bodies().at(-1)).toBe(STOP_ACK_BY_LANGUAGE.fr);
    expect(outRows(fake)).toBe(outBefore + 1);
    expect(revoked(fake)).toBeDefined();
    expect(withdrawal(fake)).toBeDefined();
  });

  it('suppresses only the matching keyword — a STOP tag on an AIDE is not an answer to it', async () => {
    const { fake, transport, deps } = await enrolled();

    const result = await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'AIDE', { providerAnsweredKeyword: 'stop' }),
      deps,
    );

    expect(result).toEqual({ status: 'helped', ack: 'sent' });
    expect(transport.bodies().at(-1)).toBe(HELP_REPLY_BY_LANGUAGE.fr);
  });

  it('stays quiet on an AIDE the provider already answered, and keeps the conversation open', async () => {
    const { fake, transport, deps } = await enrolled();
    const sentBefore = transport.sent.length;

    const result = await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'AIDE', { providerAnsweredKeyword: 'help' }),
      deps,
    );

    expect(result).toEqual({ status: 'helped', ack: 'provider_answered' });
    expect(transport.sent).toHaveLength(sentBefore);
    // The turn still completed: a carrier retry of this exact message is a duplicate,
    // not a second HELP.
    const retry = await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'AIDE', { providerAnsweredKeyword: 'help' }),
      deps,
    );
    expect(retry).toEqual({ status: 'helped', ack: 'provider_answered' });
  });

  it('re-enrols on a DEBUT the provider already answered, and says nothing itself', async () => {
    const { fake, transport, deps } = await enrolled();
    await text(fake, transport, deps, 'ARRET');
    const sentBefore = transport.sent.length;
    const outBefore = outRows(fake);

    const result = await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'DEBUT', { providerAnsweredKeyword: 'start' }),
      deps,
    );

    expect(result).toEqual({ status: 'restarted', ack: 'provider_answered' });
    expect(transport.sent).toHaveLength(sentBefore);
    expect(outRows(fake)).toBe(outBefore);
    const consents = inserts(fake, schema.consentRecords).filter(
      (c) => c.consentType === 'sms_service_messages' && c.granted === true,
    );
    expect(consents.at(-1)?.evidence).toMatchObject({ verbatimReply: 'DEBUT' });
  });

  /**
   * THE STOP → DEBUT ASYMMETRY. An opt-out list that holds STOP but not DEBUT keeps
   * refusing every send to this number — 21610 — although Hale has just re-enrolled its
   * owner. Before this ticket the refusal threw out of the START branch, so the webhook
   * 500'd and Twilio retried it into the same wall, AFTER the consent write had landed.
   * Hale cannot fix the list from here; what it can do is not lie about the outcome.
   */
  it('names a re-enrolment the provider refuses to deliver, instead of 500ing the webhook', async () => {
    const { fake, transport, deps } = await enrolled();
    await text(fake, transport, deps, 'ARRET');
    const outBefore = outRows(fake);

    const result = await handleInboundSms(fake.db, transport.inbound(PHONE, 'DEBUT'), {
      ...deps,
      transport: refusingTransport(new TwilioSendError('21610', 400)),
    });

    expect(result).toEqual({ status: 'restarted', ack: 'provider_refused' });
    // No row claiming an acknowledgment nobody received.
    expect(outRows(fake)).toBe(outBefore);
  });

  it('positive control: a provider OUTAGE on the same ack still fails the turn', async () => {
    const { fake, transport, deps } = await enrolled();
    await text(fake, transport, deps, 'ARRET');

    await expect(
      handleInboundSms(fake.db, transport.inbound(PHONE, 'DEBUT'), {
        ...deps,
        transport: refusingTransport(new TwilioSendError('20500', 503)),
      }),
    ).rejects.toBeInstanceOf(TwilioSendError);
  });
});

/**
 * VIL-360 · the D23 anchor.
 *
 * The weekday-care ask says "those are all weekend finds" about a send of Hale's own,
 * and the intake radar's first text is the only weekend find most families ever get.
 * That row carried no `template_key` at all, so nothing downstream could tell a first
 * text that offered a Saturday from one that offered nothing — and the ask would have
 * fired for nobody.
 */
describe('the first radar\'s weekend-pick stamp', () => {
  async function onboard(h: ReturnType<typeof harness>) {
    await text(h.fake, h.transport, h.deps, 'hi');
    await text(h.fake, h.transport, h.deps, 'Maya is 4, Leo is 1. M5V 2T6');
  }

  it('stamps the row when the radar carried a weekend pick', async () => {
    const h = harness({ weekendPickOffered: true });

    await onboard(h);

    expect(
      inserts(h.fake, schema.channelMessages).filter(
        (row) => row.templateKey === INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY,
      ),
    ).toHaveLength(1);
  });

  it('stamps NOTHING when it did not - the anchor must be a find that happened', async () => {
    const h = harness({ weekendPickOffered: false });

    await onboard(h);

    expect(
      inserts(h.fake, schema.channelMessages).filter(
        (row) => row.templateKey === INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY,
      ),
    ).toEqual([]);
    // The positive control: the radar text DID go out, so this is not passing because
    // nothing was sent at all.
    expect(h.transport.bodies().some((body) => body.includes('RADAR'))).toBe(true);
  });
});
