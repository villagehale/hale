import { createHmac, randomUUID } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMediaPart } from '~/lib/channel/inbound-media';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import { LINQ_GROUP_TRIGGER_PHRASE } from '~/lib/channel/linq/group';
import { handleLinqInboundRequest } from '~/lib/channel/linq/inbound';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  BROWSER_USE_LIVE_VIEW_HOST,
  LIVE_VIEW_LINK_WITHHELD,
} from '~/lib/signup/browser-use/live-view';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  BURST_MAX_HOLD_MS,
  BURST_MAX_MEMBERS,
  type BurstPlan,
  type BurstPorts,
  TURN_FOLDED_ACTION,
  foldIntoAnchor,
  foldedMemberIds,
  mergeBurstContext,
  pendingBurst,
  planBurst,
} from './burst';
import type { BurstReaderInput, BurstReading, InboundBurstReader } from './burst-reader';
import type { InboundContext } from './route';
import { auditTurnLedger } from './wiring';

/**
 * Back-to-back texts, read as one turn (phase 1: settle, read, fold, 1:1 only).
 *
 * The real DDL, because the planner's whole job is a SCOPED read and a CLAIM: which rows
 * count as "this parent's untouched texts in this chat", and which attempt gets to fold
 * one. A fake db that does not evaluate `where` would pass every scope test below on
 * nothing. The clock and the sleep are fakes, so the settle's timing is exact. Which
 * texts belong together is the model's call (run-inbound-burst-eval.mjs); here the
 * reader is scripted and the assertions are on what the planner does with its answer.
 */

let db: TestDb;
const T0 = Date.parse('2026-11-11T15:00:00.000Z');
const CHAT = 'chat-direct-1';
let clock = T0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  clock = T0;
});

interface Family {
  familyId: string;
  parentUserId: string;
}

let seq = 0;

async function text(
  fam: Family,
  body: string,
  atMs: number,
  extra: Partial<typeof schema.channelMessages.$inferInsert> = {},
): Promise<string> {
  seq += 1;
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId: `prov-${seq}-${randomUUID()}`,
      providerChatId: CHAT,
      status: 'delivered',
      body,
      inGroup: false,
      createdAt: new Date(atMs),
      ...extra,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('no row');
  return row.id;
}

function jobFor(
  fam: Family,
  channelMessageId: string,
  overrides: Partial<ChannelMessageReceivedJob> = {},
): ChannelMessageReceivedJob {
  return {
    family_id: fam.familyId,
    parent_user_id: fam.parentUserId,
    channel_message_id: channelMessageId,
    provider_message_id: 'prov',
    received_at: new Date(T0).toISOString(),
    in_group: false,
    ...overrides,
  };
}

function scriptedReader(
  answer: (input: BurstReaderInput) => BurstReading,
): InboundBurstReader & { calls: BurstReaderInput[] } {
  const reader = {
    calls: [] as BurstReaderInput[],
    async read(input: BurstReaderInput) {
      reader.calls.push(input);
      return answer(input);
    },
  };
  return reader;
}

const foldAll = (input: BurstReaderInput): BurstReading => ({
  status: 'read',
  groups: [input.messages.map((m) => m.ref)],
});

const keepApart = (input: BurstReaderInput): BurstReading => ({
  status: 'read',
  groups: input.messages.map((m) => [m.ref]),
});

function ports(
  reader: InboundBurstReader,
  options: {
    enabled?: boolean;
    arrivals?: Array<{ at: number; insert: () => Promise<unknown> }>;
  } = {},
): BurstPorts & { sleeps: number[]; logs: unknown[][] } {
  const sleeps: number[] = [];
  const logs: unknown[][] = [];
  const arrivals = [...(options.arrivals ?? [])];
  return {
    enabled: () => options.enabled ?? true,
    reader,
    now: () => new Date(clock),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      while (arrivals.length > 0 && (arrivals[0]?.at ?? Number.POSITIVE_INFINITY) <= clock) {
        await arrivals.shift()?.insert();
      }
    },
    log: {
      info: (...args: unknown[]) => logs.push(args),
      warn: (...args: unknown[]) => logs.push(args),
      error: (...args: unknown[]) => logs.push(args),
    } as unknown as Pick<Console, 'info' | 'warn' | 'error'>,
    sleeps,
    logs,
  };
}

