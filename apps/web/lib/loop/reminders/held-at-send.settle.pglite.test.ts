import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchPorts } from '~/lib/channel/dispatch';
import { fakeChannel } from '~/lib/channel/fakes';
import type { ChannelSendOutcome } from '~/lib/channel/types';
import { buildDispatchPorts } from '~/lib/channel/wiring';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';
import type { OpsPage, OpsPager } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { abandonAndSettleReminder, dispatchAndReleaseHold } from './held-at-send';
import {
  type ChannelSendJob,
  type HeldReminderRecheckDeps,
  defaultHeldReminderRecheckDeps,
  recheckHeldReminders,
  runReminderCron,
} from './run';

/**
 * VIL-730 · a reminder is 'sent' only once Linq accepted it. The Prod case of 20 Nov 2026:
 * a T-1h for a 10:00 AM ET event fired at the 9:12 run, the dispatch's claim gate refused
 * the model's text (`unbacked_claim`), and the row had already been marked 'sent' at the
 * enqueue, so it never retried and the parent got nothing.
 *
 * The run, the dispatch (buildDispatchPorts) and the reminder renderer are the shipped
 * ones; only the writer (a model call), the claim reader's verdict, the queue hop and the
 * Linq adapter are stood in. Toronto in November is EST (UTC-5). Every title is invented.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const EVENT_AT = new Date('2026-11-20T15:00:00Z'); // 10:00 AM ET
const RUN_AT = new Date('2026-11-20T14:12:03Z'); // 9:12 AM ET, the Prod run
const SEND_AT = new Date('2026-11-20T14:12:23Z'); // the Prod dispatch
const RETRY_AT = new Date('2026-11-20T14:18:00Z'); // past the first 5-minute hold

let db: TestDb;
let familyId: string;
let parentUserId: string;
let enqueued: ChannelSendJob[];
let pages: OpsPage[];
let phoneSeq = 100;

const pager: OpsPager = {
  async page(page) {
    pages.push(page);
    return 'paged';
  },
};

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LOOP_SEND_ENABLED', 'true');
  vi.stubEnv('PROACTIVE_CADENCE', 'off');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  enqueued = [];
  pages = [];
  ({ familyId, parentUserId } = await seedFamily(db.database));
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Toronto' })
    .where(eq(schema.users.id, parentUserId));
  phoneSeq += 1;
  const phone = `+1416555${String(phoneSeq).padStart(4, '0')}`;
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date('2026-10-01T12:00:00Z'),
  });
  await db.database.insert(schema.familyEvents).values({
    familyId,
    title: 'Library storytime',
    startsAt: EVENT_AT,
    source: 'placement',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function deps(): HeldReminderRecheckDeps {
  return {
    ...defaultHeldReminderRecheckDeps(),
    scopeFamilies: (rows) => rows.filter((row) => row.familyId === familyId),
    client: {} as HeldReminderRecheckDeps['client'],
    composeText: async () => ({
      status: 'written',
      draft: { texts: ['test double: model-written reminder'], bold: null },
    }),
    capture: (async () => 'sent') as unknown as HeldReminderRecheckDeps['capture'],
    enqueue: async (job) => {
      enqueued.push(job);
    },
    probe: async () => ({ ok: true }),
  };
}

/** The shipped dispatch ports with Linq and the claim reader's verdict stood in. */
function ports(
  at: Date,
  verdict: 'clean' | 'unbacked',
  linq: ChannelSendOutcome = { status: 'sent', providerMessageId: 'linq-msg-1', transport: 'sms' },
) {
  const sms = fakeChannel('sms', linq);
  const built: DispatchPorts = {
    ...buildDispatchPorts(db.database, {
      channels: { sms },
      renderer: loopTemplateRenderer,
      now: () => at,
    }),
    claimEnforce: { enforces: () => true, decide: async () => ({ status: verdict }) },
  };
  return { sms, ports: built };
}

