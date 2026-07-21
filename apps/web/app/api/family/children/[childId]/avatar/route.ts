import type { Database } from '@hale/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { childBelongsToFamily } from '~/lib/companion/log-write';
import { db } from '~/lib/db';
import {
  AVATAR_MAX_BYTES,
  removeChildAvatar,
  setChildAvatar,
  sniffAvatarMime,
} from '~/lib/family/child-avatar';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { enforceRateLimit } from '~/lib/rate-limit/apply';

// Node runtime: byte-sniffing (Buffer) + the Drizzle client + the storage adapter.
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ childId: string }>;
}

const childIdSchema = z.string().uuid();

interface OwnedChild {
  familyId: string;
  userId: string;
  database: Database;
}

/**
 * Resolves the caller to (familyId, userId) with the child confirmed theirs, or the
 * Response to return. Shared by POST + DELETE so the family-scoping (rule #1) is
 * identical on both: an unknown or FOREIGN child both return 404, indistinguishable, so
 * the route never reveals another family's child.
 */
async function resolveOwnedChild(childId: string): Promise<OwnedChild | Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to manage photos' },
      { status: 501 },
    );
  }
  if (!childIdSchema.safeParse(childId).success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const database = db();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }
  const userId = await resolveUserIdForUser(externalAuthId, database);
  if (!userId) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }
  if (!(await childBelongsToFamily(database, familyId, childId))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return { familyId, userId, database };
}

/**
 * POST /api/family/children/:childId/avatar — upload or replace a child's profile
 * photo. Shared web-cookie + mobile-Bearer auth. Multipart formData with one `file`
 * field. Server-side validation, all fail-closed (rule #1, most restrictive): the MIME
 * is SNIFFED from the raw bytes (a client Content-Type is never trusted) against the
 * images allowlist → 415 on a miss (incl. HEIC and PDF, which no browser <img> renders
 * and there is no transcode); the decoded size is capped at AVATAR_MAX_BYTES → 413. The
 * child must belong to the caller's family → 404 (indistinguishable from unknown).
 * setChildAvatar overwrites the ONE deterministic object in place, flips the pointer,
 * and writes the immutable audit row (child id only — rules #1/#6). Responds
 * { avatarUrl } — a freshly-signed short-TTL URL for the new photo.
 */
export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { childId } = await context.params;
  const owned = await resolveOwnedChild(childId);
  if (owned instanceof Response) return owned;
  const { familyId, userId, database } = owned;

  // Per-user cap before any storage write — a script can't run up storage/bandwidth
  // abuse on the private bucket.
  const limited = await enforceRateLimit('avatar-upload', userId);
  if (limited) return limited;

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'no_file' }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    return NextResponse.json({ error: 'file_too_large' }, { status: 413 });
  }
  const mime = sniffAvatarMime(bytes);
  if (!mime) {
    return NextResponse.json(
      { error: 'unsupported_type', detail: 'a profile photo must be a JPEG, PNG, or WebP image' },
      { status: 415 },
    );
  }

  const avatarUrl = await setChildAvatar(
    database,
    { familyId, childId, actorUserId: userId },
    bytes,
    mime,
  );
  if (!avatarUrl) {
    // The child was removed between the ownership check and this write.
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ avatarUrl });
}

/**
 * DELETE /api/family/children/:childId/avatar — remove a child's profile photo (revert
 * to the initials fallback). Same auth + family scoping as POST. removeChildAvatar
 * deletes the object and nulls the pointer, audited (rules #1/#6). 404 when the child
 * isn't the caller's.
 */
export async function DELETE(_req: Request, context: RouteContext): Promise<Response> {
  const { childId } = await context.params;
  const owned = await resolveOwnedChild(childId);
  if (owned instanceof Response) return owned;
  const { familyId, userId, database } = owned;

  const result = await removeChildAvatar(database, { familyId, childId, actorUserId: userId });
  if (result === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ status: 'removed' });
}
