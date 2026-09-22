import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, desc, eq, gt } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import { createDisambiguationStore } from '~/lib/channel/router/disambiguation';
import { FakeReplyTransport } from '~/lib/channel/router/reply-route';
import type { ReplyResolver } from '~/lib/channel/router/resolve';
import type { ChannelRouterDeps } from '~/lib/channel/router/route';
import { routeChannelMessage } from '~/lib/channel/router/route';
import {
  auditSmokeAlarmClaim,
  auditTurnLedger,
  defaultHandlers,
  defaultOpenQuestionReader,
  loadInboundContext,
} from '~/lib/channel/router/wiring';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { familyForForwardToken, mintForwardToken } from './forward-address';
import {
  FORWARD_REVOKE_ASK_TEMPLATE_KEY,
  FORWARD_REVOKE_ASK_TTL_MS,
  FORWARD_REVOKE_TEMPLATE_KEY,
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

/**
 * The resolver, never a model (rule #8's sibling discipline for this file): every claim
 * under test is made by a free reader, or by a reading this test states outright so that
 * what the chain does WITH it is the thing being measured.
 */
const NEVER_PLACES: ReplyResolver = {
  read: async () => ({ status: 'unresolved', reason: 'no_target' }),
};

/** Two things open and the answer fits both - the reading that sends the turn to the
 * coach and mints the clarifying menu (route.ts GATE 2b). */
const CANNOT_PLACE: ReplyResolver = {
  read: async () => ({ status: 'unresolved', reason: 'ambiguous' }),
};

/** The parent's own words, read onto THIS ask at the confidence a consequential question
 * demands. The id is the ask's own message row, which is the whole point of the door. */
function placesTheRevoke(questionId: string, polarity: 'yes' | 'no' = 'yes'): ReplyResolver {
  return {
    read: async () => ({
      status: 'resolved',
      kind: 'forward_address_revoke',
      questionId,
      polarity,
      confidence: 'high',
    }),
  };
}

function deps(
  now: Date,
  coachReply = 'Say more?',
  replyResolver: ReplyResolver = NEVER_PLACES,
): ChannelRouterDeps {
  return {
    database: db.database,
    loadContext: loadInboundContext,
    transport,
    handlers: defaultHandlers(),
    questions: defaultOpenQuestionReader(),
    weekdayCareAnswerTarget: async () => ({ status: 'no_open_ask' as const }),
    recordWeekdayCare: async (_db, input) => ({
      status: 'recorded' as const,
      care: input.care,
      providerNamed: input.provider !== null,
    }),
    searchWeekdays: async () => ({ status: 'abstain' as const, reason: 'not_configured' }),
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
    replyResolver,
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
interface TextOptions {
  /** The door this message came in by. The confirm went out on the parent's SMS route, so
   * an inbound arriving by email is not an answer to it however it reads. */
  channel?: 'sms' | 'email';
  coachReply?: string;
  resolver?: ReplyResolver;
}

async function text(seeded: Seeded, body: string, at: Date, options: TextOptions = {}) {
  const providerMessageId = `SM-${at.getTime()}-${Math.random()}`;
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: options.channel ?? 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId,
      status: 'delivered',
      body,
      createdAt: at,
      sentAt: at,
    })
    .returning({ id: schema.channelMessages.id });
  const result = await routeChannelMessage(
    deps(at, options.coachReply ?? 'Say more?', options.resolver ?? NEVER_PLACES),
    {
      family_id: seeded.familyId,
      parent_user_id: seeded.parentUserId,
      channel_message_id: row?.id as string,
      provider_message_id: providerMessageId,
      received_at: at.toISOString(),
    },
  );
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

/** A drafted action waiting for this family's approval — the neighbour that carries NO
 * ask time, so it can never win a recency race and is only ever a second open question. */
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

/** The outbound row the confirm went out on — the id the menu's option points at, and the
 * id the resolved door looks the ask up by. */
async function askMessageId(seeded: Seeded): Promise<string> {
  const [row] = await db.database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, seeded.familyId),
        eq(schema.channelMessages.templateKey, FORWARD_REVOKE_ASK_TEMPLATE_KEY),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  return row?.id as string;
}

/** What Hale printed on its clarifying menu, in the order it printed it. */
async function menuKinds(seeded: Seeded): Promise<string[]> {
  const [row] = await db.database
    .select({ options: schema.pendingDisambiguations.options })
    .from(schema.pendingDisambiguations)
    .where(eq(schema.pendingDisambiguations.parentUserId, seeded.parentUserId));
  return (row?.options ?? []).map((option) => option.kind);
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

/**
 * HALE'S OWN CLARIFYING TURN DOES NOT CLOSE THE QUESTION (round 7, B2).
 *
 * The shape the round-6 verifier found: with any other question open, a bare YES to the
 * confirm cannot be placed by the free readers, so the turn goes to the coach and Hale
 * prints a menu — a menu whose second option IS this revoke. That menu is an outbound, so
 * under a pure last-word rule it closed the very question it was asking about, and the
 * parent's pick then answered nothing. Hale offered it and could not honour it: a dropped
 * consent turn behind a false offer.
 *
 * So the derivation is split. The ASK stands while it is inside its window and no receipt
 * has answered it; the LAST-WORD rule stays on the bare-word door, where it belongs — a
 * word with no target may only ever land on the thing Hale said last.
 */
describe('the confirm survives Hale s own clarifying turn', () => {
  /** Four minutes after the ask, and two after the menu. */
  const PICKED_AT = new Date(ASKED_AT.getTime() + 4 * 60 * 1000);

  async function askThenMenu(seeded: Seeded): Promise<void> {
    await seedApprovalDraft(seeded);
    await text(seeded, 'turn off my forwarding address', ASKED_AT);
    await text(seeded, 'yes', ANSWERED_AT, {
      resolver: CANNOT_PLACE,
      coachReply: 'Which one did you mean?',
    });
    expect(await menuKinds(seeded)).toEqual(['approval', 'forward_address_revoke']);
  }

  it('offers the revoke on the menu and then honours the pick - once, with both rows', async () => {
    const seeded = await seedReachableFamily();
    await askThenMenu(seeded);

    const pick = await text(seeded, 'the forwarding address one', PICKED_AT, {
      resolver: CANNOT_PLACE,
    });

    expect(pick.handler).toBe('forward_address');
    expect(transport.bodies().at(-1)).toBe(forwardRevokeReply('en', 'revoked'));
    expect(await tokenOf(seeded.familyId)).toBeNull();
    const trail = await verbs(seeded.familyId);
    expect(trail.filter((verb) => verb === 'email_forward_address_revoke_asked')).toHaveLength(1);
    expect(trail.filter((verb) => verb === 'email_forward_address_revoked')).toHaveLength(1);
  });

  it('but not past the ask s own window - the menu outlives the confirm, the confirm still lapses', async () => {
    const seeded = await seedReachableFamily();
    await askThenMenu(seeded);

    // The menu's window is three hours; the confirm's is fifteen minutes, and it is the
    // shorter one that decides whether a credential may still be destroyed.
    const late = await text(seeded, 'the forwarding address one', TOO_LATE, {
      resolver: CANNOT_PLACE,
    });

    expect(late.handler).not.toBe('forward_address');
    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_revoked');
  });

  it('and not after the parent already said no - the declined receipt closes it for both doors', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);
    const askId = await askMessageId(seeded);
    await text(seeded, 'no', ANSWERED_AT);
    expect(transport.bodies().at(-1)).toBe(forwardRevokeDeclinedReply('en'));
    // Something else open, so the resolver stage runs at all (route.ts GATE 2b).
    await seedApprovalDraft(seeded);

    const later = await text(seeded, 'the forwarding address one', PICKED_AT, {
      resolver: placesTheRevoke(askId),
      coachReply: 'Say more?',
    });

    expect(later.handler).not.toBe('forward_address');
    expect(transport.bodies().at(-1)).toBe('Say more?');
    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_revoked');
  });

  it('and revokes once - a second reading of the same ask takes nothing more', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);
    const askId = await askMessageId(seeded);
    await text(seeded, 'yes', ANSWERED_AT);
    expect(await tokenOf(seeded.familyId)).toBeNull();
    await seedApprovalDraft(seeded);

    const again = await text(seeded, 'the forwarding address one', PICKED_AT, {
      resolver: placesTheRevoke(askId),
      coachReply: 'Say more?',
    });

    // The receipt answered the question. A second reading of it is not a second answer,
    // and must not reach the parent as "you have no forwarding address" either.
    expect(again.handler).not.toBe('forward_address');
    expect(transport.bodies().at(-1)).toBe('Say more?');
    expect(
      (await verbs(seeded.familyId)).filter((verb) => verb === 'email_forward_address_revoked'),
    ).toHaveLength(1);
  });

  /** The parent asks again past the first ask's own window, so one confirm is lapsed and
   * one is live at the moment they answer. */
  const RE_ASKED_AT = new Date(ASKED_AT.getTime() + FORWARD_REVOKE_ASK_TTL_MS + 60_000);
  /** A minute after the second ask — the answer arrives. */
  const ANSWERED_THE_ASK_AT = new Date(RE_ASKED_AT.getTime() + 60_000);

  /** Two confirms this parent was sent, and something else open beside them: the bare-word
   * door declines with a second kind standing (handlers.ts `bareWordAsk`), which is both
   * what makes the resolver stage run at all (route.ts GATE 2b) and what leaves the
   * resolution as the only thing naming which ask the YES is for. */
  async function askTwice(seeded: Seeded): Promise<{ lapsed: string; live: string }> {
    await text(seeded, 'turn off my forwarding address', ASKED_AT);
    const lapsed = await askMessageId(seeded);
    await text(seeded, 'turn off my forwarding address', RE_ASKED_AT);
    const live = await askMessageId(seeded);
    expect(live).not.toBe(lapsed);
    await seedApprovalDraft(seeded);
    return { lapsed, live };
  }

  it('honours only the ask the resolution names, never the newest one', async () => {
    const seeded = await seedReachableFamily();
    const { lapsed } = await askTwice(seeded);

    const named = await text(seeded, 'yes', ANSWERED_THE_ASK_AT, {
      resolver: placesTheRevoke(lapsed),
      coachReply: 'Say more?',
    });

    // The reading named the confirm that has lapsed. Reading past it to whichever ask
    // happens to be newest would spend a live credential on a question the parent was
    // never answering.
    expect(named.handler).not.toBe('forward_address');
    expect(transport.bodies().at(-1)).toBe('Say more?');
    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_revoked');
    expect(
      await db.database
        .select({ id: schema.channelMessages.id })
        .from(schema.channelMessages)
        .where(
          and(
            eq(schema.channelMessages.familyId, seeded.familyId),
            eq(schema.channelMessages.templateKey, FORWARD_REVOKE_TEMPLATE_KEY),
          ),
        ),
    ).toEqual([]);
  });

  it('POSITIVE CONTROL - the same yes, naming the ask that is still standing, revokes once', async () => {
    const seeded = await seedReachableFamily();
    const { live } = await askTwice(seeded);

    const named = await text(seeded, 'yes', ANSWERED_THE_ASK_AT, {
      resolver: placesTheRevoke(live),
      coachReply: 'Say more?',
    });

    expect(named.handler).toBe('forward_address');
    expect(transport.bodies().at(-1)).toBe(forwardRevokeReply('en', 'revoked'));
    expect(await tokenOf(seeded.familyId)).toBeNull();
    const trail = await verbs(seeded.familyId);
    expect(trail.filter((verb) => verb === 'email_forward_address_revoke_asked')).toHaveLength(2);
    expect(trail.filter((verb) => verb === 'email_forward_address_revoked')).toHaveLength(1);
  });
});

