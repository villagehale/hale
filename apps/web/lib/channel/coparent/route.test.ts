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
import { CANNOT_TEXT_THAT_NUMBER, CO_PARENT_REDIRECT } from '~/lib/channel/caregiver/copy';
import { F14_ALLOWLIST_ENV, F14_ENABLED_ENV } from '~/lib/channel/f14';
import { JOIN_ACCEPTED_ACK, joinWelcome } from '~/lib/channel/join/copy';
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
  // BOTH halves of the gate, or the dark test is a test of the developer's shell:
  // `f14EnabledFor` is `f14Enabled() || allowlist.has(id)`, and a machine with
  // F14_ENABLED=true exported turned the one assertion that nobody is texted green
  // for the wrong reason.
  process.env[F14_ENABLED_ENV] = '';
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  process.env[F14_ALLOWLIST_ENV] = '';
  process.env[F14_ENABLED_ENV] = '';
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

  /**
   * THE SWITCH HAS TO MEAN "STOP", not "stop new asks". The flag gated only the start
   * command, and an invite lives for 72 hours — so a family disarmed after the ask would
   * still have Hale cold-text the number on the parent's yes, which is the one send the
   * flag exists to hold back.
   */
  it('sends nothing to the stranger when the family is disarmed between the ask and the yes', async () => {
    const { fake, transport, deps } = harness();
    const { familyId } = await seedFamily(fake);
    armFor(familyId);
    await text(fake, transport, deps, PARENT_PHONE, 'add Sam 647-555-0199 as my partner');
    process.env[F14_ALLOWLIST_ENV] = '';

    const outcome = await text(fake, transport, deps, PARENT_PHONE, 'yes');

    expect(outcome).toEqual({ status: 'co_parent_add_refused', reason: 'dark' });
    expect(toPartner(transport)).toHaveLength(0);
    expect(transport.sent.at(-1)?.body).toBe(CO_PARENT_REDIRECT);
    // Nothing was authorised either: a grant row for a disclosure that did not happen is
    // a false record of what the parent agreed to.
    expect(inserts(fake, schema.consentRecords)).toHaveLength(0);
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

  /**
   * "Reply STOP anytime" is on the one cold text, and the command next door must honour
   * it. Before this, a stranger who replied STOP could be re-texted a minute later as a
   * nanny — the caregiver door consulted only OPEN invites, and a refusal closes one.
   */
  it('honours a STOP from the invitee on the CAREGIVER door too', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);
    await text(fake, transport, deps, PARTNER_PHONE, 'STOP');
    const beforeReAsk = transport.sent.length;

    const reAsked = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Sam 647-555-0199 as my nanny',
    );

    expect(reAsked).toEqual({
      status: 'caregiver_add_refused',
      reason: 'previously_declined',
    });
    // Nothing further reached them, and the sentence says only that Hale will not do it.
    expect(transport.sent.slice(beforeReAsk).every((s) => s.to === PARENT_PHONE)).toBe(true);
    expect(transport.sent.at(-1)?.body).toBe(CANNOT_TEXT_THAT_NUMBER);
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
  it("turns their yes into their OWN consent, channel, membership and the inviter's ack", async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);
    const beforeReply = transport.sent.length;

    const accepted = await text(fake, transport, deps, PARTNER_PHONE, 'yes');

    expect(accepted).toEqual({
      status: 'co_parent_accepted',
      inviterNotified: true,
      inviterHeld: null,
      supersededInviteId: null,
    });

    // Two consents, two people, neither inferred from the other. The invitee's scope
    // says Hale started the conversation; `sms_join_origination` would say they did.
    const theirs = inserts(fake, schema.consentRecords).filter(
      (r) => r.consentType === 'sms_service_messages',
    );
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ granted: true, consentScope: 'sms_coparent_invite_reply' });
    expect((theirs[0]?.evidence as Record<string, unknown>).verbatimReply).toBe('yes');
    const coParentUserId = theirs[0]?.userId;
    const grant = inserts(fake, schema.consentRecords).find(
      (r) => r.consentType === 'co_parent_access_grant',
    );
    expect(coParentUserId).not.toBe(grant?.userId);

    expect(inserts(fake, schema.familyMembers).at(-1)).toMatchObject({
      role: 'co_parent',
      userId: coParentUserId,
    });
    expect(inserts(fake, schema.parentChannels).at(-1)).toMatchObject({
      userId: coParentUserId,
      phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
      verifiedAt: NOW,
    });

    // The two sends, in order: the welcome to them, the ack to the parent who asked.
    const since = transport.sent.slice(beforeReply);
    expect(since.map((s) => s.to)).toEqual([PARTNER_PHONE, PARENT_PHONE]);
    // The join link's own words, verbatim: the same person arrives through both doors
    // and must not be told two different things about what they just joined.
    expect(since[0]?.body).toBe(joinWelcome('Ana'));
    expect(since[1]?.body).toBe(JOIN_ACCEPTED_ACK);

    expect(auditActions(fake)).toEqual(
      expect.arrayContaining([
        'co_parent_invite_accepted',
        'channel_sms_enrolled',
        'co_parent_sms_inbound',
        'co_parent_sms_outbound',
      ]),
    );
    // The exchange is its own ledger lane (migration 0112) — a co-parent's messages
    // filed under 'caregiver' would read as a disclosure to somebody outside the house.
    const ledgered = inserts(fake, schema.channelMessages);
    expect(ledgered.every((r) => r.category === 'co_parent_invite')).toBe(true);
    expect(ledgered.filter((r) => r.direction === 'out').every((r) => r.body === null)).toBe(true);
    // The parent's own words are kept — they are a member, and their instruction is the
    // first link in the chain. The INVITEE's are not: they have consented to nothing, and
    // what they decided lives in the invite's state and in their own consent row.
    const inbound = ledgered.filter((r) => r.direction === 'in');
    expect(inbound.map((r) => r.body)).toEqual([
      'add Sam 647-555-0199 as my partner',
      'yes',
      null,
    ]);
  });

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

  /**
   * The seat was checked when the parent asked and again where it is taken, and 72 hours
   * fit in between. Somebody else became the co-parent while this person thought about
   * it: they are TOLD — they answered a question Hale asked them — and nobody is seated
   * twice.
   */
  it('tells the invitee when the seat went to somebody else, and seats nobody', async () => {
    const { fake, transport, deps, threaded } = harness();
    const { familyId } = await upToInvite(fake, transport, deps);
    const [other] = await fake.db
      .insert(schema.users)
      .values({ externalAuthId: 'sms:took-the-seat', email: null, name: 'Jo' })
      .returning({ id: schema.users.id });
    await fake.db
      .insert(schema.familyMembers)
      .values({ familyId, userId: other?.id as string, role: 'co_parent' });
    const beforeReply = transport.sent.length;
    const threadedBefore = threaded.length;

    const outcome = await text(fake, transport, deps, PARTNER_PHONE, 'yes');

    expect(outcome).toEqual({ status: 'co_parent_seat_taken' });
    const since = transport.sent.slice(beforeReply);
    expect(since.map((s) => s.to)).toEqual([PARTNER_PHONE]);
    expect(since[0]?.body).toContain('somebody else was added as the co-parent');
    // Nothing of theirs was written, and the parent's thread heard none of it.
    expect(
      inserts(fake, schema.consentRecords).filter((r) => r.consentType === 'sms_service_messages'),
    ).toHaveLength(0);
    expect(inserts(fake, schema.parentChannels)).toHaveLength(1);
    expect(threaded).toHaveLength(threadedBefore);
    expect(auditActions(fake)).toContain('co_parent_invite_seat_taken');
    expect(auditActions(fake)).not.toContain('co_parent_invite_accepted');
  });

  /**
   * The seat is not the ack. At 22:00 the inviting parent texted nothing tonight, so
   * their confirmation is a PROACTIVE message and holds — while the person who did just
   * text gets answered immediately. Rule #11: the withheld send is named in the return
   * value rather than being an outcome that quietly means "sent nothing".
   */
  it('holds the inviter ack in quiet hours, and seats the co-parent anyway', async () => {
    const night = new Date('2026-09-16T02:00:00.000Z');
    const { fake, transport, deps } = harness(night);
    await upToInvite(fake, transport, deps);
    const beforeReply = transport.sent.length;

    const accepted = await text(fake, transport, deps, PARTNER_PHONE, 'yes');

    expect(accepted).toMatchObject({
      status: 'co_parent_accepted',
      inviterNotified: false,
      inviterHeld: 'quiet_hours',
    });
    expect(transport.sent.slice(beforeReply).map((s) => s.to)).toEqual([PARTNER_PHONE]);
    expect(inserts(fake, schema.familyMembers).at(-1)).toMatchObject({ role: 'co_parent' });
  });
});

