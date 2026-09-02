import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { db as defaultDb } from '~/lib/db';

/**
 * The /admin gate — the founder's analytics portal has exactly one door.
 *
 * Admin ⟺ the signed-in user's ACTIVE VERIFIED sms channel hashes into the
 * ADMIN_PHONES allowlist. The allowlist is E.164 numbers in env; each is reduced
 * to the same keyed blind index parent_channels stores (HMAC of the canonical
 * number), so the raw number is compared nowhere and an account erased and
 * re-created around the same phone re-matches with zero data migration. An
 * email-credential session passes the same way: its users row owns the verified
 * channel, so the founder is never locked out of his own portal.
 *
 * ADMIN_PHONES unset or empty ⇒ the gate is CLOSED for everyone, and the absence
 * is logged once per process rather than silently swallowed (rule #11).
 */
export type AdminGate =
  | { status: 'admin'; userId: string }
  | { status: 'unauthenticated' }
  | { status: 'not_admin' }
  /** ADMIN_PHONES unset/empty — fail-closed, named, logged once. */
  | { status: 'not_configured' };

let absenceLogged = false;

/** Test seam: the once-per-process latch would otherwise leak between cases. */
export function resetAdminGateAbsenceLogForTests(): void {
  absenceLogged = false;
}

/**
 * The allowlist as blind-index hashes, computed at request time so a redeploy
 * with a new env value takes effect immediately. Entries that don't normalize
 * to a CA/US E.164 number are dropped rather than hashed garbage.
 */
export function adminAllowlistHashes(raw: string | undefined = process.env.ADMIN_PHONES): string[] {
  if (!raw) return [];
  const hashes: string[] = [];
  for (const entry of raw.split(',')) {
    const e164 = normalizePhoneE164(entry.trim());
    if (e164) hashes.push(phoneBlindIndex(e164));
  }
  return hashes;
}

export async function resolveAdminGate(database: Database = defaultDb()): Promise<AdminGate> {
  const hashes = adminAllowlistHashes();
  if (hashes.length === 0) {
    if (!absenceLogged) {
      absenceLogged = true;
      console.warn(
        'admin: ADMIN_PHONES is not set — /admin is closed for everyone (fail-closed)',
      );
    }
    return { status: 'not_configured' };
  }

  // Fail closed when auth is unconfigured — there is no session to key off, and
  // the dev-preview first-family fallback has no business near an admin surface.
  if (!authConfigured()) return { status: 'unauthenticated' };
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) return { status: 'unauthenticated' };

  const users = await database
    .select({ id: schema.users.id, externalAuthId: schema.users.externalAuthId })
    .from(schema.users)
    .where(eq(schema.users.externalAuthId, externalAuthId))
    .limit(1);
  const user = users.find((row) => row.externalAuthId === externalAuthId);
  if (!user) return { status: 'not_admin' };

  const channels = await database
    .select({
      userId: schema.parentChannels.userId,
      kind: schema.parentChannels.kind,
      phoneE164Hash: schema.parentChannels.phoneE164Hash,
      verifiedAt: schema.parentChannels.verifiedAt,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.userId, user.id),
        eq(schema.parentChannels.kind, 'sms'),
        isNull(schema.parentChannels.revokedAt),
      ),
    );

  // Defense in depth, the resolveVerifiedChannelByPhone shape: re-check every
  // column that makes the row an admin credential rather than trusting the
  // predicate alone.
  const admin = channels.some(
    (c) =>
      c.userId === user.id &&
      c.kind === 'sms' &&
      c.verifiedAt !== null &&
      c.revokedAt === null &&
      hashes.includes(c.phoneE164Hash),
  );
  return admin ? { status: 'admin', userId: user.id } : { status: 'not_admin' };
}
