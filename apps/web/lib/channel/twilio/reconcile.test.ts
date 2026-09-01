import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { ChannelMessageReceivedJob } from './inbound';
import {
  HANDOFF_CEILING_MS,
  HANDOFF_GRACE_MS,
  RECONCILE_BATCH_LIMIT,
  type UnhandedInboundRow,
  reconcileUnhandedInbound,
  reconcileWindow,
  selectUnhandedInbound,
} from './reconcile';

/**
 * The reconciler exists because `handed_off_at` is written only once C1's job really
 * exists, which means a row left null is a parent's text that Hale recorded, audited,
 * answered 200 to — and never replied to. Twilio cannot re-drive it (its retry loses
 * the claim index and answers 'duplicate'), so this is the only thing that can.
 */

const NOW = new Date('2026-08-12T12:00:00.000Z');
const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';

function row(over: Partial<UnhandedInboundRow> = {}): UnhandedInboundRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    familyId: FAMILY,
    parentUserId: PARENT,
    providerMessageId: 'SM1',
    sentAt: new Date('2026-08-12T11:40:00.000Z'),
    createdAt: new Date('2026-08-12T11:40:01.000Z'),
    ...over,
  };
}

/**
 * Fakes select(...).from().where().orderBy().limit() — the one read — and
 * update().set().where() — the mark. The `set` spy is what proves a row was claimed,
 * and its ABSENCE is what proves a failed re-drive left the text still owed.
 */
function fakeDb(rows: UnhandedInboundRow[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  return { db: { select, update } as never, spies: { select, limit, update, set } };
}

function deps(
  rows: UnhandedInboundRow[],
  enqueue: (job: ChannelMessageReceivedJob) => Promise<void>,
) {
  const { db, spies } = fakeDb(rows);
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  return {
    spies,
    errors,
    warns,
    deps: {
      database: db,
      enqueue,
      now: () => NOW,
      log: {
        error: (...args: unknown[]) => {
          errors.push(args);
        },
        warn: (...args: unknown[]) => {
          warns.push(args);
        },
      },
    },
  };
}

describe('the age band', () => {
  /**
   * The floor is the whole reason this is a cron and not something the webhook does to
   * itself: a request that is still running holds an unmarked row, and a re-drive that
   * cannot tell a live attempt from a dead one would answer the parent twice. Age is
   * the only thing that can tell them apart.
   */
  it('ignores anything younger than the grace window and older than the ceiling', () => {
    const { notBefore, notAfter } = reconcileWindow(NOW);

    expect(notAfter).toEqual(new Date('2026-08-12T11:58:00.000Z'));
    expect(notBefore).toEqual(new Date('2026-08-11T12:00:00.000Z'));
    expect(HANDOFF_GRACE_MS).toBeLessThan(HANDOFF_CEILING_MS);
  });
});

/**
 * The selection is the whole safety of this module, and it must pick out exactly the
 * rows `handOffToConversation` records — channel 'sms', category 'reply' — because
 * those are the only unmarked rows that mean "C1 never got it". Every other recorder
 * of inbound rows is its own consumer: the intake machine answers in-request, the
 * caregiver route answers in-request, and the email leg files rows the router cannot
 * yet speak for. Sweeping any of those into C1's queue replays a text that was already
 * answered — which is precisely what happened to a family's onboarding turns, answered
 * once by intake and then again, minutes later and out of context, by the coach.
 */
describe('what the sweep may select', () => {
  let db: TestDb;

  // Booted in a hook, not the test body: pglite boot + migrations routinely
  // exceed the 5s test timeout under full parallel CI load, and hooks carry
  // their own timeout budget.
  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedInbound(
    family: { familyId: string; parentUserId: string },
    providerMessageId: string,
    over: {
      channel?: 'sms' | 'whatsapp' | 'email';
      category?: 'reply' | 'intake' | 'caregiver';
    } = {},
  ) {
    const createdAt = new Date(NOW.getTime() - 10 * 60 * 1000);
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: over.channel ?? 'sms',
        direction: 'in',
        category: over.category ?? 'reply',
        providerMessageId,
        status: 'delivered',
        body: 'hello',
        sentAt: createdAt,
        createdAt,
      })
      .returning({ id: schema.channelMessages.id });
    if (!row) throw new Error('seedInbound: insert returned no row');
    return row.id;
  }

  it('selects only sms and whatsapp reply rows — never intake, caregiver, or email rows', async () => {
    const family = await seedFamily(db.database);

    const owed = await seedInbound(family, 'SM_owed');
    // A WhatsApp reply is owed the SAME hand-off: the webhook records it with its real
    // pipe (WhatsApp v1), and a sweep pinned to 'sms' would strand it forever.
    const owedWhatsApp = await seedInbound(family, 'WA_owed', { channel: 'whatsapp' });
    await seedInbound(family, 'SM_intake', { category: 'intake' });
    await seedInbound(family, 'SM_caregiver', { category: 'caregiver' });
    await seedInbound(family, 'EM_reply', { channel: 'email' });

    const rows = await selectUnhandedInbound(db.database, NOW);

    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([owed, owedWhatsApp]));
  });
});

