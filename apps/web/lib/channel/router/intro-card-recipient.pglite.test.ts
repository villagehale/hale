import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import type { SaidLineWriter } from '~/lib/channel/voice/said-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { calendarOffersIdle } from '~/lib/integrations/calendar-offer-read';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { DISCOVERABILITY_SCOPE, proposalScope } from '~/lib/village/intros/consent';
import { defaultVillageIntroReplyDeps } from '~/lib/village/intros/reply';
import { introAskDedupeKey, introCardDedupeKey } from '~/lib/village/intros/run';
import { createInboundBurst } from './burst';
import { createDisambiguationStore } from './disambiguation';
import { villageIntroHandler } from './handlers';
import type { OpenQuestion } from './open-questions';
import { FakeReplyTransport } from './reply-route';
import type { ReplyReading, ReplyResolver } from './resolve';
import { type ChannelRouterDeps, routeChannelMessage } from './route';
import { darkSideTurn } from './side-turn.fixture';
import {
  auditSmokeAlarmClaim,
  auditTurnLedger,
  defaultOpenQuestionReader,
  loadInboundContext,
} from './wiring';

/**
 * VIL-302 · an intro ask is answered only by the parent it was texted to.
 *
 * Both intro asks are deduped per household but texted to ONE parent. A co-parent who
 * never received the card must not hold it open, or their bare "yes" would agree to an
 * introduction with another family on the household's behalf.
 *
 * The real router, the real open-question reader and the real intro lane on real
 * Postgres. The resolver is a stand-in that places a reply on the only question it is
 * shown, which is what the evals pin the real one to do; what it would read is not what
 * is under test here. What is: whether the router shows it the question at all.
 */

let phones = 300;
function nextPhone(): string {
  phones += 1;
  return `+1416555${String(phones).padStart(4, '0')}`;
}

let db: TestDb;

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
  vi.unstubAllEnvs();
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

interface Parent {
  familyId: string;
  parentUserId: string;
}

async function enrol(parent: Parent): Promise<void> {
  const phone = nextPhone();
  await db.database.insert(schema.parentChannels).values({
    familyId: parent.familyId,
    userId: parent.parentUserId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(),
  });
}

