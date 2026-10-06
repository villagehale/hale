import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { loadAgentContext } from '~/lib/coach/context';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { rememberWorkstreamTurn, renderWorkstreamExtractInput } from './workstream-extract';
import { followupBackoffUntil, runWorkstreamFollowupSweep } from './workstream-followup';
import {
  MAX_OPEN_WORKSTREAMS,
  WORKSTREAMS_ENABLED_ENV,
  activeWorkstreamBlock,
  applyWorkstreamOp,
  listDueWorkstreams,
  listOpenWorkstreams,
} from './workstreams';

const NOW = new Date('2026-08-12T15:00:00.000Z');
const SWIM = 'Saturday swim for Sebastian near L7G';

function usage(): Anthropic.Usage {
  return {
    input_tokens: 20,
    output_tokens: 20,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
  };
}

function toolClient(input: unknown, seen?: { user?: string }): AgentClient {
  return {
    messages: {
      create: async (params: { messages?: Array<{ content?: unknown }> }) => {
        const content = params.messages?.[0]?.content;
        if (seen && typeof content === 'string') seen.user = content;
        return {
          id: 'msg-tool',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [
            {
              type: 'tool_use',
              id: 'toolu_workstream',
              name: 'record_workstreams',
              input,
            },
          ],
          usage: usage(),
        } as Anthropic.Message;
      },
    },
  } as unknown as AgentClient;
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('workstream store', () => {
  it('opens, updates, and closes one thread', async () => {
    const { familyId } = await seedFamily(db.database, 'Lifecycle');
    const opened = await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-open',
      now: NOW,
      op: {
        action: 'open',
        title: 'compare two daycares',
        status: 'waiting_on_parent',
        nextStep: 'parent has not picked',
      },
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;

    const updated = await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-update',
      now: NOW,
      op: { action: 'update', id: opened.id, nextStep: 'parent asked for the afternoon one' },
    });
    expect(updated).toMatchObject({ outcome: 'updated', id: opened.id });

    const closed = await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-close',
      now: NOW,
      op: { action: 'close', id: opened.id },
    });
    expect(closed).toMatchObject({ outcome: 'closed', status: 'done' });
    expect(await listOpenWorkstreams(db.database, familyId, NOW)).toEqual([]);
  });

  it('stores a declined activity as dropped even when the model also says scheduled', async () => {
    const { familyId } = await seedFamily(db.database, 'Declined');
    const opened = await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-1',
      now: NOW,
      op: { action: 'open', title: SWIM, status: 'waiting_on_parent' },
    });
    expect(opened.outcome).toBe('opened');
    if (opened.outcome !== 'opened') return;

    const dropped = await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-2',
      now: NOW,
      op: { action: 'update', id: opened.id, declined: true, status: 'scheduled' },
    });
    expect(dropped).toMatchObject({ outcome: 'dropped', status: 'dropped' });

    const [row] = await db.database
      .select({ status: schema.familyWorkstreams.status })
      .from(schema.familyWorkstreams)
      .where(eq(schema.familyWorkstreams.id, opened.id));
    expect(row?.status).toBe('dropped');
  });

  it('drops a thread whose expiry has passed', async () => {
    const { familyId } = await seedFamily(db.database, 'Expiry');
    await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-1',
      now: NOW,
      op: {
        action: 'open',
        title: 'camp waitlist',
        expiresAt: new Date(NOW.getTime() - 60_000).toISOString(),
      },
    });
    expect(await listOpenWorkstreams(db.database, familyId, NOW)).toEqual([]);
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const block = await activeWorkstreamBlock(db.database, familyId, NOW);
    expect(block).toBe('active_workstreams: none');
  });

  it('refuses a ninth open thread', async () => {
    const { familyId } = await seedFamily(db.database, 'Cap');
    for (let n = 0; n < MAX_OPEN_WORKSTREAMS; n += 1) {
      const result = await applyWorkstreamOp(db.database, {
        familyId,
        provenance: `msg-${n}`,
        now: NOW,
        op: { action: 'open', title: `thread ${n}` },
      });
      expect(result.outcome).toBe('opened');
    }
    const refused = await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-over',
      now: NOW,
      op: { action: 'open', title: 'one more' },
    });
    expect(refused).toEqual({ outcome: 'refused', reason: 'max_open' });
  });

  it('puts the open list in context only when the flag is exactly true', async () => {
    const { familyId } = await seedFamily(db.database, 'Flag');
    await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-1',
      now: NOW,
      op: {
        action: 'open',
        title: SWIM,
        status: 'waiting_on_parent',
        nextStep: 'parent has not picked',
      },
    });

    const off = await loadAgentContext(
      {
        familyId,
        question: 'what are you on?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      NOW,
    );
    expect(off.memoryBrief.text).not.toContain(SWIM);
    expect(off.memoryBrief.text).not.toContain('active_workstreams');
    expect('activeWorkstreams' in off).toBe(false);

    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true\n');
    const newline = await activeWorkstreamBlock(db.database, familyId, NOW);
    expect(newline).toBeNull();

    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const on = await loadAgentContext(
      {
        familyId,
        question: 'what are you on?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      NOW,
    );
    expect(on.memoryBrief.text).toContain(SWIM);
    expect(on.memoryBrief.text.split(SWIM).length - 1).toBe(1);
    expect('activeWorkstreams' in on).toBe(false);
  });

  it('leaves a teen-linked thread out of the prompt', async () => {
    const { familyId } = await seedFamily(db.database, 'Teen');
    const teenId = await seedChild(db.database, familyId, 'Alex', 170, undefined, NOW);
    await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-1',
      now: NOW,
      op: { action: 'open', title: 'Alex clinic form', childIds: [teenId] },
    });
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const block = await activeWorkstreamBlock(db.database, familyId, NOW);
    expect(block).toBe('active_workstreams: none');
  });
});

