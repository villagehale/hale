import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq, gt } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { createDisambiguationStore } from '~/lib/channel/router/disambiguation';
import { FakeReplyTransport } from '~/lib/channel/router/reply-route';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import type { ChannelRouterDeps } from '~/lib/channel/router/route';
import { routeChannelMessage } from '~/lib/channel/router/route';
import {
  auditSmokeAlarmClaim,
  auditTurnLedger,
  defaultHandlers,
  defaultOpenQuestionReader,
  loadInboundContext,
} from '~/lib/channel/router/wiring';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { familyForForwardToken, mintForwardToken } from './forward-address';
import {
  FORWARD_REVOKE_ASK_TEMPLATE_KEY,
  FORWARD_REVOKE_ASK_TTL_MS,
  forwardRevokeAskReply,
  forwardRevokeDeclinedReply,
  forwardRevokeReply,
} from './forward-request';

/**
 * TURNING THE FORWARDING ADDRESS OFF IS A CONFIRM TURN NOW (VIL-352 round 6, D17).
 *
 * WHY THIS FILE EXISTS RATHER THAN MORE REGEX CASES. Five rounds of this matcher each
 * closed one named false positive and each time the next reader found another: the bare
 * word "forwarding", then questions, hypotheticals and past-tense negations about Hale's
 * OWN address ("should I turn off my forwarding address?"). Every one of them, through
 * the shipped chain, nulled the token, wrote the immutable revoke row and answered "Done
 * - your forwarding address is off". A regex over natural language cannot be closed
 * against that class, and D17 already says what to do instead: hard-to-reverse always
 * needs an unambiguous go. A revoked address is hard to reverse — a new token is a
 * DIFFERENT address the parent has to go and re-enter in their mail filter.
 *
 * So the turn-off half asks, and only a YES to that question revokes. These cases are
 * driven through `routeChannelMessage` with the SHIPPED `defaultHandlers()` and the
 * SHIPPED `defaultOpenQuestionReader()`, because the two things worth proving are both
 * wiring: that the question Hale's ask opens is the question the reader lists, and that
 * a bare YES standing beside somebody else's question is never taken by either lane.
 */

const PHONE = '+14165550188';
/** 09:00 Toronto — the parent asks. */
const ASKED_AT = new Date('2026-09-18T13:00:00.000Z');
/** Two minutes later — they answer. */
const ANSWERED_AT = new Date('2026-09-18T13:02:00.000Z');
/** Past the ask's own window, with nothing said in between. */
const TOO_LATE = new Date(ASKED_AT.getTime() + FORWARD_REVOKE_ASK_TTL_MS + 60_000);

let db: TestDb;
let transport: FakeReplyTransport;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('RESEND_API_KEY', 're_test');
  vi.stubEnv('RESEND_INBOUND_WEBHOOK_SECRET', 'whsec_test');
  vi.stubEnv('HALE_INBOUND_EMAIL_DOMAIN', 'mail.villagehale.com');
  vi.stubEnv('HALE_INBOUND_AUTHSERV_ID', 'mx.resend.com');
  transport = new FakeReplyTransport();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

interface Seeded {
  familyId: string;
  parentUserId: string;
  token: string;
}

async function seedReachableFamily(): Promise<Seeded> {
  const family = await seedFamily(db.database, 'Forwarding Family');
  vi.stubEnv('F14_FAMILY_ALLOWLIST', family.familyId);
  await db.database.insert(schema.parentChannels).values({
    familyId: family.familyId,
    userId: family.parentUserId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: ASKED_AT,
  });
  const { token } = await mintForwardToken(db.database, family.familyId);
  return { ...family, token };
}

