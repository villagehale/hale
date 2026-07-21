import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { sniffMime } from '../docs/documents.js';
import { type FetchLike, removeDocument, signDocumentUrl, uploadDocument } from '../docs/storage.js';

/**
 * The child-avatar store — DB + storage side of a parent uploading a child's profile
 * photo. Reuses the PROVEN Docs vault primitives: the SAME private 'family-docs'
 * bucket, the SAME service-key REST adapter, the SAME byte-sniffed / fail-closed
 * validation. A child's photo is the most sensitive asset class Hale holds (rule #1),
 * so the defaults are the most restrictive: images only, a small cap, a private bucket,
 * and a server-generated key that carries no filename or PII.
 *
 * The key is DETERMINISTIC — one object per child, overwritten in place on replace —
 * which makes the whole lifecycle orphan-free by construction: a replace can't strand
 * an old object (there is no old object), and both erasure and child-delete reclaim the
 * bytes from (family, child) alone. That is why no orphan sweep is needed for avatars.
 */

/** ≤5 MB — a profile photo is small; the most restrictive default for the most
 * sensitive asset class (rule #1). On Vercel the ~4.5 MB request-body ceiling rejects
 * larger uploads first; this bound is the defense that holds everywhere else. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** Browser-renderable image types ONLY. HEIC sniffs as an image but no <img> displays
 * it and the repo has no transcode, so it is rejected with honest copy (never stored).
 * PDF is a document, not a photo. */
export const AVATAR_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AvatarMime = (typeof AVATAR_MIMES)[number];

/**
 * The true MIME from the leading bytes (a client Content-Type is never trusted — rule
 * #1), restricted to the avatar allowlist. Reuses the Docs sniffer for jpeg/png and
 * adds WebP (a RIFF container: bytes 0–3 'RIFF', bytes 8–11 'WEBP'). Fail-closed: the
 * Docs sniffer also recognizes HEIC and PDF, which are accepted here only after an
 * explicit membership check — so HEIC/PDF sniff to a type outside the allowlist and
 * return null → 415.
 */
