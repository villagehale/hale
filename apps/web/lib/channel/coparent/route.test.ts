import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeAddThemYourself,
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
import { F14_ALLOWLIST_ENV, F14_ENABLED_ENV } from '~/lib/channel/f14';
import { JOIN_ACCEPTED_ACK, joinWelcome } from '~/lib/channel/join/copy';
import type { OpenQuestion } from '~/lib/channel/router/open-questions';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { seedTextedInvite } from '~/lib/testing/texted-invite';
import { INVITE_EXPIRED_BY_LANGUAGE } from './copy';

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
      addThemYourself: new FakeAddThemYourself(),
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

/** A pending co-parent add Hale asked "Reply YES" about before it stopped texting first. */
async function seedPendingAssent(fake: FakeDb, seeded: { familyId: string; parentUserId: string }) {
  await fake.db.insert(schema.caregiverInvites).values({
    familyId: seeded.familyId,
    invitedByUserId: seeded.parentUserId,
    role: 'co_parent',
    displayName: 'Sam',
    phoneE164Encrypted: encryptString(PARTNER_PHONE),
    phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
    state: 'awaiting_parent_assent',
    expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
    createdAt: NOW,
  });
}

describe('co-parent add · Hale texts nobody first', () => {
  it.each([
    ['dark', false],
    ['armed', true],
  ])('answers the parent and texts nobody, flag %s', async (_label, armed) => {
    const { fake, transport, deps, threaded } = harness();
    const { familyId } = await seedFamily(fake);
    if (armed) armFor(familyId);

    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Sam 647-555-0199 as my partner',
    );

    expect(outcome).toEqual({ status: 'add_them_yourself', role: 'co_parent', reply: 'sent' });
    expect(transport.sent).toEqual([{ to: PARENT_PHONE, body: 'ADD THEM YOURSELF' }]);
    expect(toPartner(transport)).toHaveLength(0);
    expect(threaded.map((t) => t.body)).toEqual(['ADD THEM YOURSELF']);
    expect(inserts(fake, schema.caregiverInvites)).toHaveLength(0);
    expect(inserts(fake, schema.consentRecords)).toHaveLength(0);
    expect(
      inserts(fake, schema.channelMessages).every((r) => r.category === 'co_parent_invite'),
    ).toBe(true);
  });
});

/** The invite Hale texted Sam before it stopped texting first: what Sam replies into. */
async function upToInvite(fake: FakeDb): Promise<{ familyId: string; parentUserId: string }> {
  const seeded = await seedFamily(fake);
  await seedTextedInvite(fake.db, {
    familyId: seeded.familyId,
    invitedByUserId: seeded.parentUserId,
    role: 'co_parent',
    displayName: 'Sam',
    phoneE164: PARTNER_PHONE,
    now: NOW,
  });
  return seeded;
}

