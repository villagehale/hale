import type { Database } from '@hale/db';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { UNLINKED_ATTACHMENT_TTL_MS, sweepUnlinkedAttachments } from './attachments';

/**
 * The unlinked-attachment lifecycle sweep over a fake db that EVALUATES the real
 * Drizzle WHERE (isNull(message_id) + lt(created_at, cutoff)), so the sweep's filter
 * is actually exercised — a linked row and a still-fresh unlinked row must both be
 * left alone, and only the stale, never-sent uploads purged (bytes + row + audit).
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-07-19T12:00:00.000Z');
const STALE = new Date(NOW.getTime() - UNLINKED_ATTACHMENT_TTL_MS - 60_000); // > TTL old
const FRESH = new Date(NOW.getTime() - 60_000); // uploaded a minute ago

interface Row {
  id: string;
  familyId: string;
  messageId: string | null;
  createdAt: Date;
  storagePath: string;
}

/** Walks the SQL WHERE to extract: whether message_id IS NULL is required, the
 * created_at upper bound (the lt Param), and any eq(id) (the per-row delete). */
function constraints(sql: SQL): { isNullMessage: boolean; createdBefore?: Date; eqId?: string } {
  const chunks = (sql as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  const out: { isNullMessage: boolean; createdBefore?: Date; eqId?: string } = {
    isNullMessage: false,
  };
  let lastCol: string | null = null;
  const walk = (list: unknown[]) => {
    for (const chunk of list) {
      const c = chunk as {
        constructor?: { name?: string };
        name?: string;
        table?: unknown;
        value?: unknown;
        queryChunks?: unknown[];
      };
      if (c?.constructor?.name === 'SQL') {
        walk((c as { queryChunks?: unknown[] }).queryChunks ?? []);
        lastCol = null;
        continue;
      }
      if (
        c?.constructor?.name === 'StringChunk' &&
        String(c.value).includes('is null') &&
        lastCol === 'message_id'
      ) {
        out.isNullMessage = true;
        lastCol = null;
        continue;
      }
      if (typeof c?.name === 'string' && c.table) {
        lastCol = c.name;
        continue;
      }
      if (c?.constructor?.name === 'Param' && lastCol) {
        if (lastCol === 'created_at') out.createdBefore = c.value as Date;
        if (lastCol === 'id') out.eqId = c.value as string;
        lastCol = null;
      }
    }
  };
  walk(chunks);
  return out;
}

function matchesSelect(row: Row, sql: SQL): boolean {
  const c = constraints(sql);
  if (c.isNullMessage && row.messageId !== null) return false;
  if (c.createdBefore && !(row.createdAt < c.createdBefore)) return false;
  return true;
}

function fakeDb(rows: Row[]) {
  const removed: string[] = [];
  const deletedIds: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const removeObject = vi.fn(async (path: string) => {
    removed.push(path);
  });

  const tx = {
    delete: () => ({
      where: async (sql: SQL) => {
        const id = constraints(sql).eqId;
        if (id) deletedIds.push(id);
      },
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        audits.push(row);
      },
    }),
  };

  const db = {
    select: () => ({
      from: () => ({
        where: async (sql: SQL) =>
          rows
            .filter((r) => matchesSelect(r, sql))
            .map((r) => ({ id: r.id, familyId: r.familyId, storagePath: r.storagePath })),
      }),
    }),
    transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  } as unknown as Database;

  return { db, removeObject, spies: { removed, deletedIds, audits } };
}

function row(over: Partial<Row>): Row {
  const id = over.id ?? 'x';
  return {
    id,
    familyId: FAMILY,
    messageId: null,
    createdAt: STALE,
    storagePath: `chat/${FAMILY}/${id}`,
    ...over,
  };
}

describe('sweepUnlinkedAttachments — purges only stale, never-sent uploads (rule #1)', () => {
  it('deletes the bytes + row + writes an audit row for each stale unlinked attachment, and leaves linked/fresh rows alone', async () => {
    const rows = [
      row({ id: 'stale-a', createdAt: STALE, messageId: null }),
      row({ id: 'stale-b', createdAt: STALE, messageId: null }),
      // Linked (consumed into a message) — never swept, even if old.
      row({ id: 'linked', createdAt: STALE, messageId: 'msg-1' }),
      // Unlinked but uploaded a minute ago — still within its grace window.
      row({ id: 'fresh', createdAt: FRESH, messageId: null }),
    ];
    const { db, removeObject, spies } = fakeDb(rows);

    const result = await sweepUnlinkedAttachments(db, removeObject, NOW);

    expect(result.swept).toBe(2);
    // Only the two stale, unlinked objects had their bytes removed and rows deleted.
    expect(removeObject.mock.calls.map((c) => c[0]).sort()).toEqual(
      [`chat/${FAMILY}/stale-a`, `chat/${FAMILY}/stale-b`].sort(),
    );
    expect(spies.deletedIds.sort()).toEqual(['stale-a', 'stale-b']);
    // One immutable audit row per purge (rule #6), actor 'system', no original name.
    expect(spies.audits).toHaveLength(2);
    expect(spies.audits[0]).toMatchObject({
      familyId: FAMILY,
      actor: 'system',
      actionTaken: 'chat_attachment_swept',
      targetTable: 'chat_attachments',
    });
  });

  it('sweeps nothing when every unlinked upload is still fresh', async () => {
    const { db, removeObject, spies } = fakeDb([row({ id: 'fresh', createdAt: FRESH })]);
    const result = await sweepUnlinkedAttachments(db, removeObject, NOW);
    expect(result.swept).toBe(0);
    expect(removeObject).not.toHaveBeenCalled();
    expect(spies.audits).toEqual([]);
  });
});
