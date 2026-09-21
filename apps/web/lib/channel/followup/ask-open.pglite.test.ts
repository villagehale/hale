import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalSpine, PendingAction } from '~/lib/channel/router/approval';
import { approvalHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext } from '~/lib/channel/router/route';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import { activityFollowupAskOpen } from './ask-open';

/**
 * "How did Mia get on at swim?" — the follow-up ask, through the router's REAL reader.
 *
 * THE BUG THIS FILE OPENS WITH. The ask has always been a question Hale is holding and
 * has never been on the open-question list, so `soleOpenKind` was vacuously satisfied by
 * a single drafted approval: a parent's "yes", meant for the swim question thirty seconds
 * earlier, EXECUTED an unrelated calendar write. Consent applied to the wrong question
 * (rule #4). The first case here is that theft, and it fails before the kind exists.
 *
 * It reads through `defaultOpenQuestionReader()` rather than an injected source for the
 * reason VIL-355's file gives: a fake source cannot fail on a blinded line in wiring.ts,
 * and the production wiring would otherwise stay unpinned.
 */

const NOW = new Date('2026-09-15T23:30:00.000Z'); // 19:30 America/Toronto
const ASKED_AT = new Date('2026-09-15T23:00:00.000Z'); // 19:00 America/Toronto

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

interface Seeded {
  familyId: string;
  parentUserId: string;
  coParentUserId: string;
}

async function seedFamily(): Promise<Seeded> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [primary] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:ask-open-primary', name: 'Ana' })
    .returning({ id: schema.users.id });
  const [coParent] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:ask-open-coparent', name: 'Sam' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = primary?.id as string;
  const coParentUserId = coParent?.id as string;
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: parentUserId, role: 'primary_parent' },
    { familyId, userId: coParentUserId, role: 'co_parent' },
  ]);
  return { familyId, parentUserId, coParentUserId };
}

/** The outbound the follow-up sweep writes when the ask reaches the phone
 * (`followup/run.ts` `recordSend`) — category, template key and status verbatim. */
async function seedAsk(
  seeded: Seeded,
  options: { parentUserId?: string; createdAt?: Date; status?: 'queued' | 'failed' } = {},
): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId: seeded.familyId,
    parentUserId: options.parentUserId ?? seeded.parentUserId,
    channel: 'sms',
    direction: 'out',
    category: 'followup',
    templateKey: 'followup:activity',
    status: options.status ?? 'queued',
    createdAt: options.createdAt ?? ASKED_AT,
  });
}

async function seedDraftedApproval(seeded: Seeded): Promise<string> {
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId: seeded.familyId,
      source: 'channel',
      eventType: 'channel_message',
      dedupHash: `ask-open-${seeded.familyId}`,
    })
    .returning({ id: schema.events.id });
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event?.id as string,
      familyId: seeded.familyId,
      actionType: 'calendar_add',
      userVisibleState: 'drafted_for_approval',
      reviewerVerdict: 'approved',
      draftedAt: new Date('2026-09-15T22:00:00.000Z'),
      payload: { actionType: 'calendar_add', title: 'Tuesday swim' },
    })
    .returning({ id: schema.actions.id });
  return action?.id as string;
}

function fakeSpine(pending: PendingAction[]): ApprovalSpine & { approved: string[] } {
  const approved: string[] = [];
  return {
    approved,
    listPending: async () => pending,
    latestUndoable: async () => null,
    approve: async (_database, args) => {
      approved.push(args.actionId);
      return { ok: true };
    },
    decline: async () => ({ ok: true }),
    undo: async () => ({ ok: true }),
  };
}

function turn(seeded: Seeded, body: string): HandlerContext {
  return {
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    conversationId: '33333333-3333-4333-8333-333333333333',
    body,
    send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' }),
    now: NOW,
    resolved: null,
    openQuestions: () =>
      defaultOpenQuestionReader().open(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        now: NOW,
      }),
    inboundChannelMessageId: '44444444-4444-4444-8444-444444444444',
  };
}

