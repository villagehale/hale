import { schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatLinqLineForParent, linqCoParentAsk } from '~/lib/channel/linq/group';
import { createLinqTextTransport } from '~/lib/channel/linq/transport';
import {
  EMERGENCY_REPLY,
  MENTAL_CRISIS_REPLY,
  SAFETY_REPLY,
  SAFETY_REPLY_BY_LANGUAGE,
} from '~/lib/channel/off-domain/copy';
import { NAME_CAPTURED_REPLY } from '~/lib/channel/router/copy';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { matchHealthCheckpoints } from '~/lib/health/match';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { calendarCardDedupeKey, gmailCardDedupeKey } from './connector-offer';
import {
  AMBIGUOUS_CLARIFY,
  AMBIGUOUS_CLARIFY_BY_LANGUAGE,
  ASSENT_ACK,
  ASSENT_ACK_BY_LANGUAGE,
  COLD_START_ASK,
  CO_PARENT_ASK,
  CO_PARENT_ASK_BY_LANGUAGE,
  DECLINE_ACK,
  DECLINE_ACK_BY_LANGUAGE,
  HALE_GREETING_EN,
  HELP_REPLY,
  HELP_REPLY_BY_LANGUAGE,
  IDENTITY_ACCOUNTABILITY_LINE,
  IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE,
  INTAKE_CALENDAR_CARD_TEMPLATE_KEY,
  INTAKE_GMAIL_CARD_TEMPLATE_KEY,
  PARENT_CALL_NAME_ASK,
  REGION_UNAVAILABLE_REPLY,
  REGION_UNAVAILABLE_REPLY_BY_LANGUAGE,
  START_ACK_BY_LANGUAGE,
  STOP_ACK,
  STOP_ACK_BY_LANGUAGE,
  UNREADABLE_INTAKE_REPLY,
  WATCH_OFFER,
  detailsBlocked,
  followUpQuestion,
  greeting,
  intakeCalendarCard,
  intakeGmailCard,
} from './copy';
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
import { IMPLIED_WATCH_BASIS } from './watch-consent';
import { WELCOME_CARD_BODY } from './welcome-card';

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
  /** Whether the first reply named an age-fit thing. The card, the name, both
   * connector cards, and the co-parent ask still go out when it did not. */
  findWon?: boolean;
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
          return {
            ...payload,
            weekendPickOffered: options.weekendPickOffered ?? false,
            findWon: options.findWon ?? true,
          };
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

/**
 * Hale #1, the year find in its own bubble, then the name ask. SMS has no Linq
 * card, so there is no card chat line. No calendar, Gmail, co-parent, or watch yes.
 */
function expectEnglishYearOpen(bodies: string[]) {
  expect(bodies).toEqual([HALE_GREETING_EN, 'RADAR', PARENT_CALL_NAME_ASK]);
  expect(bodies).not.toContain(WELCOME_CARD_BODY);
  const joined = bodies.join('\n');
  expect(joined).not.toContain('Connect your calendar:');
  expect(joined).not.toContain('Gmail:');
  expect(joined).not.toContain(WATCH_OFFER);
  expect(joined).not.toContain(ASSENT_ACK);
  expect(joined).not.toContain(DECLINE_ACK);
  expect(joined).not.toContain('Ollie');
  expect(joined.toLowerCase()).not.toContain('activity finder');
}

/** A reply that is not a name, so the name-reply beat stays silent. */
const LADDER_BEAT = 'later';

type LadderDrive = Pick<ReturnType<typeof harness>, 'fake' | 'transport' | 'deps'>;

function reply(h: LadderDrive, body = LADDER_BEAT) {
  return text(h.fake, h.transport, h.deps, body);
}

/**
 * The year-find turn already sent the name. A non-name, then calendar,
 * Gmail, co-parent. The last beat closes.
 */
