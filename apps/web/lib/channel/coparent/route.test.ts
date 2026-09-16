import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeExtractor,
  type FakeDb,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeAckComposer,
  fakeRadar,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { CO_PARENT_REDIRECT } from '~/lib/channel/caregiver/copy';
import { F14_ALLOWLIST_ENV } from '~/lib/channel/f14';
import type { OpenQuestion } from '~/lib/channel/router/open-questions';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  CO_PARENT_SEAT_TAKEN_BY_LANGUAGE,
  PREVIOUSLY_DECLINED_BY_LANGUAGE,
  REFERRER_UNNAMED_BY_LANGUAGE,
} from './copy';

/**
 * VIL-355 · the co-parent invite driven end to end through the ONE inbound entry point,
 * against the intake Fakes — the same double caregiver/route.test.ts trusts.
 *
 * WHAT THIS FILE IS FOR, over and above the copy tests next door: every assertion about
 * WORDS is made against what the ROUTE emitted, never against the constant it came from.
 * A test that compares `copy.ts` to `copy.ts` passes with the caregiver strings still
 * wired in, and the caregiver strings are wrong here in a way a parent would notice
 * ("I can't add it as a caregiver").
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165551234';
const PARTNER_PHONE = '+16475550199';
const OTHER_PHONE = '+16475550188';
const NOW = new Date('2026-09-15T12:00:00.000Z');

function harness(
  now: Date = NOW,
  openQuestions: OpenQuestion[] = [],
): {
  fake: FakeDb;
  transport: FakeTransport;
  deps: IntakeDeps;
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
  windows: Array<[number, number]>;
} {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const threaded: Array<{ familyId: string; parentUserId: string; body: string }> = [];
  const windows: Array<[number, number]> = [];

  // The transaction boundary is OBSERVED rather than assumed, the same way the caregiver
  // and join suites observe theirs: the parent's authorisation and the state advance are
  // one transaction, and a consent row that merely ran NEAR the advance would be rolled
  // back by a crash the advance survives.
  const db = new Proxy(fake.db, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
      return async (cb: (tx: unknown) => Promise<unknown>) => {
        const start = fake.writes.length;
        const result = await (target as Database).transaction(cb as never);
        windows.push([start, fake.writes.length]);
        return result;
      };
    },
  }) as Database;

  return {
    fake: { ...fake, db },
    transport,
    threaded,
    windows,
    deps: {
      transport,
      threadMessage: async (_db, input) => {
        threaded.push(input);
        return 'conv-1';
      },
      openQuestions: async () => openQuestions,
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
      ]),
      radar: fakeRadar,
      ackComposer: fakeAckComposer,
      answerComposer: fakeSilentAnswerComposer,
      identityAsk: new FakeIdentityAsk(),
      limiter: new FakeRateLimiter(() => now.getTime()),
      now,
    },
  };
}

/** A household that already exists: one primary parent on a verified SMS channel. */
async function seedFamily(
  fake: FakeDb,
  parentName: string | null = 'Ana',
): Promise<{ familyId: string; parentUserId: string }> {
  const [user] = await fake.db
    .insert(schema.users)
    .values({
      externalAuthId: `sms:${phoneBlindIndex(PARENT_PHONE)}`,
      email: null,
      name: parentName,
    })
    .returning({ id: schema.users.id });
  const [family] = await fake.db
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', onboardingStage: 'sms_active', country: 'CA' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await fake.db
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await fake.db.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT_PHONE),
    phoneE164Hash: phoneBlindIndex(PARENT_PHONE),
    verifiedAt: NOW,
  });
  return { familyId, parentUserId };
}

function text(
  fake: FakeDb,
  transport: FakeTransport,
  deps: IntakeDeps,
  from: string,
  body: string,
) {
  return handleInboundSms(fake.db, transport.inbound(from, body), deps);
}

function inserts(fake: FakeDb, table: unknown) {
  return fake.writes.filter((w) => w.op === 'insert' && w.table === table).map((w) => w.payload);
}

function auditActions(fake: FakeDb): string[] {
  return inserts(fake, schema.auditLog).map((p) => p.actionTaken as string);
}

/** Everything Hale sent to the person being invited. The count is the assertion that
 * matters most on this path: the whole feature is ONE message. */
function toPartner(transport: FakeTransport) {
  return transport.sent.filter((s) => s.to === PARTNER_PHONE);
}

