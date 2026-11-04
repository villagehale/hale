import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { type GuardDeps, invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChannelDraftInput, productionChannelDraftPort } from '~/lib/channel/coach/draft';
import { productionChannelCoachPorts } from '~/lib/channel/coach/runtime';
import { createTurnOfferLedger } from '~/lib/channel/coach/tools';
import {
  groupPlanActionIds,
  productionRecordGroupPlanOrigin,
} from '~/lib/channel/group-plan/stamp';
import { approvalHandler } from '~/lib/channel/router/handlers';
import { FakeReplyTransport } from '~/lib/channel/router/reply-route';
import { type ChannelRouterDeps, routeChannelMessage } from '~/lib/channel/router/route';
import {
  channelRouterDeps,
  defaultApprovalSpine,
  defaultOpenQuestionReader,
} from '~/lib/channel/router/wiring';
import { channelGroupNoteKey } from '~/lib/coach/note-key';
import { calendarOffersIdle } from '~/lib/integrations/calendar-offer-read';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * VIL-525 — a calendar draft's audience is written when it is minted, and it fixes the
 * one place the draft is answered: the household group it was asked in, or the family's
 * private threads. A shared or unclaimed chat is never that place (round 4).
 *
 * Every ask here goes through the SHIPPED production coach ports, so the draft port, the
 * group-plan wrapper, the origin it records and the dedupe that reads it are the ones a
 * real turn runs. The reviewer is unreachable: `ANTHROPIC_BASE_URL` points at a closed
 * local port, so a mint writes its rows and then stops on "Connection error." with no
 * request leaving the machine. A stubbed global `fetch` does not reach the SDK's
 * transport, which is why the base URL is the guard.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };

const NOW = new Date('2026-09-17T15:00:00.000Z');
const TITLE = 'Picture day';
/** 08:00 on 2026-09-19 in America/Chicago. */
const STARTS_AT = '2026-09-19T13:00:00.000Z';
const SHARED_CHAT = 'chat-shared';
const OTHER_SHARED_CHAT = 'chat-shared-other';
/** A fictional number: the router wants a reply address, and nothing is sent. */
const PHONE = '+15555550100';

type Turn =
  | { audience: 'direct' }
  | { audience: 'group'; groupChatId?: string; conversationId?: string };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Chicago' })
    .where(eq(schema.users.id, family.parentUserId));
  vi.stubEnv('ANTHROPIC_API_KEY', 'not-used-by-this-test');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9');
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function addIds(): Promise<string[]> {
  const rows = await db.database
    .select({ id: schema.actions.id })
    .from(schema.actions)
    .where(
      and(
        eq(schema.actions.familyId, family.familyId),
        eq(schema.actions.actionType, 'calendar_add'),
      ),
    );
  return rows.map((row) => row.id);
}

async function makeHousehold(chatId: string): Promise<void> {
  await db.database
    .update(schema.families)
    .set({ linqGroupChatId: chatId })
    .where(eq(schema.families.id, family.familyId));
}

/** The family's own group chat, with the thread a turn in it runs on. */
async function householdGroup(): Promise<{ chatId: string; conversationId: string }> {
  const chatId = `chat-household-${randomUUID()}`;
  await makeHousehold(chatId);
  const [row] = await db.database
    .insert(schema.conversations)
    .values({ familyId: family.familyId, noteKey: channelGroupNoteKey(chatId) })
    .returning({ id: schema.conversations.id });
  if (!row) throw new Error('no conversation row');
  return { chatId, conversationId: row.id };
}

/**
 * The household group ask's first draft. The group-plan stamp is written after the
 * reviewer returns, which this suite cannot reach, so the shipped stamp writer is run
 * here in the order production runs it.
 */
async function householdGroupDraft(
  household: { chatId: string; conversationId: string },
  turn: Turn,
): Promise<string> {
  const [groupId] = (await ask(turn)).minted;
  if (!groupId) throw new Error('the group ask did not draft');
  await expect(
    productionRecordGroupPlanOrigin(db.database)({
      familyId: family.familyId,
      actor: family.parentUserId,
      actionId: groupId,
      conversationId: household.conversationId,
    }),
  ).resolves.toBe('recorded');
  return groupId;
}

async function seedChild(name: string): Promise<string> {
  const [row] = await db.database
    .insert(schema.children)
    .values({ familyId: family.familyId, name, dateOfBirth: '2022-04-01' })
    .returning({ id: schema.children.id });
  if (!row) throw new Error('no child row');
  return row.id;
}