function deps(now: Date, coachReply = 'Say more?'): ChannelRouterDeps {
  return {
    database: db.database,
    loadContext: loadInboundContext,
    transport,
    handlers: defaultHandlers(),
    questions: defaultOpenQuestionReader(),
    offDomain: { consider: async () => ({ status: 'in_domain', fallback: null }) },
    coach: {
      async respond() {
        return { reply: coachReply, planOffer: null, activityPromise: null, spotWatch: null };
      },
    },
    smokeAlarm: auditSmokeAlarmClaim(db.database),
    turns: auditTurnLedger(db.database),
    apology: { compose: async () => ({ status: 'composed', reply: 'sorry' }) },
    recordPlanOffer: async () => ({ status: 'recorded' }),
    recordActivityPromise: async () => ({
      status: 'recorded',
      commitmentId: '77777777-7777-4777-8777-777777777777',
    }),
    // NEVER a model in this file. Every claim under test has to be made by the free
    // readers — the matcher, `soleOpenKind` and the ledger question — or it is not the
    // thing being tested.
    replyResolver: { read: async () => ({ status: 'unresolved', reason: 'no_target' }) },
    disambiguation: createDisambiguationStore(),
    reconcileView: loadReconcileView,
    recordStatedState: async () => ({ status: 'nothing_stated' }),
    recordRegistrationWatch: async () => ({ status: 'recorded' }),
    armWatchedSpot: async () => ({ status: 'armed', spotId: 'spot-1' }),
    dispatchDeepResearch: async () => ({ status: 'enqueued' }),
    limiter: new FakeRateLimiter(() => now.getTime()),
    now: () => now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

/**
 * One text from the parent, routed. `channel_messages.created_at` defaults to the
 * DATABASE clock while these turns are staged on a September timeline, so whatever the
 * router wrote is moved onto it afterwards — the question reader orders by created_at and
 * measures its window from it.
 */
async function text(seeded: Seeded, body: string, at: Date, coachReply = 'Say more?') {
  const providerMessageId = `SM-${at.getTime()}-${Math.random()}`;
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId,
      status: 'delivered',
      body,
      createdAt: at,
      sentAt: at,
    })
    .returning({ id: schema.channelMessages.id });
  const result = await routeChannelMessage(deps(at, coachReply), {
    family_id: seeded.familyId,
    parent_user_id: seeded.parentUserId,
    channel_message_id: row?.id as string,
    provider_message_id: providerMessageId,
    received_at: at.toISOString(),
  });
  await db.database
    .update(schema.channelMessages)
    .set({ createdAt: at })
    .where(
      and(
        eq(schema.channelMessages.familyId, seeded.familyId),
        eq(schema.channelMessages.direction, 'out'),
        gt(schema.channelMessages.createdAt, at),
      ),
    );
  return result;
}

async function verbs(familyId: string): Promise<string[]> {
  const rows = await db.database
    .select({ verb: schema.auditLog.actionTaken })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
  return rows.map((row) => row.verb);
}

async function tokenOf(familyId: string): Promise<string | null> {
  const [row] = await db.database
    .select({ token: schema.families.inboundForwardToken })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return row?.token ?? null;
}

async function openKinds(seeded: Seeded, now: Date): Promise<string[]> {
  const questions = await defaultOpenQuestionReader().open(db.database, {
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    now,
  });
  return questions.map((question) => question.kind);
}

/** An outbound row this parent already got, dated BEFORE the revoke ask so it can carry
 * an email-alert offer without being the last word Hale said. */
async function seedOutbound(seeded: Seeded, at: Date): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      status: 'delivered',
      createdAt: at,
      sentAt: at,
    })
    .returning({ id: schema.channelMessages.id });
  return row?.id as string;
}

describe('the six sentences that used to revoke now open a question', () => {
  const HYPOTHETICALS = [
    'what happens if I turn off my forwarding address?',
    'if I turn off my forwarding address, will you still read the school emails?',
    "I didn't turn off my forwarding address, did the emails stop?",
    "I'm thinking about turning off my forwarding address",
    'should I turn off my forwarding address?',
    'what if I turn off my forwarding address',
  ];

  it.each(HYPOTHETICALS)('%s - asks, and revokes nothing', async (body) => {
    const seeded = await seedReachableFamily();

    const result = await text(seeded, body, ASKED_AT);

    expect(result.handler).toBe('forward_address');
    expect(transport.bodies()).toEqual([forwardRevokeAskReply('en')]);
    // THE COLUMN, read back. The whole class of defect this round closes is a live
    // credential deleted in answer to a question about it.
    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
    expect(await familyForForwardToken(db.database, seeded.token)).toBe(seeded.familyId);
    // The ask writes its own verb and the revoke's verb is nowhere on the trail.
    expect(await verbs(seeded.familyId)).toContain('email_forward_address_revoke_asked');
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_revoked');
  });

  it('is listed by the SHIPPED reader as the one thing open, dated and solicited', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);

    const questions = await defaultOpenQuestionReader().open(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      now: ANSWERED_AT,
    });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      kind: 'forward_address_revoke',
      askedAt: ASKED_AT,
      solicited: true,
      answerable: { yes: true, no: true },
      subject: 'turning off your forwarding address',
    });
  });
});