/** Arm the dark flag for exactly this family — the shape the founder's flip replaces. */
function armFor(familyId: string) {
  process.env[F14_ALLOWLIST_ENV] = familyId;
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  process.env[F14_ALLOWLIST_ENV] = '';
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  process.env[F14_ALLOWLIST_ENV] = '';
});

describe('co-parent invite · the dark gate', () => {
  it('answers with the forwardable-link redirect while the family is not armed', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);

    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Sam 647-555-0199 as my partner',
    );

    expect(outcome).toEqual({ status: 'co_parent_add_refused', reason: 'dark' });
    expect(transport.sent.at(-1)?.body).toBe(CO_PARENT_REDIRECT);
    expect(inserts(fake, schema.caregiverInvites)).toHaveLength(0);
  });
});

describe('co-parent invite · the parent half', () => {
  it('states the scope and texts NOBODY until the parent confirms', async () => {
    const { fake, transport, deps } = harness();
    const { familyId } = await seedFamily(fake);
    armFor(familyId);

    const started = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Sam 647-555-0199 as my partner',
    );

    expect(started).toEqual({ status: 'co_parent_invite_started' });
    // The words the ROUTE emitted, not the constant — see the module note.
    const asked = transport.sent.at(-1);
    expect(asked?.to).toBe(PARENT_PHONE);
    expect(asked?.body).toContain('Adding Sam as your co-parent');
    expect(asked?.body).toContain('everything I show you');
    expect(asked?.body).toContain('approve things with me');
    expect(toPartner(transport)).toHaveLength(0);
    expect(inserts(fake, schema.consentRecords)).toHaveLength(0);
    expect(auditActions(fake)).toContain('co_parent_invite_started');
    expect(auditActions(fake)).not.toContain('caregiver_invite_started');
  });

  it("records the parent's authorisation and sends exactly ONE message, naming them", async () => {
    const { fake, transport, deps, windows } = harness();
    const { familyId } = await seedFamily(fake);
    armFor(familyId);
    await text(fake, transport, deps, PARENT_PHONE, 'add Sam 647-555-0199 as my partner');

    const sent = await text(fake, transport, deps, PARENT_PHONE, 'yes');

    expect(sent).toEqual({ status: 'co_parent_invite_sent' });
    const grant = inserts(fake, schema.consentRecords).filter(
      (r) => r.consentType === 'co_parent_access_grant',
    );
    expect(grant).toHaveLength(1);
    expect(grant[0]).toMatchObject({ granted: true, consentScope: 'family_role:co_parent' });
    const evidence = grant[0]?.evidence as Record<string, unknown>;
    expect(evidence.verbatimReply).toBe('yes');
    expect(evidence.question).toContain('Adding Sam as your co-parent');

    const invite = toPartner(transport);
    expect(invite).toHaveLength(1);
    expect(invite[0]?.body).toContain('Ana added you as their co-parent');
    expect(invite[0]?.body).toContain('Reply STOP anytime');
    expect(transport.sent.at(-1)?.to).toBe(PARENT_PHONE);
    expect(transport.sent.at(-1)?.body).toContain("I've texted Sam");
    expect(auditActions(fake)).toContain('co_parent_access_granted');

    // The grant and the state advance are ONE transaction (rule #6's invariant: no
    // invite reaches the invitee without the parent's recorded authorisation).
    const grantIndex = fake.writes.findIndex(
      (w) =>
        w.table === schema.consentRecords && w.payload.consentType === 'co_parent_access_grant',
    );
    const advanceIndex = fake.writes.findIndex(
      (w) => w.table === schema.caregiverInvites && w.op === 'update',
    );
    expect(windows.some(([start, end]) => grantIndex >= start && advanceIndex < end)).toBe(true);
  });

  it('a NO withdraws it and nobody is ever contacted', async () => {
    const { fake, transport, deps } = harness();
    const { familyId } = await seedFamily(fake);
    armFor(familyId);
    await text(fake, transport, deps, PARENT_PHONE, 'add Sam 647-555-0199 as my partner');

    const dropped = await text(fake, transport, deps, PARENT_PHONE, 'no');

    expect(dropped).toEqual({ status: 'co_parent_invite_dropped' });
    expect(toPartner(transport)).toHaveLength(0);
    expect(transport.sent.at(-1)?.body).toContain("I haven't texted Sam");
    expect(auditActions(fake)).toContain('co_parent_invite_withdrawn');
    expect(inserts(fake, schema.consentRecords)).toHaveLength(0);
  });

  it('answers a French parent in French, and promises ARRET rather than STOP', async () => {
    const { fake, transport, deps } = harness();
    const { familyId } = await seedFamily(fake);
    armFor(familyId);

    await text(fake, transport, deps, PARENT_PHONE, 'add Sam 647-555-0199 as my partner');
    const asked = transport.sent.at(-1)?.body as string;
    expect(asked).toContain('Adding Sam');

    // The authorising reply is the French evidence, and the invite rides its language:
    // the invitee has written nothing yet, so there is nothing else to read.
    await text(fake, transport, deps, PARENT_PHONE, 'oui');
    const invite = toPartner(transport);
    expect(invite).toHaveLength(1);
    expect(invite[0]?.body).toContain('ARRET');
    // The body names the INVITER, not the person being invited — that is the whole
    // reason an unnameable parent refuses rather than sending anonymously.
    expect(invite[0]?.body).toContain('Ana');
  });
});

