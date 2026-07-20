import type Anthropic from '@anthropic-ai/sdk';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { sniffMime } from '../docs/documents.js';
import {
  type FetchLike,
  downloadDocument,
  removeDocument,
  signDocumentUrl,
  uploadDocument,
} from '../docs/storage.js';
import { attachmentContentBlock } from './attachment-blocks.js';
import type { Db } from './conversation.js';

/**
 * The Ask Hale attachments store — the DB + storage side of a parent attaching a
 * photo/PDF to a coach message. Reuses the PROVEN Docs vault primitives: the SAME
 * private 'family-docs' Supabase Storage bucket (no new bucket), the SAME
 * service-key REST adapter, and the SAME byte-sniffed / fail-closed validation. The
 * ONLY differences are a `chat/{familyId}/{attachmentId}` path prefix and the chat
 * allowlist adding image/webp (which the Docs vault does not accept). Everything is
 * family-scoped (rule #1): a caller can only ever load/link/view their own family's
 * attachments.
 */

/** Hard server-side size cap on the DECODED buffer (413 above it) — mirrors the Docs
 * vault's MAX_DOC_BYTES. On Vercel the platform's ~4.5 MB request-body ceiling
 * rejects larger uploads first; this is the defense that holds everywhere else. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** At most 5 files per upload request (rule #1, most restrictive default). */
export const MAX_ATTACHMENTS_PER_REQUEST = 5;

export const CHAT_ATTACHMENT_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type ChatAttachmentMime = (typeof CHAT_ATTACHMENT_MIMES)[number];

/**
 * Determines the true MIME from the leading bytes (a client Content-Type is never
 * trusted — rule #1), across the chat allowlist. Reuses the Docs vault's sniffer for
 * jpeg/png/pdf and adds WebP, which the Docs vault does not accept: a WebP is an ISO
 * RIFF container whose bytes 0–3 spell 'RIFF' and bytes 8–11 spell 'WEBP'. Returns
 * null when the bytes match no accepted type — the route rejects with 415.
 *
 * Fail-closed (rule #1): the Docs sniffer ALSO recognizes HEIC, which is NOT in the
 * chat allowlist (the Anthropic image block cannot carry it), so a sniff result is
 * accepted only after an explicit membership check against CHAT_ATTACHMENT_MIMES —
 * never a blind cast. A HEIC therefore sniffs to a type that is dropped here → 415.
 */