async function reminderT1h() {
  const [row] = await db.database
    .select({
      id: schema.eventReminders.id,
      status: schema.eventReminders.status,
      suppressReason: schema.eventReminders.suppressReason,
      composeAttempts: schema.eventReminders.composeAttempts,
      composeNextTryAt: schema.eventReminders.composeNextTryAt,
      channelMessageId: schema.eventReminders.channelMessageId,
    })
    .from(schema.eventReminders)
    .where(
      and(eq(schema.eventReminders.familyId, familyId), eq(schema.eventReminders.offset, '-PT1H')),
    );
  if (!row) throw new Error('no T-1h reminder row');
  return row;
}

function ledger() {
  return db.database
    .select({
      id: schema.channelMessages.id,
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      providerMessageId: schema.channelMessages.providerMessageId,
      body: schema.channelMessages.body,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
}

function audits(actionTaken: string) {
  return db.database
    .select({ targetId: schema.auditLog.targetId, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, actionTaken)),
    );
}

/** The 9:12 run: one T-1h job, its row pending (never 'sent' at the enqueue). */
async function nineTwelveJob(): Promise<ChannelSendJob> {
  await runReminderCron(db.database, deps(), RUN_AT);
  const job = enqueued.find((j) => j.dedupeKey.startsWith('reminder:-PT1H:'));
  if (!job) throw new Error('the run enqueued no T-1h');
  expect(job.urgency).toBe('time_sensitive');
  expect(await reminderT1h()).toMatchObject({
    status: 'scheduled',
    suppressReason: 'send_pending',
    channelMessageId: null,
  });
  return job;
}

describe('settleReminderSend (VIL-730)', () => {
  it('the 9 AM case: the claim gate refuses the text - unsent, retryable, failure recorded, nothing to Linq', async () => {
    const job = await nineTwelveJob();
    const { sms, ports: shipped } = ports(SEND_AT, 'unbacked');

    expect(await dispatchAndReleaseHold(db.database, job, shipped, pager)).toEqual({
      outcome: 'retrying',
      reminders: 1,
      reason: 'unbacked_claim',
    });

    expect(sms.calls).toHaveLength(0);
    // The Prod ledger row, exactly: failed, unbacked_claim, no provider id, no body.
    expect(await ledger()).toEqual([
      {
        id: expect.any(String),
        status: 'failed',
        errorCode: 'unbacked_claim',
        providerMessageId: null,
        body: null,
      },
    ]);
    const row = await reminderT1h();
    expect(row).toMatchObject({
      status: 'scheduled',
      suppressReason: 'send_failed',
      composeAttempts: 1,
      channelMessageId: null,
    });
    expect(row.status).not.toBe('sent');
    expect(row.composeNextTryAt?.toISOString()).toBe('2026-11-20T14:17:23.000Z');
    expect((await audits('reminder_send_failed')).map((a) => a.after)).toEqual([
      { reason: 'unbacked_claim', offset: '-PT1H', attempts: 1 },
    ]);
    expect(pages).toEqual([]);

    // Retryable: the drain's recheck offers it again before the event, freshly composed.
    const recheck = await recheckHeldReminders(db.database, deps(), RETRY_AT);
    expect(recheck).toMatchObject({ held: 1, fired: 1 });
    expect(enqueued.filter((j) => j.dedupeKey === job.dedupeKey)).toHaveLength(2);
    expect(await reminderT1h()).toMatchObject({
      status: 'scheduled',
      suppressReason: 'send_pending',
    });
  });

  it('a Linq refusal leaves it unsent and retryable, its code on the audit row', async () => {
    const job = await nineTwelveJob();
    const { sms, ports: shipped } = ports(SEND_AT, 'clean', {
      status: 'error',
      transient: false,
      code: 'linq_rejected',
      message: 'refused',
    });

    expect(await dispatchAndReleaseHold(db.database, job, shipped, pager)).toEqual({
      outcome: 'retrying',
      reminders: 1,
      reason: 'linq_rejected',
    });
    expect(sms.calls).toHaveLength(1);
    expect(await reminderT1h()).toMatchObject({
      status: 'scheduled',
      suppressReason: 'send_failed',
      composeAttempts: 1,
      channelMessageId: null,
    });
    expect((await audits('reminder_send_failed')).map((a) => a.after)).toEqual([
      { reason: 'linq_rejected', offset: '-PT1H', attempts: 1 },
    ]);
  });

  it('a job that spent every queue retry (dead letter) is unsent and retryable too', async () => {
    const job = await nineTwelveJob();
    const { sms, ports: shipped } = ports(SEND_AT, 'clean');

    expect(await abandonAndSettleReminder(db.database, job, shipped, pager)).toEqual({
      outcome: 'retrying',
      reminders: 1,
      reason: 'send_retries_exhausted',
    });
    expect(sms.calls).toHaveLength(0);
    expect(await reminderT1h()).toMatchObject({
      status: 'scheduled',
      suppressReason: 'send_failed',
    });
  });

  it('marks it sent only once Linq accepted it, linked to that ledger row', async () => {
    const job = await nineTwelveJob();
    const { sms, ports: shipped } = ports(SEND_AT, 'clean');

    expect(await dispatchAndReleaseHold(db.database, job, shipped, pager)).toEqual({
      outcome: 'delivered',
      reminders: 1,
    });
    expect(sms.calls).toHaveLength(1);
    const [accepted] = await ledger();
    expect(accepted).toMatchObject({ status: 'queued', providerMessageId: 'linq-msg-1' });
    expect(await reminderT1h()).toMatchObject({
      status: 'sent',
      suppressReason: null,
      composeNextTryAt: null,
      channelMessageId: accepted?.id,
    });
  });

  it('after a gate refusal, the retried send that Linq accepts is the one that marks it sent', async () => {
    const job = await nineTwelveJob();
    await dispatchAndReleaseHold(db.database, job, ports(SEND_AT, 'unbacked').ports, pager);
    await recheckHeldReminders(db.database, deps(), RETRY_AT);
    const retry = enqueued.at(-1);
    if (!retry) throw new Error('no retry job');

    const { sms, ports: shipped } = ports(RETRY_AT, 'clean');
    expect(await dispatchAndReleaseHold(db.database, retry, shipped, pager)).toEqual({
      outcome: 'delivered',
      reminders: 1,
    });
    expect(sms.calls).toHaveLength(1);
    expect(await reminderT1h()).toMatchObject({ status: 'sent', suppressReason: null });
  });

  it('retries exhausted: dropped as send_retries_exhausted and #ops paged, nothing sent instead', async () => {
    const job = await nineTwelveJob();
    // Three refused tries already behind it (nextComposeHold allows four).
    await db.database
      .update(schema.eventReminders)
      .set({ composeAttempts: 3 })
      .where(eq(schema.eventReminders.id, (await reminderT1h()).id));
    const { sms, ports: shipped } = ports(SEND_AT, 'unbacked');

    expect(await dispatchAndReleaseHold(db.database, job, shipped, pager)).toEqual({
      outcome: 'exhausted',
      reminders: 1,
      reason: 'unbacked_claim',
      page: 'paged',
    });
    expect(sms.calls).toHaveLength(0);
    expect(await reminderT1h()).toMatchObject({
      status: 'suppressed',
      suppressReason: 'send_retries_exhausted',
      channelMessageId: null,
    });
    expect(pages).toEqual([{ site: 'reminder_unsent', facts: { reason: 'claim_gate' }, count: 1 }]);
    expect((await audits('reminder_suppressed')).map((a) => a.after)).toContainEqual({
      reason: 'send_retries_exhausted',
      offset: '-PT1H',
      failure: 'unbacked_claim',
    });
    // Not offered again.
    await recheckHeldReminders(db.database, deps(), RETRY_AT);
    expect(enqueued.filter((j) => j.dedupeKey === job.dedupeKey)).toHaveLength(1);
  });

  it('with LOOP_SEND_ENABLED off the run enqueues nothing and leaves the row untouched', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'false');
    await runReminderCron(db.database, deps(), RUN_AT);
    expect(enqueued).toEqual([]);
    expect(await reminderT1h()).toMatchObject({
      status: 'scheduled',
      suppressReason: null,
      composeAttempts: 0,
      composeNextTryAt: null,
    });
  });
});
