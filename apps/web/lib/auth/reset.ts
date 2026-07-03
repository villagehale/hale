import { createHash, randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { MAX_PASSWORD_LENGTH } from './constants';
import { hashPassword, verifyPassword } from './password';
import {
  type CredentialIdentity,
  type ValidationError,
  credentialExternalAuthId,
  normalizeEmail,
  validateSignup,
} from './credentials';

/**
 * Password-reset lifecycle. A reset token grants a password change — account
 * takeover if leaked — so it is held to a higher bar than the email-verification
 * token: only its SHA-256 hash is stored (`password_reset_tokens.token_hash`),
 * never the token itself (rule #1). The raw token exists only in the email link;
 * a DB read can't reconstruct a usable link.
 *
 * Every request returns the SAME shape regardless of whether the email is
 * registered (anti-enumeration): the caller mails a link only when `token` is
 * present but ALWAYS surfaces one "if that email exists…" message, so an attacker
 * can't probe which addresses have accounts.
 */

/** A reset link is valid for 1h — short, because it grants a password change. */
const RESET_TTL_MS = 60 * 60 * 1000;

function newResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 is sufficient (and standard) for a 256-bit random token: there is no
 * low-entropy input to stretch, so a fast hash suffices — argon2 is for passwords,
 * not high-entropy secrets. The stored hash is what the redeem lookup matches. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type ResetRequestResult =
  // `token` present → the email is registered; the caller mails the link. Absent →
  // no account, but the caller returns the identical "check your inbox" message.
  { email: string; token: string } | { email: string; token: null };

/**
 * Issue a password-reset token for `email` if (and only if) an account exists.
 * Invalidates the credential's prior unused tokens first, so only the newest link
 * works. Returns a raw token for the caller to email; the DB keeps only its hash.
 * Never reveals whether the account exists — a missing account returns
 * `{ token: null }`, which the caller handles with the same response.
 */
export async function requestPasswordReset(
  emailInput: string,
  database: Database,
): Promise<ResetRequestResult> {
  const email = normalizeEmail(emailInput);

  const rows = await database
    .select({ id: schema.credentials.id })
    .from(schema.credentials)
    .where(eq(schema.credentials.email, email))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { email, token: null };
  }

  // Invalidate any prior unused tokens so a leaked earlier link is dead the moment
  // the user asks for a new one.
  await database
    .update(schema.passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.passwordResetTokens.credentialId, row.id),
        isNull(schema.passwordResetTokens.usedAt),
      ),
    );

  const token = newResetToken();
  await database.insert(schema.passwordResetTokens).values({
    credentialId: row.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
  });

  return { email, token };
}

export type ResetConsumeResult =
  | { ok: true; identity: CredentialIdentity }
  | { ok: false; error: 'invalid_token' | ValidationError };

/**
 * Redeem a reset token: set a new argon2id password hash and burn the token
 * (single use). Returns the session identity on success so the caller can sign the
 * user straight in. `invalid_token` covers every non-usable token — unknown,
 * already used, or expired — with one error, so a probe learns nothing. The new
 * password is validated for strength BEFORE the token is burned, so a weak
 * password doesn't waste the user's one-shot link.
 */
