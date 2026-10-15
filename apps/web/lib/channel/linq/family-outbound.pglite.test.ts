import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { type TestDb, createTestDb, seedChild } from '~/lib/testing/pglite';
import { queueActivityDecisionFromReply } from './activity-decision';
import {
  deliverFamilyOutbound,
  familyOutboundTarget,
  flushGroupDecisionSyncs,
  noteGroupSyncConversation,
  queueGroupActivityDecision,
} from './family-outbound';
import { LINQ_GROUP_TRIGGER_PHRASE } from './group';

/**
 * A claimed group is the home channel. No group keeps the caller's door.
 * A 1:1 decision posts one sync bubble into the group and does not text SMS.
 */

const GROUP = 'chat-home';
const PERSONAL = 'chat-one-to-one';
const GROUP_MESSAGES = `https://api.linqapp.com/api/partner/v3/chats/${GROUP}/messages`;
const NOW = new Date('2026-09-24T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

function wire(): {
  fetch: typeof fetch;
  linqUrls: () => string[];
  twilioUrls: () => string[];
  bodies: () => string;
} {
  const linqUrls: string[] = [];
  const twilioUrls: string[] = [];
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('twilio.com')) twilioUrls.push(target);
    else linqUrls.push(target);
    if (init?.body) bodies.push(String(init.body));
    return new Response(JSON.stringify({ message: { id: 'msg-1' } }), { status: 201 });
  });
  return {
    fetch: fetchMock as unknown as typeof fetch,
    linqUrls: () => linqUrls,
    twilioUrls: () => twilioUrls,
    bodies: () => bodies.join('\n'),
  };
}

