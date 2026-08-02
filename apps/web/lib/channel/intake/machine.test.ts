import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  AMBIGUOUS_CLARIFY,
  AREA_BLOCKED_REPLY,
  ASSENT_ACK,
  DECLINE_ACK,
  HELP_REPLY,
  REGION_UNAVAILABLE_REPLY,
  STOP_ACK,
  WATCH_OFFER,
} from './copy';
import { FakeExtractor, FakeIntentReader, type FakeDb, fakeRadar, makeFakeDb } from './fakes';
import type { IntakeCollected } from './extract';
import type { IntentReading } from './intent';
import { type IntakeDeps, handleInboundSms } from './machine';
import { FakeTransport } from './transport';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const NOW = new Date('2026-07-30T12:00:00.000Z');

const MAYA_AND_LEO: IntakeCollected = {
  children: [
    { name: 'Maya', ageMonths: 48 },
    { name: 'Leo', ageMonths: 12 },
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

function harness(options: {
  extractions?: IntakeCollected[];
  intents?: IntentReading[];
  limiter?: FakeRateLimiter;
}): { fake: FakeDb; transport: FakeTransport; deps: IntakeDeps } {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  return {
    fake,
    transport,
    deps: {
      transport,
      extractor: new FakeExtractor(options.extractions ?? [MAYA_AND_LEO]),
      intentReader: new FakeIntentReader(options.intents ?? [assent('yes')]),
      radar: fakeRadar,
      limiter: options.limiter ?? new FakeRateLimiter(() => NOW.getTime()),
      now: NOW,
    },
  };
}

/** Drive one inbound text through the machine. */
function text(fake: FakeDb, transport: FakeTransport, deps: IntakeDeps, body: string) {
  return handleInboundSms(fake.db, transport.inbound(PHONE, body), deps);
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
    expect(transport.bodies()[0]).toContain("I keep family weeks on track for GTA parents");
    // The disclosure rides on the first reply, once.
    expect(transport.bodies()[0]).toContain("I'm an assistant, not a person");

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
      // 2026-07-30 minus (48 + 6) months, and minus (12 + 6) months.
      { familyId: expect.any(String), name: 'Maya', dateOfBirth: '2022-01-30', dobPrecision: 'derived' },
      { familyId: expect.any(String), name: 'Leo', dateOfBirth: '2025-01-30', dobPrecision: 'derived' },
    ]);

    // ── the channel: verified by origination, hashed + encrypted ──
    const [channel] = inserts(fake, schema.parentChannels);
    expect(channel).toMatchObject({ kind: 'sms', verifiedAt: NOW });
    expect(channel?.phoneE164Hash).toMatch(/^[0-9a-f]{64}$/);
    expect(channel?.phoneE164Encrypted).not.toContain('416');

    // ── the watch offer went out ──
    expect(transport.bodies().at(-1)).toContain(WATCH_OFFER);

    const answered = await text(fake, transport, deps, 'yes please');
    expect(answered).toEqual({ status: 'watch_recorded', intent: 'assent', granted: true });
    expect(transport.bodies().at(-1)).toBe(ASSENT_ACK);
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

    expect(result).toEqual({ status: 'watch_recorded', intent: 'decline', granted: false });
    expect(transport.bodies().at(-1)).toBe(DECLINE_ACK);
    const watch = inserts(fake, schema.consentRecords).find(
      (c) => c.consentType === 'proactive_watch',
    );
    expect(watch?.granted).toBe(false);
  });
});

describe('intake · the one follow-up', () => {
  it('asks exactly one targeted follow-up when only the postal code is missing', async () => {
    const { fake, transport, deps } = harness({ extractions: [NO_POSTAL, MAYA_AND_LEO] });
    await text(fake, transport, deps, 'hi');

    const asked = await text(fake, transport, deps, 'Maya is 4 and Leo is 1');
    expect(asked).toEqual({ status: 'follow_up_asked' });
    expect(transport.bodies().at(-1)).toBe("Got it — Maya (4) and Leo (1). What's your postal code?");

    const provisioned = await text(fake, transport, deps, 'M5V 2T6');
    expect(provisioned.status).toBe('provisioned');
  });

  it('never asks a second time — it states the blocker once, then goes quiet', async () => {
    const { fake, transport, deps } = harness({ extractions: [NO_POSTAL] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4 and Leo is 1');
    const before = transport.bodies().length;

    const second = await text(fake, transport, deps, "I'd rather not say");
    expect(second).toEqual({ status: 'area_blocked' });
    // One blocker line, and it is NOT the follow-up question again.
    expect(transport.bodies()).toHaveLength(before + 1);
    expect(transport.bodies().at(-1)).not.toContain("What's your postal code?");

    const third = await text(fake, transport, deps, 'still not saying');
    expect(third).toEqual({ status: 'area_blocked' });
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
    expect(transport.bodies()).not.toContain(AREA_BLOCKED_REPLY);
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
    expect(resolved).toEqual({ status: 'watch_recorded', intent: 'ambiguous', granted: false });
    // Only ONE clarification, ever.
    expect(transport.bodies().filter((b) => b === AMBIGUOUS_CLARIFY)).toHaveLength(1);

    const watch = inserts(fake, schema.consentRecords).find(
      (c) => c.consentType === 'proactive_watch',
    );
    expect(watch?.granted).toBe(false);
    expect((watch?.evidence as Record<string, unknown>).interpretation).toContain('recorded as no');
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

  it('never routes a keyword through the model', async () => {
    const extractor = new FakeExtractor([MAYA_AND_LEO]);
    const intentReader = new FakeIntentReader([assent('yes')]);
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const deps: IntakeDeps = {
      transport,
      extractor,
      intentReader,
      radar: fakeRadar,
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
