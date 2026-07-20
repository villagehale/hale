import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askHale } from './agent';
import { AttachmentConsumptionError } from './attachments';

/**
 * The ATOMIC attachment-consume contract (security remediation). The user-message
 * insert and the conditional link-UPDATE run in ONE transaction, and the send aborts
 * unless the UPDATE claims EVERY requested attachment — so a concurrent double-send
 * of the same file has exactly one winner, and the loser's model call never receives
 * the bytes (rule #1). The fake db models the `message_id IS NULL` guard by tracking
 * which attachment ids are still unlinked and committing the transaction buffer only
 * when the callback resolves (a throw = rollback, so the message row is discarded).
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const ATT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUPABASE_URL = 'https://proj.supabase.co';

function usage(input: number, output: number): Anthropic.Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
  };
}

function textMessage(text: string): Anthropic.Message {
  return {
    id: 'msg-text',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null } as Anthropic.TextBlock],
    usage: usage(100, 30),
  };
}

/** A non-streaming fake whose `create` spy records the messages it was handed, so a
 * test can assert whether (and with what content) the model was ever called. */
function fakeClient(): { client: AgentClient; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => textMessage('here is what I see in the photo.'));
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

interface Committed {
  messages: Array<{ id: string; role: string; content: string }>;
  conversations: unknown[];
  agentRuns: unknown[];
}

/**
 * A fake Database that supports transactions with buffer-and-commit semantics: writes
 * inside a transaction land in a local buffer and are flushed to `committed` only if
 * the callback resolves. `unlinked` is the set of attachment ids the link-UPDATE may
 * still claim — the winner claims (and removes) them, so a later call claims none.
 */
function makeFake(unlinkedIds: string[]) {
  const committed: Committed = { messages: [], conversations: [], agentRuns: [] };
  const unlinked = new Set(unlinkedIds);

  const rowsFor = (t: unknown): unknown[] =>
    t === schema.families
      ? [{ planTier: 'free', city: null, province: null, country: null }]
      : [];

  const emptyChain = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), {
      limit: async () => rows.slice(0, 1),
      orderBy: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
    });

  function makeHandle(buf: Committed & { claim: string[] }) {
    return {
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          if (table === schema.conversations) {
            buf.conversations.push(row);
            return { returning: async () => [{ id: CONVERSATION_ID }] };
          }
          if (table === schema.messages) {
            const id = `msg-${committed.messages.length + buf.messages.length + 1}`;
            buf.messages.push({ id, role: row.role as string, content: row.content as string });
            return { returning: async () => [{ id }] };
          }
          if (table === schema.auditLog) return Promise.resolve(undefined);
          if (table === schema.agentRuns) {
            buf.agentRuns.push(row);
            return { returning: async () => [{ id: 'run-1' }] };
          }
          throw new Error('unexpected insert target');
        },
      }),
      update: (table: unknown) => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              if (table !== schema.chatAttachments) return [];
              // The `message_id IS NULL` guard, atomically: claim whatever is still
              // unlinked (the test only ever offers the one relevant id).
              buf.claim = [...unlinked];
              return buf.claim.map((id) => ({ id }));
            },
          }),
        }),
      }),
      select: () => ({
        from: (table: unknown) => {
          const chain: Record<string, unknown> = {
            where: () => emptyChain(rowsFor(table)),
            innerJoin: () => chain,
            orderBy: () => emptyChain(rowsFor(table)),
          };
          return chain;
        },
      }),
    };
  }

  // The base (non-transaction) handle writes straight to `committed`.
  const base = makeHandle(Object.assign(committed, { claim: [] })) as ReturnType<
    typeof makeHandle
  > & {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  base.transaction = async (fn) => {
    const buf: Committed & { claim: string[] } = {
      messages: [],
      conversations: [],
      agentRuns: [],
      claim: [],
    };
    const result = await fn(makeHandle(buf)); // a throw here skips the commit below
    committed.messages.push(...buf.messages);
    committed.conversations.push(...buf.conversations);
    committed.agentRuns.push(...buf.agentRuns);
    for (const id of buf.claim) unlinked.delete(id);
    return result;
  };

  return { db: base as unknown as Database, committed, unlinked };
}

function stubDownloadFetch(): ReturnType<typeof vi.fn> {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
  const f = vi.fn(async () => new Response(new Uint8Array(jpeg), { status: 200 }));
  vi.stubGlobal('fetch', f);
  return f;
}

function attachment() {
  return { id: ATT, storagePath: `chat/${FAMILY_ID}/${ATT}`, mime: 'image/jpeg' };
}

function input() {
  return {
    familyId: FAMILY_ID,
    question: 'what is this rash?',
    intent: null,
    conversationId: null,
    focusedChildId: null,
    actor: 'user-1',
    noteKey: null,
    sourceNote: null,
    attachments: [attachment()],
  };
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('askHale — atomic attachment consumption (rule #1)', () => {
  it('aborts transactionally when the link claims fewer than requested: no model call, no persisted turn, no byte fetch', async () => {
    // The attachment is NOT among the unlinked ids (already consumed), so the atomic
    // UPDATE claims 0 of 1 → the send must abort inside the transaction.
    const { db, committed } = makeFake([]);
    const download = stubDownloadFetch();
    const { client, create } = fakeClient();

    await expect(askHale(input(), db, client)).rejects.toBeInstanceOf(AttachmentConsumptionError);

    // The user message was rolled back with the transaction (never persisted).
    expect(committed.messages).toEqual([]);
    // The model was never called, and the bytes were never even fetched from the bucket.
    expect(create).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('concurrent double-send: the winner links + reaches the model with the bytes; the loser is rejected and never calls the model', async () => {
    // One unlinked attachment shared across both sends — the classic race.
    const { db, committed } = makeFake([ATT]);
    stubDownloadFetch();

    // Winner: claims the attachment, so the send proceeds and the model is called with
    // the image block (the bytes reach the model).
    const winner = fakeClient();
    const won = await askHale(input(), db, winner.client);
    expect(won.answer).toBe('here is what I see in the photo.');
    expect(winner.create).toHaveBeenCalledTimes(1);
    const firstUser = winner.create.mock.calls[0]?.[0]?.messages?.[0];
    const content = firstUser?.content as Anthropic.ContentBlockParam[];
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((b) => b.type === 'image')).toBe(true);
    expect(committed.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    // Loser: the same attachment id is now linked, so its atomic UPDATE claims 0 → the
    // send is rejected and its model client is never touched with the bytes.
    const loser = fakeClient();
    await expect(askHale(input(), db, loser.client)).rejects.toBeInstanceOf(
      AttachmentConsumptionError,
    );
    expect(loser.create).not.toHaveBeenCalled();
  });
});
