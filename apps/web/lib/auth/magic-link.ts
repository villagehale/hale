import { createHash, randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  type CredentialIdentity,
  credentialExternalAuthId,
  isValidEmail,
  normalizeEmail,
} from './credentials';

/**
 * Magic-link (passwordless) sign-in lifecycle. A magic link grants a signed-in
 * session — account takeover if leaked — so it is held to the same bar as a reset
 * token: only its SHA-256 hash is stored (`magic_link_tokens.token_hash`), never
 * the token itself (rule #1). The raw token exists only in the email link.
 *
 * Two properties distinguish it from password reset:
 *   1. It doubles as first-time SIGN-UP, so `requestMagicLink` mints for ANY valid
 *      email regardless of whether an account exists — the request path therefore
 *      carries no account-existence signal (anti-enumeration by construction), and
 *      `consumeMagicLinkToken` FIND-OR-CREATES the credential on redemption.
 *   2. Redemption resolves to the SAME identity a password login would
 *      (`credentials:<id>`), so a user who already has an email+password account
 *      lands on that account (and its family), not a fresh one.
 */

/** A magic link is valid for 15 minutes — short, because it grants a session. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/**
 * An argon2id hash of a throwaway value, no password ever verifies against it.
 * Stored as the password_hash of a credential CREATED by a magic link (the column
 * is NOT NULL but the account has no password). Password sign-in for such an
 * account always fails; the user can set a real password later via forgot-password.
 * Same sentinel the timing-defense dummy uses in credentials.ts / reset.ts.
 */
const UNUSABLE_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$8NEfJiW5Esgq5j8m2oK8tw$oNNZK3tHOnanjLWq2Is7Rk0wQt9wkAR3gsCxoiw9y6w';

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 is sufficient for a 256-bit random token: no low-entropy input to
 * stretch, so a fast hash suffices (argon2 is for passwords). The stored hash is
 * what the redeem lookup matches. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type MagicLinkRequestResult =
  // `token` present → mail the link. Absent → the address was malformed; the caller
  // still surfaces the identical "check your inbox" response (uniform, no signal).
  { email: string; token: string } | { email: string; token: null };

/**
 * Issue a magic-link token for `email`. Mints for ANY valid address — existing
 * account or not — because a magic link doubles as sign-up; the request path thus
 * reveals nothing about which addresses are registered. Invalidates the email's
 * prior unconsumed tokens first, so only the newest link works. Returns a raw token
 * for the caller to email; the DB keeps only its hash. A malformed address returns
 * `{ token: null }` (nothing minted, nothing sent), handled with the same response.
 */
export async function requestMagicLink(
  emailInput: string,
  database: Database,
): Promise<MagicLinkRequestResult> {
  const email = normalizeEmail(emailInput);
  if (!isValidEmail(email)) {
    return { email, token: null };
  }

  // Invalidate any prior unconsumed link so a leaked earlier one is dead the moment
  // the user asks for a new one.
  await database
    .update(schema.magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.magicLinkTokens.email, email),
        isNull(schema.magicLinkTokens.consumedAt),
      ),
    );

  const token = newToken();
  await database.insert(schema.magicLinkTokens).values({
    email,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  });

  return { email, token };
}

export type MagicLinkConsumeResult =
  | { ok: true; identity: CredentialIdentity }
  | { ok: false };

/**
 * Redeem a magic-link token: burn it (single use) and resolve the session identity,
 * find-or-creating the credential for the token's email (email pre-verified — the
 * link proves ownership). `{ ok: false }` covers every non-usable token — unknown,
 * already consumed, or expired — so a probe learns nothing.
 *
 * Single-use is ATOMIC: the burn is one conditional `UPDATE … WHERE token_hash = ?
 * AND consumed_at IS NULL AND expires_at > now RETURNING email`. Only the request
 * whose UPDATE returns a row wins; a concurrent replay's WHERE matches nothing.
 * This closes the check-then-update race the reset flow's select-then-update leaves
 * open.
 */
export async function consumeMagicLinkToken(
  token: string,
  database: Database,
): Promise<MagicLinkConsumeResult> {
  // Reject an empty/implausible token before the indexed hash lookup. A real token
  // is ~43 base64url chars; its hash is 64 hex.
  if (!token || token.length > 64) {
    return { ok: false };
  }

  const burned = await database
    .update(schema.magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.magicLinkTokens.tokenHash, hashToken(token)),
        isNull(schema.magicLinkTokens.consumedAt),
        gt(schema.magicLinkTokens.expiresAt, new Date()),
      ),
    )
    .returning({ email: schema.magicLinkTokens.email });

  const row = burned[0];
  if (!row) {
    return { ok: false };
  }

  const credentialId = await findOrCreateVerifiedCredential(row.email, database);
  return {
    ok: true,
    identity: { id: credentialExternalAuthId(credentialId), email: row.email },
  };
}

/**
 * The credential id for `email`, creating a verified, password-less credential when
 * none exists. An existing UNVERIFIED credential is stamped verified — the magic
 * link proved ownership, the same evidence the verification email establishes.
 *
 * Race-safe: the insert is `onConflictDoNothing` on the unique email index, so two
 * concurrent first-redemptions can't both create a row; the loser re-selects the
 * winner's id. Never fabricates an id (rule #1) — an absent row after the upsert is
 * a real invariant violation and throws rather than masks (CLAUDE.md #8).
 */
async function findOrCreateVerifiedCredential(email: string, database: Database): Promise<string> {
  const existing = await database
    .select({ id: schema.credentials.id, emailVerifiedAt: schema.credentials.emailVerifiedAt })
    .from(schema.credentials)
    .where(eq(schema.credentials.email, email))
    .limit(1);

  const found = existing[0];
  if (found) {
    if (!found.emailVerifiedAt) {
      await database
        .update(schema.credentials)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(schema.credentials.id, found.id));
    }
    return found.id;
  }

  const inserted = await database
    .insert(schema.credentials)
    .values({
      email,
      passwordHash: UNUSABLE_PASSWORD_HASH,
      emailVerifiedAt: new Date(),
    })
    .onConflictDoNothing({ target: schema.credentials.email })
    .returning({ id: schema.credentials.id });

  const row = inserted[0];
  if (row) {
    return row.id;
  }

  const reselect = await database
    .select({ id: schema.credentials.id })
    .from(schema.credentials)
    .where(eq(schema.credentials.email, email))
    .limit(1);
  const raced = reselect[0];
  if (!raced) {
    throw new Error('findOrCreateVerifiedCredential: no credential row after upsert');
  }
  return raced.id;
}
