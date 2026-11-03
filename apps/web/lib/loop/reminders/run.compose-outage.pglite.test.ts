import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  type ChannelSendJob,
  type ReminderRunDeps,
  defaultReminderRunDeps,
  runReminderCron,
} from './run';

/**
 * VIL-563 · a provider outage while the reminder is being written leaves it scheduled,
 * and only a refused draft is terminal. Driven through the SHIPPED deps and the REAL
 * writer (composeReminderTexts, its skill, its agent_runs rows); only the client stands
 * in, at the AgentClient port, answering or throwing what the SDK would. Chicago is CDT
 * (UTC-5) before Nov 1. Every title is invented.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;
let enqueued: ChannelSendJob[];

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
    startsAt: new Date('2026-10-27T15:00:00Z'), // 10:00 CDT on Tuesday
    source: 'placement',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// The evening-before slot is 18:00 CDT on Monday; the run ticks at :12.
const EVENING_TICK = new Date('2026-10-26T23:12:00Z');
const NEXT_TICK = new Date('2026-10-27T00:12:00Z');

const SERVER_ERROR = () =>
  Anthropic.APIError.generate(
    500,
    { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
    undefined,
    { 'request-id': 'req_probe' },
  );

/** Answers in the shape the request asked for (tool or JSON output), or throws. */
function client(...replies: ({ texts: string[] } | unknown)[]): AgentClient {
  const create = async (request: { tools?: unknown[] }) => {
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
  };
  return { messages: { create } } as unknown as AgentClient;
}

function deps(agent: AgentClient): ReminderRunDeps {
  return {
    ...defaultReminderRunDeps(),
    scopeFamilies: (rows) => rows.filter((row) => row.familyId === familyId),
    client: agent,
    capture: (async () => 'sent') as unknown as ReminderRunDeps['capture'],
    enqueue: async (job) => {
      enqueued.push(job);
    },
  };
}

async function eveningBefore() {
  const [row] = await db.database
    .select({
      status: schema.eventReminders.status,
      suppressReason: schema.eventReminders.suppressReason,
    })
    .from(schema.eventReminders)
    .where(
      and(eq(schema.eventReminders.familyId, familyId), eq(schema.eventReminders.offset, '-P1D')),
    );
  return row;
}

function runs() {
  return db.database
    .select({ agentName: schema.agentRuns.agentName, status: schema.agentRuns.status })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.familyId, familyId));
}

function audits() {
  return db.database.select().from(schema.auditLog).where(eq(schema.auditLog.familyId, familyId));
}

describe('runReminderCron with the real writer - a provider outage (VIL-563)', () => {
  it('holds the evening-before reminder through a 500, then sends it at the next tick', async () => {
    const down = await runReminderCron(
      db.database,
      deps(client(SERVER_ERROR(), SERVER_ERROR())),
      EVENING_TICK,
    );
    expect(down).toMatchObject({ fired: 0, suppressed: 0, heldComposeUnavailable: 1 });
    expect(await eveningBefore()).toEqual({ status: 'scheduled', suppressReason: null });
    expect(await runs()).toEqual([
      { agentName: 'reminder-voice', status: 'failed' },
      { agentName: 'reminder-voice', status: 'failed' },
    ]);
    expect(await audits()).toEqual([]);

    const back = await runReminderCron(
      db.database,
      deps(client({ texts: ['Puppet Club tomorrow at 10:00 AM.'] })),
      NEXT_TICK,
    );
    expect(back).toMatchObject({ fired: 1, heldComposeUnavailable: 0 });
    expect(enqueued).toHaveLength(1);
    expect(await eveningBefore()).toEqual({ status: 'sent', suppressReason: null });
    expect((await runs()).filter((run) => run.status === 'completed')).toHaveLength(1);
  });

  it('positive control: two refused drafts drop it as unwritten, with an audit row', async () => {
    const linked = { texts: ['Puppet Club tomorrow, see https://example.com/x'] };
    const result = await runReminderCron(db.database, deps(client(linked, linked)), EVENING_TICK);
    expect(result).toMatchObject({ fired: 0, suppressed: 1, heldComposeUnavailable: 0 });
    expect(await eveningBefore()).toEqual({ status: 'suppressed', suppressReason: 'unwritten' });
    const audit = await audits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actionTaken: 'reminder_suppressed',
      after: { reason: 'unwritten', offset: '-P1D' },
    });
    expect(enqueued).toEqual([]);
  });
});