describe('promise kinds and job titles', () => {
  it('puts both in the brief once, and does not copy either into the other line', async () => {
    const { familyId } = await seedFamily(db.database, 'Both');
    await db.database.insert(schema.agentCommitments).values({
      familyId,
      commitmentKind: 'first_find',
      createdFrom: 'msg-promise',
      summary: 'SECRET_SUMMARY',
      dueAt: new Date('2026-08-20T15:00:00.000Z'),
    });
    await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-job',
      now: NOW,
      op: { action: 'open', title: SWIM, status: 'waiting_on_parent' },
    });
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const ctx = await loadAgentContext(
      {
        familyId,
        question: 'what are you on?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      NOW,
    );
    const text = ctx.memoryBrief.text;
    const promiseLine = text.split('\n').find((line) => line.startsWith('workstreams:'));
    const jobsAt = text.indexOf('active_workstreams:');
    expect(promiseLine).toContain('first_find');
    expect(promiseLine).not.toContain(SWIM);
    expect(text).not.toContain('SECRET_SUMMARY');
    expect(jobsAt).toBeGreaterThan(text.indexOf('workstreams:'));
    expect(text.slice(0, jobsAt)).toContain('first_find');
    expect(text.slice(jobsAt)).not.toContain('first_find');
    expect(text.slice(jobsAt)).toContain(SWIM);
    expect(text.split(SWIM).length - 1).toBe(1);
    expect('activeWorkstreams' in ctx).toBe(false);
  });
});

function allowGate(timeZone: string): OutboundGatePorts {
  return {
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => 0,
    proactiveSentSince: async () => false,
    parentTimeZone: async () => timeZone,
  };
}

