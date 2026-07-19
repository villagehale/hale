import { type Database, schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { getConversationTranscript, listConversations } from './history';

// history.ts pulls in ~/lib/family (→ ~/auth → next-auth) for its session-scoped
// wrappers; stub it so importing the module under test doesn't drag in the auth
// chain. These tests drive the family-explicit reads directly with an injected db.
vi.mock('~/lib/family', () => ({ currentFamilyId: async () => null }));

/**
 * Ask-session history reads (the listing + reopen backend). Both reads are
 * family-scoped (rule #1): a caller can only ever list — or open the transcript of —
 * a conversation owned by their OWN family. A fake db serves the rows; no real
 * infrastructure is touched. The pure derivations (title = first live user turn,
 * truncation, soft-delete skipping, empty-exclusion, lastMessageAt ordering) are
 * exercised through real message rows so each assertion fails when the logic is wrong.
 */

const FAMILY_A = '11111111-1111-4111-8111-111111111111';
const FAMILY_B = '99999999-9999-4999-8999-999999999999';
const CONV1 = '22222222-2222-4222-8222-222222222222';
const CONV2 = '33333333-3333-4333-8333-333333333333';
const CONV3 = '44444444-4444-4444-8444-444444444444';
const CONV_B = '55555555-5555-4555-8555-555555555555';

interface MessageRow {
  conversationId: string;
  noteKey: string | null;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  deletedAt: Date | null;
}

/**
 * Fake db for listConversations: `select().from(messages).innerJoin(conversations)
 * .where(clause).orderBy()`. Captures the where clause so the family scope can be
 * asserted at the value level (rule #1 isolation).
 */
function listFakeDb(rows: MessageRow[], capture?: { where?: unknown }): Database {
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table !== schema.messages) throw new Error('unexpected list select target');
        return {
          innerJoin: () => ({
            where: (clause: unknown) => {
              if (capture) capture.where = clause;
              return { orderBy: async () => rows };
            },
          }),
        };
      },
    }),
  };
  return db as unknown as Database;
}

/** Walks a Drizzle SQL clause collecting bound Param values, so a test can assert
 * WHICH family id the query filters on (not merely that a where exists). */
function paramValues(clause: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const obj = node as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown };
    if (obj.constructor?.name === 'Param' && 'value' in obj) out.push(obj.value);
    if ('queryChunks' in obj) walk(obj.queryChunks);
  };
  walk(clause);
  return out;
}

interface TimelineRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  childId: string | null;
  topic: string | null;
  createdAt: Date;
}

/**
 * Fake db for getConversationTranscript: the ownership check reads `from(conversations)
 * .where().limit()`, then loadTimeline reads `from(messages).where().orderBy()`. A flag
 * records whether the message read ran — so a foreign conversation is proven to NEVER
 * reach the transcript.
 */
function transcriptFakeDb(
  ownershipRows: Array<{ id: string }>,
  messageRows: TimelineRow[],
  probe?: { readMessages?: boolean },
): Database {
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.conversations) {
          return { where: () => ({ limit: async () => ownershipRows }) };
        }
        if (table === schema.messages) {
          return {
            where: () => ({
              orderBy: async () => {
                if (probe) probe.readMessages = true;
                return messageRows;
              },
            }),
          };
        }
        throw new Error('unexpected transcript select target');
      },
    }),
  };
  return db as unknown as Database;
}

describe('cross-family isolation (rule #1)', () => {
  it('getConversationTranscript returns null for a conversation owned by another family — never reads its messages', async () => {
    // Family A asks for a conversation that belongs to family B: the ownership
    // check (scoped to A) finds no row, so the transcript is null and the message
    // read is never reached — B's turns can never leak to A.
    const probe: { readMessages?: boolean } = {};
    const db = transcriptFakeDb([], [], probe);

    const transcript = await getConversationTranscript(FAMILY_A, CONV_B, db);

    expect(transcript).toBeNull();
    expect(probe.readMessages).toBeUndefined();
  });

  it('listConversations filters on the requesting family id, not any other', async () => {
    const capture: { where?: unknown } = {};
    const db = listFakeDb([], capture);

    await listConversations(FAMILY_A, db);

    const params = paramValues(capture.where);
    expect(params).toContain(FAMILY_A);
    expect(params).not.toContain(FAMILY_B);
  });
});