/** A draft minted before origins were recorded: no mint row, no group stamp. */
async function seedLegacyPrivateDraft(over: {
  title: string;
  startsAt: string;
  draftedAt: Date;
}): Promise<string> {
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId: family.familyId,
      source: 'channel_sms',
      eventType: 'channel_sms.calendar_intent',
      dedupHash: randomUUID(),
    })
    .returning({ id: schema.events.id });
  if (!event) throw new Error('no event row');
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      familyId: family.familyId,
      eventId: event.id,
      actionType: 'calendar_add',
      payload: { title: over.title, startsAt: over.startsAt, childId: null },
      userVisibleState: 'drafted_for_approval',
      reviewerVerdict: 'pending',
      draftedAt: over.draftedAt,
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error('no action row');
  return action.id;
}

/**
 * One `propose_calendar_add` through the production ports. `minted` is every add row the
 * call created, so "reused" and "drafted again" are read off the table, not the result.
 */
async function ask(
  turn: Turn,
  over: { time?: string; childId?: string } = {},
): Promise<{ result: unknown; minted: string[] }> {
  const before = await addIds();
  const noop = () => {};
  const tool = productionChannelCoachPorts(db.database)
    .buildTools(
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        conversationId:
          turn.audience === 'group' ? (turn.conversationId ?? randomUUID()) : randomUUID(),
        body: 'add picture day',
        now: NOW,
        standingQuestions: [],
        audience: turn.audience,
        ...(turn.audience === 'group' && turn.groupChatId ? { groupChatId: turn.groupChatId } : {}),
      },
      noop,
      noop,
      noop,
      noop,
      noop,
      createTurnOfferLedger(),
    )
    .find((candidate) => candidate.name === 'propose_calendar_add');
  if (!tool) throw new Error('production buildTools registers no propose_calendar_add');
  const guard: GuardDeps = {
    writeAudit: async () => {},
    checkChildContentAccess: async () => ({ ok: true, reason: 'ok' }),
  };
  const result = await invokeTool(
    tool,
    {
      title: TITLE,
      date: '2026-09-19',
      time: over.time ?? '08:00',
      weekday: 'sat',
      ...(over.childId ? { childId: over.childId } : {}),
    },
    { familyId: family.familyId, actor: family.parentUserId },
    guard,
  ).catch((err: unknown) => {
    // The mint reached the reviewer, which this suite cannot reach.
    if (err instanceof Error && err.message === 'Connection error.') return null;
    throw err;
  });
  const minted = (await addIds()).filter((id) => !before.includes(id));
  return { result, minted };
}

async function mintRowAfter(actionId: string): Promise<unknown> {
  const [row] = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetId, actionId),
        eq(schema.auditLog.actionTaken, 'channel_sms.calendar_drafted'),
      ),
    );
  if (!row) throw new Error('no mint row');
  return row.after;
}

async function mintOrigin(actionId: string): Promise<unknown> {
  return ((await mintRowAfter(actionId)) as { origin?: unknown }).origin;
}

/** The reviewer this suite cannot reach, standing in for its approve verdict. */
async function reviewerApproved(actionId: string): Promise<void> {
  await db.database
    .update(schema.actions)
    .set({ reviewerVerdict: 'approved' })
    .where(eq(schema.actions.id, actionId));
}

/**
 * A parent's "yes" through the shipped router, in a group chat or on the private thread.
 * The open-question reader, the group list and the approval spine's listing are the
 * production ones. Only the model readers are scripted: the resolver answers YES to
 * `target` when it is shown, and `approve` records instead of enqueueing.
 */
