import type { Database } from '@hale/db';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  linkAttachmentsToMessage,
  loadUnlinkedAttachments,
  sanitizeOriginalName,
  sniffAttachmentMime,
} from './attachments';

/**
 * The attachments store over a fake db that EVALUATES the real Drizzle WHERE (eq +
 * inArray + isNull, walked from queryChunks), so family scoping and the unlinked
 * guard are actually exercised — not stipulated. Load-bearing: loadUnlinkedAttachments
 * MUST drop a foreign-family or already-linked id (rule #1), and link MUST scope its
 * write the same way while stamping message_id + conversation_id.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '99999999-9999-4999-8999-999999999999';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LINKED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MSG = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CONV = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

interface Row {
  id: string;
  familyId: string;
  messageId: string | null;
  conversationId: string | null;
  storagePath: string;
  mime: string;
}

interface Constraints {
  eq: Record<string, unknown>;
  inArray: Record<string, unknown[]>;
  isNull: Set<string>;
}

function walk(sql: SQL, out: Constraints): Constraints {
  const chunks = (sql as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  let lastCol: string | null = null;
  for (const chunk of chunks) {
    if (Array.isArray(chunk)) {
      if (lastCol) out.inArray[lastCol] = chunk.map((p) => (p as { value: unknown }).value);
      lastCol = null;
      continue;
    }
    const c = chunk as {
      constructor?: { name?: string };
      name?: string;
      table?: unknown;
      value?: unknown;
    };
    if (c?.constructor?.name === 'SQL') {
      walk(chunk as SQL, out);
      lastCol = null;
      continue;
    }
    if (c?.constructor?.name === 'StringChunk' && String((c as { value?: unknown }).value).includes('is null') && lastCol) {
      out.isNull.add(lastCol);
      lastCol = null;
      continue;
    }
    if (typeof c?.name === 'string' && c.table) {
      lastCol = c.name;
      continue;
    }
    if (c?.constructor?.name === 'Param' && lastCol) {
      out.eq[lastCol] = c.value;
      lastCol = null;
    }
  }
  return out;
}

function matches(row: Row, sql: SQL): boolean {
  const c = walk(sql, { eq: {}, inArray: {}, isNull: new Set() });
  if (c.eq.family_id !== undefined && row.familyId !== c.eq.family_id) return false;
  if (c.eq.id !== undefined && row.id !== c.eq.id) return false;
  if (c.inArray.id && !c.inArray.id.includes(row.id)) return false;
  if (c.isNull.has('message_id') && row.messageId !== null) return false;
  return true;
}

function fakeDb(rows: Row[], capture: { updates: { patch: Record<string, unknown>; ids: string[] }[] }): Database {
  const handle = {
    select: () => ({
      from: () => ({
        where: (sql: SQL) =>
          Promise.resolve(
            rows
              .filter((r) => matches(r, sql))
              .map((r) => ({ id: r.id, storagePath: r.storagePath, mime: r.mime })),
          ),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (sql: SQL) => {
          const hit = rows.filter((r) => matches(r, sql));
          capture.updates.push({ patch, ids: hit.map((r) => r.id) });
          return { returning: async () => hit.map((r) => ({ id: r.id })) };
        },
      }),
    }),
  };
  return handle as unknown as Database;
}

function row(over: Partial<Row>): Row {
  return {
    id: A,
    familyId: FAMILY,
    messageId: null,
    conversationId: null,
    storagePath: `chat/${FAMILY}/${A}`,
    mime: 'image/jpeg',
    ...over,
  };
}

describe('sniffAttachmentMime', () => {
  it('rejects a file whose bytes match no accepted type (junk / a spoofed extension) → null', () => {
    expect(sniffAttachmentMime(Buffer.from('this is not an image at all', 'ascii'))).toBeNull();
  });

  it('rejects a ZIP and an SVG — both outside the allowlist', () => {
    expect(sniffAttachmentMime(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // PK\x03\x04
    expect(sniffAttachmentMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">', 'ascii'))).toBeNull();
  });

  it('accepts the chat allowlist by MAGIC bytes: jpeg, png, webp, pdf', () => {
    expect(sniffAttachmentMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffAttachmentMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    // RIFF....WEBP — the type the Docs vault does NOT accept but chat does.
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
    expect(sniffAttachmentMime(webp)).toBe('image/webp');
    expect(sniffAttachmentMime(Buffer.from('%PDF-1.7', 'ascii'))).toBe('application/pdf');
  });

  it('rejects HEIC — the Docs sniffer recognizes it, but chat fails closed on it → null', () => {
    // The Anthropic image block cannot carry HEIC, so it must never enter the chat
    // allowlist (else it would silently degrade to a useless text marker). The
    // membership check against CHAT_ATTACHMENT_MIMES drops it even though sniffMime
    // identifies it.
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('ftypheic')]);
    expect(sniffAttachmentMime(heic)).toBeNull();
  });
});

describe('sanitizeOriginalName — a safe display label (rule #1)', () => {
  const RLO = String.fromCharCode(0x202e);
  const LRI = String.fromCharCode(0x2066);
  const PDI = String.fromCharCode(0x2069);

  it('collapses ALL C0/C1 control chars to spaces, not just \\r\\n\\t', () => {
    // NUL, bell, vertical tab, escape (C0) and NEL (U+0085, C1) between letters —
    // each collapses so no control byte survives into a log or display line.
    const raw = `a${String.fromCharCode(0)}b${String.fromCharCode(7)}c${String.fromCharCode(11)}d${String.fromCharCode(27)}e${String.fromCharCode(0x85)}f`;
    expect(sanitizeOriginalName(raw)).toBe('a b c d e f');
  });

  it('removes Unicode bidi-format chars that could spoof the displayed name', () => {
    // RLO + the isolate controls reverse a filename so "gpj.exe" renders as
    // "exe.jpg"; they must not survive.
    const raw = `invoice${RLO}gpj.exe${PDI}.pdf`;
    expect(sanitizeOriginalName(raw)).toBe('invoicegpj.exe.pdf');
  });

  it('falls back to "attachment" when nothing printable remains', () => {
    expect(sanitizeOriginalName(` ${LRI}${PDI}`)).toBe('attachment');
  });
});

describe('loadUnlinkedAttachments — family-scoped + unlinked (rule #1)', () => {
  it("drops a foreign family's id and an already-linked id; keeps only own unlinked ids", async () => {
    const rows = [
      row({ id: A }),
      row({ id: B }),
      row({ id: FOREIGN, familyId: OTHER_FAMILY }),
      row({ id: LINKED, messageId: MSG, conversationId: CONV }),
    ];
    const db = fakeDb(rows, { updates: [] });
    const out = await loadUnlinkedAttachments(db, FAMILY, [A, B, FOREIGN, LINKED]);
    expect(out.map((r) => r.id).sort()).toEqual([A, B].sort());
  });

  it('returns [] for an empty id list without querying', async () => {
    const db = fakeDb([row({})], { updates: [] });
    expect(await loadUnlinkedAttachments(db, FAMILY, [])).toEqual([]);
  });
});

describe('linkAttachmentsToMessage — stamps messageId + conversationId, family-scoped', () => {
  it('sets both foreign keys and only touches own unlinked rows among the ids', async () => {
    const rows = [
      row({ id: A }),
      row({ id: FOREIGN, familyId: OTHER_FAMILY }),
      row({ id: LINKED, messageId: 'oldmsg' }),
    ];
    const capture = { updates: [] as { patch: Record<string, unknown>; ids: string[] }[] };
    const db = fakeDb(rows, capture);

    const linked = await linkAttachmentsToMessage(db, FAMILY, [A, FOREIGN, LINKED], MSG, CONV);

    expect(capture.updates).toHaveLength(1);
    expect(capture.updates[0]?.patch).toEqual({ messageId: MSG, conversationId: CONV });
    // Foreign-family and already-linked rows are excluded by the WHERE.
    expect(capture.updates[0]?.ids).toEqual([A]);
    // RETURNING gives back exactly the ids it claimed — the count the caller verifies.
    expect(linked).toEqual([A]);
  });
});
