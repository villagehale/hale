import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@hale/db';
import { loadLatestThread, resolveLatestConversationForFamily } from './conversation';

/**
 * Rehydration path for Ask Hale: on page load the family's most recent thread is
 * resolved and its messages replayed, so visible history survives a refresh. The
 * read is family-scoped (rule #1) — a thread is only ever resolved for its owning
 * family. A fake db serves the rows; no real infrastructure is touched.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

interface TimelineRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  childId: string | null;
  topic: string | null;
  createdAt: Date;
}

interface SelectStub {
  conversationRows: Array<{ id: string }>;
  messageRows: TimelineRow[];
}

/**
 * A fake Database that records which family the conversation lookup was scoped to
 * and serves the configured conversation/message rows. The conversation read is
 * `select → from → where → orderBy → limit`; the transcript read is
 * `select → from → where → orderBy`.
 */
function fakeDb(stub: SelectStub, capture?: { familyId?: unknown }): Database {
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.conversations) {
          return {
            where: (clause: unknown) => {
              if (capture) capture.familyId = clause;
              return {
                orderBy: () => ({
                  limit: async () => stub.conversationRows,
                }),
              };
            },
          };
        }
        if (table === schema.messages) {
          return {
            where: () => ({
              orderBy: async () => stub.messageRows,
            }),
          };
        }
        throw new Error('unexpected select target');
      },
    }),
  };
  return db as unknown as Database;
}

describe('resolveLatestConversationForFamily', () => {
  it('returns the most recent conversation id owned by the family', async () => {
    const db = fakeDb({ conversationRows: [{ id: CONVERSATION_ID }], messageRows: [] });

    const id = await resolveLatestConversationForFamily(FAMILY_ID, db);

    expect(id).toBe(CONVERSATION_ID);
  });

  it('returns null when the family has no conversations yet', async () => {
    const db = fakeDb({ conversationRows: [], messageRows: [] });

    const id = await resolveLatestConversationForFamily(FAMILY_ID, db);

    expect(id).toBeNull();
  });

  it('scopes the lookup to the requesting family (rule #1)', async () => {
    const capture: { familyId?: unknown } = {};
    const db = fakeDb({ conversationRows: [{ id: CONVERSATION_ID }], messageRows: [] }, capture);

    await resolveLatestConversationForFamily(FAMILY_ID, db);

    expect(capture.familyId).toBeDefined();
  });
});

describe('loadLatestThread', () => {
  it('rehydrates the latest conversation with its scope-tagged timeline in order', async () => {
    const t0 = new Date('2026-06-17T10:00:00Z');
    const t1 = new Date('2026-06-17T10:01:00Z');
    const db = fakeDb({
      conversationRows: [{ id: CONVERSATION_ID }],
      messageRows: [
        {
          id: 'm0',
          role: 'user',
          content: 'when do I start solids?',
          childId: 'child-1',
          topic: 'feeding',
          createdAt: t0,
        },
        {
          id: 'm1',
          role: 'assistant',
          content: 'around six months is the common window.',
          childId: 'child-1',
          topic: 'feeding',
          createdAt: t1,
        },
      ],
    });

    const thread = await loadLatestThread(FAMILY_ID, db);

    expect(thread).not.toBeNull();
    expect(thread?.conversationId).toBe(CONVERSATION_ID);
    // The timeline carries scope (child + topic) for filtering, not just text.
    expect(thread?.timeline).toEqual([
      {
        id: 'm0',
        role: 'user',
        content: 'when do I start solids?',
        childId: 'child-1',
        topic: 'feeding',
        createdAt: t0.toISOString(),
      },
      {
        id: 'm1',
        role: 'assistant',
        content: 'around six months is the common window.',
        childId: 'child-1',
        topic: 'feeding',
        createdAt: t1.toISOString(),
      },
    ]);
  });

  it('returns null when the family has no thread to rehydrate', async () => {
    const db = fakeDb({ conversationRows: [], messageRows: [] });

    const thread = await loadLatestThread(FAMILY_ID, db);

    expect(thread).toBeNull();
  });
});
