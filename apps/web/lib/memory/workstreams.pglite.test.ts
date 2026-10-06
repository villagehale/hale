import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadAgentContext } from '~/lib/coach/context';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { rememberWorkstreamTurn } from './workstream-extract';
import {
  MAX_OPEN_WORKSTREAMS,
  WORKSTREAMS_ENABLED_ENV,
  activeWorkstreamBlock,
  applyWorkstreamOp,
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

function toolClient(input: unknown): AgentClient {
  return {
    messages: {
      create: async () =>
        ({
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
        }) as Anthropic.Message,
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
    expect(off.activeWorkstreams).toBeUndefined();

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
    expect(on.activeWorkstreams).toContain(SWIM);
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

describe('a swim search carried across turns', () => {
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
    expect(later.activeWorkstreams).toContain(SWIM);
    expect(later.activeWorkstreams).toContain('waiting_on_parent');

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
});
