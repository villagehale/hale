import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { removeDocument, type FetchLike, signDocumentUrl, storagePathFor, uploadDocument } from './storage.js';

/** The document categories the vault accepts (mockup: Health / Insurance / Other). */
export const DOC_KINDS = ['health', 'insurance', 'other'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** Hard server-side size cap on the DECODED buffer (413 above it). NOTE: on Vercel
 * the platform's ~4.5 MB request-body ceiling rejects larger uploads before this
 * route runs, so in prod the effective cap is the platform's; this bound is the
 * defense that holds everywhere else (tests, self-hosting, future config). */
export const MAX_DOC_BYTES = 10 * 1024 * 1024;

export const MAX_TITLE_LENGTH = 120;

/**
 * The accepted MIME allowlist → the leading magic bytes that prove it. A mobile
 * client can lie in the Content-Type, so the route validates the RAW bytes against
 * this table, not the declared type (rule: risks #1). HEIC has no single fixed
 * prefix (the 'ftyp' box sits at offset 4 with several brand codes), so it is
 * checked structurally in `sniffMime`, not by a flat prefix here.
 */
const MAGIC_PREFIXES: Record<string, readonly number[][]> = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
};

export const ACCEPTED_MIMES = [...Object.keys(MAGIC_PREFIXES), 'image/heic'] as const;

function startsWith(bytes: Buffer, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heif', 'mif1', 'hevc', 'msf1']);

/**
 * Determines the true MIME from the leading bytes, independent of the declared
 * Content-Type. Returns null when the bytes match no accepted type — the route
 * rejects with 415. HEIC is detected by its ISO-BMFF 'ftyp' box: bytes 4–7 spell
 * 'ftyp' and bytes 8–11 carry a HEIC brand.
 */
export function sniffMime(bytes: Buffer): (typeof ACCEPTED_MIMES)[number] | null {
  for (const [mime, prefixes] of Object.entries(MAGIC_PREFIXES)) {
    if (prefixes.some((p) => startsWith(bytes, p))) {
      return mime as (typeof ACCEPTED_MIMES)[number];
    }
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 4, 8) === 'ftyp' &&
    HEIC_BRANDS.has(bytes.toString('ascii', 8, 12))
  ) {
    return 'image/heic';
  }
  return null;
}

/** Collapses whitespace and trims a client title to a bounded plain-text label.
 * Never a filename source — the storage path is server-generated. Returns null for
 * an all-whitespace / empty title so the route rejects it. */