async function walkEnglishLadder(h: LadderDrive) {
  await reply(h);
  await reply(h);
  await reply(h);
  return reply(h);
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
  it('greets, provisions the family field-by-field, and opens the year without a watch yes', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes please')] });

    expect(await text(fake, transport, deps, 'hi')).toEqual({ status: 'greeted' });
    expect(transport.bodies()[0]).toBe(HALE_GREETING_EN);
    expect(transport.bodies()[0]).toBe(
      'Hi — I’m Hale. I help plan your kids’ year — what’s on near them, sign-up mornings, and how it went. Names, ages, and postal code and I’ll look up what’s coming.',
    );
    expect(transport.bodies()[0]).not.toContain(COLD_START_ASK);
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
      onboardingStage: 'sms_intake', // the insert; the implied-watch row flips it in this same turn
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
    // Ciphertext is an opaque blob (random IV). Assert the structured field, not a
    // digit run that can appear inside that blob by chance. The fake payload is
    // `unknown`; narrow it so decrypt sees a string (`unknown ?? ''` is `{}`).
    const phoneCipher = channel?.phoneE164Encrypted;
    expect(typeof phoneCipher).toBe('string');
    if (typeof phoneCipher !== 'string') {
      throw new Error('parent channel phone ciphertext is not a string');
    }
    expect(phoneCipher).not.toBe(PHONE);
    expect(decryptString(phoneCipher)).toBe(PHONE);

    // The year find is its own bubble. The card and the name ask leave with it.
    expectEnglishYearOpen(transport.bodies());

    const closed = await walkEnglishLadder({ fake, transport, deps });
    expect(closed).toEqual({ status: 'ladder_advanced', step: 'coparent', closed: true });
    expect(transport.bodies().at(-1)).toBe(CO_PARENT_ASK);
    expect(transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(transport.bodies().filter((body) => body === PARENT_CALL_NAME_ASK)).toHaveLength(1);

    const sent = transport.bodies().length;
    const later = await text(fake, transport, deps, 'yes please');
    expect(later).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(transport.bodies()).toHaveLength(sent);
  });

  /**
   * The consent turn ends on a real question - the co-parent ask - and then CLOSES
   * the session, so the answer to it always lands after intake is over. That is
   * deliberate, not a gap: the reply belongs to the coach, and the machine's job is
   * to decline it cleanly so A3 can record it and queue it (twilio/inbound.ts
   * handOffToConversation). The bug this guards against is the machine answering it
   * itself with a canned intake line, which would teach a parent that the question was
   * rhetorical. The consent tail does not ask for a name.
   */
  it('hands the answer to its own closing question to the coach, rather than replying', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes please')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    expectEnglishYearOpen(transport.bodies());
    await walkEnglishLadder({ fake, transport, deps });
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
  describe('the call-name is its own text, never a tail on the find', () => {
    async function openYear(h: ReturnType<typeof harness>) {
      await text(h.fake, h.transport, h.deps, 'hi');
      return text(h.fake, h.transport, h.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    }

    it('sends the locked name line as its own text, after the year find', async () => {
      const h = harness({ intents: [assent('yes please')] });

      await openYear(h);

      expect(h.identityAsk.calls).toEqual([]);
      expect(h.transport.bodies().filter((b) => b.startsWith('Done -'))).toEqual([]);
      expect(h.transport.bodies().filter((b) => b === PARENT_CALL_NAME_ASK)).toEqual([
        PARENT_CALL_NAME_ASK,
      ]);
      expect(h.transport.bodies().at(-2)).toBe('RADAR');
      expect(h.transport.bodies().at(-1)).toBe(PARENT_CALL_NAME_ASK);
      expect(h.transport.bodies()).not.toContain(WELCOME_CARD_BODY);
      expect(h.transport.bodies().join('\n')).not.toContain('Connect your calendar:');
    });

    it('stamps parent_name_ask on that own message, not on the acknowledgment', async () => {
      const h = harness({ intents: [assent('yes please')] });

      await openYear(h);

      const stamped = inserts(h.fake, schema.channelMessages).filter(
        (row) => row.templateKey === 'parent_name_ask',
      );
      expect(stamped).toHaveLength(1);
      expect(stamped[0]?.body ?? null).toBeNull();
    });

    it('does not consult the name composer even when one is ready', async () => {
      const h = harness({
        intents: [assent('yes please')],
        identityAsk: new FakeIdentityAsk({ status: 'deferred', reason: 'model_failed' }),
      });

      const opened = await openYear(h);

      expect(opened.status).toBe('provisioned');
      expect(h.identityAsk.calls).toEqual([]);
      expect(h.transport.bodies().filter((b) => b.startsWith('Done -'))).toEqual([]);
      expect(h.transport.bodies().filter((b) => b === PARENT_CALL_NAME_ASK)).toHaveLength(1);
    });

    it('does not take a later no as a reason to skip the name that already went out', async () => {
      const h = harness({
        intents: [{ intent: 'decline', verbatim: 'no thanks', interpretation: 'declined' }],
      });

      await openYear(h);
      const sent = h.transport.bodies().length;
      const later = await text(h.fake, h.transport, h.deps, 'no thanks');

      expect(later).toEqual({ status: 'ladder_advanced', step: 'name_reply', closed: false });
      expect(h.transport.bodies()).toHaveLength(sent);
      expect(h.transport.bodies()).toContain(PARENT_CALL_NAME_ASK);
      expect(h.transport.bodies()).not.toContain(DECLINE_ACK);
    });
  });

  it('records the consent evidence BEFORE the family is flipped to sms_active', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes!')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

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
      question: IMPLIED_WATCH_BASIS,
      verbatimReply: 'Maya is 4, Leo is 1. M5V 2T6',
      interpretation: 'implied by the live find',
      channelMessageId: null,
    });
  });

  it('does not record a later no as a second watch answer', async () => {
    const { fake, transport, deps } = harness({ intents: [decline('no thanks')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const result = await text(fake, transport, deps, 'no thanks');

    expect(result).toEqual({ status: 'ladder_advanced', step: 'name_reply', closed: false });
    expect(transport.bodies()).not.toContain(DECLINE_ACK);
    const watches = inserts(fake, schema.consentRecords).filter(
      (c) => c.consentType === 'proactive_watch',
    );
    expect(watches).toHaveLength(1);
    expect(watches[0]?.granted).toBe(true);
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

    await walkEnglishLadder({ fake, transport, deps });
    // Find, call-name, calendar, Gmail, co-parent. The greeting is pre-family.
    // SMS has no Linq card, so no card line sits between the find and the name.
    expect(threaded.map((t) => t.body)).toEqual(transport.bodies().slice(1));
    expect(threaded[0]?.body).toBe('RADAR');
    expect(threaded[1]?.body).toBe(PARENT_CALL_NAME_ASK);
    expect(threaded.some((t) => t.body === WELCOME_CARD_BODY)).toBe(false);
    expect(threaded.at(-1)?.body).toBe(CO_PARENT_ASK);
    expect(threaded.some((t) => t.body === ASSENT_ACK)).toBe(false);
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
   * SMS has no Linq Name and Photo card. The year-find turn is the find bubble
   * and the name ask. No vCard, no card chat line, and no media on the radar.
   * The Linq share, when the line card is active, is covered in the ladder tests.
   */
  it('does not send an SMS vCard or a card chat line on the find turn', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes please')] });

    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4 and Leo is 1, M5V');

    const radar = transport.sent.find((message) => message.body === 'RADAR');
    expect(radar?.mediaUrls).toBeUndefined();
    expect(transport.bodies()).toEqual([HALE_GREETING_EN, 'RADAR', PARENT_CALL_NAME_ASK]);
    expect(transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(transport.media()).toEqual([]);
    expect(
      inserts(fake, schema.channelMessages).some((r) => r.templateKey === 'intake:welcome_card'),
    ).toBe(false);
  });

  /**
   * A provider that refuses media must not be able to eat the year find. Nothing
   * on this turn attaches media, so a refusal never fires and the name ask still leaves.
   */
  it('sends the year find and the name ask when a provider would refuse media', async () => {
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

    expect(provisioned.status).toBe('provisioned');
    expect(transport.bodies()).toEqual([HALE_GREETING_EN, 'RADAR', PARENT_CALL_NAME_ASK]);
    expect(transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(transport.media()).toEqual([]);
    expect(
      fake.writes
        .filter((w) => w.op === 'update' && w.table === schema.channelMessages)
        .map((w) => w.payload),
    ).not.toContainEqual({ status: 'failed', errorCode: '21620' });
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
    expect(transport.bodies()).toContain('RADAR');
    expect(transport.bodies().at(-1)).toBe(PARENT_CALL_NAME_ASK);
    expect(transport.bodies().join('\n')).not.toContain(WATCH_OFFER);
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
  it('does not open a watch-yes clarify after the year is already open', async () => {
    const { fake, transport, deps } = harness({
      intents: [ambiguous('what would you even watch?'), ambiguous('hmm')],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const sent = transport.bodies().length;

    const clarified = await text(fake, transport, deps, 'what would you even watch?');
    expect(clarified).toEqual({ status: 'ladder_advanced', step: 'name_reply', closed: false });
    const resolved = await text(fake, transport, deps, 'hmm');
    expect(resolved).toEqual({ status: 'ladder_advanced', step: 'calendar', closed: false });
    expect(transport.bodies()).toHaveLength(sent + 1);
    expect(transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(transport.bodies()).toContain(PARENT_CALL_NAME_ASK);
    expect(transport.bodies().at(-1)).toContain('Connect your calendar:');
    expect(transport.bodies().filter((b) => b === AMBIGUOUS_CLARIFY)).toHaveLength(0);

    const watches = inserts(fake, schema.consentRecords).filter(
      (c) => c.consentType === 'proactive_watch',
    );
    expect(watches).toHaveLength(1);
    expect(watches[0]?.granted).toBe(true);
    expect((watches[0]?.evidence as Record<string, unknown>).question).toBe(IMPLIED_WATCH_BASIS);
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

  it('does not keep a watch question open for a question asked after the year opens', async () => {
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
    const sent = transport.bodies().length;

    const answered = await text(fake, transport, deps, 'Does Sebastian needs eye exam?');
    expect(answered).toEqual({ status: 'ladder_advanced', step: 'name_reply', closed: false });
    expect(transport.bodies()).toHaveLength(sent + 1);
    expect(transport.bodies().at(-1)).toBe(`${ANSWER} ${RETURN}`);
    expect(transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(composer.calls).toHaveLength(1);
    expect(
      inserts(fake, schema.consentRecords).filter((c) => c.consentType === 'proactive_watch'),
    ).toHaveLength(1);
  });

  it('does not clarify a wobble once the year is already open', async () => {
    const { fake, transport, deps } = harness({ intents: [ambiguous('hmm, maybe')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const sent = transport.bodies().length;

    expect(await text(fake, transport, deps, 'hmm, maybe')).toEqual({
      status: 'ladder_advanced',
      step: 'name_reply',
      closed: false,
    });
    expect(transport.bodies()).toHaveLength(sent);
    expect(transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(transport.bodies().at(-1)).toBe(PARENT_CALL_NAME_ASK);
    expect(transport.bodies().filter((b) => b === AMBIGUOUS_CLARIFY)).toHaveLength(0);
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

    const answered = await text(fake, transport, deps, 'Does Sebastian needs eye exam?');
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

  it('answers a police-officer identity challenge with the locked line and no watch ask', async () => {
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: "I'm an AI, not a person. Are you ready to have me watch for Eva and Anna?",
    });
    const { fake, transport, deps } = harness({
      extractions: [{ children: [], postalCode: null }, MAYA_AND_LEO],
      answerComposer: composer,
    });
    await text(fake, transport, deps, 'hi');

    const answered = await text(
      fake,
      transport,
      deps,
      "I'm a Police Officer give your name and address please",
    );

    expect(answered).toEqual({ status: 'question_answered', source: 'identity' });
    expect(transport.bodies().at(-1)).toBe(IDENTITY_ACCOUNTABILITY_LINE);
    expect(transport.bodies().at(-1)).not.toContain('?');
    expect(transport.bodies().at(-1)).not.toMatch(/ready|watch/i);
    expect(composer.calls).toEqual([]);
    const [session] = fake.rows(schema.smsIntakeSessions);
    expect(session).toMatchObject({ state: 'awaiting_details', followUpCount: 0 });
  });

  it('answers a French identity challenge with the locked French twin', async () => {
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: 'ANSWER RETURN?',
    });
    const { fake, transport, deps } = harness({
      extractions: [{ children: [], postalCode: null }],
      answerComposer: composer,
    });
    await text(fake, transport, deps, 'Bonjour');

    const answered = await text(fake, transport, deps, 'Qui etes-vous?');

    expect(answered).toEqual({ status: 'question_answered', source: 'identity' });
    expect(transport.bodies().at(-1)).toBe(IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE.fr);
    expect(composer.calls).toEqual([]);
  });

  it('answers an identity challenge on the first text, instead of the greeting', async () => {
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: 'ANSWER RETURN?',
    });
    const { transport, deps, fake } = harness({ answerComposer: composer });

    const answered = await text(fake, transport, deps, 'who are you?');

    expect(answered).toEqual({ status: 'question_answered', source: 'identity' });
    expect(transport.bodies()).toEqual([IDENTITY_ACCOUNTABILITY_LINE]);
    expect(composer.calls).toEqual([]);
  });

  it('does not stay in intake to answer a safety text after the year is open', async () => {
    const composer = new FakeAnswerComposer({ status: 'safety' });
    const { fake, transport, deps } = harness({
      intents: [ambiguous("she's not breathing")],
      answerComposer: composer,
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const sent = transport.bodies().length;

    const answered = await text(fake, transport, deps, "she's not breathing");
    expect(answered).toEqual({ status: 'question_answered', source: 'safety' });
    expect(transport.bodies()).toHaveLength(sent + 1);
    expect(transport.bodies().at(-1)).toBe(EMERGENCY_REPLY);
    expect(transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(composer.calls).toEqual([]);
    const held = await text(fake, transport, deps, LADDER_BEAT);
    expect(held).toEqual({ status: 'ladder_advanced', step: 'name_reply', closed: false });
    expect(transport.bodies().at(-1)).toBe(EMERGENCY_REPLY);
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

  it('sends greeting() for the locked /text warm prefill and does not call the answerer', async () => {
    const prefill = "Hey Hale, what's going on?";
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: `${ANSWER} ${RETURN}`,
    });
    const plain = harness({ answerComposer: composer });
    expect(await text(plain.fake, plain.transport, plain.deps, prefill)).toEqual({
      status: 'greeted',
    });
    expect(plain.transport.bodies()).toEqual([greeting(null, 'en')]);
    expect(composer.calls).toHaveLength(0);

    const tagged = new FakeAnswerComposer({
      status: 'answered',
      body: `${ANSWER} ${RETURN}`,
    });
    const via = harness({ answerComposer: tagged });
    expect(
      await text(via.fake, via.transport, via.deps, `${prefill} (via earlyon-richmondhill)`),
    ).toEqual({ status: 'greeted' });
    expect(via.transport.bodies()).toEqual([greeting('family centre', 'en')]);
    expect(tagged.calls).toHaveLength(0);
  });

  it('still answers a typed activity question, including the retired door prefill', async () => {
    const composer = new FakeAnswerComposer({
      status: 'answered',
      body: `${ANSWER} ${RETURN}`,
    });
    const { fake, transport, deps } = harness({ answerComposer: composer });
    const answered = await text(
      fake,
      transport,
      deps,
      'What is worth doing with the kids near us?',
    );
    expect(answered).toEqual({ status: 'question_answered', source: 'composed' });
    expect(transport.bodies()).toEqual([`${ANSWER} ${RETURN}`]);
    expect(transport.bodies()[0]).not.toBe(greeting(null, 'en'));
    expect(composer.calls).toEqual([
      {
        parentWords: 'What is worth doing with the kids near us?',
        pendingAsk: COLD_START_ASK,
        children: [],
        postalCode: null,
      },
    ]);
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
    // The year-open turn already closed the session, so STOP revokes the channel
    // rather than rewriting that row to `stopped`.
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
    // The channel revoke is written before the ack. A closed intake session is not
    // what makes the unsubscribe durable.
    expect(
      fake.writes.some(
        (w) => w.op === 'update' && w.table === schema.parentChannels && w.payload.revokedAt,
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

  it('HELP from an unknown number stays unledgered — channel_messages has no family row to hold it', async () => {
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

  it('does not clarify a wobbly French text once the year is open', async () => {
    const { fake, transport, deps } = harness({
      intents: [ambiguous('vous surveillez quoi au juste?')],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const sent = transport.bodies().length;

    const clarified = await text(fake, transport, deps, 'vous surveillez quoi au juste?');
    expect(clarified).toEqual({ status: 'ladder_advanced', step: 'name_reply', closed: false });
    expect(transport.bodies()).toHaveLength(sent);
    expect(transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(transport.bodies()).not.toContain(AMBIGUOUS_CLARIFY_BY_LANGUAGE.fr);
  });

  it('does not answer a later no in either language', async () => {
    const fr = harness({ intents: [decline('non merci')] });
    await text(fr.fake, fr.transport, fr.deps, 'hi');
    await text(fr.fake, fr.transport, fr.deps, 'Mes enfants ont 4 ans et 1 an, M5V 2T6');
    const frSent = fr.transport.bodies().length;
    await text(fr.fake, fr.transport, fr.deps, 'non merci');
    expect(fr.transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(fr.transport.bodies()).not.toContain(PARENT_CALL_NAME_ASK);
    expect(fr.transport.bodies()).not.toContain(DECLINE_ACK_BY_LANGUAGE.fr);
    expect(fr.transport.bodies().at(-1)).toContain('Gmail');
    expect(fr.transport.bodies()).toHaveLength(frSent + 1);

    const en = harness({ intents: [decline('no thanks')] });
    await text(en.fake, en.transport, en.deps, 'hi');
    await text(en.fake, en.transport, en.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const enSent = en.transport.bodies().length;
    await text(en.fake, en.transport, en.deps, 'no thanks');
    expect(en.transport.bodies()).toHaveLength(enSent);
    expect(en.transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(en.transport.bodies().at(-1)).toBe(PARENT_CALL_NAME_ASK);
    expect(en.transport.bodies()).not.toContain(DECLINE_ACK);
  });

  it('sends the French cards on a French kids-and-postal text, and skips the English name', async () => {
    const fr = harness({ intents: [assent('oui')] });
    await text(fr.fake, fr.transport, fr.deps, 'Bonjour');
    const recorded = await text(
      fr.fake,
      fr.transport,
      fr.deps,
      'Mes enfants ont 4 ans et 1 an, M5V 2T6',
    );

    expect(recorded.status).toBe('provisioned');
    expect(fr.transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(fr.transport.bodies()).not.toContain(PARENT_CALL_NAME_ASK);
    expect(fr.transport.bodies()).not.toContain(ASSENT_ACK_BY_LANGUAGE.fr);
    expect(fr.transport.bodies().at(-1)).not.toBe(CO_PARENT_ASK_BY_LANGUAGE.fr);
    const calendar = fr.transport.bodies().at(-1) as string;
    expect(fr.transport.bodies().at(-2)).toBe('RADAR');

    await text(fr.fake, fr.transport, fr.deps, 'plus tard');
    const gmail = fr.transport.bodies().at(-1) as string;
    expect(fr.transport.bodies()).not.toContain(PARENT_CALL_NAME_ASK);
    const [calendarUrl] = calendar.match(/https:\/\/\S+/g) as RegExpMatchArray;
    const [gmailUrl] = gmail.match(/https:\/\/\S+/g) as RegExpMatchArray;
    expect(calendar).toBe(intakeCalendarCard('fr', calendarUrl as string));
    expect(gmail).toBe(intakeGmailCard('fr', gmailUrl as string));
    expect(calendar).not.toContain('Gmail');
    expect(gmail).toContain('Gmail');
    await text(fr.fake, fr.transport, fr.deps, 'plus tard');
    expect(fr.transport.bodies().at(-1)).toBe(CO_PARENT_ASK_BY_LANGUAGE.fr);

    const en = harness({ intents: [assent('yes')] });
    await text(en.fake, en.transport, en.deps, 'hi');
    const enRecorded = await text(en.fake, en.transport, en.deps, 'Maya is 4, Leo is 1. M5V 2T6');

    expect(enRecorded.status).toBe('provisioned');
    expect(en.transport.bodies()).toContain(PARENT_CALL_NAME_ASK);
    expect(en.transport.bodies()).not.toContain(ASSENT_ACK);
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
    expect(await text(fr.fake, fr.transport, fr.deps, 'AIDE')).toEqual({
      status: 'helped',
      ack: 'sent',
    });
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
    expect(transport.bodies()).toEqual([HALE_GREETING_EN]);
    expect(transport.bodies()[0]).toBe(
      'Hi — I’m Hale. I help plan your kids’ year — what’s on near them, sign-up mornings, and how it went. Names, ages, and postal code and I’ll look up what’s coming.',
    );
    expect(transport.bodies()[0]).not.toContain(COLD_START_ASK);
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

const LINQ_LINE = '+16462352164';

/** A live Hale card: setup 201, retrieve active, share 200. */
function liveLinqCardFetch(options?: {
  refuseSetupTimes?: number;
  refuseShare?: boolean;
}) {
  let setups = 0;
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/contact_card?') || init?.method === 'GET') {
      return Response.json({
        contact_cards: [{ phone_number: LINQ_LINE, first_name: 'Hale', is_active: true }],
      });
    }
    if (target.includes('/contact_card') && !target.includes('share_contact_card')) {
      setups += 1;
      if (options?.refuseSetupTimes !== undefined && setups <= options.refuseSetupTimes) {
        return Response.json({ error: { code: 'image_unreachable' } }, { status: 400 });
      }
      return Response.json({ is_active: true, phone_number: LINQ_LINE }, { status: 201 });
    }
    if (target.includes('share_contact_card') && options?.refuseShare) {
      return Response.json({ error: { code: 'share_rejected' } }, { status: 400 });
    }
    if (target.includes('/messages')) {
      return Response.json({ message: { id: `msg-out-${setups}` } }, { status: 201 });
    }
    return new Response(null, { status: 200 });
  });
}

function shareCardCalls(fetchMock: { mock: { calls: unknown[][] } }) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes('share_contact_card'));
}

/**
 * The year-find turn sends the find, then the name. Later replies settle one
 * job each. A night reply still sends the connector card that beat is for.
 * The Linq Name and Photo share is silent and happens on the first outbound.
 */
describe('intake · one ladder job per reply', () => {
  it('sends the name with the year find, then one later job per reply', async () => {
    const h = harness({});
    await text(h.fake, h.transport, h.deps, 'hi');
    const beforeFind = h.transport.bodies().length;
    await text(h.fake, h.transport, h.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    expect(h.transport.bodies().slice(beforeFind)).toEqual(['RADAR', PARENT_CALL_NAME_ASK]);
    const afterFind = h.transport.bodies().length;

    expect(await reply(h, 'Jimmy')).toEqual({
      status: 'ladder_advanced',
      step: 'name_reply',
      closed: false,
    });
    expect(h.transport.bodies().slice(afterFind)).toEqual([NAME_CAPTURED_REPLY]);

    expect(await reply(h)).toEqual({ status: 'ladder_advanced', step: 'calendar', closed: false });
    expect(h.transport.bodies().at(-1)).toContain('Connect your calendar:');
    expect(h.transport.bodies().at(-1)).not.toContain('Gmail:');

    expect(await reply(h)).toEqual({ status: 'ladder_advanced', step: 'gmail', closed: false });
    expect(h.transport.bodies().at(-1)).toContain('Gmail:');
    expect(h.transport.bodies().at(-1)).not.toContain('Connect your calendar:');

    expect(await reply(h)).toEqual({ status: 'ladder_advanced', step: 'coparent', closed: true });
    expect(h.transport.bodies().at(-1)).toBe(CO_PARENT_ASK);
    expect(h.transport.bodies().at(-1)).not.toContain("Calendar's connected");
    expect(h.transport.bodies().at(-1)).not.toContain("Gmail's connected");
  });

  it('does not wait for a soft ack, and does not read cool as a name', async () => {
    const h = harness({});
    await text(h.fake, h.transport, h.deps, 'hi');
    await text(h.fake, h.transport, h.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    expect(h.transport.bodies().at(-2)).toBe('RADAR');
    expect(h.transport.bodies().at(-1)).toBe(PARENT_CALL_NAME_ASK);
    const afterFind = h.transport.bodies().length;

    expect(await text(h.fake, h.transport, h.deps, 'cool')).toEqual({
      status: 'ladder_advanced',
      step: 'name_reply',
      closed: false,
    });
    expect(h.transport.bodies()).toHaveLength(afterFind);
    expect(
      inserts(h.fake, schema.auditLog).some((row) => row.actionTaken === 'parent_name_captured'),
    ).toBe(false);
  });

  it('asks what to call you on the year-find turn when the iMessage card cannot be shared', async () => {
    vi.stubEnv('LINQ_FROM_E164', '');
    const h = harness({});
    const imessage = (body: string) =>
      handleInboundSms(
        h.fake.db,
        h.transport.inbound(PHONE, body, { transport: 'imessage', chatId: 'chat-year' }),
        h.deps,
      );
    await imessage('hi');
    const beforeFind = h.transport.bodies().length;
    await imessage('Maya is 4, Leo is 1. M5V 2T6');
    expect(h.transport.bodies().slice(beforeFind)).toEqual(['RADAR', PARENT_CALL_NAME_ASK]);
    expect(h.transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    const afterFind = h.transport.bodies().length;
    expect(await imessage('cool')).toEqual({
      status: 'ladder_advanced',
      step: 'name_reply',
      closed: false,
    });
    expect(h.transport.bodies()).toHaveLength(afterFind);
    expect(
      h.fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'linq_contact_card_shared' &&
          (write.payload.after as { outcome?: string } | undefined)?.outcome === 'shared',
      ),
    ).toBe(false);
  });

  it('shares the live Linq card once on the first hello, and the year-find turn does not share again', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', LINQ_LINE);
    const fetchMock = liveLinqCardFetch();
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({});
    const imessage = (body: string) =>
      handleInboundSms(
        h.fake.db,
        h.transport.inbound(PHONE, body, { transport: 'imessage', chatId: 'chat-year' }),
        h.deps,
      );
    await imessage('hi');
    expect(h.transport.bodies()).toEqual([greeting(null, 'en')]);
    expect(shareCardCalls(fetchMock)).toHaveLength(1);
    expect(h.transport.bodies()).not.toContain(WELCOME_CARD_BODY);

    const beforeFind = h.transport.bodies().length;
    await imessage('Maya is 4, Leo is 1. M5V 2T6');

    expect(h.transport.bodies().slice(beforeFind)).toEqual(['RADAR', PARENT_CALL_NAME_ASK]);
    expect(shareCardCalls(fetchMock)).toHaveLength(1);
    expect(h.fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt).toEqual(NOW);
    expect(
      h.fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'linq_contact_card_shared' &&
          (write.payload.after as { outcome?: string } | undefined)?.outcome === 'shared',
      ),
    ).toBe(true);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('never shares the Linq card on SMS', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', LINQ_LINE);
    const fetchMock = liveLinqCardFetch();
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({});
    await text(h.fake, h.transport, h.deps, 'hi');
    await text(h.fake, h.transport, h.deps, 'Maya is 4, Leo is 1. M5V 2T6');
    expect(h.transport.bodies()).toEqual([greeting(null, 'en'), 'RADAR', PARENT_CALL_NAME_ASK]);
    expect(shareCardCalls(fetchMock)).toHaveLength(0);
    expect(h.fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt ?? null).toBeNull();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('never shares the Linq card into a group', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', LINQ_LINE);
    const fetchMock = liveLinqCardFetch();
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({});
    await handleInboundSms(
      h.fake.db,
      h.transport.inbound(PHONE, 'hi', {
        transport: 'imessage',
        chatId: 'chat-group',
        isGroup: true,
      }),
      h.deps,
    );
    expect(h.transport.bodies()).toEqual([greeting(null, 'en')]);
    expect(shareCardCalls(fetchMock)).toHaveLength(0);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('releases a refused setup on the first hello so the year-find turn can share once', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', LINQ_LINE);
    const fetchMock = liveLinqCardFetch({ refuseSetupTimes: 1 });
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({});
    const imessage = (body: string) =>
      handleInboundSms(
        h.fake.db,
        h.transport.inbound(PHONE, body, { transport: 'imessage', chatId: 'chat-year' }),
        h.deps,
      );
    await imessage('hi');
    expect(shareCardCalls(fetchMock)).toHaveLength(0);
    expect(h.transport.bodies()).toEqual([greeting(null, 'en')]);

    const beforeFind = h.transport.bodies().length;
    await imessage('Maya is 4, Leo is 1. M5V 2T6');
    expect(h.transport.bodies().slice(beforeFind)).toEqual(['RADAR', PARENT_CALL_NAME_ASK]);
    expect(shareCardCalls(fetchMock)).toHaveLength(1);
    expect(h.fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt).toEqual(NOW);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps the claim when the share itself is refused and does not retry at year-find', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', LINQ_LINE);
    const fetchMock = liveLinqCardFetch({ refuseShare: true });
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({});
    const imessage = (body: string) =>
      handleInboundSms(
        h.fake.db,
        h.transport.inbound(PHONE, body, { transport: 'imessage', chatId: 'chat-year' }),
        h.deps,
      );
    await imessage('hi');
    expect(shareCardCalls(fetchMock)).toHaveLength(1);
    await imessage('Maya is 4, Leo is 1. M5V 2T6');
    expect(shareCardCalls(fetchMock)).toHaveLength(1);
    expect(h.transport.bodies()).toEqual([greeting(null, 'en'), 'RADAR', PARENT_CALL_NAME_ASK]);
    expect(h.fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt).toEqual(NOW);
    expect(
      h.fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'linq_contact_card_shared' &&
          (write.payload.after as { outcome?: string } | undefined)?.outcome === 'shared',
      ),
    ).toBe(false);
    expect(
      h.fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'linq_contact_card_shared' &&
          (write.payload.after as { outcome?: string } | undefined)?.outcome === 'share_refused',
      ),
    ).toBe(true);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('shares once on a details-first iMessage send, between the find and the name', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', LINQ_LINE);
    const chatId = 'chat-year';
    const fetchMock = liveLinqCardFetch();
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({});
    const inbound = h.transport.inbound(PHONE, 'Maya is 4, Leo is 1. M5V 2T6', {
      transport: 'imessage',
      chatId,
      providerId: 'msg-in-details',
    });
    const linq = createLinqTextTransport({
      chatId,
      replyToMessageId: inbound.providerId,
      fetch: fetchMock,
    });
    const recorded = await handleInboundSms(h.fake.db, inbound, { ...h.deps, transport: linq });

    expect(recorded.status).toBe('provisioned');
    expect(shareCardCalls(fetchMock)).toHaveLength(1);
    const calls = fetchMock.mock.calls.map((call) => ({
      url: String(call[0]),
      method: (call[1]?.method ?? 'GET').toUpperCase(),
    }));
    const thread = calls.filter(
      (call) =>
        call.method === 'POST' &&
        (call.url.endsWith(`/chats/${chatId}/messages`) ||
          call.url.endsWith(`/chats/${chatId}/share_contact_card`)),
    );
    expect(thread.map((call) => call.url.split('/chats/')[1])).toEqual([
      `${chatId}/messages`,
      `${chatId}/share_contact_card`,
      `${chatId}/messages`,
    ]);
    expect(h.transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('shares into the inbound Linq chat on the first hello, then replies the year find and the name', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+16462352164');
    const chatId = 'chat-year';
    const inboundId = 'msg-in-year';
    let messageCount = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/contact_card?') || init?.method === 'GET') {
        return Response.json({
          contact_cards: [{ phone_number: '+16462352164', first_name: 'Hale', is_active: true }],
        });
      }
      if (target.includes('/contact_card')) {
        return Response.json({ is_active: true, phone_number: '+16462352164' }, { status: 201 });
      }
      if (target.includes('/messages')) {
        messageCount += 1;
        return Response.json({ message: { id: `msg-out-${messageCount}` } }, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({});
    await handleInboundSms(
      h.fake.db,
      h.transport.inbound(PHONE, 'hi', { transport: 'imessage', chatId }),
      h.deps,
    );
    const findInbound = h.transport.inbound(PHONE, 'Maya is 4, Leo is 1. M5V 2T6', {
      transport: 'imessage',
      chatId,
      providerId: inboundId,
    });
    // The door binds the turn's transport to this chat and this inbound message.
    const linq = createLinqTextTransport({
      chatId,
      replyToMessageId: findInbound.providerId,
      fetch: fetchMock,
    });
    const recorded = await handleInboundSms(h.fake.db, findInbound, {
      ...h.deps,
      transport: linq,
    });

    expect(recorded.status).toBe('provisioned');
    const calls = fetchMock.mock.calls.map((call) => {
      const init = call[1];
      return {
        url: String(call[0]),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
    });
    const thread = calls.filter(
      (call) =>
        call.method === 'POST' &&
        (call.url.endsWith(`/chats/${chatId}/messages`) ||
          call.url.endsWith(`/chats/${chatId}/share_contact_card`)),
    );
    expect(thread.map((call) => call.url.split('/chats/')[1])).toEqual([
      `${chatId}/share_contact_card`,
      `${chatId}/messages`,
      `${chatId}/messages`,
    ]);
    expect(thread[1]?.body).toEqual({
      message: {
        parts: [{ type: 'text', value: 'RADAR' }],
        reply_to: { message_id: inboundId },
      },
    });
    expect(thread[2]?.body).toEqual({
      message: {
        parts: [{ type: 'text', value: PARENT_CALL_NAME_ASK }],
        reply_to: { message_id: inboundId },
      },
    });
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/chats'))).toBe(false);
    const outbound = inserts(h.fake, schema.channelMessages).filter(
      (row) => row.direction === 'out',
    );
    expect(outbound.length).toBeGreaterThan(0);
    expect(outbound.every((row) => row.providerChatId === chatId)).toBe(true);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('replies the French calendar card into that same Linq chat, not a new thread', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+16462352164');
    const chatId = 'chat-year';
    const inboundId = 'msg-in-year-fr';
    let messageCount = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/contact_card?') || init?.method === 'GET') {
        return Response.json({
          contact_cards: [{ phone_number: '+16462352164', first_name: 'Hale', is_active: true }],
        });
      }
      if (target.includes('/contact_card')) {
        return Response.json({ is_active: true, phone_number: '+16462352164' }, { status: 201 });
      }
      if (target.includes('/messages')) {
        messageCount += 1;
        return Response.json({ message: { id: `msg-out-${messageCount}` } }, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({});
    await handleInboundSms(
      h.fake.db,
      h.transport.inbound(PHONE, 'Bonjour', { transport: 'imessage', chatId }),
      h.deps,
    );
    const findInbound = h.transport.inbound(PHONE, 'Mes enfants ont 4 ans et 1 an, M5V 2T6', {
      transport: 'imessage',
      chatId,
      providerId: inboundId,
    });
    const linq = createLinqTextTransport({
      chatId,
      replyToMessageId: findInbound.providerId,
      fetch: fetchMock,
    });
    const recorded = await handleInboundSms(h.fake.db, findInbound, {
      ...h.deps,
      transport: linq,
    });

    expect(recorded.status).toBe('provisioned');
    const calls = fetchMock.mock.calls.map((call) => {
      const init = call[1];
      return {
        url: String(call[0]),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
    });
    const thread = calls.filter(
      (call) =>
        call.method === 'POST' &&
        (call.url.includes(`/chats/${chatId}/`) || call.url.endsWith('/chats')),
    );
    expect(thread.some((call) => call.url.endsWith('/chats'))).toBe(false);
    expect(thread[0]?.url.endsWith(`/chats/${chatId}/share_contact_card`)).toBe(true);
    expect(thread[1]?.url.endsWith(`/chats/${chatId}/messages`)).toBe(true);
    expect(thread[1]?.body).toEqual({
      message: {
        parts: [{ type: 'text', value: 'RADAR' }],
        reply_to: { message_id: inboundId },
      },
    });
    expect(thread.slice(1).every((call) => !call.url.endsWith('/share_contact_card'))).toBe(true);
    const calendar = thread[2]?.body as {
      message: { parts: Array<{ type: string; value: string }>; reply_to?: { message_id: string } };
    };
    const calendarText = calendar.message.parts[0]?.value ?? '';
    const calendarUrl = (calendarText.match(/https:\/\/\S+/g) ?? [])[0] as string;
    expect(calendarText).toBe(intakeCalendarCard('fr', calendarUrl));
    expect(calendar.message.reply_to).toEqual({ message_id: inboundId });
    expect(thread.slice(2).every((call) => call.url.endsWith(`/chats/${chatId}/messages`))).toBe(
      true,
    );
    expect(
      calls.some((call) => String(JSON.stringify(call.body)).includes(PARENT_CALL_NAME_ASK)),
    ).toBe(false);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('still asks the name when Linq reports the card inactive', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+16462352164');
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/contact_card?') || init?.method === 'GET') {
        return Response.json({
          contact_cards: [{ phone_number: '+16462352164', first_name: 'Hale', is_active: false }],
        });
      }
      if (target.includes('/contact_card')) {
        return Response.json({ is_active: true, phone_number: '+16462352164' }, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({});
    await handleInboundSms(
      h.fake.db,
      h.transport.inbound(PHONE, 'hi', { transport: 'imessage', chatId: 'chat-year' }),
      h.deps,
    );
    const beforeFind = h.transport.bodies().length;
    await handleInboundSms(
      h.fake.db,
      h.transport.inbound(PHONE, 'Maya is 4, Leo is 1. M5V 2T6', {
        transport: 'imessage',
        chatId: 'chat-year',
      }),
      h.deps,
    );

    expect(h.transport.bodies().slice(beforeFind)).toEqual(['RADAR', PARENT_CALL_NAME_ASK]);
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('share_contact_card')),
    ).toBe(false);
    expect(
      h.fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'linq_contact_card_shared' &&
          (write.payload.after as { outcome?: string } | undefined)?.outcome === 'shared',
      ),
    ).toBe(false);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('shares a live French Linq card and sends the calendar card, not the English name', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+16462352164');
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/contact_card?') || init?.method === 'GET') {
        return Response.json({
          contact_cards: [{ phone_number: '+16462352164', first_name: 'Hale', is_active: true }],
        });
      }
      if (target.includes('/contact_card')) {
        return Response.json({ is_active: true, phone_number: '+16462352164' }, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({});
    const imessage = (body: string) =>
      handleInboundSms(
        h.fake.db,
        h.transport.inbound(PHONE, body, { transport: 'imessage', chatId: 'chat-year' }),
        h.deps,
      );
    await imessage('Bonjour');
    const beforeFind = h.transport.bodies().length;
    await imessage('Mes enfants ont 4 ans et 1 an, M5V 2T6');

    const sent = h.transport.bodies().slice(beforeFind);
    expect(sent[0]).toBe('RADAR');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(
      intakeCalendarCard('fr', (sent[1]?.match(/https:\/\/\S+/g) ?? [])[0] as string),
    );
    expect(h.transport.bodies()).not.toContain(PARENT_CALL_NAME_ASK);
    expect(h.transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(shareCardCalls(fetchMock)).toHaveLength(1);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('asks for the iMessage group on the co-parent beat and does not collect a number', async () => {
    vi.stubEnv('LINQ_FROM_E164', '+16462352164');
    vi.stubEnv('LINQ_API_KEY', '');
    const h = harness({});
    const imessage = (body: string) =>
      handleInboundSms(
        h.fake.db,
        h.transport.inbound(PHONE, body, { transport: 'imessage', chatId: 'chat-year' }),
        h.deps,
      );
    await imessage('hi');
    await imessage('Maya is 4, Leo is 1. M5V 2T6');
    await imessage('cool');
    await imessage('Jimmy');
    await imessage('later');
    await imessage('later');
    const closed = await imessage('later');
    expect(closed).toEqual({ status: 'ladder_advanced', step: 'coparent', closed: true });
    expect(h.transport.bodies().at(-1)).toBe(
      linqCoParentAsk(formatLinqLineForParent('+16462352164'), 'en'),
    );
    expect(h.transport.bodies().at(-1)).not.toMatch(/text me their number/i);
    expect(h.transport.bodies().join('\n')).not.toMatch(/I'll invite|I'll send an invite/i);
  });
});

describe('intake · the calendar card and the Gmail card', () => {
  async function openYear(h: ReturnType<typeof harness>, override?: IntakeDeps) {
    await text(h.fake, h.transport, h.deps, 'hi');
    return text(h.fake, h.transport, h.deps, 'Maya is 4, Leo is 1. M5V 2T6', override);
  }

  it('sends the calendar card, then the Gmail card, each with one link', async () => {
    const h = harness({ intents: [assent('yes please')] });

    const recorded = await openYear(h);

    expect(recorded.status).toBe('provisioned');
    expectEnglishYearOpen(h.transport.bodies());
    await reply(h);
    await reply(h);
    const calendar = h.transport.bodies().at(-1) as string;
    await reply(h);
    const gmail = h.transport.bodies().at(-1) as string;
    expect(calendar).toBe(
      intakeCalendarCard('en', (calendar.match(/https:\/\/\S+/g) as string[])[0] as string),
    );
    expect(gmail).toBe(
      intakeGmailCard('en', (gmail.match(/https:\/\/\S+/g) as string[])[0] as string),
    );

    const calendarRow = inserts(h.fake, schema.channelMessages).find(
      (row) => row.templateKey === INTAKE_CALENDAR_CARD_TEMPLATE_KEY,
    );
    const gmailRow = inserts(h.fake, schema.channelMessages).find(
      (row) => row.templateKey === INTAKE_GMAIL_CARD_TEMPLATE_KEY,
    );
    expect(calendarRow).toMatchObject({
      direction: 'out',
      category: 'intake',
      dedupeKey: calendarCardDedupeKey(String(calendarRow?.familyId)),
      status: 'queued',
    });
    expect(gmailRow).toMatchObject({
      direction: 'out',
      category: 'intake',
      dedupeKey: gmailCardDedupeKey(String(gmailRow?.familyId)),
      status: 'queued',
    });
    expect(
      inserts(h.fake, schema.auditLog)
        .map((a) => a.actionTaken)
        .filter((action) => action === 'connector_link_minted'),
    ).toHaveLength(2);
  });

  it('still sends both cards when the name composer is ready and unused', async () => {
    const h = harness({
      intents: [assent('yes please')],
      identityAsk: new FakeIdentityAsk({ status: 'deferred', reason: 'model_failed' }),
    });

    const recorded = await openYear(h);
    await reply(h);
    await reply(h);
    await reply(h);
    await reply(h);

    expect(recorded.status).toBe('provisioned');
    expect(h.identityAsk.calls).toEqual([]);
    expect(h.transport.bodies()).toContain(PARENT_CALL_NAME_ASK);
    expect(h.transport.bodies().at(-3)).toContain('Connect your calendar:');
    expect(h.transport.bodies().at(-2)).toContain('Gmail:');
    expect(h.transport.bodies().at(-1)).toBe(CO_PARENT_ASK);
  });

  it('sends both cards on a night reply and closes the session', async () => {
    const h = harness({ intents: [assent('yes please')] });
    const late = new Date('2026-09-18T02:30:00.000Z');

    const recorded = await openYear(h, { ...h.deps, now: late });
    expect(recorded.status).toBe('provisioned');
    expect(h.transport.bodies().at(-1)).toBe(PARENT_CALL_NAME_ASK);

    const night = { ...h.deps, now: late };
    await text(h.fake, h.transport, h.deps, LADDER_BEAT, night);
    await text(h.fake, h.transport, h.deps, LADDER_BEAT, night);
    await text(h.fake, h.transport, h.deps, LADDER_BEAT, night);
    const closed = await text(h.fake, h.transport, h.deps, LADDER_BEAT, night);

    expect(closed).toEqual({ status: 'ladder_advanced', step: 'coparent', closed: true });
    expect(h.transport.bodies().at(-1)).toBe(CO_PARENT_ASK);
    expect(h.transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(
      inserts(h.fake, schema.channelMessages).filter(
        (row) =>
          row.templateKey === INTAKE_CALENDAR_CARD_TEMPLATE_KEY ||
          row.templateKey === INTAKE_GMAIL_CARD_TEMPLATE_KEY,
      ),
    ).toEqual([
      expect.objectContaining({ templateKey: INTAKE_CALENDAR_CARD_TEMPLATE_KEY, status: 'queued' }),
      expect.objectContaining({ templateKey: INTAKE_GMAIL_CARD_TEMPLATE_KEY, status: 'queued' }),
    ]);

    const sent = h.transport.sent.length;
    const replay = await text(h.fake, h.transport, h.deps, 'yes');
    expect(replay).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(h.transport.sent).toHaveLength(sent);
    expect(
      h.fake.writes.some(
        (w) =>
          w.op === 'update' &&
          w.table === schema.smsIntakeSessions &&
          w.payload.state === 'complete',
      ),
    ).toBe(true);
  });

  it('still sends the co-parent ask when the provider refuses both cards', async () => {
    const h = harness({ intents: [assent('yes please')] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const inner = h.transport;
    const refusesTheOffer: IntakeDeps['transport'] = {
      async send(input) {
        if (input.body.includes('/connect?t=')) throw new TwilioSendError('21610', 400);
        return inner.send(input);
      },
    };

    const recorded = await openYear(h, { ...h.deps, transport: refusesTheOffer });
    const refuse = { ...h.deps, transport: refusesTheOffer };
    await text(h.fake, h.transport, h.deps, LADDER_BEAT, refuse);
    await text(h.fake, h.transport, h.deps, LADDER_BEAT, refuse);
    await text(h.fake, h.transport, h.deps, LADDER_BEAT, refuse);
    await text(h.fake, h.transport, h.deps, LADDER_BEAT, refuse);

    expect(recorded.status).toBe('provisioned');
    expect(h.transport.bodies().at(-1)).toBe(CO_PARENT_ASK);
    expect(h.transport.bodies()).toContain(PARENT_CALL_NAME_ASK);
    expect(h.transport.bodies()).not.toContain(ASSENT_ACK);
    expect(
      h.fake.writes.some(
        (w) =>
          w.op === 'update' &&
          w.table === schema.smsIntakeSessions &&
          w.payload.state === 'complete',
      ),
    ).toBe(true);
    const failed = h.fake.writes.filter(
      (w) =>
        w.op === 'update' && w.table === schema.channelMessages && w.payload.status === 'failed',
    );
    expect(failed.map((w) => w.payload.errorCode)).toEqual(['21610', '21610']);
  });

  it('sends the French cards, and not the English name, when the details are French', async () => {
    const h = harness({ intents: [assent('oui')] });
    await text(h.fake, h.transport, h.deps, 'Bonjour');
    const recorded = await text(
      h.fake,
      h.transport,
      h.deps,
      'Mes enfants ont 4 ans et 1 an, M5V 2T6',
    );

    expect(recorded.status).toBe('provisioned');
    expect(h.transport.bodies().at(-2)).toBe('RADAR');
    const calendar = h.transport.bodies().at(-1) as string;
    await text(h.fake, h.transport, h.deps, 'plus tard');
    const gmail = h.transport.bodies().at(-1) as string;
    await text(h.fake, h.transport, h.deps, 'plus tard');
    expect(h.transport.bodies().at(-1)).toBe(CO_PARENT_ASK_BY_LANGUAGE.fr);
    expect(h.transport.bodies()).not.toContain(PARENT_CALL_NAME_ASK);
    expect(calendar).toBe(
      intakeCalendarCard('fr', (calendar.match(/https:\/\/\S+/g) as string[])[0] as string),
    );
    expect(gmail).toBe(
      intakeGmailCard('fr', (gmail.match(/https:\/\/\S+/g) as string[])[0] as string),
    );
  });

  it('still sends the name, both links, and the co-parent ask when the find is empty', async () => {
    const h = harness({ intents: [assent('yes please')], findWon: false });

    await openYear(h);
    expectEnglishYearOpen(h.transport.bodies());
    expect(h.transport.bodies()).toContain(PARENT_CALL_NAME_ASK);
    expect(h.transport.bodies()).not.toContain(CO_PARENT_ASK);

    const sent = h.transport.bodies().length;
    const later = await text(h.fake, h.transport, h.deps, 'yes please');
    expect(later).toEqual({ status: 'ladder_advanced', step: 'name_reply', closed: false });
    expect(h.transport.bodies()).toHaveLength(sent);
    expect(h.transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    expect(h.transport.bodies().join('\n')).not.toContain('Connect your calendar:');
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
describe("the first radar's weekend-pick stamp", () => {
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