describe('only a YES to the question Hale asked revokes', () => {
  it('revokes exactly once, with both audit rows, and the receipt is unchanged', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);

    const yes = await text(seeded, 'yes', ANSWERED_AT);

    expect(yes.handler).toBe('forward_address');
    expect(transport.bodies()).toEqual([
      forwardRevokeAskReply('en'),
      forwardRevokeReply('en', 'revoked'),
    ]);
    expect(await tokenOf(seeded.familyId)).toBeNull();
    const trail = await verbs(seeded.familyId);
    expect(trail.filter((verb) => verb === 'email_forward_address_revoke_asked')).toHaveLength(1);
    expect(trail.filter((verb) => verb === 'email_forward_address_revoked')).toHaveLength(1);
    // The receipt closed the question: it is Hale's last word now.
    expect(await openKinds(seeded, ANSWERED_AT)).toEqual([]);
  });

  it('leaves the address alone on a NO, and closes the question so a later yes cannot take it', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);

    const no = await text(seeded, 'no', ANSWERED_AT);

    expect(no.handler).toBe('forward_address');
    expect(transport.bodies().at(-1)).toBe(forwardRevokeDeclinedReply('en'));
    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_revoked');
    expect(await openKinds(seeded, ANSWERED_AT)).toEqual([]);

    // A yes a minute after the no is answering nothing, and takes nothing away.
    const later = new Date(ANSWERED_AT.getTime() + 60_000);
    await text(seeded, 'yes', later);
    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
  });

  it('lets the question lapse in silence, so a yes past the window revokes nothing', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);
    // Nothing said by either side in between — the only thing that changed is the clock.
    expect(await openKinds(seeded, TOO_LATE)).toEqual([]);

    const late = await text(seeded, 'yes', TOO_LATE);

    expect(late.handler).not.toBe('forward_address');
    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_revoked');
  });

  it('never opens a question for a family with no address to turn off', async () => {
    const family = await seedFamily(db.database, 'No Address');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', family.familyId);
    await db.database.insert(schema.parentChannels).values({
      familyId: family.familyId,
      userId: family.parentUserId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: ASKED_AT,
    });
    const seeded = { ...family, token: 'never-minted' };

    const result = await text(seeded, 'turn off my forwarding address', ASKED_AT);

    expect(result.handler).toBe('forward_address');
    expect(transport.bodies()).toEqual([forwardRevokeReply('en', 'not_configured')]);
    // A question nobody can answer usefully would make every bare affirmative in the
    // household ambiguous for a quarter of an hour, for nothing.
    expect(await openKinds(seeded, ANSWERED_AT)).toEqual([]);
  });

  it('is never answered by a co-parent the question was not put to', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);

    const [other] = await db.database
      .insert(schema.users)
      .values({ email: `${seeded.familyId}-co@example.test`, name: 'Sam' })
      .returning({ id: schema.users.id });
    const coParentUserId = other?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: seeded.familyId, userId: coParentUserId, role: 'co_parent' });

    expect(await openKinds({ ...seeded, parentUserId: coParentUserId }, ANSWERED_AT)).toEqual([]);

    await text({ ...seeded, parentUserId: coParentUserId }, 'yes', ANSWERED_AT);
    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
  });
});

/**
 * A BARE YES IS NEVER STOLEN, IN EITHER DIRECTION.
 *
 * The two neighbours are deliberately different shapes. A drafted approval carries NO ask
 * time, which already disables the recency precedence; an email-alert offer carries one
 * AND prints "Reply YES", so with the revoke ask newer `soleOpenKind` would hand this lane
 * the word on recency alone. A revoke must not win a race it only won by being the most
 * recent thing Hale said, so the handler's check is stricter than that helper.
 */
