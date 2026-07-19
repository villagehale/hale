import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import {
  type ChatAttachmentMime,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_REQUEST,
  createChatAttachment,
  sanitizeOriginalName,
  sniffAttachmentMime,
  type StoredAttachment,
} from '~/lib/coach/attachments';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';

// Node runtime: byte-sniffing (Buffer) + the Drizzle client + the storage adapter.
export const runtime = 'nodejs';

/**
 * POST /api/coach/attachments — upload one or more files to attach to an Ask Hale
 * message. Shared web-cookie + mobile-Bearer auth (the middleware bridge), resolved
 * exactly like /api/coach. Multipart formData with repeated `files` fields.
 *
 * Server-side validation, all fail-closed (rule #1, most restrictive): at most
 * MAX_ATTACHMENTS_PER_REQUEST files → 413; each file's MIME is SNIFFED from the raw
 * bytes (a client Content-Type is never trusted) against the images + PDF allowlist
 * → 415 on a miss; the decoded size is capped at MAX_ATTACHMENT_BYTES → 413. All
 * files are validated BEFORE any is stored, so a bad file in the batch never leaves a
 * partial upload. The client filename never reaches the storage key — createChatAttachment
 * mints the id and derives chat/{familyId}/{attachmentId}; it writes the row + its
 * immutable audit_log row (attachment id only, never the name, rules #1/#6).
 *
 * Responds [{ id, name, sizeBytes, mime }] — the ids the client then passes as
 * attachmentIds on the /api/coach send.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to attach files' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'no_files' }, { status: 400 });
  }
  if (files.length > MAX_ATTACHMENTS_PER_REQUEST) {
    return NextResponse.json({ error: 'too_many_files' }, { status: 413 });
  }

  const database = db();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }
  const uploadedBy = await resolveUserIdForUser(externalAuthId, database);
  if (!uploadedBy) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  // Validate EVERY file before storing any — a bad file must not leave a partial batch.
  const validated: { bytes: Buffer; mime: ChatAttachmentMime; name: string }[] = [];
  for (const file of files) {
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ error: 'file_too_large' }, { status: 413 });
    }
    const mime = sniffAttachmentMime(bytes);
    if (!mime) {
      return NextResponse.json({ error: 'unsupported_type' }, { status: 415 });
    }
    validated.push({ bytes, mime, name: sanitizeOriginalName(file.name) });
  }

  const stored: StoredAttachment[] = [];
  for (const v of validated) {
    stored.push(
      await createChatAttachment(
        database,
        { familyId, uploadedBy, mime: v.mime, sizeBytes: v.bytes.byteLength, originalName: v.name },
        v.bytes,
      ),
    );
  }

  return NextResponse.json(stored, { status: 201 });
}