/**
 * THE INVITEE'S EXCHANGE IS NOT THE PARENT'S CONVERSATION.
 *
 * Their messages ledger against the authorising parent — `channel_messages.parent_user_id`
 * is NOT NULL and pre-acceptance there is no users row for them — but the parent's COACH
 * THREAD must not receive a word of it. `reply()` sends; `replyToParent()` sends and
 * threads, and the whole difference is who is being texted. Threaded, the coach reads a
 * stranger's half of a conversation back to the parent as things Hale said to them.
 */
describe('co-parent invite · whose conversation is whose', () => {
  it('threads what Hale said to the PARENT, and nothing it said to the invitee', async () => {
    const { fake, transport, deps, threaded } = harness();
    await upToInvite(fake, transport, deps);
    await text(fake, transport, deps, PARTNER_PHONE, 'yes');

    // Exactly the three sentences addressed to the parent, in order. An equality rather
    // than a `not.toContain`: a threading regression adds a message, and only a test that
    // knows how many there should be can see one arrive.
    expect(threaded).toHaveLength(3);
    expect(threaded.every((t) => t.parentUserId !== undefined)).toBe(true);
    expect(threaded[0]?.body).toContain('Adding Sam as your co-parent');
    expect(threaded[1]?.body).toContain("I've texted Sam");
    expect(threaded[2]?.body).toBe(JOIN_ACCEPTED_ACK);
    // And nothing Hale said to the person being invited — the cold text itself, or the
    // welcome that answered their yes.
    const toThem = toPartner(transport).map((s) => s.body);
    expect(toThem).toHaveLength(2);
    for (const body of toThem) {
      expect(threaded.map((t) => t.body)).not.toContain(body);
    }
    expect(threaded.map((t) => t.body)).not.toContain(joinWelcome('Ana'));
  });

  it('threads nothing at all when the invitee refuses, or writes something unreadable', async () => {
    const { fake, transport, deps, threaded } = harness();
    await upToInvite(fake, transport, deps);
    const parentSideSoFar = threaded.length;

    await text(fake, transport, deps, PARTNER_PHONE, 'who is this?');
    await text(fake, transport, deps, PARTNER_PHONE, 'no thanks');

    // Both answers went to THEM and nowhere else: the inviting parent is told nothing
    // about a refusal, and a nudge to a stranger is not a line in anybody's transcript.
    expect(threaded).toHaveLength(parentSideSoFar);
    expect(transport.sent.slice(-2).every((s) => s.to === PARTNER_PHONE)).toBe(true);
  });
});