describe('co-parent invite · the refusals', () => {
  it('refuses when Hale has no name to sign the text with', async () => {
    const { fake, transport, deps } = harness();
    const { familyId } = await seedFamily(fake, null);
    armFor(familyId);

    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Sam 647-555-0199 as my partner',
    );

    expect(outcome).toEqual({ status: 'co_parent_add_refused', reason: 'referrer_unnamed' });
    expect(transport.sent.at(-1)?.body).toBe(REFERRER_UNNAMED_BY_LANGUAGE.en);
    expect(inserts(fake, schema.caregiverInvites)).toHaveLength(0);
  });

  it('refuses a second seat when the household already has a co-parent', async () => {
    const { fake, transport, deps } = harness();
    const { familyId } = await seedFamily(fake);
    armFor(familyId);
    const [other] = await fake.db
      .insert(schema.users)
      .values({ externalAuthId: 'sms:other', email: null, name: 'Jo' })
      .returning({ id: schema.users.id });
    await fake.db
      .insert(schema.familyMembers)
      .values({ familyId, userId: other?.id as string, role: 'co_parent' });

    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Sam 647-555-0199 as my partner',
    );

    expect(outcome).toEqual({ status: 'co_parent_add_refused', reason: 'co_parent_seat_taken' });
    expect(transport.sent.at(-1)?.body).toBe(CO_PARENT_SEAT_TAKEN_BY_LANGUAGE.en);
    expect(inserts(fake, schema.caregiverInvites)).toHaveLength(0);
  });

  /**
   * The un-stoppable-message fix, with its positive control in the same test. A lookback
   * that refused EVERY number would pass the first half alone — the second half is what
   * proves the memory is keyed on the number that actually said no.
   */
  it('never re-texts a number that already refused, and still texts a fresh one', async () => {
    const { fake, transport, deps } = harness();
    const { familyId, parentUserId } = await seedFamily(fake);
    armFor(familyId);
    await fake.db.insert(schema.caregiverInvites).values({
      familyId,
      invitedByUserId: parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(PARTNER_PHONE),
      phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
      state: 'declined',
      expiresAt: NOW,
      closedAt: NOW,
      createdAt: NOW,
    });

    const refused = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Sam 647-555-0199 as my partner',
    );
    expect(refused).toEqual({ status: 'co_parent_add_refused', reason: 'previously_declined' });
    expect(transport.sent.at(-1)?.body).toBe(PREVIOUSLY_DECLINED_BY_LANGUAGE.en);
    expect(auditActions(fake)).toContain('co_parent_invite_blocked_prior_refusal');

    const fresh = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Alex 647-555-0188 as my partner',
    );
    expect(fresh).toEqual({ status: 'co_parent_invite_started' });
    expect(transport.sent.at(-1)?.body).toContain('Adding Alex as your co-parent');
  });

  it('refuses a number that already carries an active Hale channel', async () => {
    const { fake, transport, deps } = harness();
    const { familyId } = await seedFamily(fake);
    armFor(familyId);
    const [other] = await fake.db
      .insert(schema.users)
      .values({ externalAuthId: 'sms:busy', email: null, name: 'Jo' })
      .returning({ id: schema.users.id });
    await fake.db.insert(schema.parentChannels).values({
      userId: other?.id as string,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(OTHER_PHONE),
      phoneE164Hash: phoneBlindIndex(OTHER_PHONE),
      verifiedAt: NOW,
    });

    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Alex 647-555-0188 as my partner',
    );

    expect(outcome).toEqual({ status: 'co_parent_add_refused', reason: 'number_in_use' });
    // Says the number is spoken for; never whose household it belongs to (rule #1).
    expect(transport.sent.at(-1)?.body).toContain('already set up with Hale');
    expect(transport.sent.at(-1)?.body).not.toContain('Jo');
  });
});