async function routeYes(
  target: string,
  where: { chatId: string | null },
): Promise<{ shown: string[][]; approved: string[] }> {
  const shown: string[][] = [];
  const approved: string[] = [];
  const providerMessageId = `in-${randomUUID()}`;
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId,
      status: 'delivered',
      body: 'yes',
      createdAt: NOW,
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('no inbound row');
  const inGroup = where.chatId !== null;
  const deps: ChannelRouterDeps = {
    ...channelRouterDeps(db.database),
    loadContext: async () => ({
      body: 'yes',
      role: 'primary_parent',
      primaryParentName: null,
      reply:
        where.chatId === null
          ? { channel: 'sms', to: PHONE }
          : { channel: 'imessage', to: PHONE, chatId: where.chatId, replyToMessageId: null },
      inGroup,
    }),
    transport: new FakeReplyTransport(),
    handlers: [
      approvalHandler({
        ...defaultApprovalSpine(),
        approve: async (_database, args) => {
          approved.push(args.actionId);
          return { ok: true };
        },
      }),
    ],
    offDomain: { consider: async () => ({ status: 'in_domain', fallback: null }) },
    replyResolver: {
      read: async (input) => {
        const ids = input.questions.map((question) => question.id);
        shown.push(ids);
        return ids.includes(target)
          ? {
              status: 'resolved' as const,
              questionId: target,
              kind: 'approval' as const,
              polarity: 'yes' as const,
              confidence: 'high' as const,
            }
          : { status: 'unresolved' as const, reason: 'no_target' as const };
      },
    },
    calendarOffers: calendarOffersIdle,
    coach: {
      async respond() {
        return { reply: 'Noted.', planOffer: null, activityPromise: null, spotWatch: null };
      },
    },
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    now: () => NOW,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  await routeChannelMessage(deps, {
    family_id: family.familyId,
    parent_user_id: family.parentUserId,
    channel_message_id: row.id,
    provider_message_id: providerMessageId,
    received_at: NOW.toISOString(),
    in_group: inGroup,
  });
  return { shown, approved };
}

async function privateApprovalIds(): Promise<string[]> {
  const questions = await defaultOpenQuestionReader().open(db.database, {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    now: NOW,
  });
  return questions.filter((question) => question.kind === 'approval').map((q) => q.id);
}

describe('VIL-525 a calendar draft records its audience at mint', () => {
  it('a shared-chat draft is answered on the private thread, never in the shared chat', async () => {
    await householdGroup();
    const [sharedId] = (await ask({ audience: 'group', groupChatId: SHARED_CHAT })).minted;
    if (!sharedId) throw new Error('the shared-chat ask did not draft');
    await reviewerApproved(sharedId);

    expect(await privateApprovalIds()).toEqual([sharedId]);
    expect(
      await groupPlanActionIds(db.database, { familyId: family.familyId, chatId: SHARED_CHAT }),
    ).toEqual(new Set());

    const inShared = await routeYes(sharedId, { chatId: SHARED_CHAT });
    expect(inShared.shown).toEqual([]);
    expect(inShared.approved).toEqual([]);

    const onPrivate = await routeYes(sharedId, { chatId: null });
    expect(onPrivate.shown).toEqual([[sharedId]]);
    expect(onPrivate.approved).toEqual([sharedId]);
  });

  it("a household-group draft is listed and approved only in that group's chat", async () => {
    const household = await householdGroup();
    const groupId = await householdGroupDraft(household, {
      audience: 'group',
      groupChatId: household.chatId,
      ...household,
    });
    await reviewerApproved(groupId);

    expect(
      await groupPlanActionIds(db.database, {
        familyId: family.familyId,
        chatId: household.chatId,
      }),
    ).toEqual(new Set([groupId]));
    expect(
      await groupPlanActionIds(db.database, { familyId: family.familyId, chatId: SHARED_CHAT }),
    ).toEqual(new Set());
    expect(await privateApprovalIds()).toEqual([]);

    const onPrivate = await routeYes(groupId, { chatId: null });
    expect(onPrivate.approved).toEqual([]);
    const inGroup = await routeYes(groupId, { chatId: household.chatId });
    expect(inGroup.shown).toEqual([[groupId]]);
    expect(inGroup.approved).toEqual([groupId]);
  });

  it('a household-group ask reuses its own group draft and never the private draft beside it', async () => {
    const household = await householdGroup();
    const group: Turn = { audience: 'group', groupChatId: household.chatId, ...household };
    const groupId = await householdGroupDraft(household, group);

    const privateAsk = await ask({ audience: 'direct' });
    expect(privateAsk.minted).toHaveLength(1);
    const [privateId] = privateAsk.minted;
    expect(privateId).not.toBe(groupId);
    expect(await mintOrigin(privateId as string)).toEqual({ surface: 'private' });

    const groupAgain = await ask(group);
    expect(groupAgain.minted).toEqual([]);
    expect(groupAgain.result).toMatchObject({ alreadyPending: true, actionId: groupId });
    const privateAgain = await ask({ audience: 'direct' });
    expect(privateAgain.minted).toEqual([]);
    expect(privateAgain.result).toMatchObject({ alreadyPending: true, actionId: privateId });
  });

  it('a private ask reuses a shared-chat draft, which waits on the private thread', async () => {
    await householdGroup();
    const [sharedId] = (await ask({ audience: 'group', groupChatId: SHARED_CHAT })).minted;
    if (!sharedId) throw new Error('the shared-chat ask did not draft');

    const privateAsk = await ask({ audience: 'direct' }, { time: '08:01' });

    expect(privateAsk.minted).toEqual([]);
    expect(privateAsk.result).toMatchObject({ alreadyPending: true, actionId: sharedId });
  });

  it("a group ask in household chat B never reuses chat A's draft, though A's is the newest", async () => {
    const chatB = await householdGroup();
    const inB: Turn = { audience: 'group', groupChatId: chatB.chatId, ...chatB };
    const bId = await householdGroupDraft(chatB, inB);
    const chatA = await householdGroup();
    const aId = await householdGroupDraft(chatA, {
      audience: 'group',
      groupChatId: chatA.chatId,
      ...chatA,
    });
    await makeHousehold(chatB.chatId);

    const again = await ask(inB);

    expect(again.minted).toEqual([]);
    expect(again.result).toMatchObject({ alreadyPending: true, actionId: bId });
    // Recorded at mint: a later change of household chat leaves A's draft on A's list.
    expect(
      await groupPlanActionIds(db.database, { familyId: family.familyId, chatId: chatA.chatId }),
    ).toEqual(new Set([aId]));
  });

  it('a group ask in a shared chat reuses only a draft asked in that same chat', async () => {
    await householdGroup();
    const [privateId] = (await ask({ audience: 'direct' })).minted;
    if (!privateId) throw new Error('the private ask did not draft');

    const shared = await ask({ audience: 'group', groupChatId: SHARED_CHAT });
    expect(shared.minted).toHaveLength(1);
    expect(shared.minted).not.toContain(privateId);
    const [sharedId] = shared.minted;

    const sharedAgain = await ask(
      { audience: 'group', groupChatId: SHARED_CHAT },
      { time: '08:01' },
    );
    expect(sharedAgain.minted).toEqual([]);
    expect(sharedAgain.result).toMatchObject({ alreadyPending: true, actionId: sharedId });

    const otherShared = await ask({ audience: 'group', groupChatId: OTHER_SHARED_CHAT });
    expect(otherShared.minted).toHaveLength(1);
    expect(otherShared.minted).not.toContain(sharedId);
  });

  it('a group ask with no chat id mints nothing and names group_chat_unknown', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const unknown = await ask({ audience: 'group' });

    expect(unknown.minted).toEqual([]);
    expect(unknown.result).toEqual({ drafted: false, outcome: 'group_chat_unknown' });
    expect(info).toHaveBeenCalledWith(
      { familyId: family.familyId, outcome: 'group_chat_unknown' },
      expect.any(String),
    );

    // Positive control: the same ask with its chat named drafts.
    const named = await ask({ audience: 'group', groupChatId: SHARED_CHAT });
    expect(named.minted).toHaveLength(1);
  });

  it('the mint row records the origin without the raw chat id', async () => {
    const household = await householdGroup();
    const [sharedId] = (await ask({ audience: 'group', groupChatId: SHARED_CHAT })).minted;
    if (!sharedId) throw new Error('the shared-chat ask did not draft');
    const householdId = await householdGroupDraft(household, {
      audience: 'group',
      groupChatId: household.chatId,
      ...household,
    });

    for (const [id, chatId] of [
      [sharedId, SHARED_CHAT],
      [householdId, household.chatId],
    ] as const) {
      expect(JSON.stringify(await mintRowAfter(id))).not.toContain(chatId);
    }
    // Positive control: the origin is still recorded, keyed, with the household bit.
    expect(await mintOrigin(sharedId)).toEqual({
      surface: 'group',
      chatKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      household: false,
    });
    expect(await mintOrigin(householdId)).toEqual({
      surface: 'group',
      chatKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      household: true,
    });
    expect(await mintOrigin(sharedId)).not.toEqual(await mintOrigin(householdId));
  });

  it("an ask for one child never reuses another child's draft, and an ask with no child never reuses a child's", async () => {
    const ada = await seedChild('Ada');
    const ben = await seedChild('Ben');
    const [adaId] = (await ask({ audience: 'direct' }, { childId: ada })).minted;
    if (!adaId) throw new Error('the ask did not draft');

    const noChild = await ask({ audience: 'direct' });
    expect(noChild.minted).toHaveLength(1);
    expect(noChild.minted).not.toContain(adaId);

    const forBen = await ask({ audience: 'direct' }, { childId: ben });
    expect(forBen.minted).toHaveLength(1);

    // Positive control: the same child's ask reuses that child's draft.
    const adaAgain = await ask({ audience: 'direct' }, { childId: ada });
    expect(adaAgain.minted).toEqual([]);
    expect(adaAgain.result).toMatchObject({ alreadyPending: true, actionId: adaId });
  });

  it('finds the newest draft when more than a page of older drafts is waiting', async () => {
    for (let index = 0; index < 20; index += 1) {
      await seedLegacyPrivateDraft({
        title: `Older add ${index}`,
        startsAt: STARTS_AT,
        draftedAt: new Date(Date.UTC(2026, 0, 1 + index)),
      });
    }
    const [newest] = (await ask({ audience: 'direct' })).minted;
    if (!newest) throw new Error('the ask did not draft');

    const again = await ask({ audience: 'direct' });

    expect(again.minted).toEqual([]);
    expect(again.result).toMatchObject({ alreadyPending: true, actionId: newest });
  });

  it('two close same-title drafts are duplicates, so a repeat ask reuses the newest instead of minting a third', async () => {
    await seedLegacyPrivateDraft({
      title: TITLE,
      startsAt: STARTS_AT,
      draftedAt: new Date('2026-09-10T12:00:00.000Z'),
    });
    const newer = await seedLegacyPrivateDraft({
      title: TITLE,
      startsAt: new Date(Date.parse(STARTS_AT) + 60_000).toISOString(),
      draftedAt: new Date('2026-09-11T12:00:00.000Z'),
    });

    const again = await ask({ audience: 'direct' });

    expect(again.minted).toEqual([]);
    expect(again.result).toMatchObject({ alreadyPending: true, actionId: newer });
  });

  it('an older matching draft is found behind a page of newer drafts for other children', async () => {
    const other = await seedChild('Ada');
    const older = await seedLegacyPrivateDraft({
      title: TITLE,
      startsAt: STARTS_AT,
      draftedAt: new Date('2026-09-01T12:00:00.000Z'),
    });
    for (let index = 0; index < 20; index += 1) {
      const id = await seedLegacyPrivateDraft({
        title: TITLE,
        startsAt: STARTS_AT,
        draftedAt: new Date(Date.UTC(2026, 8, 2 + index)),
      });
      await db.database
        .update(schema.actions)
        .set({ payload: { title: TITLE, startsAt: STARTS_AT, childId: other } })
        .where(eq(schema.actions.id, id));
    }

    const again = await ask({ audience: 'direct' });

    expect(again.minted).toEqual([]);
    expect(again.result).toMatchObject({ alreadyPending: true, actionId: older });
  });

  it("a group turn's move or cancel stays on the private list, as only a group add is the group's", async () => {
    const household = await householdGroup();
    const port = productionChannelDraftPort(
      db.database,
      new Anthropic({
        apiKey: 'not-used-by-this-test',
        baseURL: 'http://127.0.0.1:9',
        maxRetries: 0,
      }),
      {
        now: NOW,
        parentUserId: family.parentUserId,
        origin: { surface: 'group', chatId: household.chatId },
      },
    );
    const draft = async (actionType: ChannelDraftInput['actionType']): Promise<string> => {
      const before = await db.database
        .select({ id: schema.actions.id })
        .from(schema.actions)
        .where(eq(schema.actions.familyId, family.familyId));
      await port
        .draft({
          familyId: family.familyId,
          actor: family.parentUserId,
          actionType,
          payload: {
            title: TITLE,
            startsAt: STARTS_AT,
            endsAt: null,
            location: null,
            childId: null,
            privacySensitive: false,
            ...(actionType === 'calendar_add' ? {} : { reversalHandle: randomUUID() }),
          },
          rationale: 'the group asked',
          teenContent: false,
        })
        .catch((err: unknown) => {
          if (!(err instanceof Error && err.message === 'Connection error.')) throw err;
        });
      const after = await db.database
        .select({ id: schema.actions.id })
        .from(schema.actions)
        .where(eq(schema.actions.familyId, family.familyId));
      const [id] = after.map((row) => row.id).filter((row) => !before.some((b) => b.id === row));
      if (!id) throw new Error(`no ${actionType} drafted`);
      return id;
    };

    const cancelId = await draft('calendar_cancel');
    const addId = await draft('calendar_add');

    expect(await privateApprovalIds()).toEqual([cancelId]);
    expect(
      await groupPlanActionIds(db.database, {
        familyId: family.familyId,
        chatId: household.chatId,
      }),
    ).toEqual(new Set([addId]));
  });
});