export function sniffAttachmentMime(bytes: Buffer): ChatAttachmentMime | null {
  const base = sniffMime(bytes);
  for (const allowed of CHAT_ATTACHMENT_MIMES) {
    if (allowed === base) return allowed;
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** The server-generated object key — no client filename ever reaches it (rule #1). */
export function chatStoragePathFor(familyId: string, attachmentId: string): string {
  return `chat/${familyId}/${attachmentId}`;
}

/** The validated fields of one upload — no raw bytes (the adapter handles those). */
export interface ChatAttachmentInsert {
  familyId: string;
  uploadedBy: string;
  mime: ChatAttachmentMime;
  sizeBytes: number;
  originalName: string;
}

/** What the upload endpoint echoes back per stored file. */
export interface StoredAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  mime: string;
}

/**
 * Stores one attachment: mints the id, PUTs the bytes to the private bucket at the
 * server-generated chat path, then writes the DB row + its immutable audit_log row
 * in one transaction (rule #6). The audit row carries the attachment id ONLY — never
 * the originalName (which may be PII) and never the bytes (rule #1). The storage
 * upload happens BEFORE the transaction so a failed upload never leaves a row
 * pointing at absent bytes.
 */
export async function createChatAttachment(
  database: Database,
  insert: ChatAttachmentInsert,
  bytes: Buffer,
  fetchImpl: FetchLike = fetch,
): Promise<StoredAttachment> {
  const id = crypto.randomUUID();
  const storagePath = chatStoragePathFor(insert.familyId, id);

  await uploadDocument(storagePath, bytes, insert.mime, fetchImpl);

  await database.transaction(async (tx) => {
    await tx.insert(schema.chatAttachments).values({
      id,
      familyId: insert.familyId,
      storagePath,
      mime: insert.mime,
      sizeBytes: insert.sizeBytes,
      originalName: insert.originalName,
    });
    await tx.insert(schema.auditLog).values({
      familyId: insert.familyId,
      actor: insert.uploadedBy,
      actionTaken: 'chat_attachment_uploaded',
      targetTable: 'chat_attachments',
      targetId: id,
    });
  });

  return { id, name: insert.originalName, sizeBytes: insert.sizeBytes, mime: insert.mime };
}

/** A pending upload with no message is a not-yet-consumed attachment; after this TTL
 * the lifecycle sweep purges it (bytes + row) so a never-sent photo can't linger in
 * the bucket forever (rule #1). */
export const UNLINKED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The lifecycle sweep: purges every UNLINKED attachment (message_id IS NULL) older
 * than UNLINKED_ATTACHMENT_TTL_MS — a photo/PDF a parent uploaded but never sent. For
 * each, the bytes leave the bucket FIRST, then the row is deleted and an immutable
 * audit_log row is written (rule #6, actor 'system') in one transaction; a storage
 * failure aborts that row and leaves it for the next run rather than deleting a row
 * whose bytes still exist. Family scope is inherent — each row carries its family_id.
 * Idempotent: a row purged on one run is gone, so a re-run simply finds fewer.
 */
export async function sweepUnlinkedAttachments(
  database: Database,
  removeObject: (path: string) => Promise<void> = removeDocument,
  now: Date = new Date(),
): Promise<{ swept: number }> {
  const cutoff = new Date(now.getTime() - UNLINKED_ATTACHMENT_TTL_MS);
  const stale = await database
    .select({
      id: schema.chatAttachments.id,
      familyId: schema.chatAttachments.familyId,
      storagePath: schema.chatAttachments.storagePath,
    })
    .from(schema.chatAttachments)
    .where(
      and(
        isNull(schema.chatAttachments.messageId),
        lt(schema.chatAttachments.createdAt, cutoff),
      ),
    );

  let swept = 0;
  for (const att of stale) {
    await database.transaction(async (tx) => {
      // Re-assert unlinked INSIDE the transaction: a send may claim the attachment
      // between the listing above and this delete, and a linked attachment must
      // never lose its bytes. Claim the row first; only a successful claim removes
      // the object (same bytes-inside-tx tradeoff as the erase path: a storage
      // failure rolls the row back so the next sweep retries).
      const claimed = await tx
        .delete(schema.chatAttachments)
        .where(
          and(eq(schema.chatAttachments.id, att.id), isNull(schema.chatAttachments.messageId)),
        )
        .returning({ id: schema.chatAttachments.id });
      if (claimed.length === 0) return;
      await removeObject(att.storagePath);
      await tx.insert(schema.auditLog).values({
        familyId: att.familyId,
        actor: 'system',
        actionTaken: 'chat_attachment_swept',
        targetTable: 'chat_attachments',
        targetId: att.id,
      });
      swept += 1;
    });
  }

  return { swept };
}

/** A family's own attachment, carrying just what linking + block-building need. */
export interface OwnedChatAttachment {
  id: string;
  storagePath: string;
  mime: string;
}

/**
 * Loads the UNLINKED attachments among `ids` that belong to `familyId` (rule #1:
 * family-scoped, and message_id IS NULL so an already-consumed attachment can't be
 * re-attached to a second message). The caller compares the returned count against
 * the requested count: a shortfall means a foreign, unknown, or already-linked id
 * was passed — reject the whole send.
 */
export async function loadUnlinkedAttachments(
  database: Database,
  familyId: string,
  ids: string[],
): Promise<OwnedChatAttachment[]> {
  if (ids.length === 0) return [];
  return database
    .select({
      id: schema.chatAttachments.id,
      storagePath: schema.chatAttachments.storagePath,
      mime: schema.chatAttachments.mime,
    })
    .from(schema.chatAttachments)
    .where(
      and(
        inArray(schema.chatAttachments.id, ids),
        eq(schema.chatAttachments.familyId, familyId),
        isNull(schema.chatAttachments.messageId),
      ),
    );
}

/** Thrown when a turn's attachments cannot all be consumed atomically — a foreign,
 * unknown, or already-linked id (e.g. a concurrent double-send lost the race). The
 * enclosing transaction rolls back, so the user message is NOT persisted and the
 * model is never called with the bytes. */
export class AttachmentConsumptionError extends Error {
  constructor(readonly requested: number, readonly linked: number) {
    super(`attachment consumption failed: linked ${linked} of ${requested}`);
    this.name = 'AttachmentConsumptionError';
  }
}

/**
 * Links attachments to the persisted user message — a single conditional UPDATE that
 * sets message_id + conversation_id ONLY on the family's own still-unlinked rows
 * (WHERE id = ANY, family_id =, message_id IS NULL) and RETURNs the ids it actually
 * claimed. Run inside the same transaction as the user-message insert: because the
 * `message_id IS NULL` guard is evaluated atomically, a concurrent double-send of the
 * same attachment has exactly one winner — the loser gets back fewer ids than it
 * requested and the caller aborts before any model call (rule #1). Returns the linked
 * ids so the caller can verify the count.
 */
export async function linkAttachmentsToMessage(
  database: Db,
  familyId: string,
  ids: string[],
  messageId: string,
  conversationId: string,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const linked = await database
    .update(schema.chatAttachments)
    .set({ messageId, conversationId })
    .where(
      and(
        inArray(schema.chatAttachments.id, ids),
        eq(schema.chatAttachments.familyId, familyId),
        isNull(schema.chatAttachments.messageId),
      ),
    )
    .returning({ id: schema.chatAttachments.id });
  return linked.map((row) => row.id);
}

/**
 * A family-scoped attachment for the signed-URL read path. Returns null when no such
 * row belongs to the family — the check that makes the URL route 404 a foreign id
 * (rule #1), indistinguishable from an unknown one.
 */
export async function loadOwnedAttachment(
  database: Database,
  id: string,
  familyId: string,
): Promise<OwnedChatAttachment | null> {
  const rows = await database
    .select({
      id: schema.chatAttachments.id,
      storagePath: schema.chatAttachments.storagePath,
      mime: schema.chatAttachments.mime,
    })
    .from(schema.chatAttachments)
    .where(
      and(eq(schema.chatAttachments.id, id), eq(schema.chatAttachments.familyId, familyId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Mints a short-TTL signed URL (600s, via the shared Docs adapter) for one attachment
 * AND writes the immutable view-url audit row (rule #6) — the caller has already
 * confirmed family ownership. The audit row records the attachment id only (never the
 * originalName or bytes, rule #1).
 */
export async function signAndAuditAttachment(
  database: Database,
  familyId: string,
  actor: string,
  attachment: OwnedChatAttachment,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const url = await signDocumentUrl(attachment.storagePath, fetchImpl);
  await database.insert(schema.auditLog).values({
    familyId,
    actor,
    actionTaken: 'chat_attachment_view_url',
    targetTable: 'chat_attachments',
    targetId: attachment.id,
  });
  return url;
}

/**
 * Bounds the client filename to a safe display label (never a path/log/trace source).
 * Strips EVERY C0/C1 control char (not just \r\n\t) so no control byte can forge a
 * log line, and removes the Unicode bidi-format chars (RLO/LRO/PDF + the isolate
 * controls U+2066–U+2069) that could reverse the rendered name to spoof an extension.
 * Callers must sanitize BEFORE uploading bytes so a name that reduces to nothing can
 * never orphan a stored object.
 */
export function sanitizeOriginalName(raw: string): string {
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/**
 * Fetches each attachment's bytes from the private bucket and builds its native
 * content block for the CURRENT turn's user message. Server-side only: the bytes
 * reach the MODEL, never a log or the client. Pure block-mapping is delegated to
 * attachmentContentBlock so it stays unit-testable without storage.
 */
export async function buildAttachmentBlocks(
  attachments: OwnedChatAttachment[],
  fetchImpl: FetchLike = fetch,
): Promise<Anthropic.ContentBlockParam[]> {
  return Promise.all(
    attachments.map(async (a) => attachmentContentBlock(await downloadDocument(a.storagePath, fetchImpl), a.mime)),
  );
}
