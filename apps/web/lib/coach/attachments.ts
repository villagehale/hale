import type Anthropic from '@anthropic-ai/sdk';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { sniffMime } from '../docs/documents.js';
import {
  type FetchLike,
  downloadDocument,
  signDocumentUrl,
  uploadDocument,
} from '../docs/storage.js';
import { attachmentContentBlock } from './attachment-blocks.js';

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
  'image/heic',
  'application/pdf',
] as const;
export type ChatAttachmentMime = (typeof CHAT_ATTACHMENT_MIMES)[number];

/**
 * Determines the true MIME from the leading bytes (a client Content-Type is never
 * trusted — rule #1), across the chat allowlist. Reuses the Docs vault's sniffer for
 * jpeg/png/heic/pdf and adds WebP, which the Docs vault does not accept: a WebP is an
 * ISO RIFF container whose bytes 0–3 spell 'RIFF' and bytes 8–11 spell 'WEBP'.
 * Returns null when the bytes match no accepted type — the route rejects with 415.
 */
export function sniffAttachmentMime(bytes: Buffer): ChatAttachmentMime | null {
  // sniffMime is typed `string | null` (its ACCEPTED_MIMES const widens), but it only
  // ever returns jpeg/png/heic/pdf — all members of the chat allowlist.
  const base = sniffMime(bytes) as ChatAttachmentMime | null;
  if (base) return base;
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

/**
 * Links attachments to the persisted user message — sets message_id + conversation_id
 * so the turn owns them and they can never be consumed again. Family-scoped and
 * only-if-unlinked (rule #1): the WHERE keys on (id, family_id, message_id IS NULL),
 * so a foreign or already-linked row is untouched.
 */
export async function linkAttachmentsToMessage(
  database: Database,
  familyId: string,
  ids: string[],
  messageId: string,
  conversationId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await database
    .update(schema.chatAttachments)
    .set({ messageId, conversationId })
    .where(
      and(
        inArray(schema.chatAttachments.id, ids),
        eq(schema.chatAttachments.familyId, familyId),
        isNull(schema.chatAttachments.messageId),
      ),
    );
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

/** Bounds the client filename to a safe display label (never a path/log/trace source). */
export function sanitizeOriginalName(raw: string): string {
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 255);
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