export function sanitizeTitle(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/** A document row flattened for the vault list. Never carries the storage path or
 * a URL — a URL is minted per-view through the [id]/url route. */
export interface DocumentView {
  id: string;
  childId: string | null;
  kind: string;
  title: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Rule #1 teen redaction for the Docs vault — the EXACT mirror of
 * recent-logs.dropTeenEpisodes. The table carries no teen flag, so the teen set is
 * derived LIVE from each child's DOB (deriveStage boundary 156mo).
 *
 * A doc uploaded by the REQUESTING parent (`authoredBy === requestingUserId`) is
 * always kept — a parent's own upload about their teen is the parent's content.
 * Otherwise a doc attributed to a teen child is the teen's own and is dropped; an
 * UNATTRIBUTED doc (childId null) the requester did NOT upload is dropped when the
 * family has any teenager (most-restrictive default). A family with no teen keeps
 * everything. Pure, no I/O — exported as _internal for unit-testability.
 */
function dropTeenDocuments<T extends { childId: string | null; authoredBy: string | null }>(
  docs: T[],
  children: ReadonlyArray<{ id: string; dateOfBirth: string }>,
  requestingUserId: string | null,
  now: Date = new Date(),
): T[] {
  const teenChildIds = new Set(
    children.filter((c) => deriveStage(c.dateOfBirth, now) === 'teenager').map((c) => c.id),
  );
  const familyHasTeen = teenChildIds.size > 0;
  return docs.filter((d) => {
    if (requestingUserId !== null && d.authoredBy === requestingUserId) return true;
    if (d.childId === null) return !familyHasTeen;
    return !teenChildIds.has(d.childId);
  });
}

/** The doc-row shape the read path pulls, before the teen gate + view mapping. */
interface DocRow {
  id: string;
  childId: string | null;
  authoredBy: string | null;
  kind: string;
  title: string;
  mime: string;
  sizeBytes: number;
  createdAt: Date;
}

async function familyChildren(
  database: Database,
  familyId: string,
): Promise<{ id: string; dateOfBirth: string }[]> {
  return database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
}

/**
 * Lists the family's live documents, most-recent first, with a 13+ child's docs
 * dropped (rule #1, via dropTeenDocuments). Injectable Database + ids so the list
 * is testable without the auth chain.
 */
export async function listDocuments(
  database: Database,
  familyId: string,
  requestingUserId: string | null,
): Promise<DocumentView[]> {
  const [children, rows] = await Promise.all([
    familyChildren(database, familyId),
    database
      .select({
        id: schema.childDocuments.id,
        childId: schema.childDocuments.childId,
        authoredBy: schema.childDocuments.uploadedBy,
        kind: schema.childDocuments.kind,
        title: schema.childDocuments.title,
        mime: schema.childDocuments.mime,
        sizeBytes: schema.childDocuments.sizeBytes,
        createdAt: schema.childDocuments.createdAt,
      })
      .from(schema.childDocuments)
      .where(
        and(
          eq(schema.childDocuments.familyId, familyId),
          isNull(schema.childDocuments.deletedAt),
        ),
      )
      .orderBy(desc(schema.childDocuments.createdAt)),
  ]);

  return dropTeenDocuments(rows as DocRow[], children, requestingUserId).map((row) => ({
    id: row.id,
    childId: row.childId,
    kind: row.kind,
    title: row.title,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * The already-validated fields of an upload — no client filename, no raw bytes
 * (those are handled by the storage adapter). childId is null for a family-wide doc.
 */
export interface DocumentInsert {
  familyId: string;
  childId: string | null;
  uploadedBy: string;
  kind: DocKind;
  title: string;
  mime: string;
  sizeBytes: number;
}

/**
 * The full upload: mints the docId, PUTs the bytes to the private bucket at the
 * server-generated path, then writes the DB row + its immutable audit_log row in
 * one transaction (rule #6). The audit row carries the doc id + kind ONLY — never
 * the title (which may carry PII) and never doc content (rule #1). The storage
 * upload happens BEFORE the transaction: a failed upload throws and never leaves a
 * DB row pointing at absent bytes.
 */
export async function createDocument(
  database: Database,
  insert: DocumentInsert,
  bytes: Buffer,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const docId = crypto.randomUUID();
  const storagePath = storagePathFor(insert.familyId, docId);

  await uploadDocument(storagePath, bytes, insert.mime, fetchImpl);

  await database.transaction(async (tx) => {
    await tx.insert(schema.childDocuments).values({
      id: docId,
      familyId: insert.familyId,
      childId: insert.childId,
      uploadedBy: insert.uploadedBy,
      kind: insert.kind,
      title: insert.title,
      storagePath,
      mime: insert.mime,
      sizeBytes: insert.sizeBytes,
    });
    await tx.insert(schema.auditLog).values({
      familyId: insert.familyId,
      actor: insert.uploadedBy,
      actionTaken: `document_uploaded_${insert.kind}`,
      targetTable: 'child_documents',
      targetId: docId,
    });
  });

  return docId;
}

/**
 * A LIVE document scoped to the family, carrying just what the signed-URL and
 * delete paths need (the storage path + the teen-gate fields). Returns null when
 * no such live row belongs to the family — the family-scope check that makes the
 * URL and delete routes 404 a foreign / removed doc (rule #1).
 */
export interface OwnedDocument {
  id: string;
  childId: string | null;
  authoredBy: string | null;
  storagePath: string;
  kind: string;
}

export async function loadOwnedDocument(
  database: Database,
  id: string,
  familyId: string,
): Promise<OwnedDocument | null> {
  const rows = await database
    .select({
      id: schema.childDocuments.id,
      childId: schema.childDocuments.childId,
      authoredBy: schema.childDocuments.uploadedBy,
      storagePath: schema.childDocuments.storagePath,
      kind: schema.childDocuments.kind,
    })
    .from(schema.childDocuments)
    .where(
      and(
        eq(schema.childDocuments.id, id),
        eq(schema.childDocuments.familyId, familyId),
        isNull(schema.childDocuments.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Whether a document is VISIBLE to the requesting parent under the teen gate —
 * reuses dropTeenDocuments on the single row so the URL route and the list share
 * ONE redaction rule (a signed URL must never be minted for a redacted doc, rule
 * #1). Live-derives the teen set from the family's children.
 */
export async function documentVisibleToRequester(
  database: Database,
  familyId: string,
  doc: OwnedDocument,
  requestingUserId: string | null,
): Promise<boolean> {
  const children = await familyChildren(database, familyId);
  const kept = dropTeenDocuments([doc], children, requestingUserId);
  return kept.length === 1;
}

/**
 * Mints a short-TTL signed URL for a document AND writes the immutable view-url
 * audit row (rule #6) — the caller has already confirmed visibility. The audit row
 * records the doc id + kind only (no title, no content).
 */
export async function signAndAuditDocument(
  database: Database,
  familyId: string,
  actor: string,
  doc: OwnedDocument,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const url = await signDocumentUrl(doc.storagePath, fetchImpl);
  await database.insert(schema.auditLog).values({
    familyId,
    actor,
    actionTaken: `document_view_url_${doc.kind}`,
    targetTable: 'child_documents',
    targetId: doc.id,
  });
  return url;
}

/**
 * Soft-deletes a document: stamps deleted_at (the row the audit trail references
 * stays intact, rules #6/#9), removes the bytes from the private bucket, and writes
 * the delete audit row — all family-scoped. Returns false when no live doc matches
 * (foreign / already-removed), writing nothing. The storage removal runs after the
 * DB update commits so a delete is never reported while the row still reads live.
 *
 * The delete re-applies the teen READ gate (rule #1): the teen set derives LIVE
 * from DOB, so a doc id listed to both parents while the child was 12 must not
 * remain a deletable — and existence-confirming — handle at 13. Redacted reads
 * as false → 404, indistinguishable from foreign; the uploader passes visibility.
 */
export async function softDeleteDocument(
  database: Database,
  id: string,
  familyId: string,
  actor: string,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<boolean> {
  const doc = await loadOwnedDocument(database, id, familyId);
  if (!doc) return false;
  if (!(await documentVisibleToRequester(database, familyId, doc, actor))) return false;

  await database.transaction(async (tx) => {
    await tx
      .update(schema.childDocuments)
      .set({ deletedAt: now })
      .where(
        and(eq(schema.childDocuments.id, id), eq(schema.childDocuments.familyId, familyId)),
      );
    await tx.insert(schema.auditLog).values({
      familyId,
      actor,
      actionTaken: `document_deleted_${doc.kind}`,
      targetTable: 'child_documents',
      targetId: id,
    });
  });

  await removeDocument(doc.storagePath, fetchImpl);
  return true;
}

export const _internal = { dropTeenDocuments };