export async function consumePasswordReset(
  token: string,
  newPassword: string,
  database: Database,
): Promise<ResetConsumeResult> {
  // Reject an empty/implausible token before the indexed hash lookup. A real token
  // hashes to 64 hex chars; the raw token is ~43 base64url chars.
  if (!token || token.length > 64) {
    return { ok: false, error: 'invalid_token' };
  }
  const tokenHash = hashToken(token);

  const rows = await database
    .select({
      id: schema.passwordResetTokens.id,
      credentialId: schema.passwordResetTokens.credentialId,
      expiresAt: schema.passwordResetTokens.expiresAt,
      usedAt: schema.passwordResetTokens.usedAt,
    })
    .from(schema.passwordResetTokens)
    .where(eq(schema.passwordResetTokens.tokenHash, tokenHash))
    .limit(1);

  const tokenRow = rows[0];
  if (!tokenRow || tokenRow.usedAt || tokenRow.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'invalid_token' };
  }

  // The token is valid — now validate the new password. `validateSignup` needs an
  // email too, but only the password strength matters here (the account already
  // exists), so pass the credential's own address.
  const credRows = await database
    .select({ email: schema.credentials.email })
    .from(schema.credentials)
    .where(eq(schema.credentials.id, tokenRow.credentialId))
    .limit(1);
  const cred = credRows[0];
  if (!cred) {
    return { ok: false, error: 'invalid_token' };
  }

  const validated = validateSignup(cred.email, newPassword);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const passwordHash = await hashPassword(newPassword);

  await database
    .update(schema.credentials)
    .set({ passwordHash, emailVerifiedAt: new Date() })
    .where(eq(schema.credentials.id, tokenRow.credentialId));

  // Burn the token AFTER the password is written (single use). A replay finds
  // used_at set and returns invalid_token.
  await database
    .update(schema.passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(schema.passwordResetTokens.id, tokenRow.id));

  return {
    ok: true,
    identity: { id: credentialExternalAuthId(tokenRow.credentialId), email: cred.email },
  };
}

export type ResendResult = { email: string; token: string } | { email: string; token: null };

/**
 * Mint a fresh verification token for an UNVERIFIED account. Returns the raw token
 * for the caller to email, or `{ token: null }` when there is no account OR it is
 * already verified — both cases give the caller the same "if you have an
 * unconfirmed account, we've re-sent the link" response, so it can't be used to
 * probe which addresses exist or are verified.
 */
export async function resendVerification(
  emailInput: string,
  database: Database,
): Promise<ResendResult> {
  const email = normalizeEmail(emailInput);

  const rows = await database
    .select({
      id: schema.credentials.id,
      emailVerifiedAt: schema.credentials.emailVerifiedAt,
    })
    .from(schema.credentials)
    .where(eq(schema.credentials.email, email))
    .limit(1);

  const row = rows[0];
  if (!row || row.emailVerifiedAt) {
    return { email, token: null };
  }

  const token = randomBytes(32).toString('base64url');
  await database
    .update(schema.credentials)
    .set({ verificationToken: token, verificationSentAt: new Date() })
    .where(eq(schema.credentials.id, row.id));

  return { email, token };
}

/**
 * True only when `email`+`password` is a CORRECT credential whose email is not yet
 * verified. Used by the sign-in action to split "confirm your email" out of the
 * generic error — but ONLY after the caller has proved the password, so telling
 * them the account is unverified leaks nothing (they already hold the credential).
 * Any wrong password or unknown email returns false, preserving the generic,
 * non-enumerating error for a real attacker. Constant-time password compare, with
 * a dummy verify on a missing account so timing can't betray existence.
 */
export async function credentialUnverified(
  emailInput: string,
  password: string,
  database: Database,
): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  const email = normalizeEmail(emailInput);

  const rows = await database
    .select({
      passwordHash: schema.credentials.passwordHash,
      emailVerifiedAt: schema.credentials.emailVerifiedAt,
    })
    .from(schema.credentials)
    .where(eq(schema.credentials.email, email))
    .limit(1);

  const row = rows[0];
  if (!row) {
    await verifyPassword(DUMMY_HASH, password);
    return false;
  }

  const passwordOk = await verifyPassword(row.passwordHash, password);
  if (!passwordOk) {
    return false;
  }

  return !row.emailVerifiedAt;
}

// A real argon2id hash of a throwaway value, used only to spend the same CPU on a
// missing account as on a present one (mirrors credentials.ts).
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$8NEfJiW5Esgq5j8m2oK8tw$oNNZK3tHOnanjLWq2Is7Rk0wQt9wkAR3gsCxoiw9y6w';