/**
 * THE DAILY CAP IS THE OUTBOUND GATE'S STAND-IN ON THIS PATH.
 *
 * `outbound-gate.ts` is bypassed by design here (role-scope.ts: every check it makes
 * presumes an enrolled recipient, and an invitee has none), so this counter is the whole
 * meter on how many strangers one family may have Hale text in a day.
 */
describe('co-parent invite · the meter on strangers', () => {
  const NUMBERS = [
    '+16475550101',
    '+16475550102',
    '+16475550103',
    '+16475550104',
    '+16475550105',
    '+16475550106',
  ];

  it('sends five and refuses the sixth, with nobody new texted', async () => {
    const { fake, transport, deps } = harness();
    const { familyId } = await seedFamily(fake);
    armFor(familyId);

    for (const number of NUMBERS.slice(0, 5)) {
      await text(fake, transport, deps, PARENT_PHONE, `add Sam ${number} as my partner`);
      await text(fake, transport, deps, PARENT_PHONE, 'yes');
    }
    const strangersTexted = transport.sent.filter((s) => NUMBERS.includes(s.to)).length;

    const sixth = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      `add Sam ${NUMBERS[5]} as my partner`,
    );

    expect(sixth).toEqual({ status: 'co_parent_add_refused', reason: 'too_many' });
    expect(transport.sent.at(-1)?.to).toBe(PARENT_PHONE);
    expect(transport.sent.at(-1)?.body).toContain("That's a lot of people in one day");
    // The count, not the last outcome: the assertion has to be able to see a sixth
    // stranger being texted, which a check on the final reply alone cannot.
    expect(strangersTexted).toBe(5);
    expect(transport.sent.filter((s) => NUMBERS.includes(s.to))).toHaveLength(5);
  });

  /**
   * What the meter counts is an invite that REACHED somebody. A parent who fumbles the
   * wording five times texted nobody, and charging them for it would leave them stuck —
   * which is exactly what the meter's exclusion of `awaiting_parent_assent` and
   * `superseded` is for. Asserted here because those two words are otherwise a comment.
   */
  it('does not charge unconfirmed asks against it — five fumbles still leave the budget whole', async () => {
    const { fake, transport, deps } = harness();
    const { familyId } = await seedFamily(fake);
    armFor(familyId);

    for (const number of NUMBERS.slice(0, 5)) {
      await text(fake, transport, deps, PARENT_PHONE, `add Sam ${number} as my partner`);
    }
    expect(transport.sent.filter((s) => NUMBERS.includes(s.to))).toHaveLength(0);

    const sixth = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      `add Sam ${NUMBERS[5]} as my partner`,
    );
    expect(sixth).toEqual({ status: 'co_parent_invite_started' });

    // And the ask that follows it still reaches a phone: the budget was never spent.
    await text(fake, transport, deps, PARENT_PHONE, 'yes');
    expect(transport.sent.filter((s) => s.to === NUMBERS[5])).toHaveLength(1);
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
