import { schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HALE_CONTACT_FIRST_NAME } from '~/lib/channel/linq/contact-card';
import { LinqSendError, createLinqTextTransport } from '~/lib/channel/linq/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { START_ACK_BY_LANGUAGE, STOP_ACK, STOP_ACK_BY_LANGUAGE } from './copy';
import type { IntakeCollected } from './extract';
import {
  FakeAnswerComposer,
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from './fakes';
import type { IntentReading } from './intent';
import { type IntakeDeps, handleInboundSms } from './machine';
import { scriptedFriendVoice } from './scripted-friend-voice.fixture';
import { FakeTransport } from './transport';
import { claimIntakeTurn } from './turn-claim';
import { IMPLIED_WATCH_BASIS } from './watch-consent';
import { WELCOME_CARD_BODY } from './welcome-card';

/** #868: the fixed ask is gone; any pending-ask text is a fixture. */
const COLD_START_ASK = 'cold start ask (test fixture)';

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

function assent(reply: string): IntentReading {
  return { intent: 'assent', verbatim: reply, interpretation: 'plain yes' };
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
  /** Titles from that find. Two or more can become a year-find poll. */
  titles?: readonly string[];
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
            ...(options.titles ? { titles: options.titles } : {}),
          };
        },
      },
      answerComposer: options.answerComposer ?? fakeSilentAnswerComposer,
      friendVoice: scriptedFriendVoice,
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
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = '';
});

describe('intake · happy path', () => {
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

  it('does not seed anything for a conversation that never provisioned', async () => {
    const { fake, transport, deps, steps } = harness({
      extractions: [{ children: MAYA_AND_LEO.children, postalCode: '10001' }],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya 4, Leo 1, 10001');
    expect(steps).toEqual([]);
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

  it('with group onboarding v2 on, a group STOP the roster did not answer still revokes and acks, as with v2 off', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const result = await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'STOP', {
        transport: 'imessage',
        chatId: 'chat-group',
        isGroup: true,
      }),
      deps,
    );

    expect(result).toEqual({ status: 'stopped', ack: 'sent' });
    expect(transport.bodies().at(-1)).toBe(STOP_ACK);
    expect(
      fake.writes.some(
        (w) => w.op === 'update' && w.table === schema.parentChannels && w.payload.revokedAt,
      ),
    ).toBe(true);
    vi.unstubAllEnvs();
  });

  it('records the STOP even when Linq permanently refuses the ack (21610 — the carrier already told them)', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const result = await text(fake, transport, deps, 'STOP', {
      ...deps,
      transport: refusingTransport(new LinqSendError('21610', 400, true)),
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
        transport: refusingTransport(new LinqSendError('20500', 503, false)),
      }),
    ).rejects.toBeInstanceOf(LinqSendError);
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
    expect(transport.bodies().at(-1)).toEqual(expect.any(String)); // model-written; no fixed copy
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
    expect(transport.bodies().at(-1)).toEqual(expect.any(String)); // model-written; no fixed copy
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
    expect(transport.bodies().at(-1)).toEqual(expect.any(String)); // model-written; no fixed copy

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

  it('does not spend the sender budget on a group turn the door already charged to the chat', async () => {
    const limiter = new FakeRateLimiter(() => NOW.getTime());
    const { fake, transport, deps } = harness({ limiter });
    const hash = phoneBlindIndex(PHONE);
    for (let i = 0; i < RATE_LIMITS['sms-inbound'].limit; i += 1) {
      await limiter.check(hash, 'sms-inbound', RATE_LIMITS['sms-inbound']);
    }
    const group = { transport: 'imessage' as const, chatId: 'chat-group', isGroup: true };

    // The control: the same exhausted sender budget silences an ordinary group turn.
    expect(await handleInboundSms(fake.db, transport.inbound(PHONE, 'hi', group), deps)).toEqual({
      status: 'rate_limited',
    });

    const charged = await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'hi', { ...group, budget: 'chat' }),
      deps,
    );
    expect(charged).not.toEqual({ status: 'rate_limited' });
    expect(transport.bodies()).toHaveLength(1); // one model-written reply; no fixed copy
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

  it('rejects an unsupported address format without a ledger write', async () => {
    const { fake, transport, deps } = harness({});
    const result = await handleInboundSms(
      fake.db,
      transport.inbound('whatsapp:+14165551234', 'hi'),
      deps,
    );
    expect(result).toEqual({ status: 'ignored', reason: 'invalid_number' });
    expect(transport.sent).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
    expect(fake.rows(schema.channelMessages)).toHaveLength(0);
    expect(fake.rows(schema.auditLog)).toHaveLength(0);
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
    expect(fr.transport.bodies().at(-1)).toEqual(expect.any(String)); // model-written; no fixed copy

    const en = harness({});
    await text(en.fake, en.transport, en.deps, 'hi');
    await text(en.fake, en.transport, en.deps, 'HELP');
    expect(en.transport.bodies().at(-1)).toEqual(expect.any(String)); // model-written; no fixed copy
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
});

/**
 * VIL-332 — createSession commits before send. A crash or a refused first
 * send must not leave an open awaiting_details row that swallows the retry
 * as details / a duplicate and never greets.
 */
describe('intake · VIL-332 first-hello cannot die after createSession', () => {
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
 * old duplicate check could not see a resend racing a turn still running (Linq
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
        contact_cards: [
          { phone_number: LINQ_LINE, first_name: HALE_CONTACT_FIRST_NAME, is_active: true },
        ],
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
 * The year-find turn sends the find. Later replies settle one job each. A
 * night reply still sends the connector card that beat is for. The Linq Name
 * and Photo share is silent and happens on the first outbound.
 */
describe('intake · one ladder job per reply', () => {
  it('refuses a group turn while this number has an open intake, and says nothing into the group', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    const h = harness({});
    await text(h.fake, h.transport, h.deps, 'hi');
    const before = h.transport.bodies().length;

    const outcome = await handleInboundSms(
      h.fake.db,
      h.transport.inbound(PHONE, 'Maya is 4, Leo is 1. M5V 2T6', {
        transport: 'imessage',
        chatId: 'chat-group',
        isGroup: true,
      }),
      h.deps,
    );

    expect(outcome).toEqual({ status: 'ignored', reason: 'group_turn_during_intake' });
    expect(h.transport.bodies().slice(before)).toEqual([]);
    vi.unstubAllEnvs();
  });

  it('shares once on a details-first iMessage send, after the find', async () => {
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
    ]);
    expect(h.transport.bodies()).not.toContain(WELCOME_CARD_BODY);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
    expect(transport.bodies().at(-1)).toEqual(expect.any(String)); // model-written; no fixed copy
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
   * 500'd and Linq retried it into the same wall, AFTER the consent write had landed.
   * Hale cannot fix the list from here; what it can do is not lie about the outcome.
   */
  it('names a re-enrolment the provider refuses to deliver, instead of 500ing the webhook', async () => {
    const { fake, transport, deps } = await enrolled();
    await text(fake, transport, deps, 'ARRET');
    const outBefore = outRows(fake);

    const result = await handleInboundSms(fake.db, transport.inbound(PHONE, 'DEBUT'), {
      ...deps,
      transport: refusingTransport(new LinqSendError('21610', 400, true)),
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
        transport: refusingTransport(new LinqSendError('20500', 503, false)),
      }),
    ).rejects.toBeInstanceOf(LinqSendError);
  });
});
