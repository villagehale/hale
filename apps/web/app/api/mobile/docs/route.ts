import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { childBelongsToFamily } from '~/lib/companion/log-write';
import { db } from '~/lib/db';
import {
  createDocument,
  DOC_KINDS,
  type DocKind,
  listDocuments,
  MAX_DOC_BYTES,
  sanitizeTitle,
  sniffMime,
} from '~/lib/docs/documents';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import type { MobileDocsResponse, MobileDocUploadResponse } from '../types';

// Node runtime: the docs lib uses the Drizzle client and Buffer byte-sniffing.
export const runtime = 'nodejs';

function isDocKind(value: unknown): value is DocKind {
  return typeof value === 'string' && (DOC_KINDS as readonly string[]).includes(value);
}

/**
 * GET /api/mobile/docs — the family's Docs vault, most-recent first, with a 13+
 * child's docs dropped for anyone but their uploader (rule #1, via listDocuments's
 * shared teen gate). No storage path or URL travels here — the viewer mints a
 * short-TTL signed URL per document through /docs/[id]/url.
 *
 * Auth() is the consent gate (rule #4): signed-out → 401. An authenticated user
 * with no resolved family (onboarding incomplete) → 403, matching the companion
 * routes — never a fabricated family.
 */
export async function GET(): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const database = db();
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const requestingUserId = await resolveUserIdForUser(session.user.id, database);
  const documents = await listDocuments(database, familyId, requestingUserId);

  const body: MobileDocsResponse = { documents };
  return NextResponse.json(body);
}

/**
 * POST /api/mobile/docs — upload a document to the private vault. Multipart
 * formData: file + kind (health|insurance|other) + title + optional childId.
 *
 * Server-side validation, all fail-closed (rule #1, most restrictive): the MIME is
 * SNIFFED from the raw bytes (a client Content-Type is never trusted) against the
 * images + PDF allowlist → 415 on a miss; the decoded size is capped at
 * MAX_DOC_BYTES → 413; the title is sanitized to a bounded plain-text label → 400
 * when empty. The client filename NEVER reaches the storage key — createDocument
 * mints the docId and derives the path {familyId}/{docId} (no PII in the path).
 * createDocument writes the row + its immutable audit_log row (doc id + kind only,
 * never the title, rule #6) in one transaction after the bytes land.
 */
export async function POST(req: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const file = form.get('file');
  const kind = form.get('kind');
  const rawTitle = form.get('title');
  const childIdField = form.get('childId');

  if (!(file instanceof File) || typeof rawTitle !== 'string' || !isDocKind(kind)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const title = sanitizeTitle(rawTitle);
  if (!title) {
    return NextResponse.json({ error: 'invalid_title' }, { status: 400 });
  }

  const childId = typeof childIdField === 'string' && childIdField.length > 0 ? childIdField : null;

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength > MAX_DOC_BYTES) {
    return NextResponse.json({ error: 'file_too_large' }, { status: 413 });
  }

  // Sniff the true type from the leading bytes — a mobile client can lie in the
  // Content-Type, so the declared type is never trusted (rule #1).
  const mime = sniffMime(bytes);
  if (!mime) {
    return NextResponse.json({ error: 'unsupported_type' }, { status: 415 });
  }

  const database = db();
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  // An audited upload needs a real actor (rule #6): a signed-in user with no
  // mirrored users row (onboarding incomplete) can't be the uploader → fail closed.
  const uploadedBy = await resolveUserIdForUser(session.user.id, database);
  if (!uploadedBy) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  // A childId, when given, must belong to the family — scoping the doc to a foreign
  // child would misattribute it (rule #1). listDocuments's teen gate keys off childId,
  // so a spoofed foreign child id must never be accepted.
  if (childId && !(await childBelongsToFamily(database, familyId, childId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const id = await createDocument(database, {
    familyId,
    childId,
    uploadedBy,
    kind,
    title,
    mime,
    sizeBytes: bytes.byteLength,
  }, bytes);

  const body: MobileDocUploadResponse = { status: 'uploaded', id };
  return NextResponse.json(body, { status: 201 });
}