describe('co-parent invite · the invitee half', () => {
  it("turns their yes into their OWN consent, channel, membership and the inviter's ack", async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake);
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
    expect(inbound.map((r) => r.body)).toEqual([null]);
  });

  it('tells the inviting parent NOTHING when the invitee says no', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake);
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
    await upToInvite(fake);
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
    const { familyId } = await upToInvite(fake);
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
    await upToInvite(fake);
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
    await upToInvite(fake);
    await text(fake, transport, deps, PARTNER_PHONE, 'yes');

    // Exactly the one sentence addressed to the parent. An equality rather than a
    // `not.toContain`: a threading regression adds a message, and only a test that
    // knows how many there should be can see one arrive.
    expect(threaded).toHaveLength(1);
    expect(threaded[0]?.body).toBe(JOIN_ACCEPTED_ACK);
    // And nothing Hale said to the person being invited: the welcome that answered
    // their yes.
    const toThem = toPartner(transport).map((s) => s.body);
    expect(toThem).toHaveLength(1);
    for (const body of toThem) {
      expect(threaded.map((t) => t.body)).not.toContain(body);
    }
    expect(threaded.map((t) => t.body)).not.toContain(joinWelcome('Ana'));
  });

  it('threads nothing at all when the invitee refuses, or writes something unreadable', async () => {
    const { fake, transport, deps, threaded } = harness();
    await upToInvite(fake);
    const parentSideSoFar = threaded.length;

    await text(fake, transport, deps, PARTNER_PHONE, 'who is this?');
    await text(fake, transport, deps, PARTNER_PHONE, 'no thanks');

    // Both answers went to THEM and nowhere else: the inviting parent is told nothing
    // about a refusal, and a nudge to a stranger is not a line in anybody's transcript.
    expect(threaded).toHaveLength(parentSideSoFar);
    expect(transport.sent.slice(-2).every((s) => s.to === PARTNER_PHONE)).toBe(true);
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
    await seedPendingAssent(fake, await seedFamily(fake));
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
    await seedPendingAssent(fake, await seedFamily(fake));

    const outcome = await text(fake, transport, deps, PARENT_PHONE, 'yes');

    // Claimed, and still nobody is texted: the parent is told how Sam gets in.
    expect(outcome).toEqual({ status: 'add_them_yourself', role: 'co_parent', reply: 'sent' });
    expect(toPartner(transport)).toHaveLength(0);
    expect(transport.sent).toEqual([{ to: PARENT_PHONE, body: 'ADD THEM YOURSELF' }]);
  });
});

/**
 * VIL-355 follow-up · item 1 — the answer that comes on day four.
 *
 * Driven through `handleInboundSms`, because the bug was never in the invite module: the
 * 72h bound is applied on READ, so the lapsed row answered null and the turn fell all
 * the way through to `greet`. What the stranger Hale had cold-texted once actually got,
 * for answering, was an intake greeting asking for their children's names.
 */
describe('co-parent invite · a yes that arrives after the 72h bound', () => {
  /** One hour past the invitee's own window, which starts when they are texted. */
  const LATE = new Date(NOW.getTime() + 74 * 3_600_000);

  it('answers the late yes honestly, opens no session, and seats nobody', async () => {
    const { fake, transport, deps } = harness();
    const seeded = await upToInvite(fake);
    const beforeReply = transport.sent.length;

    const outcome = await text(
      fake,
      transport,
      { ...deps, now: LATE },
      PARTNER_PHONE,
      'yes please',
    );

    expect(outcome).toEqual({ status: 'invite_expired_answered', role: 'co_parent' });
    expect(transport.sent.slice(beforeReply).map((s) => s.body)).toEqual([
      INVITE_EXPIRED_BY_LANGUAGE.en,
    ]);
    // The greeting is what this replaces — it must not be anywhere in the reply.
    expect(transport.sent.at(-1)?.body).not.toContain('Hale');
    // No session was opened, so their next word is not read as intake details.
    expect(inserts(fake, schema.smsIntakeSessions)).toEqual([]);
    // One seat, still: the primary parent's.
    const seats = inserts(fake, schema.familyMembers);
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({ familyId: seeded.familyId, role: 'primary_parent' });
    expect(auditActions(fake)).toContain('co_parent_invite_expired_answered');
  });

  /**
   * THE POSITIVE CONTROL, and the reason the reader is gated on the message being an
   * ANSWER at all: the same number, later, wanting Hale for their own family. A shadow
   * that swallowed this would lock a person out of the product for having been invited.
   */
  it('still greets the same number when they are starting their own intake', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake);
    const beforeReply = transport.sent.length;

    const outcome = await text(
      fake,
      transport,
      { ...deps, now: LATE },
      PARTNER_PHONE,
      'hi, I heard about you from a friend',
    );

    expect(outcome).toEqual({ status: 'greeted' });
    expect(transport.sent.slice(beforeReply).map((s) => s.body)).not.toContain(
      INVITE_EXPIRED_BY_LANGUAGE.en,
    );
  });
});
