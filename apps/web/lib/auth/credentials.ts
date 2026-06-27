import { randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './constants';
import { hashPassword, verifyPassword } from './password';

export { MIN_PASSWORD_LENGTH } from './constants';

/**
 * Email + password identity, alongside Google OAuth. The only Hale-specific
 * identity is still `users.external_auth_id`: a Google user's is the OAuth `sub`,
 * a credentials user's is `credentials:<credential id>`. Returning that same shape
 * from `authenticate` lets the Auth.js session, family resolution, and onboarding
 * treat a credentials login identically to a Google one (see auth.ts, lib/family.ts).
 *
 * No raw passwords are ever stored or logged (rule #1) — only argon2id hashes
 * (lib/auth/password.ts). The unique email index is the source of truth for
 * duplicate sign-ups, so a race can never create two accounts for one email.
 */

/** The external_auth_id prefix that distinguishes a credentials login from Google. */
const EXTERNAL_AUTH_PREFIX = 'credentials:';

/** A verification link is valid for 24h after it is sent. */
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** The identity Auth.js pins onto the session for a credentials login. Shaped so
 * the `id` drops straight into `token.sub` → `users.external_auth_id`. */
export interface CredentialIdentity {
  id: string;
  email: string;
}

export function credentialExternalAuthId(credentialId: string): string {
  return `${EXTERNAL_AUTH_PREFIX}${credentialId}`;
}

/** Lowercase + trim so 'A@B.com ' and 'a@b.com' are the same account (the column
 * stores the normalized form; the unique index enforces it). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Deliberately permissive: a single @ with a non-empty local part and a dotted
// domain. Real deliverability is proven by the verification email, not a regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ValidationError = 'invalid_email' | 'weak_password';

export function validateSignup(
  email: string,
  password: string,
): { ok: true; email: string } | { ok: false; error: ValidationError } {
  const normalized = normalizeEmail(email);
  if (!EMAIL_RE.test(normalized)) {
    return { ok: false, error: 'invalid_email' };
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: 'weak_password' };
  }
  return { ok: true, email: normalized };
}

function newVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

export type RegisterResult =
  | { ok: true; credentialId: string; email: string; verificationToken: string }
  | { ok: false; error: ValidationError | 'email_taken' };

/**
 * Create a credential for `email` with an argon2id hash of `password`, plus a
 * fresh single-use verification token. The unique email index — not a pre-check —
 * decides duplicates: a second sign-up for the same email returns `email_taken`
 * (the caller maps every duplicate to one generic "account exists" path so it
 * never reveals whether an address is registered). The returned token is handed to
 * the verification email; it is NOT logged.
 */
export async function registerCredential(
  emailInput: string,
  password: string,
  database: Database,
): Promise<RegisterResult> {
  const validated = validateSignup(emailInput, password);
  if (!validated.ok) {
    return validated;
  }

  const passwordHash = await hashPassword(password);
  const verificationToken = newVerificationToken();

  const inserted = await database
    .insert(schema.credentials)
    .values({
      email: validated.email,
      passwordHash,
      verificationToken,
      verificationSentAt: new Date(),
    })
    .onConflictDoNothing({ target: schema.credentials.email })
    .returning({ id: schema.credentials.id });

  const row = inserted[0];
  if (!row) {
    return { ok: false, error: 'email_taken' };
  }
  return { ok: true, credentialId: row.id, email: validated.email, verificationToken };
}

export interface AuthenticateOptions {
  /** When true, an unverified email cannot sign in (returns null). */
  requireVerified: boolean;
}

/**
 * Verify an email+password pair, returning the session identity on success or
 * null on ANY failure (no such email, wrong password, or — when enforced —
 * unverified email). One null for every failure so the caller surfaces a single
 * generic error and never leaks which field was wrong or whether the email exists.
 * The password compare is constant-time (argon2 verify); a missing account still
 * pays a verify so timing doesn't betray existence.
 */
export async function authenticateCredential(
  emailInput: string,
  password: string,
  database: Database,
  options: AuthenticateOptions,
): Promise<CredentialIdentity | null> {
  // Bound the password BEFORE the DB read and any argon2 verify. This is the
  // chokepoint BOTH entry paths cross — the /sign-in server action AND a direct
  // POST to /api/auth/callback/credentials (which bypasses the action) — so an
  // over-length password can never reach the 19 MiB memory-hard verify and burn
  // CPU/memory (DoS). Returns null (generic, non-enumerating), never throws.
  if (password.length > MAX_PASSWORD_LENGTH) {
    return null;
  }

  const email = normalizeEmail(emailInput);
  const rows = await database
    .select({
      id: schema.credentials.id,
      email: schema.credentials.email,
      passwordHash: schema.credentials.passwordHash,
      emailVerifiedAt: schema.credentials.emailVerifiedAt,
    })
    .from(schema.credentials)
    .where(eq(schema.credentials.email, email))
    .limit(1);

  const row = rows[0];
  // No such account: still run a verify against a dummy hash so the response time
  // doesn't reveal whether the email is registered (account-enumeration defense).
  if (!row) {
    await verifyPassword(DUMMY_HASH, password);
    return null;
  }

  const passwordOk = await verifyPassword(row.passwordHash, password);
  if (!passwordOk) {
    return null;
  }

  if (options.requireVerified && !row.emailVerifiedAt) {
    return null;
  }

  return { id: credentialExternalAuthId(row.id), email: row.email };
}

/**
 * Redeem a verification token: stamp email_verified_at and clear the token (single
 * use). Returns the verified email on success, null when the token is unknown,
 * already used, or expired. Idempotent at the DB layer — the token is cleared on
 * first use, so a replayed link finds nothing and returns null.
 */
export async function verifyEmailToken(
  token: string,
  database: Database,
): Promise<{ email: string } | null> {
  // A real token is a 32-byte base64url string (~43 chars). Reject anything empty
  // or implausibly long before the indexed lookup — no point scanning for a value
  // that can't be a token.
  if (!token || token.length > 64) {
    return null;
  }
  const rows = await database
    .select({
      id: schema.credentials.id,
      email: schema.credentials.email,
      verificationSentAt: schema.credentials.verificationSentAt,
    })
    .from(schema.credentials)
    .where(eq(schema.credentials.verificationToken, token))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  const sentAt = row.verificationSentAt?.getTime();
  if (!sentAt || Date.now() - sentAt > VERIFICATION_TTL_MS) {
    return null;
  }

  await database
    .update(schema.credentials)
    .set({ emailVerifiedAt: new Date(), verificationToken: null })
    .where(eq(schema.credentials.id, row.id));

  return { email: row.email };
}

// A real argon2id hash of a throwaway value, used only to spend the same CPU on a
// missing account as on a present one. Comparing any password to it always fails.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$8NEfJiW5Esgq5j8m2oK8tw$oNNZK3tHOnanjLWq2Is7Rk0wQt9wkAR3gsCxoiw9y6w';