describe('a bare yes beside somebody else s question', () => {
  async function seedApprovalDraft(seeded: Seeded): Promise<void> {
    const [event] = await db.database
      .insert(schema.events)
      .values({
        familyId: seeded.familyId,
        source: 'test',
        eventType: 'calendar',
        dedupHash: randomUUID(),
      })
      .returning({ id: schema.events.id });
    await db.database.insert(schema.actions).values({
      eventId: event?.id as string,
      familyId: seeded.familyId,
      actionType: 'calendar.place',
      payload: {},
      reviewerVerdict: 'approved',
      userVisibleState: 'drafted_for_approval',
    });
  }

  async function seedEmailAlertOffer(seeded: Seeded, at: Date): Promise<void> {
    const channelMessageId = await seedOutbound(seeded, at);
    await db.database.insert(schema.emailAlertOffers).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      integrationId: randomUUID(),
      messageId: `gmail-${randomUUID()}`,
      kind: 'event',
      title: 'Picture day',
      startsAt: new Date('2026-09-25T13:00:00.000Z'),
      channelMessageId,
      expiresAt: new Date(at.getTime() + 24 * 3_600_000),
      createdAt: at,
    });
  }

  it('is not taken by this lane while a drafted action is pending', async () => {
    const seeded = await seedReachableFamily();
    await seedApprovalDraft(seeded);
    await text(seeded, 'turn off my forwarding address', ASKED_AT);
    expect(new Set(await openKinds(seeded, ANSWERED_AT))).toEqual(
      new Set(['approval', 'forward_address_revoke']),
    );

    await text(seeded, 'yes', ANSWERED_AT);

    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_revoked');
  });

  it('is not taken by this lane while an email-alert offer is standing, even though the revoke ask is newer', async () => {
    const seeded = await seedReachableFamily();
    await seedEmailAlertOffer(seeded, new Date(ASKED_AT.getTime() - 3_600_000));
    await text(seeded, 'turn off my forwarding address', ASKED_AT);
    expect(new Set(await openKinds(seeded, ANSWERED_AT))).toEqual(
      new Set(['email_alert_add', 'forward_address_revoke']),
    );

    await text(seeded, 'yes', ANSWERED_AT);

    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_revoked');
  });

  it('and the reverse - the email-alert lane does not take a yes meant for the revoke ask', async () => {
    const seeded = await seedReachableFamily();
    await seedEmailAlertOffer(seeded, new Date(ASKED_AT.getTime() - 3_600_000));
    await text(seeded, 'turn off my forwarding address', ASKED_AT);

    const answer = await text(seeded, 'yes', ANSWERED_AT);

    expect(answer.handler).not.toBe('email_alert_add');
    expect(
      await db.database
        .select({ id: schema.familyEvents.id })
        .from(schema.familyEvents)
        .where(eq(schema.familyEvents.familyId, seeded.familyId)),
    ).toEqual([]);
  });

  it('POSITIVE CONTROL - the same yes, with nothing else open, does revoke', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);

    await text(seeded, 'yes', ANSWERED_AT);

    expect(await tokenOf(seeded.familyId)).toBe(null);
  });
});

describe('a statement about a forwarding address mints nothing', () => {
  const DECLARATIVES = [
    'I already set up a canada post forwarding address.',
    'the school has a new forwarding address.',
    'We already have a forwarding address.',
    'I set up a filter to my forwarding address.',
  ];

  it.each(DECLARATIVES)('%s - no token, no audit row, no address in the reply', async (body) => {
    const family = await seedFamily(db.database, 'Telling Hale Something');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', family.familyId);
    await db.database.insert(schema.parentChannels).values({
      familyId: family.familyId,
      userId: family.parentUserId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: ASKED_AT,
    });
    const seeded = { ...family, token: 'never-minted' };

    const result = await text(seeded, body, ASKED_AT);

    expect(result.handler).not.toBe('forward_address');
    expect(await tokenOf(seeded.familyId)).toBeNull();
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_minted');
    expect(transport.bodies().join(' ')).not.toContain('@mail.villagehale.com');
  });

  it('POSITIVE CONTROL - the same noun, asked for, still hands out the address', async () => {
    const family = await seedFamily(db.database, 'Asking Properly');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', family.familyId);
    await db.database.insert(schema.parentChannels).values({
      familyId: family.familyId,
      userId: family.parentUserId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: ASKED_AT,
    });
    const seeded = { ...family, token: 'never-minted' };

    const result = await text(seeded, "what's my forwarding address", ASKED_AT);

    expect(result.handler).toBe('forward_address');
    const minted = await tokenOf(seeded.familyId);
    expect(minted).toMatch(/^[0-9a-f]{30}$/);
    expect(transport.bodies()[0]).toContain(`hale+${minted}@mail.villagehale.com`);
  });
});

/** The template key is the whole mechanism behind the derived question — if the router
 * stops writing it, the question stops existing and a YES silently goes nowhere. */
describe('the ask is recognisable in the ledger', () => {
  it('names itself on the outbound row it went out on', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);

    const rows = await db.database
      .select({ templateKey: schema.channelMessages.templateKey })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, seeded.familyId),
          eq(schema.channelMessages.direction, 'out'),
        ),
      );
    expect(rows.map((row) => row.templateKey)).toEqual([FORWARD_REVOKE_ASK_TEMPLATE_KEY]);
  });
});
