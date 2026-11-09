import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderHealth } from '~/lib/monitoring/provider-health';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  type ChannelSendJob,
  type HeldReminderRecheckDeps,
  defaultHeldReminderRecheckDeps,
  recheckHeldReminders,
  runReminderCron,
} from './run';
import { REMINDER_MAX_ATTEMPTS } from './compose';
import { COMPOSE_HOLD_MAX_ATTEMPTS } from './schedule';

/**
 * VIL-586 · a T-1h held because the writer could not be reached is asked again by the
 * drain, so it can still go out before the event. The next hourly slot only finds the
 * event started. Driven through the SHIPPED deps and the REAL writer; only the client
 * (and the provider probe) stand in. Chicago is CDT (UTC-5) before Nov 1. Every title
 * is invented.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;
let enqueued: ChannelSendJob[];

const STARTS_AT = new Date('2026-10-27T15:00:00Z'); // 10:00 CDT on Tuesday
// The T-1h is due at 09:00 CDT; the hourly run ticks at :12.
const T1H_TICK = new Date('2026-10-27T14:12:00Z');
const MINUTES_LATER = new Date('2026-10-27T14:20:00Z');
const AFTER_START = new Date('2026-10-27T15:01:00Z');

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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  enqueued = [];
  ({ familyId, parentUserId } = await seedFamily(db.database));
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Chicago' })
    .where(eq(schema.users.id, parentUserId));
  await db.database.insert(schema.familyEvents).values({
    familyId,
    title: 'Puppet Club',
    startsAt: STARTS_AT,
    source: 'placement',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SERVER_ERROR = () =>
  Anthropic.APIError.generate(
    500,
    { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
    undefined,
    { 'request-id': 'req_probe' },
  );

/** Answers in the shape the request asked for (tool or JSON output), or throws. */
function client(...replies: ({ texts: string[] } | unknown)[]) {
  const create = vi.fn(async (request: { tools?: unknown[] }) => {
    if (replies.length === 0) throw new Error('fake client: no reply left');
    const next = replies.shift();
    if (!(next && typeof next === 'object' && 'texts' in next)) throw next;
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test',
      stop_reason: request.tools ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 900, output_tokens: 40 },
      content: request.tools
        ? [{ type: 'tool_use', id: 'tu_0', name: 'reminder_texts', input: next }]
        : [{ type: 'text', text: JSON.stringify(next) }],
    };
  });
  return { agent: { messages: { create } } as unknown as AgentClient, create };
}

/** A writer the provider never answers: every call is a 500. */
function failing() {
  const create = vi.fn(async () => {
    throw SERVER_ERROR();
  });
  return { agent: { messages: { create } } as unknown as AgentClient, create };
}

const UP: ProviderHealth = { ok: true };
const DOWN: ProviderHealth = {
  ok: false,
  failure: 'transient',
  httpStatus: 529,
  errorType: 'overloaded_error',
};

function deps(agent: AgentClient, health: ProviderHealth = UP): HeldReminderRecheckDeps {
  return {
    ...defaultHeldReminderRecheckDeps(),
    scopeFamilies: (rows) => rows.filter((row) => row.familyId === familyId),
    client: agent,
    probe: vi.fn(async () => health),
    capture: (async () => 'sent') as unknown as HeldReminderRecheckDeps['capture'],
    enqueue: async (job) => {
      enqueued.push(job);
    },
  };
}