describe('a bare "yes" while Hale is waiting to hear how an activity went', () => {
  it('does NOT execute a drafted approval — the swim question makes it ambiguous', async () => {
    const seeded = await seedFamily();
    const actionId = await seedDraftedApproval(seeded);
    await seedAsk(seeded);

    const spine = fakeSpine([
      { actionId, actionType: 'calendar_add', reviewerApproved: true },
    ]);
    const verdict = await approvalHandler(spine).handle(db.database, turn(seeded, 'yes'));

    expect(verdict.claimed).toBe(false);
    expect(spine.approved).toEqual([]);
  });

  /** The positive control the fix must not break: the ordinary path still works. */
  it('still executes the drafted approval when no ask is standing', async () => {
    const seeded = await seedFamily();
    const actionId = await seedDraftedApproval(seeded);

    const spine = fakeSpine([
      { actionId, actionType: 'calendar_add', reviewerApproved: true },
    ]);
    const verdict = await approvalHandler(spine).handle(db.database, turn(seeded, 'yes'));

    expect(verdict.claimed).toBe(true);
    expect(spine.approved).toEqual([actionId]);
  });
});

describe('the ask as a listed open question, through the production reader', () => {
  it('lists it, unsolicited and unanswerable in either polarity', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);

    const questions = await defaultOpenQuestionReader().open(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      now: NOW,
    });

    expect(
      questions.map((question) => ({
        kind: question.kind,
        askedAt: question.askedAt,
        solicited: question.solicited,
        answerable: question.answerable,
      })),
    ).toEqual([
      {
        kind: 'activity_followup_ask',
        askedAt: ASKED_AT,
        solicited: false,
        answerable: { yes: false, no: false },
      },
    ]);
    // Rule #1: the line goes to a model, so it carries no child name and no title.
    const listed = questions[0];
    expect(listed?.description).toBe('How an activity went');
    expect(listed?.subject).toBe('how that activity went');
  });

  it('closes the moment anything else goes out to that parent', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'nudge',
      templateKey: 'nudge:something-else',
      status: 'sent',
      createdAt: new Date(ASKED_AT.getTime() + 60_000),
    });

    expect(
      await activityFollowupAskOpen(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('answers as of `now` — a reply Hale has since answered was still an answer', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    const answeredAt = new Date(ASKED_AT.getTime() + 10 * 60_000);
    // Hale's own reply to the parent, five seconds after they wrote back. The router
    // persists one on EVERY coach turn, so by the time an hourly pass looks back at the
    // ask there is always something newer than it — and a reader that answered as of the
    // read rather than as of `now` would call every answered ask closed.
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      status: 'queued',
      createdAt: new Date(answeredAt.getTime() + 5_000),
    });

    expect(
      await activityFollowupAskOpen(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        now: answeredAt,
      }),
    ).toEqual({ id: expect.any(String), askedAt: ASKED_AT });
  });

  it('reads the ask that was standing at `now`, not tomorrow night’s', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    await seedAsk(seeded, { createdAt: new Date(ASKED_AT.getTime() + 2 * 60 * 60_000) });

    expect(
      await activityFollowupAskOpen(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        now: new Date(ASKED_AT.getTime() + 30 * 60_000),
      }),
    ).toEqual({ id: expect.any(String), askedAt: ASKED_AT });
  });

  it('does not stand for the co-parent — the question went to one phone', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);

    expect(
      await activityFollowupAskOpen(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.coParentUserId,
        now: NOW,
      }),
    ).toBeNull();
    // Positive control on the same rows: the parent it was sent to still has it open.
    expect(
      await activityFollowupAskOpen(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        now: NOW,
      }),
    ).not.toBeNull();
  });

  it('lapses at 08:00 local the next morning', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    const input = {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
    };

    // 07:59 America/Toronto the next morning — still standing.
    expect(
      await activityFollowupAskOpen(db.database, {
        ...input,
        now: new Date('2026-09-16T11:59:00.000Z'),
      }),
    ).not.toBeNull();
    // 08:01 — gone.
    expect(
      await activityFollowupAskOpen(db.database, {
        ...input,
        now: new Date('2026-09-16T12:01:00.000Z'),
      }),
    ).toBeNull();
  });

  it('is not open when the send failed — nobody was asked anything', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded, { status: 'failed' });

    expect(
      await activityFollowupAskOpen(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        now: NOW,
      }),
    ).toBeNull();
  });
});