/** A household of two parents, both enrolled: the primary and a co-parent. */
async function household(label: string): Promise<{ primary: Parent; coParent: Parent }> {
  const primary = await seedFamily(db.database, `Family ${label}`);
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `co-${randomUUID()}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  const coParent = { familyId: primary.familyId, parentUserId: user?.id as string };
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: primary.familyId, userId: coParent.parentUserId, role: 'co_parent' });
  await enrol(primary);
  await enrol(coParent);
  return { primary, coParent };
}

/** An outbound ask under `dedupeKey`, delivered to `to` an hour ago. */
async function deliveredTo(to: Parent, dedupeKey: string): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId: to.familyId,
    parentUserId: to.parentUserId,
    channel: 'sms',
    direction: 'out',
    category: 'village_intro',
    status: 'delivered',
    dedupeKey,
    sentAt: new Date(Date.now() - 60 * 60 * 1000),
  });
}

/** A live card pairing `asked` with `other`, its `asked` side delivered to `to`. */
async function cardDeliveredTo(
  to: Parent,
  other: { familyId: string },
): Promise<{ proposalId: string; side: 'a' | 'b' }> {
  const askedIsA = to.familyId < other.familyId;
  const now = new Date();
  const [row] = await db.database
    .insert(schema.villageIntroProposals)
    .values({
      fsa: 'A1A',
      status: 'proposed',
      stage: 'toddler',
      familyAId: askedIsA ? to.familyId : other.familyId,
      familyBId: askedIsA ? other.familyId : to.familyId,
      familyAAskedAt: now,
      familyBAskedAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: schema.villageIntroProposals.id });
  const proposalId = row?.id as string;
  const side = askedIsA ? 'a' : 'b';
  await deliveredTo(to, introCardDedupeKey(proposalId, side));
  return { proposalId, side };
}

/** A bare "yes" the parent texted, as the door hands it to C1. */
async function bareYes(from: Parent) {
  const providerId = `prov-${randomUUID()}`;
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: from.familyId,
      parentUserId: from.parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId: providerId,
      providerChatId: `chat-${from.parentUserId}`,
      providerService: 'iMessage',
      status: 'delivered',
      body: 'yes',
      inGroup: false,
      createdAt: new Date(Date.now() - 5_000),
    })
    .returning({ id: schema.channelMessages.id });
  return {
    family_id: from.familyId,
    parent_user_id: from.parentUserId,
    channel_message_id: row?.id as string,
    provider_message_id: providerId,
    received_at: new Date().toISOString(),
    in_group: false,
  };
}

/** Places a reply on the one question it is shown, and records every list it saw. */
function soleQuestionResolver(): ReplyResolver & { shown: OpenQuestion[][] } {
  const resolver = {
    shown: [] as OpenQuestion[][],
    async read(input: { questions: readonly OpenQuestion[] }): Promise<ReplyReading> {
      resolver.shown.push([...input.questions]);
      const [only, ...rest] = input.questions;
      if (!only || rest.length > 0) return { status: 'unresolved', reason: 'ambiguous' };
      return {
        status: 'resolved',
        questionId: only.id,
        kind: only.kind,
        polarity: 'yes',
        confidence: 'high',
      };
    },
  };
  return resolver;
}

const saidLine: SaidLineWriter = { write: async () => 'Lovely, noted.' };

function routerDeps(
  transport: FakeReplyTransport,
  replyResolver: ReplyResolver,
): ChannelRouterDeps {
  const database = db.database;
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  return {
    database,
    loadContext: loadInboundContext,
    transport,
    handlers: [villageIntroHandler({ ...defaultVillageIntroReplyDeps(), saidLine })],
    offDomain: { consider: async () => ({ status: 'in_domain', fallback: null }) },
    coach: {
      async respond() {
        return {
          reply: 'Two Saturday art classes for her.',
          planOffer: null,
          activityPromise: null,
          spotWatch: null,
        };
      },
    },
    smokeAlarm: auditSmokeAlarmClaim(database),
    turns: auditTurnLedger(database),
    burst: createInboundBurst(database, {
      enabled: () => false,
      reader: { read: async () => ({ status: 'unavailable', reason: 'client_unavailable' }) },
      now: () => new Date(),
      sleep: async () => undefined,
      log,
    }),
    sideTurn: darkSideTurn(),
    apology: { compose: async () => ({ status: 'composed', reply: 'sorry' }) },
    holdingLine: { compose: async () => ({ status: 'composed', line: 'on it' }) },
    floodLine: { compose: async () => ({ status: 'composed', line: 'busy' }) },
    recordPlanOffer: async () => ({ status: 'recorded' }),
    recordCapabilityNotes: async () => ({ status: 'recorded', declined: 0, corrected: 0 }),
    recordActivityPromise: async () => ({
      status: 'recorded',
      commitmentId: '77777777-7777-4777-8777-777777777777',
    }),
    questions: defaultOpenQuestionReader(),
    replyResolver,
    calendarOffers: calendarOffersIdle,
    weekdayCareReader: { read: async () => ({ status: 'nothing_stated' as const }) },
    schoolBreakReplyReader: { read: async () => ({ status: 'nothing_stated' as const }) },
    recordSchoolBreak: async () => {},
    disambiguation: createDisambiguationStore(),
    reconcileView: loadReconcileView,
    claimShadow: { coachTurn: () => 'off', sweep: () => 'off', dispatch: () => 'off' },
    claimEnforcer: {
      enforces: () => false,
      read: async () => {
        throw new Error('the claim reader is not enforced here');
      },
    },
    recordStatedState: async () => ({ status: 'nothing_stated' }),
    weekdayCareAnswerTarget: async () => ({ status: 'no_open_ask' as const }),
    recordWeekdayCare: async (_db, input) => ({
      status: 'recorded' as const,
      care: input.care,
      providerNamed: input.provider !== null,
    }),
    searchWeekdays: async () => ({ status: 'abstain' as const, reason: 'not_configured' }),
    recordRegistrationWatch: async () => ({ status: 'recorded' }),
    armWatchedSpot: async () => ({ status: 'armed', spotId: 'spot-1' }),
    dispatchDeepResearch: async () => ({ status: 'enqueued' }),
    limiter: new FakeRateLimiter(() => Date.now()),
    now: () => new Date(),
    log,
  };
}

async function consentScopes(parent: Parent): Promise<string[]> {
  const rows = await db.database
    .select({ scope: schema.consentRecords.consentScope })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, parent.familyId),
        eq(schema.consentRecords.userId, parent.parentUserId),
      ),
    );
  return rows.map((row) => row.scope ?? '');
}

async function sideReply(proposalId: string, side: 'a' | 'b') {
  const [row] = await db.database
    .select({
      a: schema.villageIntroProposals.familyAReply,
      b: schema.villageIntroProposals.familyBReply,
    })
    .from(schema.villageIntroProposals)
    .where(eq(schema.villageIntroProposals.id, proposalId));
  return side === 'a' ? row?.a : row?.b;
}

const kindsShown = (resolver: { shown: OpenQuestion[][] }) =>
  resolver.shown.flat().map((question) => question.kind);

describe('an intro card is answered only by the parent it was texted to', () => {
  it("binds the recipient's bare yes to the card", async () => {
    const { primary } = await household('a');
    const other = await seedFamily(db.database, 'Family b');
    const card = await cardDeliveredTo(primary, other);
    const resolver = soleQuestionResolver();

    const result = await routeChannelMessage(
      routerDeps(new FakeReplyTransport(), resolver),
      await bareYes(primary),
    );

    expect(kindsShown(resolver)).toEqual(['intro_proposal']);
    expect(result.handler).toBe('village_intro');
    expect(await sideReply(card.proposalId, card.side)).toBe('yes');
    expect(await consentScopes(primary)).toEqual([proposalScope(card.proposalId)]);
  });

  it("never binds the co-parent's bare yes to a card they did not receive", async () => {
    const { primary, coParent } = await household('a');
    const other = await seedFamily(db.database, 'Family b');
    const card = await cardDeliveredTo(primary, other);
    const resolver = soleQuestionResolver();

    const result = await routeChannelMessage(
      routerDeps(new FakeReplyTransport(), resolver),
      await bareYes(coParent),
    );

    expect(kindsShown(resolver)).not.toContain('intro_proposal');
    expect(result.handler).not.toBe('village_intro');
    expect(await sideReply(card.proposalId, card.side)).toBeNull();
    expect(await consentScopes(coParent)).toEqual([]);
    expect(await consentScopes(primary)).toEqual([]);
  });
});

describe('the discoverability ask is answered only by the parent it was texted to', () => {
  it("binds the recipient's bare yes to the ask", async () => {
    const { primary } = await household('a');
    await deliveredTo(primary, introAskDedupeKey(primary.familyId));
    const resolver = soleQuestionResolver();

    const result = await routeChannelMessage(
      routerDeps(new FakeReplyTransport(), resolver),
      await bareYes(primary),
    );

    expect(kindsShown(resolver)).toEqual(['intro_optin']);
    expect(result.handler).toBe('village_intro');
    expect(await consentScopes(primary)).toEqual([DISCOVERABILITY_SCOPE]);
  });

  it("never binds the co-parent's bare yes to an ask they did not receive", async () => {
    const { primary, coParent } = await household('a');
    await deliveredTo(primary, introAskDedupeKey(primary.familyId));
    const resolver = soleQuestionResolver();

    const result = await routeChannelMessage(
      routerDeps(new FakeReplyTransport(), resolver),
      await bareYes(coParent),
    );

    expect(kindsShown(resolver)).not.toContain('intro_optin');
    expect(result.handler).not.toBe('village_intro');
    expect(await consentScopes(coParent)).toEqual([]);
  });
});