export function sniffAvatarMime(bytes: Buffer): AvatarMime | null {
  const base = sniffMime(bytes);
  for (const allowed of AVATAR_MIMES) {
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

/** The server-generated, DETERMINISTIC object key for a child's avatar: one object per
 * child under the family prefix. No client filename ever reaches it (rule #1). Stable
 * by (family, child) so a replace overwrites in place and erasure/child-delete reclaim
 * it from the id alone. */
export function avatarStoragePathFor(familyId: string, childId: string): string {
  return `avatars/${familyId}/${childId}`;
}

/** Who + what an avatar mutation targets — the child, scoped to a family (rule #1),
 * and the parent making the change (the audit actor, rule #6). */
export interface AvatarMutationTarget {
  familyId: string;
  childId: string;
  /** The internal users.id of the parent making the change (audit actor). */
  actorUserId: string;
}

/**
 * Sets (or replaces) a child's avatar. Overwrites the ONE deterministic object in
 * place (upsert), then flips the pointer + audits in one transaction (rule #6). Bytes
 * go to storage BEFORE the row write — a failed upload never leaves avatar_path
 * pointing at absent bytes (mirrors createChatAttachment). The UPDATE is scoped to the
 * caller's family; if it claims 0 rows the child was removed between the caller's
 * ownership check and this write, so the just-uploaded bytes are cleaned up (no orphan)
 * and null is returned. The audit row carries the child id ONLY — never a filename or
 * bytes (rule #1). Returns a freshly-signed URL so the caller can render the new photo,
 * or null when the child vanished.
 */
export async function setChildAvatar(
  database: Database,
  target: AvatarMutationTarget,
  bytes: Buffer,
  mime: AvatarMime,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const path = avatarStoragePathFor(target.familyId, target.childId);
  await uploadDocument(path, bytes, mime, fetchImpl, true);

  // Stamp when the photo was set so the rendered URL carries a deterministic version
  // marker (the key is stable/overwritten in place — see resolveChildAvatarUrl): a
  // replaced photo must not render stale from a browser/CDN cache.
  const updatedAt = new Date();
  const claimed = await database.transaction(async (tx) => {
    const updated = await tx
      .update(schema.children)
      .set({ avatarPath: path, avatarUpdatedAt: updatedAt })
      .where(and(eq(schema.children.id, target.childId), eq(schema.children.familyId, target.familyId)))
      .returning({ id: schema.children.id });
    if (updated.length === 0) {
      return false;
    }
    await tx.insert(schema.auditLog).values({
      familyId: target.familyId,
      actor: target.actorUserId,
      actionTaken: 'child_avatar_set',
      targetTable: 'children',
      targetId: target.childId,
    });
    return true;
  });

  if (!claimed) {
    await removeDocument(path, fetchImpl);
    return null;
  }
  return withCacheBuster(await signDocumentUrl(path, fetchImpl), updatedAt);
}

/**
 * Removes a child's avatar: confirms the child is the caller's (rule #1), deletes the
 * ONE object, then nulls the pointer + audits in one transaction (rule #6). The key is
 * derived deterministically, so a column-null object stranded by a failed set is
 * reclaimed too, and removeDocument tolerates a 404. Bytes leave BEFORE the pointer is
 * cleared: a storage failure throws before the row write, so avatar_path is never
 * nulled while bytes remain. Returns 'not_found' when the child isn't in the family.
 */
export async function removeChildAvatar(
  database: Database,
  target: AvatarMutationTarget,
  fetchImpl: FetchLike = fetch,
): Promise<'removed' | 'not_found'> {
  const owned = await database
    .select({ id: schema.children.id })
    .from(schema.children)
    .where(and(eq(schema.children.id, target.childId), eq(schema.children.familyId, target.familyId)))
    .limit(1);
  if (owned.length === 0) {
    return 'not_found';
  }

  const path = avatarStoragePathFor(target.familyId, target.childId);
  await removeDocument(path, fetchImpl);

  await database.transaction(async (tx) => {
    await tx
      .update(schema.children)
      .set({ avatarPath: null, avatarUpdatedAt: null })
      .where(and(eq(schema.children.id, target.childId), eq(schema.children.familyId, target.familyId)));
    await tx.insert(schema.auditLog).values({
      familyId: target.familyId,
      actor: target.actorUserId,
      actionTaken: 'child_avatar_removed',
      targetTable: 'children',
      targetId: target.childId,
    });
  });
  return 'removed';
}

/** Appends a deterministic cache-buster to a rendered avatar URL. The storage key is
 * stable (overwritten in place), so without this a browser/CDN could serve a REPLACED
 * photo's stale bytes; ?v=<avatar_updated_at epoch> changes the URL identity on every
 * replace. A null stamp (no photo, or a pre-column row) yields the bare URL. */
function withCacheBuster(url: string, avatarUpdatedAt: Date | null): string {
  if (!avatarUpdatedAt) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${avatarUpdatedAt.getTime()}`;
}

/**
 * Resolves a child's avatar_path to a short-TTL signed URL (with a deterministic
 * ?v=<avatar_updated_at> cache-buster so a replaced photo can't render stale), or null
 * when there is no avatar. An unresolvable avatar (storage hiccup) degrades to null so
 * the surface falls back to initials rather than erroring the page — a display boundary
 * where null is a valid, expected state (rule #1: most restrictive, never a public URL;
 * never break the page over a photo).
 */
export async function resolveChildAvatarUrl(
  avatarPath: string | null,
  avatarUpdatedAt: Date | null,
  signImpl: (path: string) => Promise<string> = signDocumentUrl,
): Promise<string | null> {
  if (!avatarPath) return null;
  try {
    return withCacheBuster(await signImpl(avatarPath), avatarUpdatedAt);
  } catch {
    return null;
  }
}