async function foldRows(memberId: string) {
  return db.database
    .select({ after: schema.auditLog.after, audience: schema.auditLog.audience })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, TURN_FOLDED_ACTION),
        eq(schema.auditLog.targetId, memberId),
      ),
    );
}

async function claimRows(memberId: string) {
  return db.database
    .select({ id: schema.channelTurnAnswerClaims.id })
    .from(schema.channelTurnAnswerClaims)
    .where(eq(schema.channelTurnAnswerClaims.channelMessageId, memberId));
}

function anchorOf(plan: BurstPlan): Extract<BurstPlan, { kind: 'anchor' }> {
  if (plan.kind !== 'anchor') throw new Error(`expected an anchor plan, got ${plan.kind}`);
  return plan;
}

describe('the settle', () => {
  it('a lone text picked up 2.5s after it arrived costs no sleep and no reader', async () => {
    const fam = await seedFamily(db.database, 'Lone Late');
    const m1 = await text(fam, 'is swim on thursday', T0);
    clock = T0 + 2_500;
    const reader = scriptedReader(foldAll);
    const p = ports(reader);

    const plan = await planBurst(db.database, p, jobFor(fam, m1), 'fresh');

    expect(plan).toEqual({ kind: 'lone', waitedMs: 0, why: 'alone' });
    expect(p.sleeps).toEqual([]);
    expect(reader.calls).toHaveLength(0);
  });

  it('positive control: two texts inside the window do call the reader', async () => {
    const fam = await seedFamily(db.database, 'Two Texts');
    const m1 = await text(fam, 'is swim on thursday', T0);
    await text(fam, 'at 4?', T0 + 500);
    clock = T0 + 3_000;
    const reader = scriptedReader(keepApart);

    await planBurst(db.database, ports(reader), jobFor(fam, m1), 'fresh');

    expect(reader.calls).toHaveLength(1);
  });

  it('a lone text picked up at 1s waits out the rest of the quiet, 1.5s, then goes alone', async () => {
    const fam = await seedFamily(db.database, 'Lone Early');
    const m1 = await text(fam, 'is swim on thursday', T0);
    clock = T0 + 1_000;
    const reader = scriptedReader(foldAll);
    const p = ports(reader);

    const plan = await planBurst(db.database, p, jobFor(fam, m1), 'fresh');

    expect(plan).toEqual({ kind: 'lone', waitedMs: 1_500, why: 'alone' });
    expect(p.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(1_500);
    expect(reader.calls).toHaveLength(0);
  });

  it('a stream that never goes quiet is cut at the hold ceiling, measured from the settle start', async () => {
    const fam = await seedFamily(db.database, 'Stream');
    const m1 = await text(fam, 'ok so', T0);
    const late: string[] = [];
    const arrivals = [2_000, 4_000, 6_000, 8_000, 10_000].map((offset) => ({
      at: T0 + offset,
      insert: async () => {
        late.push(await text(fam, `part ${offset}`, T0 + offset));
      },
    }));
    const p = ports(scriptedReader(foldAll), { arrivals });

    const plan = anchorOf(await planBurst(db.database, p, jobFor(fam, m1), 'fresh'));

    expect(plan.waitedMs).toBe(BURST_MAX_HOLD_MS);
    // Inside the hold: the anchor and the texts at 2, 4, 6 and 8 seconds.
    expect(plan.members.map((m) => m.channelMessageId)).toEqual([m1, ...late.slice(0, 4)]);
    // Arrived after the hold: never seen by this turn, still its own.
    expect(late).toHaveLength(4);
  });
});

describe('reading and folding', () => {
  it('folds what the reader groups with the anchor: a claim and a fold row per member', async () => {
    const fam = await seedFamily(db.database, 'Correction');
    const conversation = await db.database
      .insert(schema.conversations)
      .values({ familyId: fam.familyId, noteKey: channelSmsNoteKey(fam.parentUserId) })
      .returning({ id: schema.conversations.id });
    await db.database.insert(schema.messages).values({
      conversationId: conversation[0]?.id ?? '',
      role: 'assistant',
      content: 'What budget should I look within?',
    });
    const m1 = await text(fam, '$600 budget for a fall program', T0);
    const m2 = await text(fam, '$900', T0 + 800);
    clock = T0 + 4_000;
    const reader = scriptedReader(foldAll);

    const plan = anchorOf(await planBurst(db.database, ports(reader), jobFor(fam, m1), 'fresh'));

    expect(plan.members.map((m) => m.channelMessageId)).toEqual([m1, m2]);
    expect(plan.members.map((m) => m.body)).toEqual(['$600 budget for a fall program', '$900']);
    expect(plan.replyTo.channelMessageId).toBe(m2);
    expect(plan.read).toBe('read');
    expect(reader.calls[0]).toEqual({
      previousHaleLine: 'What budget should I look within?',
      messages: [
        { ref: 'm1', text: '$600 budget for a fall program', attachments: [] },
        { ref: 'm2', text: '$900', attachments: [] },
      ],
    });
    expect(await claimRows(m2)).toHaveLength(1);
    // About one parent's texts: tagged to that parent (VIL-635), never a plain family row.
    expect(await foldRows(m2)).toEqual([
      { after: { into: m1, read: 'read' }, audience: fam.parentUserId },
    ]);
    // The anchor is not folded into anything.
    expect(await foldRows(m1)).toEqual([]);
    const ledger = auditTurnLedger(db.database);
    expect(await ledger.stageOf({ familyId: fam.familyId, channelMessageId: m2 })).toBe('folded');
    expect(await ledger.stageOf({ familyId: fam.familyId, channelMessageId: m1 })).toBe('fresh');
  });

  it('leaves texts the reader keeps apart alone: no fold rows, each its own turn', async () => {
    const fam = await seedFamily(db.database, 'Two Asks');
    const m1 = await text(fam, 'is swim still on thursday?', T0);
    const m2 = await text(fam, 'can you find a saturday art class', T0 + 600);
    clock = T0 + 4_000;

    const plan = await planBurst(
      db.database,
      ports(scriptedReader(keepApart)),
      jobFor(fam, m1),
      'fresh',
    );

    expect(plan).toEqual({ kind: 'lone', waitedMs: 0, why: 'kept_apart' });
    expect(await claimRows(m2)).toEqual([]);
    expect(await foldRows(m2)).toEqual([]);
    const ledger = auditTurnLedger(db.database);
    expect(await ledger.stageOf({ familyId: fam.familyId, channelMessageId: m2 })).toBe('fresh');
  });

  it('folds only the anchor’s own group; the rest wait for their own job', async () => {
    const fam = await seedFamily(db.database, 'Three');
    const m1 = await text(fam, 'find piano for Ada', T0);
    const m2 = await text(fam, 'is swim on thursday', T0 + 400);
    const m3 = await text(fam, 'make that guitar not piano', T0 + 800);
    clock = T0 + 4_000;
    const reader = scriptedReader(() => ({ status: 'read', groups: [['m1', 'm3'], ['m2']] }));

    const plan = anchorOf(await planBurst(db.database, ports(reader), jobFor(fam, m1), 'fresh'));

    expect(plan.members.map((m) => m.channelMessageId)).toEqual([m1, m3]);
    expect(plan.replyTo.channelMessageId).toBe(m3);
    expect(await foldRows(m2)).toEqual([]);
    // m2's own job re-reads itself plus newer untouched texts: m3 is folded, so it is alone.
    const second = await planBurst(db.database, ports(reader), jobFor(fam, m2), 'fresh');
    expect(second).toEqual({ kind: 'lone', waitedMs: 0, why: 'alone' });
  });

  it('reads everything as one turn when the reader cannot answer, and names why', async () => {
    const fam = await seedFamily(db.database, 'Reader Down');
    const m1 = await text(fam, 'private words one', T0);
    const m2 = await text(fam, 'private words two', T0 + 300);
    clock = T0 + 4_000;
    const p = ports(scriptedReader(() => ({ status: 'unavailable', reason: 'invalid_partition' })));

    const plan = anchorOf(await planBurst(db.database, p, jobFor(fam, m1), 'fresh'));

    expect(plan.members.map((m) => m.channelMessageId)).toEqual([m1, m2]);
    expect(plan.read).toBe('reader_unavailable');
    expect(await foldRows(m2)).toEqual([
      { after: { into: m1, read: 'reader_unavailable' }, audience: fam.parentUserId },
    ]);
    const logged = JSON.stringify(p.logs);
    expect(logged).toContain('invalid_partition');
    expect(logged).toContain(m1);
    // Positive control above; and never the parent's words (rule #1).
    expect(logged).not.toContain('private words');
  });

  it('a live-view link never reaches the reader or a member, first read or rebuilt', async () => {
    const fam = await seedFamily(db.database, 'Live View');
    const link = `https://${BROWSER_USE_LIVE_VIEW_HOST}/s/abc123?token=xyz`;
    const m1 = await text(fam, 'can you finish the swim signup', T0);
    const m2 = await text(fam, `it is stuck here ${link}`, T0 + 500);
    clock = T0 + 4_000;
    const reader = scriptedReader(foldAll);

    const plan = anchorOf(await planBurst(db.database, ports(reader), jobFor(fam, m1), 'fresh'));
    const rebuilt = anchorOf(
      await planBurst(db.database, ports(scriptedReader(foldAll)), jobFor(fam, m1), 'deferred'),
    );

    const withheld = `it is stuck here ${LIVE_VIEW_LINK_WITHHELD}`;
    expect(reader.calls[0]?.messages.map((m) => m.text)).toEqual([
      'can you finish the swim signup',
      withheld,
    ]);
    expect(plan.members.map((m) => m.body)).toEqual(['can you finish the swim signup', withheld]);
    expect(rebuilt.members.map((m) => m.body)).toEqual([
      'can you finish the swim signup',
      withheld,
    ]);
    expect(JSON.stringify([reader.calls, plan, rebuilt])).not.toContain(BROWSER_USE_LIVE_VIEW_HOST);
    expect(m2).toBe(plan.members[1]?.channelMessageId);
  });

  it('collects at most BURST_MAX_MEMBERS texts; the rest stay fresh', async () => {
    const fam = await seedFamily(db.database, 'Many');
    const ids: string[] = [];
    for (let i = 0; i < BURST_MAX_MEMBERS + 2; i += 1) {
      ids.push(await text(fam, `t${i}`, T0 + i * 100));
    }
    clock = T0 + 5_000;
    const [anchor] = ids;
    if (!anchor) throw new Error('no anchor');

    const plan = anchorOf(
      await planBurst(db.database, ports(scriptedReader(foldAll)), jobFor(fam, anchor), 'fresh'),
    );

    expect(plan.members.map((m) => m.channelMessageId)).toEqual(ids.slice(0, BURST_MAX_MEMBERS));
    const ledger = auditTurnLedger(db.database);
    for (const id of ids.slice(BURST_MAX_MEMBERS)) {
      expect(await ledger.stageOf({ familyId: fam.familyId, channelMessageId: id })).toBe('fresh');
    }
  });

  it('a member another attempt already claimed is dropped, never folded twice', async () => {
    const fam = await seedFamily(db.database, 'Raced');
    const m1 = await text(fam, 'a', T0);
    const m2 = await text(fam, 'b', T0 + 200);
    const m3 = await text(fam, 'c', T0 + 400);
    await db.database.insert(schema.channelTurnAnswerClaims).values({ channelMessageId: m2 });

    const won = await foldIntoAnchor(db.database, {
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      anchorId: m1,
      memberIds: [m2, m3],
      read: 'read',
    });

    expect(won).toEqual([m3]);
    expect(await foldRows(m2)).toEqual([]);
    expect(await claimRows(m2)).toHaveLength(1);
    expect(await foldRows(m3)).toHaveLength(1);
  });
});

describe('what counts as this parent’s burst', () => {
  it('never collects a co-parent’s, a group’s, another chat’s or channel’s, an older, or a touched text', async () => {
    const fam = await seedFamily(db.database, 'Scope');
    const [coParent] = await db.database
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Co Parent' })
      .returning({ id: schema.users.id });
    if (!coParent) throw new Error('no co-parent');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: fam.familyId, userId: coParent.id, role: 'co_parent' });
    const other = await seedFamily(db.database, 'Other Family');

    await text(fam, 'older', T0 - 1_000);
    const anchor = await text(fam, 'anchor', T0);
    await text({ familyId: fam.familyId, parentUserId: coParent.id }, 'co-parent', T0 + 100);
    await text(fam, 'group', T0 + 200, { inGroup: true, providerChatId: 'chat-group' });
    await text(fam, 'unknown group bit', T0 + 250, { inGroup: null });
    await text(fam, 'other chat', T0 + 300, { providerChatId: 'chat-direct-2' });
    await text(fam, 'other channel', T0 + 400, { channel: 'sms', providerChatId: null });
    await text(other, 'other family', T0 + 450);
    await text(fam, 'outbound', T0 + 500, { direction: 'out' });
    const answered = await text(fam, 'answered', T0 + 600);
    await db.database.insert(schema.channelTurnAnswerClaims).values({ channelMessageId: answered });
    const deferred = await text(fam, 'deferred', T0 + 700);
    await db.database.insert(schema.auditLog).values({
      familyId: fam.familyId,
      actor: fam.parentUserId,
      actionTaken: 'sms_turn_deferred',
      targetTable: 'channel_messages',
      targetId: deferred,
    });
    const member = await text(fam, 'member', T0 + 800);

    const pending = await pendingBurst(
      db.database,
      { familyId: fam.familyId, parentUserId: fam.parentUserId, channelMessageId: anchor },
      BURST_MAX_MEMBERS,
    );

    expect(pending.map((m) => m.body)).toEqual(['anchor', 'member']);
    expect(pending.map((m) => m.channelMessageId)).toEqual([anchor, member]);
  });

  it('never collects a 1:1 text the Linq door already answered itself', async () => {
    const secret = Buffer.alloc(32, 9);
    const phone = '+14165550177';
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubEnv('LINQ_FROM_E164', '+14165550100');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${secret.toString('base64')}`);
    try {
      const fam = await seedFamily(db.database, 'Door Answered');
      await db.database.insert(schema.parentChannels).values({
        userId: fam.parentUserId,
        familyId: fam.familyId,
        kind: 'sms',
        phoneE164Encrypted: encryptString(phone),
        phoneE164Hash: phoneBlindIndex(phone),
        verifiedAt: new Date(),
      });
      const anchor = await text(fam, 'find a swim class for Milo', Date.now() - 60_000);

      const sentAt = new Date();
      const ts = String(Math.floor(sentAt.getTime() / 1000));
      const raw = JSON.stringify({
        api_version: 'v3',
        webhook_version: '2026-02-03',
        event_type: 'message.received',
        event_id: 'evt_burst_door',
        created_at: sentAt.toISOString(),
        data: {
          chat: { id: CHAT, is_group: false },
          id: randomUUID(),
          direction: 'inbound',
          sender_handle: { handle: phone, is_me: false },
          parts: [{ type: 'text', value: LINQ_GROUP_TRIGGER_PHRASE.en }],
          sent_at: sentAt.toISOString(),
          service: 'iMessage',
        },
      });
      const mac = createHmac('sha256', secret)
        .update(`evt_burst_door.${ts}.${raw}`)
        .digest('base64');
      const jobs: unknown[] = [];
      const res = await handleLinqInboundRequest(
        new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'webhook-id': 'evt_burst_door',
            'webhook-timestamp': ts,
            'webhook-signature': `v1,${mac}`,
          },
          body: raw,
        }),
        {
          database: db.database,
          intake: () => {
            throw new Error('the trigger in a 1:1 is not intake');
          },
          enqueue: async (job: unknown) => {
            jobs.push(job);
          },
          log: { info: () => {}, warn: () => {}, error: () => {} },
          countOutcome: async () => {},
          now: () => sentAt,
          markRead: async () => ({ status: 'accepted' }),
          sendGroupText: async () => ({ providerMessageId: `out-${randomUUID()}` }),
        } as unknown as Parameters<typeof handleLinqInboundRequest>[1],
      );
      await expect(res.json()).resolves.toMatchObject({ outcome: 'group_trigger_in_1to1' });
      expect(jobs).toEqual([]);
      const doorRows = await db.database
        .select({ id: schema.channelMessages.id })
        .from(schema.channelMessages)
        .where(
          and(
            eq(schema.channelMessages.familyId, fam.familyId),
            eq(schema.channelMessages.body, LINQ_GROUP_TRIGGER_PHRASE.en),
          ),
        );
      expect(doorRows).toHaveLength(1);
      const later = await text(fam, 'on saturdays', Date.now() + 1_000);

      const pending = await pendingBurst(
        db.database,
        { familyId: fam.familyId, parentUserId: fam.parentUserId, channelMessageId: anchor },
        BURST_MAX_MEMBERS,
      );

      // Positive control: a plain text after the door's row is still collected.
      expect(pending.map((m) => m.channelMessageId)).toEqual([anchor, later]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('a re-driven anchor', () => {
  it('rebuilds its burst from the fold rows: no settle, no reader', async () => {
    const fam = await seedFamily(db.database, 'Redrive');
    const m1 = await text(fam, 'swim thursday at 4', T0);
    const m2 = await text(fam, 'sorry 5', T0 + 700);
    clock = T0 + 4_000;
    anchorOf(
      await planBurst(db.database, ports(scriptedReader(foldAll)), jobFor(fam, m1), 'fresh'),
    );

    clock = T0 + 60_000;
    const reader = scriptedReader(keepApart);
    const p = ports(reader);
    const plan = anchorOf(await planBurst(db.database, p, jobFor(fam, m1), 'deferred'));

    expect(plan.members.map((m) => m.channelMessageId)).toEqual([m1, m2]);
    expect(plan.replyTo.channelMessageId).toBe(m2);
    expect(plan.read).toBe('decided_earlier');
    expect(plan.waitedMs).toBe(0);
    expect(p.sleeps).toEqual([]);
    expect(reader.calls).toHaveLength(0);
  });

  it('an attempt that crashed after folding (no defer row) rebuilds the same burst', async () => {
    const fam = await seedFamily(db.database, 'Crashed');
    const m1 = await text(fam, 'a', T0);
    const m2 = await text(fam, 'b', T0 + 700);
    clock = T0 + 4_000;
    await planBurst(db.database, ports(scriptedReader(foldAll)), jobFor(fam, m1), 'fresh');

    const reader = scriptedReader(keepApart);
    const plan = anchorOf(await planBurst(db.database, ports(reader), jobFor(fam, m1), 'fresh'));

    expect(plan.members.map((m) => m.channelMessageId)).toEqual([m1, m2]);
    expect(plan.read).toBe('decided_earlier');
    expect(reader.calls).toHaveLength(0);
  });

  it('a crashed attempt retried with the flag off still rebuilds what it folded', async () => {
    const fam = await seedFamily(db.database, 'Crashed Dark');
    const m1 = await text(fam, 'swim thursday at 4', T0);
    const m2 = await text(fam, 'sorry 5', T0 + 700);
    clock = T0 + 4_000;
    anchorOf(
      await planBurst(db.database, ports(scriptedReader(foldAll)), jobFor(fam, m1), 'fresh'),
    );

    const reader = scriptedReader(keepApart);
    const p = ports(reader, { enabled: false });
    const plan = anchorOf(await planBurst(db.database, p, jobFor(fam, m1), 'fresh'));

    expect(plan.members.map((m) => m.channelMessageId)).toEqual([m1, m2]);
    expect(plan.read).toBe('decided_earlier');
    expect(reader.calls).toHaveLength(0);
    expect(p.sleeps).toEqual([]);
  });

  it('names the texts folded into an anchor, by id, and only those', async () => {
    const fam = await seedFamily(db.database, 'Folded Ids');
    const m1 = await text(fam, 'a', T0);
    const m2 = await text(fam, 'b', T0 + 300);
    const m3 = await text(fam, 'c', T0 + 600);
    clock = T0 + 4_000;
    const reader = scriptedReader(() => ({ status: 'read', groups: [['m1', 'm3'], ['m2']] }));
    await planBurst(db.database, ports(reader), jobFor(fam, m1), 'fresh');

    expect(await foldedMemberIds(db.database, { familyId: fam.familyId, anchorId: m1 })).toEqual([
      m3,
    ]);
    expect(await foldedMemberIds(db.database, { familyId: fam.familyId, anchorId: m2 })).toEqual(
      [],
    );
  });

  it('a deferred text nothing was folded into goes alone', async () => {
    const fam = await seedFamily(db.database, 'Deferred Lone');
    const m1 = await text(fam, 'a', T0);

    const plan = await planBurst(
      db.database,
      ports(scriptedReader(foldAll)),
      jobFor(fam, m1),
      'deferred',
    );

    expect(plan).toEqual({ kind: 'lone', waitedMs: 0, why: 're_driven' });
  });
});

describe('dark, and out of scope', () => {
  const untouchable = new Proxy(
    {},
    {
      get() {
        throw new Error('touched the database');
      },
    },
  ) as Database;

  it('flag off: two texts in the window stay lone, with no read, no sleep and no fold', async () => {
    const fam = await seedFamily(db.database, 'Dark Pair');
    const m1 = await text(fam, 'is swim on thursday', T0);
    const m2 = await text(fam, 'at 4?', T0 + 500);
    clock = T0 + 1_000;
    const reader = scriptedReader(foldAll);
    const p = ports(reader, { enabled: false });

    const plan = await planBurst(db.database, p, jobFor(fam, m1), 'fresh');

    expect(plan).toEqual({ kind: 'lone', waitedMs: 0, why: 'flag_off' });
    expect(reader.calls).toHaveLength(0);
    expect(p.sleeps).toEqual([]);
    expect(await foldRows(m2)).toEqual([]);
  });

  it('positive control: the same pair with the flag on is read and folded', async () => {
    const fam = await seedFamily(db.database, 'Lit Pair');
    const m1 = await text(fam, 'is swim on thursday', T0);
    const m2 = await text(fam, 'at 4?', T0 + 500);
    clock = T0 + 1_000;
    const reader = scriptedReader(foldAll);

    anchorOf(await planBurst(db.database, ports(reader), jobFor(fam, m1), 'fresh'));

    expect(reader.calls).toHaveLength(1);
    expect(await foldRows(m2)).toHaveLength(1);
  });

  it.each([
    ['a group text', true],
    ['a text whose group bit is unknown', undefined],
  ])('%s is never a burst, and costs no read', async (_name, inGroup) => {
    const fam = { familyId: randomUUID(), parentUserId: randomUUID() };
    const plan = await planBurst(
      untouchable,
      ports(scriptedReader(foldAll)),
      jobFor(fam, randomUUID(), { in_group: inGroup }),
      'fresh',
    );
    expect(plan).toEqual({ kind: 'lone', waitedMs: 0, why: 'not_direct' });
  });
});

describe('mergeBurstContext', () => {
  const context: InboundContext = {
    body: 'first',
    role: 'primary_parent',
    primaryParentName: 'Sam',
    reply: {
      channel: 'imessage',
      to: '+15555550100',
      chatId: CHAT,
      replyToMessageId: 'prov-first',
    },
    inGroup: false,
  };
  const member = (id: string, body: string, media: InboundMediaPart[]) => ({
    channelMessageId: id,
    providerMessageId: `prov-${id}`,
    body,
    media,
    createdAt: new Date(T0),
    optOutUnread: false,
  });

  it('joins the bodies, unions the media, and threads under the latest text', () => {
    const photo = { kind: 'image' as const, url: 'https://example.test/a.jpg', mime: 'image/jpeg' };
    const members = [
      member('first', 'first', []),
      member('second', '', [photo]),
      member('third', 'add this', []),
    ];
    const merged = mergeBurstContext(context, {
      kind: 'anchor',
      members,
      replyTo: members[2] as (typeof members)[number],
      waitedMs: 0,
      read: 'read',
    });

    expect(merged.body).toBe('first\nadd this');
    expect(merged.media).toEqual([photo]);
    expect(merged.reply).toEqual({ ...context.reply, replyToMessageId: 'prov-third' });
    expect(merged.role).toBe('primary_parent');
  });

  it('leaves an SMS route as it was: SMS has no threading', () => {
    const sms: InboundContext = { ...context, reply: { channel: 'sms', to: '+15555550100' } };
    const members = [member('first', 'first', []), member('second', 'second', [])];
    const merged = mergeBurstContext(sms, {
      kind: 'anchor',
      members,
      replyTo: members[1] as (typeof members)[number],
      waitedMs: 0,
      read: 'read',
    });
    expect(merged.reply).toEqual({ channel: 'sms', to: '+15555550100' });
    expect(merged.body).toBe('first\nsecond');
  });
});
