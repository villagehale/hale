import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DispatchResult, dispatchLoopMessage } from '~/lib/channel/dispatch';
import { fakeChannel } from '~/lib/channel/fakes';
import type { LoopMessage, TemplateRenderer } from '~/lib/channel/types';
import { buildDispatchPorts } from '~/lib/channel/wiring';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { releaseHeldReminder } from './held-at-send';
import {
  type ChannelSendJob,
  type ReminderRunDeps,
  defaultReminderRunDeps,
  runReminderCron,
} from './run';

/**
 * VIL-562 · a reminder the proactive floor holds AT SEND goes back to the run, and the
 * run's own rules decide again at the next slot: re-offered once the floor opens before
 * the event, dropped otherwise. The job is the one the shipped run enqueued and the
 * dispatch is the shipped one (buildDispatchPorts); only the writer (a model call), the
 * queue hop and the SMS adapter are stood in. Denver in November is MST (UTC-7). Every
 * title is invented.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;
let enqueued: ChannelSendJob[];

const throwingRenderer: TemplateRenderer = {
  render() {
    throw new Error('a held leg must never render');
  },
};

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('LOOP_SEND_ENABLED', 'true');
  vi.stubEnv('PROACTIVE_CADENCE', 'off');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  enqueued = [];
  ({ familyId, parentUserId } = await seedFamily(db.database));
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Denver' })
    .where(eq(schema.users.id, parentUserId));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function deps(): ReminderRunDeps {
  return {
    ...defaultReminderRunDeps(),
    scopeFamilies: (rows) => rows.filter((row) => row.familyId === familyId),
    client: {} as ReminderRunDeps['client'],
    composeText: async () => ({
      status: 'written',
      draft: { texts: ['test double: model-written reminder'], bold: null },
    }),
    capture: (async () => 'sent') as unknown as ReminderRunDeps['capture'],
    enqueue: async (job) => {
      enqueued.push(job);
    },
  };
}

async function seedEvent(startsAt: string): Promise<void> {
  await db.database
    .insert(schema.familyEvents)
    .values({ familyId, title: 'Toddler gym', startsAt: new Date(startsAt), source: 'placement' });
}

async function reminder(offset: '-P1D' | '-PT1H') {
  const [row] = await db.database
    .select({
      status: schema.eventReminders.status,
      suppressReason: schema.eventReminders.suppressReason,
    })
    .from(schema.eventReminders)
    .where(
      and(eq(schema.eventReminders.familyId, familyId), eq(schema.eventReminders.offset, offset)),
    );
  return row;
}

function audits(actionTaken: string) {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, actionTaken)),
    );
}

function ledger() {
  return db.database
    .select({
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      dedupeKey: schema.channelMessages.dedupeKey,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
}

async function dispatchAt(job: ChannelSendJob, at: string) {
  const sms = fakeChannel('sms');
  const result = await dispatchLoopMessage(
    job,
    buildDispatchPorts(db.database, {
      channels: { sms },
      renderer: throwingRenderer,
      now: () => new Date(at),
    }),
  );
  return { result, sms };
}

/** The T-24h job the shipped run enqueues at the 18:12 MST slot on 5 Nov, for an event
 * at 16:00 MST on 6 Nov. Its row is 'sent' from the moment of the enqueue. */
async function eveningBeforeJob(): Promise<ChannelSendJob> {
  await seedEvent('2026-11-06T23:00:00Z');
  await runReminderCron(db.database, deps(), new Date('2026-11-06T01:12:00Z'));
  const [job] = enqueued;
  if (!job) throw new Error('the run enqueued no evening-before reminder');
  expect(job.dedupeKey).toBe(`reminder:-P1D:${familyId}:${parentUserId}:2026-11-05`);
  expect(await reminder('-P1D')).toEqual({ status: 'sent', suppressReason: null });
  return job;
}