async function seed(chatId: string | null): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Barton + kids',
      provinceOrState: 'ON',
      postalCode: 'M6H2H9',
      linqGroupChatId: chatId,
    })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${family?.id}`, name: 'Barton' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId: parentUserId,
    role: 'primary_parent',
  });
  return { familyId, parentUserId };
}

describe('familyOutboundTarget', () => {
  it('returns the group when one is claimed', async () => {
    const seeded = await seed(GROUP);
    await expect(familyOutboundTarget(db.database, seeded.familyId)).resolves.toEqual({
      channel: 'group',
      chatId: GROUP,
      familyId: seeded.familyId,
    });
  });

  it('stays on the legacy door when the family has no group', async () => {
    const seeded = await seed(null);
    await expect(familyOutboundTarget(db.database, seeded.familyId)).resolves.toEqual({
      channel: 'legacy',
    });
  });
});

describe('deliverFamilyOutbound', () => {
  it('sends a scheduled-style body to the group and not to SMS', async () => {
    const seeded = await seed(GROUP);
    const legacy = new FakeTransport();
    const http = wire();
    const delivered = await deliverFamilyOutbound(db.database, {
      familyId: seeded.familyId,
      body: 'Richmond Hill rec opens Tuesday.',
      to: '+14165550100',
      legacy,
      fetch: http.fetch,
      shareGroupCap: false,
    });
    expect(delivered).toMatchObject({ status: 'sent', channel: 'imessage', chatId: GROUP });
    expect(legacy.sent).toEqual([]);
    expect(http.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(http.twilioUrls()).toEqual([]);
    expect(http.bodies()).toContain('Richmond Hill rec opens Tuesday.');
  });

  it('keeps a family without a group on the legacy transport', async () => {
    const seeded = await seed(null);
    const legacy = new FakeTransport();
    const http = wire();
    vi.stubGlobal('fetch', http.fetch);
    const delivered = await deliverFamilyOutbound(db.database, {
      familyId: seeded.familyId,
      body: 'Same nudge as before.',
      to: '+14165550100',
      legacy,
      fetch: http.fetch,
    });
    expect(delivered.status).toBe('sent');
    if (delivered.status === 'sent') expect(delivered.channel).toBe('sms');
    expect(legacy.bodies()).toEqual(['Same nudge as before.']);
    expect(http.linqUrls()).toEqual([]);
    expect(http.twilioUrls()).toEqual([]);
  });
});

describe('a 1:1 decision syncs the group', () => {
  it('waits until the 1:1 is quiet, then posts one picked line and not SMS', async () => {
    const seeded = await seed(GROUP);
    const http = wire();
    const queued = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: {
        decision: 'picked',
        activity: 'swim',
        kid: 'Maya',
        day: 'Tuesday',
        time: '4:00',
      },
      now: NOW,
    });
    expect(queued).toBe('queued');
    const early = await flushGroupDecisionSyncs(db.database, { now: NOW, fetch: http.fetch });
    expect(early.sent).toBe(0);
    expect(http.linqUrls()).toEqual([]);
    const settled = new Date(NOW.getTime() + 10 * 60 * 1000);
    const flushed = await flushGroupDecisionSyncs(db.database, {
      now: settled,
      fetch: http.fetch,
    });
    expect(flushed.sent).toBe(1);
    expect(http.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(http.twilioUrls()).toEqual([]);
    expect(http.bodies()).toContain('Quick sync: Barton picked swim for Maya, Tuesday at 4:00.');
    expect(http.bodies()).not.toMatch(/inbox|subject|@|booked/i);
    const [row] = await db.database
      .select({
        channel: schema.channelMessages.channel,
        providerChatId: schema.channelMessages.providerChatId,
        templateKey: schema.channelMessages.templateKey,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, seeded.familyId));
    expect(row).toMatchObject({
      channel: 'imessage',
      providerChatId: GROUP,
      templateKey: 'linq:group_sync',
    });
  });

  it('does not post a second bubble when the decision was already in the group', async () => {
    const seeded = await seed(GROUP);
    const http = wire();
    const result = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: GROUP,
      decision: {
        decision: 'passed',
        activity: 'swim',
        kid: 'Maya',
      },
      now: NOW,
    });
    expect(result).toBe('skipped');
    expect(http.linqUrls()).toEqual([]);
  });

  it('posts one bubble with every due line, including a pass', async () => {
    const seeded = await seed(GROUP);
    const http = wire();
    const decisions = [
      { decision: 'picked' as const, activity: 'swim', kid: 'Maya', day: 'Tuesday', time: '4:00' },
      { decision: 'passed' as const, activity: 'art', kid: 'Maya' },
      {
        decision: 'picked' as const,
        activity: 'music',
        kid: 'Leo',
        day: 'Wednesday',
        time: '5:00',
      },
      { decision: 'picked' as const, activity: 'dance', kid: 'Leo', day: 'Thursday', time: '6:00' },
    ];
    for (const [index, decision] of decisions.entries()) {
      await queueGroupActivityDecision(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        originChatId: PERSONAL,
        decision,
        now: new Date(NOW.getTime() + index * 1000),
      });
    }
    const flushed = await flushGroupDecisionSyncs(db.database, {
      now: new Date(NOW.getTime() + 3 * 1000 + 10 * 60 * 1000),
      fetch: http.fetch,
    });
    expect(flushed.sent).toBe(1);
    expect(http.linqUrls()).toEqual([GROUP_MESSAGES]);
    const body = http.bodies();
    expect(body).toContain('Quick sync: Barton picked swim for Maya, Tuesday at 4:00.');
    expect(body).toContain('Quick sync: Barton passed on art for Maya.');
    expect(body).toContain('Quick sync: Barton picked music for Leo, Wednesday at 5:00.');
    expect(body).toContain('Quick sync: Barton picked dance for Leo, Thursday at 6:00.');
    expect(body).not.toMatch(/booked/i);
    const waiting = await db.database
      .select({
        activity: schema.groupDecisionSync.activity,
        flushedAt: schema.groupDecisionSync.flushedAt,
      })
      .from(schema.groupDecisionSync);
    expect(waiting).toHaveLength(4);
    expect(waiting.every((row) => row.flushedAt !== null)).toBe(true);
  });

  it('uses the French template and waits out a later 1:1 reply', async () => {
    const seeded = await seed(GROUP);
    await db.database
      .update(schema.families)
      .set({ primaryLanguage: 'fr' })
      .where(eq(schema.families.id, seeded.familyId));
    const http = wire();
    await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: { decision: 'picked', activity: 'swim', kid: 'Maya', day: 'mardi', time: '16 h' },
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 5 * 60 * 1000);
    await noteGroupSyncConversation(db.database, {
      familyId: seeded.familyId,
      originChatId: PERSONAL,
      now: later,
    });
    const early = await flushGroupDecisionSyncs(db.database, {
      now: new Date(NOW.getTime() + 10 * 60 * 1000),
      fetch: http.fetch,
    });
    expect(early.sent).toBe(0);
    const flushed = await flushGroupDecisionSyncs(db.database, {
      now: new Date(later.getTime() + 10 * 60 * 1000),
      fetch: http.fetch,
    });
    expect(flushed.sent).toBe(1);
    expect(http.bodies()).toContain('Pour info: Barton a choisi swim pour Maya, mardi a 16 h.');
  });

  it('does not queue a question or an incomplete pick', async () => {
    const seeded = await seed(GROUP);
    const skipped = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: { decision: 'picked', activity: 'swim', kid: 'Maya' },
      now: NOW,
    });
    expect(skipped).toBe('skipped');
  });

  it("never names a 13+ child in the group, at queue or at flush, while a younger child's pick still goes", async () => {
    const seeded = await seed(GROUP);
    await seedChild(db.database, seeded.familyId, 'Noor', 14 * 12, undefined, NOW);
    await seedChild(db.database, seeded.familyId, 'Maya', 4 * 12, undefined, NOW);
    const http = wire();
    const teen = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: {
        decision: 'picked',
        activity: 'hockey',
        kid: 'Noor',
        day: 'Monday',
        time: '6:00',
      },
      now: NOW,
    });
    expect(teen).toBe('skipped');
    // A row already waiting — queued before the gate, or before a birthday — is still held back.
    await db.database.insert(schema.groupDecisionSync).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: 'passed',
      activity: 'debate',
      kid: 'Noor',
      flushAfter: NOW,
      createdAt: NOW,
    });
    const younger = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: { decision: 'picked', activity: 'swim', kid: 'Maya', day: 'Tuesday', time: '4:00' },
      now: NOW,
    });
    expect(younger).toBe('queued');
    const flushed = await flushGroupDecisionSyncs(db.database, {
      now: new Date(NOW.getTime() + 10 * 60 * 1000),
      fetch: http.fetch,
    });
    expect(flushed.sent).toBe(1);
    const body = http.bodies();
    expect(body).toContain('Quick sync: Barton picked swim for Maya, Tuesday at 4:00.');
    expect(body).not.toContain('Noor');
    expect(body).not.toMatch(/hockey|debate/);
  });

  it('queues one row for a repeated pick, and does not sync it again the same day', async () => {
    const seeded = await seed(GROUP);
    const http = wire();
    const decision = {
      decision: 'picked' as const,
      activity: 'swim',
      kid: 'Maya',
      day: 'Tuesday',
      time: '4:00',
    };
    await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision,
      now: NOW,
    });
    const again = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision,
      now: new Date(NOW.getTime() + 60 * 1000),
    });
    expect(again).toBe('queued');
    const rows = await db.database
      .select({ id: schema.groupDecisionSync.id })
      .from(schema.groupDecisionSync);
    expect(rows).toHaveLength(1);
    const settled = new Date(NOW.getTime() + 11 * 60 * 1000);
    await flushGroupDecisionSyncs(db.database, { now: settled, fetch: http.fetch });
    const repeat = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision,
      now: new Date(settled.getTime() + 60 * 1000),
    });
    expect(repeat).toBe('skipped');
    const later = await flushGroupDecisionSyncs(db.database, {
      now: new Date(settled.getTime() + 20 * 60 * 1000),
      fetch: http.fetch,
    });
    expect(later.sent).toBe(0);
    expect(http.linqUrls()).toEqual([GROUP_MESSAGES]);
  });

  it('holds through quiet hours, then retries a failed send once', async () => {
    const seeded = await seed(GROUP);
    const quiet = new Date('2026-09-25T02:30:00.000Z');
    await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: {
        decision: 'passed',
        activity: 'art',
        kid: 'Maya',
      },
      now: new Date(quiet.getTime() - 11 * 60 * 1000),
    });
    const http = wire();
    const heldQuiet = await flushGroupDecisionSyncs(db.database, { now: quiet, fetch: http.fetch });
    expect(heldQuiet).toEqual({ sent: 0, held: 1 });
    expect(http.linqUrls()).toEqual([]);
    const morning = new Date('2026-09-25T12:30:00.000Z');
    const sent = await flushGroupDecisionSyncs(db.database, { now: morning, fetch: http.fetch });
    expect(sent.sent).toBe(1);
    expect(http.bodies()).toContain('Quick sync: Barton passed on art for Maya.');

    const failing = vi.fn(async () => {
      throw new Error('linq down');
    });
    await db.exec('delete from channel_messages');
    await db.exec('delete from group_decision_sync');
    await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: {
        decision: 'picked',
        activity: 'swim',
        kid: 'Maya',
        day: 'Friday',
        time: '3:00',
      },
      now: NOW,
    });
    const failed = await flushGroupDecisionSyncs(db.database, {
      now: new Date(NOW.getTime() + 10 * 60 * 1000),
      fetch: failing as unknown as typeof fetch,
    });
    expect(failed.sent).toBe(0);
    const [unflushed] = await db.database
      .select({ flushedAt: schema.groupDecisionSync.flushedAt })
      .from(schema.groupDecisionSync);
    expect(unflushed?.flushedAt).toBeNull();
    const retry = wire();
    const recovered = await flushGroupDecisionSyncs(db.database, {
      now: new Date(NOW.getTime() + 20 * 60 * 1000),
      fetch: retry.fetch,
    });
    expect(recovered.sent).toBe(1);
    expect(retry.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(retry.bodies()).toContain('Quick sync: Barton picked swim for Maya, Friday at 3:00.');
  });

  it('does not mark a not-yet-due row flushed with the sitting', async () => {
    const seeded = await seed(GROUP);
    const http = wire();
    await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: {
        decision: 'passed',
        activity: 'art',
        kid: 'Maya',
      },
      now: NOW,
    });
    await db.database.insert(schema.groupDecisionSync).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: 'picked',
      activity: 'music',
      kid: 'Leo',
      day: 'Thursday',
      time: '6:00',
      flushAfter: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
      createdAt: new Date(NOW.getTime() + 1000),
    });
    await flushGroupDecisionSyncs(db.database, {
      now: new Date(NOW.getTime() + 10 * 60 * 1000),
      fetch: http.fetch,
    });
    const rows = await db.database
      .select({
        activity: schema.groupDecisionSync.activity,
        flushedAt: schema.groupDecisionSync.flushedAt,
      })
      .from(schema.groupDecisionSync);
    const art = rows.find((row) => row.activity === 'art');
    const music = rows.find((row) => row.activity === 'music');
    expect(art?.flushedAt).not.toBeNull();
    expect(music?.flushedAt).toBeNull();
    expect(http.bodies()).not.toContain('music');
  });

  it('reads a 1:1 sentence only when the kid is on the family', async () => {
    const seeded = await seed(GROUP);
    await db.database.insert(schema.children).values({
      familyId: seeded.familyId,
      name: 'Maya',
      dateOfBirth: '2022-04-01',
    });
    const queued = await queueActivityDecisionFromReply(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      body: 'picked swim for maya, Tuesday at 4:00',
      now: NOW,
    });
    expect(queued).toBe('queued');
    const [row] = await db.database
      .select({ kid: schema.groupDecisionSync.kid, activity: schema.groupDecisionSync.activity })
      .from(schema.groupDecisionSync);
    expect(row).toEqual({ kid: 'Maya', activity: 'swim' });
    const unknown = await queueActivityDecisionFromReply(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      body: 'picked swim for Tuesday, Tuesday at 4:00',
      now: NOW,
    });
    expect(unknown).toBe('skipped');
    const question = await queueActivityDecisionFromReply(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      body: 'picked swim for Maya, Tuesday at 4:00?',
      now: NOW,
    });
    expect(question).toBe('skipped');
  });
});

describe('quiet hours and co-parent asks', () => {
  const QUIET = new Date('2026-09-25T02:30:00.000Z');

  it('holds a discretionary send in quiet hours and still sends rec-morning', async () => {
    const seeded = await seed(GROUP);
    const legacy = new FakeTransport();
    const http = wire();
    const held = await deliverFamilyOutbound(db.database, {
      familyId: seeded.familyId,
      body: "Heads up: Barton added Maya's swim, Tuesday at 4:00.",
      to: '+14165550100',
      legacy,
      fetch: http.fetch,
      now: QUIET,
      bubbleKind: 'discretionary',
    });
    expect(held).toEqual({ status: 'held', reason: 'quiet_hours' });
    expect(http.linqUrls()).toEqual([]);
    const morning = await deliverFamilyOutbound(db.database, {
      familyId: seeded.familyId,
      body: 'Richmond Hill opens at 6:30.',
      to: '+14165550100',
      legacy,
      fetch: http.fetch,
      now: QUIET,
      bubbleKind: 'rec_morning',
    });
    expect(morning).toMatchObject({ status: 'sent', chatId: GROUP });
    expect(legacy.sent).toEqual([]);
  });

  it('does not send the co-parent ask into a claimed group', async () => {
    const seeded = await seed(GROUP);
    const legacy = new FakeTransport();
    const http = wire();
    const delivered = await deliverFamilyOutbound(db.database, {
      familyId: seeded.familyId,
      // The model writes the ask; code appends the trigger phrase the hold reads.
      body: `Group chat with the other parent? (test fixture) send: ${LINQ_GROUP_TRIGGER_PHRASE.en}`,
      to: '+14165550100',
      legacy,
      fetch: http.fetch,
      now: NOW,
      bubbleKind: 'uncapped',
    });
    expect(delivered).toEqual({ status: 'held', reason: 'coparent_ask' });
    expect(http.linqUrls()).toEqual([]);
    expect(legacy.sent).toEqual([]);
  });
});

describe('a family without a group does not sync', () => {
  it('does nothing for a family without a group', async () => {
    const seeded = await seed(null);
    const http = wire();
    const result = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: {
        decision: 'picked',
        activity: 'swim',
        kid: 'Maya',
        day: 'Tuesday',
        time: '4:00',
      },
      now: NOW,
    });
    expect(result).toBe('skipped');
    expect(http.linqUrls()).toEqual([]);
  });
});

describe('group onboarding v2: the roster decides what the group may hear', () => {
  type MemberSeed = {
    status: (typeof schema.linqGroupRosterMembers.$inferInsert)['status'];
    confirmedRole?: (typeof schema.linqGroupRosterMembers.$inferInsert)['confirmedRole'];
  };

  async function seedRoster(
    familyId: string,
    status: (typeof schema.linqGroupRosters.$inferInsert)['status'],
    members: MemberSeed[],
  ): Promise<string> {
    const [roster] = await db.database
      .insert(schema.linqGroupRosters)
      .values({ chatId: GROUP, familyId, source: 'added_to_existing', status })
      .returning({ id: schema.linqGroupRosters.id });
    const rosterId = roster?.id as string;
    let n = 0;
    for (const member of members) {
      n += 1;
      await db.database.insert(schema.linqGroupRosterMembers).values({
        rosterId,
        chatId: GROUP,
        phoneE164Encrypted: `enc-${n}`,
        phoneE164Hash: `hash-${n}`,
        status: member.status,
        confirmedRole: member.confirmedRole ?? null,
      });
    }
    return rosterId;
  }

  async function heldAudits(familyId: string) {
    const rows = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken, targetId: schema.auditLog.targetId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    return rows.filter((row) => row.actionTaken === 'linq_group_sends_held');
  }

  beforeEach(() => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  });

  it('keeps a proactive send 1:1 while anyone in the chat has not said who they are, and audits the hold once', async () => {
    const seeded = await seed(GROUP);
    const rosterId = await seedRoster(seeded.familyId, 'partial', [
      { status: 'known_parent' },
      { status: 'confirmed', confirmedRole: 'co_parent' },
      { status: 'asked' },
    ]);

    const first = await familyOutboundTarget(db.database, seeded.familyId, {
      contentClass: 'schedule',
    });
    const second = await familyOutboundTarget(db.database, seeded.familyId, {
      contentClass: 'pickup_duty',
    });

    expect(first).toEqual({ channel: 'legacy', reason: 'group_roles_unconfirmed' });
    expect(second).toEqual({ channel: 'legacy', reason: 'group_roles_unconfirmed' });
    expect(await heldAudits(seeded.familyId)).toEqual([
      { actionTaken: 'linq_group_sends_held', targetId: rosterId },
    ]);
  });

  it('with a grandparent confirmed, lets schedule into the group and keeps registration 1:1', async () => {
    const seeded = await seed(GROUP);
    await seedRoster(seeded.familyId, 'confirmed', [
      { status: 'known_parent' },
      { status: 'confirmed', confirmedRole: 'grandparent' },
    ]);

    await expect(
      familyOutboundTarget(db.database, seeded.familyId, { contentClass: 'schedule' }),
    ).resolves.toEqual({ channel: 'group', chatId: GROUP, familyId: seeded.familyId });
    await expect(
      familyOutboundTarget(db.database, seeded.familyId, { contentClass: 'registration' }),
    ).resolves.toEqual({ channel: 'legacy', reason: 'group_audience_refused' });
    await expect(
      familyOutboundTarget(db.database, seeded.familyId, { contentClass: 'health' }),
    ).resolves.toEqual({ channel: 'legacy', reason: 'group_audience_refused' });
    expect(await heldAudits(seeded.familyId)).toEqual([]);
  });

  it('keeps a send that names no content class out of a confirmed group', async () => {
    const seeded = await seed(GROUP);
    await seedRoster(seeded.familyId, 'confirmed', [
      { status: 'known_parent' },
      { status: 'confirmed', confirmedRole: 'co_parent' },
    ]);

    await expect(familyOutboundTarget(db.database, seeded.familyId)).resolves.toEqual({
      channel: 'legacy',
      reason: 'group_audience_refused',
    });
    await expect(
      familyOutboundTarget(db.database, seeded.familyId, { contentClass: 'event_logistics' }),
    ).resolves.toEqual({ channel: 'group', chatId: GROUP, familyId: seeded.familyId });
  });

  it('goes quiet when someone who is not family stays in a confirmed chat', async () => {
    const seeded = await seed(GROUP);
    await seedRoster(seeded.familyId, 'confirmed', [
      { status: 'known_parent' },
      { status: 'confirmed', confirmedRole: 'grandparent' },
      { status: 'not_family' },
    ]);

    await expect(
      familyOutboundTarget(db.database, seeded.familyId, { contentClass: 'schedule' }),
    ).resolves.toEqual({ channel: 'legacy', reason: 'group_audience_empty' });
  });

  it('flag off: the chat id alone still decides, whatever the roster says', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'false');
    const seeded = await seed(GROUP);
    await seedRoster(seeded.familyId, 'roles_proposed', [
      { status: 'known_parent' },
      { status: 'asked' },
    ]);

    await expect(
      familyOutboundTarget(db.database, seeded.familyId, { contentClass: 'registration' }),
    ).resolves.toEqual({ channel: 'group', chatId: GROUP, familyId: seeded.familyId });
    expect(await heldAudits(seeded.familyId)).toEqual([]);
  });
});