describe('a swim search carried across turns', () => {
  beforeEach(() => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
  });

  it('opens from the ask, shows up on a later turn, and closes when they pick', async () => {
    const { familyId } = await seedFamily(db.database, 'Sebastian');
    const sebastian = await seedChild(db.database, familyId, 'Sebastian', 36, undefined, NOW);

    const parentAsk = 'Can you find a Saturday swim for Sebastian near L7G?';
    const haleOptions = 'I found three Saturday swims near L7G. Want me to hold one?';
    const opened = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: parentAsk,
      haleText: haleOptions,
      provenance: 'msg-swim-ask',
      now: NOW,
      client: toolClient({
        ops: [
          {
            action: 'open',
            title: SWIM,
            status: 'waiting_on_parent',
            nextStep: 'parent has not picked',
            checkBackAt: '2026-08-15T15:00:00.000Z',
            childIds: [sebastian],
          },
        ],
      }),
    });
    expect(opened.applied[0]).toMatchObject({ outcome: 'opened', status: 'waiting_on_parent' });
    const id = opened.applied[0] && 'id' in opened.applied[0] ? opened.applied[0].id : '';

    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const later = await loadAgentContext(
      {
        familyId,
        question: 'anything I should know?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      new Date('2026-08-13T15:00:00.000Z'),
    );
    expect(later.memoryBrief.text).toContain(SWIM);
    expect(later.memoryBrief.text).toContain('waiting_on_parent');
    expect(later.memoryBrief.text.split(SWIM).length - 1).toBe(1);

    const parentPick = "Let's do the 9am one.";
    const haleClose = "I'll hold the 9am.";
    const closed = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: parentPick,
      haleText: haleClose,
      provenance: 'msg-swim-pick',
      now: new Date('2026-08-13T16:00:00.000Z'),
      client: toolClient({ ops: [{ action: 'close', id }] }),
    });
    expect(closed.applied[0]).toMatchObject({ outcome: 'closed', status: 'done' });

    const after = await activeWorkstreamBlock(
      db.database,
      familyId,
      new Date('2026-08-13T16:00:00.000Z'),
    );
    expect(after).toBe('active_workstreams: none');
  });

  it('drops the swim when they say they do not want it, even if the model marks it scheduled', async () => {
    const { familyId } = await seedFamily(db.database, 'No swim');
    const opened = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: 'Can you find a Saturday swim for Sebastian near L7G?',
      haleText: 'Three options near L7G.',
      provenance: 'msg-a',
      now: NOW,
      client: toolClient({
        ops: [{ action: 'open', title: SWIM, status: 'waiting_on_parent' }],
      }),
    });
    const id = opened.applied[0] && 'id' in opened.applied[0] ? opened.applied[0].id : '';
    const dropped = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: 'No we do not want that swim.',
      haleText: 'Got it, I will leave that one.',
      provenance: 'msg-b',
      now: NOW,
      client: toolClient({
        ops: [{ action: 'update', id, declined: true, status: 'scheduled' }],
      }),
    });
    expect(dropped.applied[0]).toMatchObject({ outcome: 'dropped', status: 'dropped' });
  });

  it('does not call the model or write a row when the flag is off', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'false');
    const { familyId } = await seedFamily(db.database, 'Flag off');
    const create = vi.fn();
    const result = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: 'Can you find a Saturday swim?',
      haleText: 'Three options.',
      provenance: 'msg-off',
      now: NOW,
      client: { messages: { create } } as unknown as AgentClient,
    });
    expect(result).toEqual({ applied: [], skipped: 'flag_off' });
    expect(create).not.toHaveBeenCalled();
    const rows = await db.database
      .select({ id: schema.familyWorkstreams.id })
      .from(schema.familyWorkstreams)
      .where(eq(schema.familyWorkstreams.familyId, familyId));
    expect(rows).toEqual([]);
  });

  it('reads a bare clock time in the family timezone and drops one already past', async () => {
    const { familyId } = await seedFamily(db.database, 'Dates');
    const seen: { user?: string } = {};
    const future = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: 'Check back Thursday at 3.',
      haleText: 'I will look Thursday.',
      provenance: 'msg-future',
      now: NOW,
      client: toolClient(
        {
          ops: [
            {
              action: 'open',
              title: 'Thursday check',
              status: 'waiting_on_third_party',
              checkBackAt: '2026-08-13T15:00:00',
            },
          ],
        },
        seen,
      ),
    });
    expect(future.applied[0]).toMatchObject({ outcome: 'opened' });
    const futureId = future.applied[0] && 'id' in future.applied[0] ? future.applied[0].id : '';
    const [stored] = await db.database
      .select({ checkBackAt: schema.familyWorkstreams.checkBackAt })
      .from(schema.familyWorkstreams)
      .where(eq(schema.familyWorkstreams.id, futureId));
    expect(stored?.checkBackAt?.toISOString()).toBe('2026-08-13T19:00:00.000Z');
    expect(seen.user).toContain('now: 2026-08-12T11:00:00-04:00');
    expect(seen.user).toContain('timezone: America/Toronto');

    const past = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: 'That Thursday already passed.',
      haleText: 'Leaving it.',
      provenance: 'msg-past',
      now: NOW,
      client: toolClient({
        ops: [
          {
            action: 'open',
            title: 'Last year Thursday',
            status: 'open',
            checkBackAt: '2025-10-09T15:00:00.000Z',
          },
        ],
      }),
    });
    const pastId = past.applied[0] && 'id' in past.applied[0] ? past.applied[0].id : '';
    const [stale] = await db.database
      .select({ checkBackAt: schema.familyWorkstreams.checkBackAt })
      .from(schema.familyWorkstreams)
      .where(eq(schema.familyWorkstreams.id, pastId));
    expect(stale?.checkBackAt).toBeNull();
  });

  it('links a teen the parent names, then leaves that thread out of the prompt and the sweep', async () => {
    const { familyId } = await seedFamily(db.database, 'Léa household');
    const lea = await seedChild(db.database, familyId, 'Léa Martin', 170, undefined, NOW);
    const seen: { user?: string } = {};
    const invented = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const opened = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: 'Léa has a clinic form due.',
      haleText: 'I can hold that form.',
      provenance: 'msg-lea',
      now: NOW,
      client: toolClient(
        {
          ops: [
            {
              action: 'open',
              title: 'Léa clinic form',
              status: 'waiting_on_parent',
              checkBackAt: '2026-08-13T15:00:00.000Z',
              childIds: ['Léa', invented, lea],
            },
          ],
        },
        seen,
      ),
    });
    expect(opened.applied[0]).toMatchObject({ outcome: 'opened' });
    const id = opened.applied[0] && 'id' in opened.applied[0] ? opened.applied[0].id : '';
    expect(seen.user).toContain(`id=${lea}`);
    expect(seen.user).toContain('name=Léa');
    expect(seen.user).toContain('age_months=170');
    const [row] = await db.database
      .select({ childIds: schema.familyWorkstreams.childIds })
      .from(schema.familyWorkstreams)
      .where(eq(schema.familyWorkstreams.id, id));
    expect(row?.childIds).toEqual([lea]);

    const block = await activeWorkstreamBlock(db.database, familyId, NOW);
    expect(block).toBe('active_workstreams: none');

    const compose = vi.fn();
    const sweep = await runWorkstreamFollowupSweep(db.database, {
      now: () => new Date('2026-08-14T15:00:00.000Z'),
      listDue: async (database, now) =>
        (await listDueWorkstreams(database, now)).filter((row) => row.familyId === familyId),
      f14: () => true,
      compose,
      buildGate: () => allowGate('America/Toronto'),
    });
    expect(sweep.skipped.teen_redacted).toBe(1);
    expect(compose).not.toHaveBeenCalled();
  });

  it('adds a teen id when the linked event belongs to that child', async () => {
    const { familyId } = await seedFamily(db.database, 'Event teen');
    const lea = await seedChild(db.database, familyId, 'Léa', 170, undefined, NOW);
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId,
        childId: lea,
        title: 'Clinic form',
        startsAt: new Date('2026-08-20T15:00:00.000Z'),
        source: 'parent',
      })
      .returning({ id: schema.familyEvents.id });
    const opened = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: 'The clinic form is still out.',
      haleText: 'Holding it.',
      provenance: 'msg-event',
      now: NOW,
      client: toolClient({
        ops: [
          {
            action: 'open',
            title: 'Clinic form',
            status: 'waiting_on_third_party',
            eventIds: [event?.id ?? ''],
          },
        ],
      }),
    });
    const id = opened.applied[0] && 'id' in opened.applied[0] ? opened.applied[0].id : '';
    const [row] = await db.database
      .select({
        childIds: schema.familyWorkstreams.childIds,
        eventIds: schema.familyWorkstreams.eventIds,
      })
      .from(schema.familyWorkstreams)
      .where(eq(schema.familyWorkstreams.id, id));
    expect(row?.eventIds).toEqual([event?.id]);
    expect(row?.childIds).toEqual([lea]);
    expect(await activeWorkstreamBlock(db.database, familyId, NOW)).toBe(
      'active_workstreams: none',
    );
  });

  it('stores a confirmed booking as scheduled', async () => {
    const { readFileSync } = await import('node:fs');
    const skill = readFileSync(
      new URL('../../../../packages/agent/skills/extract-workstream.md', import.meta.url),
      'utf8',
    );
    expect(skill).toContain('A confirmed booking is never `waiting_on_parent`.');
    expect(skill).toContain('It is never a step Hale will perform.');

    const { familyId } = await seedFamily(db.database, 'Booked');
    const opened = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: 'Which Sunday swim should I hold?',
      haleText: 'The 9am or the 11am.',
      provenance: 'msg-offer',
      now: NOW,
      client: toolClient({
        ops: [{ action: 'open', title: 'Sunday swim', status: 'waiting_on_parent' }],
      }),
    });
    const id = opened.applied[0] && 'id' in opened.applied[0] ? opened.applied[0].id : '';
    const booked = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: 'booked the Sunday one, thanks',
      haleText: 'Glad that one is booked.',
      provenance: 'msg-booked',
      now: NOW,
      client: toolClient({
        ops: [{ action: 'update', id, title: 'Sunday swim', status: 'scheduled' }],
      }),
    });
    expect(booked.applied[0]).toMatchObject({ outcome: 'updated', status: 'scheduled' });
  });

  it('drops a next step that promises Hale will chase a third party', async () => {
    const { familyId } = await seedFamily(db.database, 'Camp desk');
    const opened = await rememberWorkstreamTurn({
      database: db.database,
      familyId,
      parentText: 'Camp Kawartha has not confirmed the week.',
      haleText: 'I will keep an eye on it.',
      provenance: 'msg-camp',
      now: NOW,
      client: toolClient({
        ops: [
          {
            action: 'open',
            title: 'Camp Kawartha',
            status: 'waiting_on_parent',
            nextStep: 'Follow up with Camp Kawartha registration desk Thursday',
            checkBackAt: '2026-08-13T15:00:00.000Z',
          },
        ],
      }),
    });
    expect(opened.applied[0]).toMatchObject({
      outcome: 'opened',
      status: 'waiting_on_third_party',
    });
    const id = opened.applied[0] && 'id' in opened.applied[0] ? opened.applied[0].id : '';
    const [row] = await db.database
      .select({
        nextStep: schema.familyWorkstreams.nextStep,
        status: schema.familyWorkstreams.status,
      })
      .from(schema.familyWorkstreams)
      .where(eq(schema.familyWorkstreams.id, id));
    expect(row?.nextStep).toBeNull();
    expect(row?.status).toBe('waiting_on_third_party');
  });

  it('retries a failed check-back after the backoff, then stops', async () => {
    const { familyId } = await seedFamily(db.database, 'Backoff');
    const opened = await applyWorkstreamOp(db.database, {
      familyId,
      provenance: 'msg-due',
      now: NOW,
      op: {
        action: 'open',
        title: 'Camp waitlist',
        status: 'waiting_on_third_party',
        checkBackAt: '2026-08-13T15:00:00.000Z',
      },
    });
    expect(opened.outcome).toBe('opened');
    const later = new Date('2026-08-14T15:00:00.000Z');
    const pages: string[] = [];
    const compose = vi.fn(async () => ({ ok: false as const, reason: 'model_failed' }));
    const listDue = async (database: TestDb['database'], now: Date) =>
      (await listDueWorkstreams(database, now)).filter((row) => row.familyId === familyId);
    const first = await runWorkstreamFollowupSweep(db.database, {
      now: () => later,
      listDue,
      f14: () => true,
      compose,
      buildGate: () => allowGate('America/Toronto'),
      page: async (text) => {
        pages.push(text);
      },
    });
    expect(first.skipped.compose_failed).toBe(1);
    expect(pages).toHaveLength(1);
    expect(compose).toHaveBeenCalledTimes(1);

    const second = await runWorkstreamFollowupSweep(db.database, {
      now: () => later,
      listDue,
      f14: () => true,
      compose,
      buildGate: () => allowGate('America/Toronto'),
      page: async (text) => {
        pages.push(text);
      },
    });
    expect(second.considered).toBe(1);
    expect(second.skipped.deferred).toBe(1);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(pages).toHaveLength(1);

    const afterBackoff = new Date(followupBackoffUntil(1, later).getTime() + 1000);
    const third = await runWorkstreamFollowupSweep(db.database, {
      now: () => afterBackoff,
      listDue,
      f14: () => true,
      compose,
      buildGate: () => allowGate('America/Toronto'),
      page: async (text) => {
        pages.push(text);
      },
    });
    expect(third.skipped.compose_failed).toBe(1);
    expect(compose).toHaveBeenCalledTimes(2);
    expect(pages).toHaveLength(1);

    const afterSecondWait = new Date(followupBackoffUntil(2, afterBackoff).getTime() + 1000);
    const fourth = await runWorkstreamFollowupSweep(db.database, {
      now: () => afterSecondWait,
      listDue,
      f14: () => true,
      compose,
      buildGate: () => allowGate('America/Toronto'),
      page: async (text) => {
        pages.push(text);
      },
    });
    expect(fourth.skipped.compose_failed).toBe(1);
    expect(compose).toHaveBeenCalledTimes(3);
    expect(pages).toHaveLength(1);

    const fifth = await runWorkstreamFollowupSweep(db.database, {
      now: () => afterSecondWait,
      listDue,
      f14: () => true,
      compose,
      buildGate: () => allowGate('America/Toronto'),
      page: async (text) => {
        pages.push(text);
      },
    });
    expect(fifth.considered).toBe(0);
    expect(compose).toHaveBeenCalledTimes(3);
    expect(pages).toHaveLength(1);
  });
});

describe('extract input', () => {
  it('names the children and events the model is allowed to link', () => {
    const text = renderWorkstreamExtractInput({
      now: NOW,
      timeZone: 'America/Toronto',
      language: 'fr',
      children: [{ id: 'child-1', name: 'Léa', ageMonths: 170 }],
      events: [{ id: 'event-1', title: 'Clinic', startsAt: '2026-08-20T11:00:00-04:00' }],
      parentText: 'Léa a un formulaire.',
      haleText: 'Je le garde.',
      openLines: 'none',
    });
    expect(text).toContain('language: fr');
    expect(text).toContain('id=child-1 name=Léa age_months=170');
    expect(text).toContain('id=event-1 title=Clinic starts=2026-08-20T11:00:00-04:00');
  });
});