describe('releaseHeldReminder (VIL-562)', () => {
  it('R1: a T-24h held by the floor at 21:05 goes back to the run and is re-offered at 08:12', async () => {
    const job = await eveningBeforeJob();

    const { result, sms } = await dispatchAt(job, '2026-11-06T04:05:00Z'); // 21:05 MST
    expect(result.legs).toEqual([
      { channel: 'sms', outcome: 'suppressed_quiet_hours', reason: 'proactive_floor' },
    ]);
    expect(sms.calls).toHaveLength(0);

    expect(await releaseHeldReminder(db.database, job, result)).toEqual({
      outcome: 'released',
      reminders: 1,
    });
    expect(await reminder('-P1D')).toEqual({ status: 'scheduled', suppressReason: null });
    const held = await audits('reminder_held_at_send');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      actor: 'system',
      targetTable: 'event_reminders',
      after: { offset: '-P1D', reason: 'proactive_floor' },
    });
    expect(await ledger()).toEqual([
      { status: 'suppressed_quiet_hours', errorCode: 'proactive_floor', dedupeKey: null },
    ]);

    // 07:12 MST: the floor is still closed but opens at 08:00, before 16:00 — held.
    await runReminderCron(db.database, deps(), new Date('2026-11-06T14:12:00Z'));
    expect(enqueued).toHaveLength(1);
    expect(await reminder('-P1D')).toEqual({ status: 'scheduled', suppressReason: null });

    // 08:12 MST: re-offered, recomposed, under the same evening key.
    await runReminderCron(db.database, deps(), new Date('2026-11-06T15:12:00Z'));
    expect(enqueued.map((j) => j.dedupeKey)).toEqual([job.dedupeKey, job.dedupeKey]);
    expect(await reminder('-P1D')).toEqual({ status: 'sent', suppressReason: null });
  });

  it('R2: a T-1h held at 21:05 is released, then the 21:12 run ends it as started', async () => {
    await seedEvent('2026-11-06T04:12:00Z'); // 21:12 MST on 5 Nov
    await runReminderCron(db.database, deps(), new Date('2026-11-06T03:12:00Z')); // 20:12 MST
    const job = enqueued.find((j) => j.dedupeKey.startsWith('reminder:-PT1H:'));
    if (!job) throw new Error('the run enqueued no T-1h');
    expect(job.urgency).toBe('time_sensitive');

    const { result } = await dispatchAt(job, '2026-11-06T04:05:00Z');
    expect(result.legs[0]?.reason).toBe('proactive_floor');
    expect(await releaseHeldReminder(db.database, job, result)).toEqual({
      outcome: 'released',
      reminders: 1,
    });

    await runReminderCron(db.database, deps(), new Date('2026-11-06T04:12:00Z'));
    expect(await reminder('-PT1H')).toEqual({ status: 'suppressed', suppressReason: 'started' });
    const ended = (await audits('reminder_suppressed')).filter(
      (a) => (a.after as { offset?: string }).offset === '-PT1H',
    );
    expect(ended.map((a) => a.after)).toEqual([{ reason: 'started', offset: '-PT1H' }]);
    expect(enqueued.filter((j) => j.dedupeKey === job.dedupeKey)).toHaveLength(1);
  });

  it('R2b: released before the event starts, the run drops it as quiet_hours (the floor opens too late)', async () => {
    await seedEvent('2026-11-06T04:12:00Z');
    await runReminderCron(db.database, deps(), new Date('2026-11-06T03:12:00Z'));
    const job = enqueued.find((j) => j.dedupeKey.startsWith('reminder:-PT1H:'));
    if (!job) throw new Error('the run enqueued no T-1h');
    const { result } = await dispatchAt(job, '2026-11-06T04:05:00Z');
    await releaseHeldReminder(db.database, job, result);

    await runReminderCron(db.database, deps(), new Date('2026-11-06T04:10:00Z'));
    expect(await reminder('-PT1H')).toEqual({
      status: 'suppressed',
      suppressReason: 'quiet_hours',
    });
  });

  it('R3: part of the set already reached the parent - nothing is re-offered', async () => {
    const job = await eveningBeforeJob();
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      category: 'reminder',
      templateKey: job.templateKey,
      dedupeKey: `${job.dedupeKey}:sms:0`,
      status: 'queued',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = await dispatchAt(job, '2026-11-06T04:05:00Z');
    expect(await releaseHeldReminder(db.database, job, result)).toEqual({
      outcome: 'started_set',
    });
    expect(await reminder('-P1D')).toEqual({ status: 'sent', suppressReason: null });
    expect(await audits('reminder_held_at_send')).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('R4: a leg that was sent or failed is not a hold', async () => {
    const job = await eveningBeforeJob();
    for (const outcome of ['sent', 'failed'] as const) {
      const result: DispatchResult = { legs: [{ channel: 'sms', outcome }] };
      expect(await releaseHeldReminder(db.database, job, result)).toEqual({ outcome: 'not_held' });
    }
    expect(await reminder('-P1D')).toEqual({ status: 'sent', suppressReason: null });
    expect(await audits('reminder_held_at_send')).toEqual([]);
  });

  it('R5: a payload with no events is named payload_unreadable, rows untouched', async () => {
    const job = await eveningBeforeJob();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unreadable: LoopMessage = { ...job, payload: { offset: '-P1D' } };
    const result: DispatchResult = {
      legs: [{ channel: 'sms', outcome: 'suppressed_quiet_hours', reason: 'proactive_floor' }],
    };
    expect(await releaseHeldReminder(db.database, unreadable, result)).toEqual({
      outcome: 'payload_unreadable',
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'payload_unreadable' }),
      expect.any(String),
    );
    expect(await reminder('-P1D')).toEqual({ status: 'sent', suppressReason: null });
  });

  it('R6: a quiet hold with no named reason is hold_unnamed, rows untouched', async () => {
    const job = await eveningBeforeJob();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result: DispatchResult = {
      legs: [{ channel: 'sms', outcome: 'suppressed_quiet_hours' }],
    };
    expect(await releaseHeldReminder(db.database, job, result)).toEqual({
      outcome: 'hold_unnamed',
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'hold_unnamed' }),
      expect.any(String),
    );
    expect(await reminder('-P1D')).toEqual({ status: 'sent', suppressReason: null });
    expect(await audits('reminder_held_at_send')).toEqual([]);
  });

  it("R7: the parent's own window holding it at 22:00 releases it too, named parent_window", async () => {
    const job = await eveningBeforeJob();
    const { result } = await dispatchAt(job, '2026-11-06T05:00:00Z'); // 22:00 MST
    expect(result.legs[0]).toMatchObject({ reason: 'parent_window' });
    expect(await releaseHeldReminder(db.database, job, result)).toEqual({
      outcome: 'released',
      reminders: 1,
    });
    expect((await audits('reminder_held_at_send'))[0]?.after).toEqual({
      offset: '-P1D',
      reason: 'parent_window',
    });
  });

  it('a second release of the same hold is a no-op with no second audit row', async () => {
    const job = await eveningBeforeJob();
    const { result } = await dispatchAt(job, '2026-11-06T04:05:00Z');
    expect(await releaseHeldReminder(db.database, job, result)).toEqual({
      outcome: 'released',
      reminders: 1,
    });
    expect(await releaseHeldReminder(db.database, job, result)).toEqual({
      outcome: 'released',
      reminders: 0,
    });
    expect(await audits('reminder_held_at_send')).toHaveLength(1);
  });
});