describe('reconcileUnhandedInbound', () => {
  it('re-drives an abandoned text and only then marks it handed off', async () => {
    const jobs: ChannelMessageReceivedJob[] = [];
    const h = deps([row()], async (job) => {
      // The mark must not exist yet at the moment the queue is asked.
      expect(h.spies.set).not.toHaveBeenCalled();
      jobs.push(job);
    });

    const summary = await reconcileUnhandedInbound(h.deps);

    expect(jobs).toEqual([
      {
        family_id: FAMILY,
        parent_user_id: PARENT,
        channel_message_id: '33333333-3333-4333-8333-333333333333',
        provider_message_id: 'SM1',
        // The parent's own send time, not when the row was written.
        received_at: '2026-08-12T11:40:00.000Z',
      },
    ]);
    expect(h.spies.set).toHaveBeenCalledWith({ handedOffAt: NOW });
    expect(summary).toEqual({ scanned: 1, redriven: 1, failed: 0 });
  });

  it('falls back to created_at when the row carries no send time', async () => {
    const jobs: ChannelMessageReceivedJob[] = [];
    const h = deps([row({ sentAt: null })], async (job) => {
      jobs.push(job);
    });

    await reconcileUnhandedInbound(h.deps);

    expect(jobs[0]?.received_at).toBe('2026-08-12T11:40:01.000Z');
  });

  /**
   * The failure this module must never have: telling the ledger a text was delivered to
   * C1 when the queue refused it again. That is the original swallowed-text bug, and a
   * reconciler that marked optimistically would be the thing that finally made it
   * permanent — nothing would ever look at the row again.
   */
  it('leaves a row UNMARKED when the queue refuses it again, and says so', async () => {
    const h = deps([row()], async () => {
      throw new Error('pool exhausted');
    });

    const summary = await reconcileUnhandedInbound(h.deps);

    expect(h.spies.set).not.toHaveBeenCalled();
    expect(summary).toEqual({ scanned: 1, redriven: 0, failed: 1 });
    const line = JSON.stringify(h.errors[0]);
    expect(line).toContain('SM1');
    expect(line).toContain('pool exhausted');
  });

  it('does not strand the rest of the batch behind one unqueueable row', async () => {
    const seen: string[] = [];
    const rows = [
      row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', providerMessageId: 'SM_bad' }),
      row({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', providerMessageId: 'SM_good' }),
    ];
    const h = deps(rows, async (job) => {
      seen.push(job.provider_message_id);
      if (job.provider_message_id === 'SM_bad') throw new Error('pool exhausted');
    });

    const summary = await reconcileUnhandedInbound(h.deps);

    expect(seen).toEqual(['SM_bad', 'SM_good']);
    expect(h.spies.set).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ scanned: 2, redriven: 1, failed: 1 });
  });

  /** The quiet case is the common one: nothing owed, nothing logged, no operator noise
   * on a cron that runs every ten minutes forever. */
  it('says nothing at all when every text was handed off normally', async () => {
    const h = deps([], async () => {
      throw new Error('must not be called');
    });

    const summary = await reconcileUnhandedInbound(h.deps);

    expect(summary).toEqual({ scanned: 0, redriven: 0, failed: 0 });
    expect(h.warns).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.spies.update).not.toHaveBeenCalled();
  });

  it('bounds one tick to a batch rather than a whole backlog', async () => {
    const h = deps([], async () => {});
    await reconcileUnhandedInbound(h.deps);

    expect(h.spies.limit).toHaveBeenCalledWith(RECONCILE_BATCH_LIMIT);
  });
});