async function reminder(offset: '-PT1H' | '-P1D') {
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

const EVENING_TICK = new Date('2026-10-26T23:12:00Z');

/** The evening-before reminder goes out, then the hourly run at the T-1h slot meets a
 * provider outage. */
async function holdAtTheSlot() {
  await runReminderCron(
    db.database,
    deps(client({ texts: ['Puppet Club tomorrow at 10:00 AM.'] }).agent),
    EVENING_TICK,
  );
  expect(await reminder('-P1D')).toMatchObject({ status: 'sent' });
  enqueued = [];
  const down = await runReminderCron(
    db.database,
    deps(client(SERVER_ERROR(), SERVER_ERROR()).agent),
    T1H_TICK,
  );
  expect(down).toMatchObject({ fired: 0, suppressed: 0, heldComposeUnavailable: 1 });
}

describe('recheckHeldReminders (VIL-586)', () => {
  it('sends a T-1h held through an outage once the provider answers, before the event', async () => {
    await holdAtTheSlot();
    expect(await reminder('-PT1H')).toEqual({
      status: 'scheduled',
      suppressReason: 'compose_unavailable',
    });

    const writer = client({ texts: ['Puppet Club at 10:00 AM.'] });
    const result = await recheckHeldReminders(db.database, deps(writer.agent), MINUTES_LATER);

    expect(result).toMatchObject({ held: 1, fired: 1, suppressed: 0 });
    expect(writer.create).toHaveBeenCalledTimes(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ urgency: 'time_sensitive', familyId, parentUserId });
    expect(await reminder('-PT1H')).toEqual({ status: 'sent', suppressReason: null });
  });

  it('sends nothing to the writer while the provider is still down, and keeps the hold', async () => {
    await holdAtTheSlot();

    const writer = client({ texts: ['unreached'] });
    const d = deps(writer.agent, DOWN);
    const result = await recheckHeldReminders(db.database, d, MINUTES_LATER);

    expect(result).toEqual({
      held: 1,
      skipped: 'provider_down',
      failure: 'transient',
      httpStatus: 529,
      errorType: 'overloaded_error',
    });
    expect(d.probe).toHaveBeenCalledTimes(1);
    expect(writer.create).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
    expect(await reminder('-PT1H')).toEqual({
      status: 'scheduled',
      suppressReason: 'compose_unavailable',
    });
  });

  it('drops a held T-1h as started once the event has begun, with an audit row', async () => {
    await holdAtTheSlot();

    const writer = client({ texts: ['unreached'] });
    const result = await recheckHeldReminders(db.database, deps(writer.agent), AFTER_START);

    expect(result).toMatchObject({ held: 1, fired: 0, suppressed: 1 });
    expect(writer.create).not.toHaveBeenCalled();
    expect(await reminder('-PT1H')).toEqual({ status: 'suppressed', suppressReason: 'started' });
    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actionTaken: 'reminder_suppressed',
      after: { reason: 'started', offset: '-PT1H' },
    });
  });

  it('leaves a due T-1h the hourly run has not held to the hourly run, and never probes', async () => {
    // The evening-before slot has passed and sent; the T-1h slot has not been run.
    await runReminderCron(
      db.database,
      deps(client({ texts: ['Puppet Club tomorrow at 10:00 AM.'] }).agent),
      EVENING_TICK,
    );
    enqueued = [];

    const writer = client({ texts: ['unreached'] });
    const d = deps(writer.agent);
    const result = await recheckHeldReminders(db.database, d, MINUTES_LATER);

    expect(result).toEqual({ held: 0 });
    expect(d.probe).not.toHaveBeenCalled();
    expect(writer.create).not.toHaveBeenCalled();
    expect(await reminder('-PT1H')).toEqual({ status: 'scheduled', suppressReason: null });
  });

  it('leaves a held evening-before reminder to the next hourly slot', async () => {
    const down = await runReminderCron(
      db.database,
      deps(client(SERVER_ERROR(), SERVER_ERROR()).agent),
      EVENING_TICK,
    );
    expect(down).toMatchObject({ heldComposeUnavailable: 1 });
    expect(await reminder('-P1D')).toEqual({
      status: 'scheduled',
      suppressReason: 'compose_unavailable',
    });

    const d = deps(client({ texts: ['unreached'] }).agent);
    expect(await recheckHeldReminders(db.database, d, new Date('2026-10-26T23:20:00Z'))).toEqual({
      held: 0,
    });
    expect(d.probe).not.toHaveBeenCalled();
  });

  it('names a run with no writer instead of probing', async () => {
    await holdAtTheSlot();

    const d = { ...deps(client().agent), client: null };
    expect(await recheckHeldReminders(db.database, d, MINUTES_LATER)).toEqual({
      held: 1,
      skipped: 'no_client',
    });
    expect(d.probe).not.toHaveBeenCalled();
  });

  it('backs off a hold the writer keeps failing instead of asking it every drain minute', async () => {
    await holdAtTheSlot();
    const writer = failing();
    const d = deps(writer.agent);

    // The drain ticks every minute from the slot to the event's start; the provider probe
    // says it answers each time, but the compose itself keeps failing.
    for (let at = T1H_TICK.getTime() + 60_000; at < STARTS_AT.getTime(); at += 60_000) {
      await recheckHeldReminders(db.database, d, new Date(at));
    }

    // One compose per remaining try (the slot's own was the first), each of which makes
    // the writer's own two attempts. Unbounded, this is two calls every minute.
    expect(writer.create).toHaveBeenCalledTimes(
      (COMPOSE_HOLD_MAX_ATTEMPTS - 1) * REMINDER_MAX_ATTEMPTS,
    );
    expect(d.probe).toHaveBeenCalledTimes(COMPOSE_HOLD_MAX_ATTEMPTS - 1);
    expect(enqueued).toEqual([]);
  });

  it('does not probe or write again the minute after a hold, only once its next try is due', async () => {
    await holdAtTheSlot();
    const early = deps(failing().agent);
    expect(
      await recheckHeldReminders(db.database, early, new Date(T1H_TICK.getTime() + 60_000)),
    ).toEqual({ held: 0 });
    expect(early.probe).not.toHaveBeenCalled();

    // Positive control: the same hold is asked again once its next try comes round.
    const writer = client({ texts: ['Puppet Club at 10:00 AM.'] });
    const later = await recheckHeldReminders(db.database, deps(writer.agent), MINUTES_LATER);
    expect(later).toMatchObject({ held: 1, fired: 1 });
    expect(await reminder('-PT1H')).toEqual({ status: 'sent', suppressReason: null });
  });

  it('ends the hold as compose_retries_exhausted with an audit row when the tries run out', async () => {
    await holdAtTheSlot();
    const d = deps(failing().agent);
    for (let at = T1H_TICK.getTime() + 60_000; at < STARTS_AT.getTime(); at += 60_000) {
      await recheckHeldReminders(db.database, d, new Date(at));
    }

    expect(await reminder('-PT1H')).toEqual({
      status: 'suppressed',
      suppressReason: 'compose_retries_exhausted',
    });
    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actionTaken: 'reminder_suppressed',
      after: { reason: 'compose_retries_exhausted', offset: '-PT1H' },
    });
    // Ended, so the drain has nothing left to ask about.
    expect(await recheckHeldReminders(db.database, d, new Date(STARTS_AT.getTime() - 1))).toEqual({
      held: 0,
    });
  });

  it('migration 0220 applies a second time over itself', async () => {
    await expect(
      db.applyMigration('0220_event_reminders_compose_backoff.sql'),
    ).resolves.toBeUndefined();
    const result = await db.client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'event_reminders'
          and column_name in ('compose_attempts', 'compose_next_try_at')
        order by column_name`,
    );
    expect(result.rows.map((r) => r.column_name)).toEqual([
      'compose_attempts',
      'compose_next_try_at',
    ]);
  });
});