/**
 * THE BARE WORD KEEPS ROUND 6'S STRICTER RULE. A yes with no target in it may only ever
 * answer the thing Hale said LAST, on the door it said it through — everything the split
 * above loosened is loosened for readings that name their question, and for nothing else.
 */
describe('a bare yes, and the three things it still has to clear', () => {
  it('is not an answer to an ask Hale has already spoken past', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);
    // An ordinary turn in between: Hale's last word is the coach's, not the confirm.
    await text(seeded, 'what time does the library open', new Date(ASKED_AT.getTime() + 60_000), {
      coachReply: 'Ten, most days.',
    });

    await text(seeded, 'yes', ANSWERED_AT);

    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_revoked');
  });

  it('is not an answer arriving through a door the question never went out of', async () => {
    const seeded = await seedReachableFamily();
    await text(seeded, 'turn off my forwarding address', ASKED_AT);

    const wrongDoor = await text(seeded, 'yes', ANSWERED_AT, { channel: 'email' });

    expect(wrongDoor.handler).not.toBe('forward_address');
    expect(await tokenOf(seeded.familyId)).toBe(seeded.token);
    expect(await verbs(seeded.familyId)).not.toContain('email_forward_address_revoked');
  });
});

describe('a statement about a forwarding address mints nothing', () => {
  const DECLARATIVES = [
    'I already set up a canada post forwarding address.',
    'the school has a new forwarding address.',
    'We already have a forwarding address.',
    'I set up a filter to my forwarding address.',
    // The same class one verb along (round 7): the subject is the school, the camp or
    // Canada Post, and each of these minted a token and texted the parent the address in
    // answer to news about somebody else.
    'Canada Post will give us a forwarding address.',
    'the school will send us a forwarding address.',
    "the camp said they'd text me the forwarding address.",
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