/** Arm the flag, ask, and authorise — the state the person being invited replies into. */
async function upToInvite(
  fake: FakeDb,
  transport: FakeTransport,
  deps: IntakeDeps,
): Promise<{ familyId: string; parentUserId: string }> {
  const seeded = await seedFamily(fake);
  armFor(seeded.familyId);
  await text(fake, transport, deps, PARENT_PHONE, 'add Sam 647-555-0199 as my partner');
  await text(fake, transport, deps, PARENT_PHONE, 'yes');
  return seeded;
}

describe('co-parent invite · the invitee half', () => {
  it('tells the inviting parent NOTHING when the invitee says no', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);
    const beforeReply = transport.sent.length;

    const declined = await text(fake, transport, deps, PARTNER_PHONE, 'no thanks');

    expect(declined).toEqual({ status: 'co_parent_declined' });
    const since = transport.sent.slice(beforeReply);
    // One message, to the person who refused. A refusal from a number is that person's
    // business, not the household's (the caregiver precedent).
    expect(since.map((s) => s.to)).toEqual([PARTNER_PHONE]);
    expect(auditActions(fake)).toContain('co_parent_invite_refused');
    expect(
      inserts(fake, schema.consentRecords).filter((r) => r.consentType === 'sms_service_messages'),
    ).toHaveLength(0);
    expect(inserts(fake, schema.familyMembers).filter((r) => r.role === 'co_parent')).toHaveLength(
      0,
    );
  });

  it('restates the choice ONCE when the reply is neither, and seats nobody', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);
    const beforeReply = transport.sent.length;

    const prompted = await text(fake, transport, deps, PARTNER_PHONE, 'who is this?');

    expect(prompted).toEqual({ status: 'co_parent_prompted' });
    expect(transport.sent.slice(beforeReply).map((s) => s.to)).toEqual([PARTNER_PHONE]);
    expect(inserts(fake, schema.familyMembers).filter((r) => r.role === 'co_parent')).toHaveLength(
      0,
    );
  });
});

describe('co-parent invite · arbitrating the bare YES', () => {
  /**
   * `caregiver/route.ts` claimed a bare affirmative straight off the pending assent. For
   * a caregiver that was tolerable; here a mis-claimed YES texts a stranger. With another
   * question of a different kind open, NOBODY claims it and the invite lapses — the
   * correct failure.
   */
  it('claims nothing while an unrelated approval is also open', async () => {
    const approval: OpenQuestion = {
      id: 'action-1',
      kind: 'approval',
      description: 'Add to your calendar',
      subject: 'add to your calendar',
      answerable: { yes: true, no: true },
      askedAt: null,
      solicited: false,
    };
    const { fake, transport, deps } = harness(NOW, [approval]);
    const { familyId } = await seedFamily(fake);
    armFor(familyId);
    await text(fake, transport, deps, PARENT_PHONE, 'add Sam 647-555-0199 as my partner');
    const before = transport.sent.length;

    const outcome = await text(fake, transport, deps, PARENT_PHONE, 'yes');

    expect(outcome).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(toPartner(transport)).toHaveLength(0);
    expect(transport.sent).toHaveLength(before);
    expect(inserts(fake, schema.consentRecords)).toHaveLength(0);
  });

  /** The positive control for the test above: with the assent the ONLY thing open, the
   * same word is claimed. Without this, a gate that refused every YES would pass. */
  it('claims it when the assent is the only question open', async () => {
    const { fake, transport, deps } = harness(NOW, []);
    const { familyId } = await seedFamily(fake);
    armFor(familyId);
    await text(fake, transport, deps, PARENT_PHONE, 'add Sam 647-555-0199 as my partner');

    const outcome = await text(fake, transport, deps, PARENT_PHONE, 'yes');

    expect(outcome).toEqual({ status: 'co_parent_invite_sent' });
    expect(toPartner(transport)).toHaveLength(1);
  });
});