describe('listConversations', () => {
  const t = (hhmm: string) => new Date(`2026-06-17T${hhmm}:00Z`);

  function rows(): MessageRow[] {
    // Emitted in global chronological order — the shape the createdAt-asc query returns.
    return [
      // conv3: its only turn is soft-deleted → an empty conversation, excluded.
      { conversationId: CONV3, noteKey: null, role: 'user', content: 'never mind', createdAt: t('09:00'), deletedAt: t('09:05') },
      // conv1: general thread, two live turns.
      { conversationId: CONV1, noteKey: null, role: 'user', content: 'When do I start solids for the baby?', createdAt: t('10:00'), deletedAt: null },
      { conversationId: CONV1, noteKey: null, role: 'assistant', content: 'Around six months is the common window.', createdAt: t('10:01'), deletedAt: null },
      // conv2: note-anchored thread; first user turn was edited away (soft-deleted).
      { conversationId: CONV2, noteKey: 'action-abc', role: 'user', content: 'first draft question', createdAt: t('11:00'), deletedAt: t('11:02') },
      { conversationId: CONV2, noteKey: 'action-abc', role: 'user', content: 'What does this nap-regression brief mean for our week ahead, in detail please?', createdAt: t('11:05'), deletedAt: null },
      { conversationId: CONV2, noteKey: 'action-abc', role: 'assistant', content: 'Here is what that brief means for your week.', createdAt: t('11:06'), deletedAt: null },
    ];
  }

  it('orders by last live message time (desc) and excludes empty conversations', async () => {
    const summaries = await listConversations(FAMILY_A, listFakeDb(rows()));

    // conv2 (last live 11:06) before conv1 (last live 10:01); conv3 (all deleted) gone.
    expect(summaries.map((s) => s.id)).toEqual([CONV2, CONV1]);
  });

  it('titles a conversation from its first LIVE user turn — never the assistant reply, never a soft-deleted turn', async () => {
    const summaries = await listConversations(FAMILY_A, listFakeDb(rows()));
    const byId = new Map(summaries.map((s) => [s.id, s]));

    // conv1: the short user question verbatim (not the assistant's "Around six months…").
    expect(byId.get(CONV1)?.title).toBe('When do I start solids for the baby?');
    // conv2: the first LIVE user turn (the soft-deleted "first draft question" is skipped).
    expect(byId.get(CONV2)?.title?.startsWith('What does this nap-regression brief')).toBe(true);
  });

  it('truncates a long title to a bounded length with a trailing ellipsis', async () => {
    const conv2 = (await listConversations(FAMILY_A, listFakeDb(rows()))).find((s) => s.id === CONV2);

    expect(conv2?.title.length).toBeLessThanOrEqual(48);
    expect(conv2?.title.endsWith('…')).toBe(true);
  });

  it('counts only live turns and stamps lastMessageAt from the last live turn', async () => {
    const summaries = await listConversations(FAMILY_A, listFakeDb(rows()));
    const byId = new Map(summaries.map((s) => [s.id, s]));

    // conv2: 3 turns, one soft-deleted → 2 counted; last live turn is 11:06.
    expect(byId.get(CONV2)?.messageCount).toBe(2);
    expect(byId.get(CONV2)?.lastMessageAt).toBe(t('11:06').toISOString());
    // conv2 carries its note anchor; conv1 (general thread) carries none.
    expect(byId.get(CONV2)?.noteKey).toBe('action-abc');
    expect(byId.get(CONV1)?.noteKey).toBeNull();
  });

  it('returns an empty list when the family has no conversations', async () => {
    expect(await listConversations(FAMILY_A, listFakeDb([]))).toEqual([]);
  });
});

describe('getConversationTranscript', () => {
  it('returns the owned conversation timeline in order, scope-tagged', async () => {
    const t0 = new Date('2026-06-17T10:00:00Z');
    const t1 = new Date('2026-06-17T10:01:00Z');
    const db = transcriptFakeDb(
      [{ id: CONV1 }],
      [
        { id: 'm0', role: 'user', content: 'when do I start solids?', childId: 'child-1', topic: 'feeding', createdAt: t0 },
        { id: 'm1', role: 'assistant', content: 'around six months.', childId: 'child-1', topic: 'feeding', createdAt: t1 },
      ],
    );

    const transcript = await getConversationTranscript(FAMILY_A, CONV1, db);

    expect(transcript).toEqual([
      { id: 'm0', role: 'user', content: 'when do I start solids?', childId: 'child-1', topic: 'feeding', createdAt: t0.toISOString() },
      { id: 'm1', role: 'assistant', content: 'around six months.', childId: 'child-1', topic: 'feeding', createdAt: t1.toISOString() },
    ]);
  });
});
