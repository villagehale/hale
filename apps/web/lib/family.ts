import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';

/**
 * Resolves the current request's family from the Auth.js session.
 *
 * Auth lives in Auth.js (Google OAuth); `users.external_auth_id` mirrors the
 * Google account id (the OAuth `sub`), and `family_members` links a user to their
 * family. So the lookup is:
 *   session.user.id (Google sub) → users.external_auth_id → family_members.family_id
 *
 * Degrades to null (never a fake id, never a throw) when the signed-in user has no
 * mirrored `users` row / family membership yet (onboarding incomplete). The caller
 * renders the calm empty state.
 *
 * Dev-preview mode (auth not configured): there is no signed-in user to key off,
 * so we resolve the first family by creation order — the counterpart to the
 * layout's "auth disabled — development preview" banner. This NEVER runs in
 * production: if auth is somehow unconfigured in prod (misconfiguration), the path
 * fails CLOSED (returns null) rather than surfacing a family to an unauthenticated
 * request — rule #1, default to most restrictive.
 *
 * TODO: when a user belongs to more than one family, this picks the first
 * membership. Multi-family switching isn't wired yet; the families↔active-family
 * selection lands when that UI exists.
 */
export async function currentFamilyId(database: Database = defaultDb()): Promise<string | null> {
  if (!authConfigured()) {
    // Fail closed in production (rule #1): never surface a family to an
    // unauthenticated request if auth is missing in prod. The first-family
    // dev-preview fallback is for local screenshots/demo only.
    if (process.env.NODE_ENV === 'production') {
      return null;
    }
    return firstFamilyForDevPreview(database);
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return null;
  }

  return resolveFamilyForUser(externalAuthId, database);
}

/**
 * Resolves the current request's internal user id (users.id) from the Auth.js
 * session — the counterpart to currentFamilyId for surfaces that must know WHICH
 * parent is asking (the teen-redaction parent-authored exemption: a parent's own
 * quick-log about their teen is theirs to read). Degrades to null (never a fake id)
 * when auth is unconfigured (dev preview — there is no signed-in parent) or the
 * signed-in user has no mirrored `users` row yet. A null requester simply gets no
 * exemption — the redaction fails closed (rule #1), never open.
 */
export async function currentUserId(database: Database = defaultDb()): Promise<string | null> {
  if (!authConfigured()) return null;
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) return null;
  return resolveUserIdForUser(externalAuthId, database);
}

/**
 * Dev-preview family resolution: the earliest-created family. Used only when auth
 * is unconfigured (local screenshots / demo), never in production.
 */
async function firstFamilyForDevPreview(database: Database): Promise<string | null> {
  const rows = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .orderBy(schema.families.createdAt)
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Pure-ish DB lookup: external auth id → family id. Extracted so the join logic is
 * unit-testable with an injected db. Returns null when the user has no mirrored
 * row or no family membership.
 */
export async function resolveFamilyForUser(
  externalAuthId: string,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ familyId: schema.familyMembers.familyId })
    .from(schema.users)
    .innerJoin(schema.familyMembers, eq(schema.familyMembers.userId, schema.users.id))
    .where(eq(schema.users.externalAuthId, externalAuthId))
    .limit(1);

  return rows[0]?.familyId ?? null;
}

/**
 * External auth id → internal users.id. The accept flow needs the uuid (to write a
 * family_members row and stamp the invite), but the session only hands us the
 * external id. Returns null when the user has no mirrored `users` row yet — the
 * caller fails closed rather than fabricating a user id (rule #1).
 */
export async function resolveUserIdForUser(
  externalAuthId: string,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.externalAuthId, externalAuthId))
    .limit(1);

  return rows[0]?.id ?? null;
}

/** The identity Auth.js hands us for a signed-in parent, mirrored into `users`. */
export interface AuthIdentity {
  /** The Google account id (OAuth `sub`), stored as users.external_auth_id. */
  externalAuthId: string;
  email: string;
  /** Null when the Google profile carries no name. */
  name: string | null;
}

/**
 * Resolve-or-create the internal `users` row mirroring a signed-in user, returning
 * its uuid. Idempotent: a user that already has a mirrored row is returned
 * unchanged (no write). Onboarding's family provisioning and invite acceptance
 * both call this so a brand-new parent gets a `users` row before anything is
 * linked to it.
 *
 * Race-safe: the insert is `onConflictDoNothing` on the unique external_auth_id
 * index, so two concurrent first-requests can't both create a row; whichever
 * loses the insert still resolves the winner's id on the re-select. We never
 * fabricate an id (rule #1) — if the row is somehow absent after the upsert, that
 * is a real invariant violation and we throw rather than mask it (CLAUDE.md #8).
 */
export async function ensureUserRow(
  identity: AuthIdentity,
  database: Database = defaultDb(),
): Promise<string> {
  const existing = await resolveUserIdForUser(identity.externalAuthId, database);
  if (existing) {
    return existing;
  }

  try {
    await database
      .insert(schema.users)
      .values({
        externalAuthId: identity.externalAuthId,
        email: identity.email,
        name: identity.name,
      })
      .onConflictDoNothing({ target: schema.users.externalAuthId });
  } catch (err) {
    // users.email is ALSO unique, and the conflict target above covers only
    // external_auth_id — a second provider (e.g. Apple after Google) carrying the
    // same address lands here. Typed so the API boundaries can answer "this email
    // already has an account — sign in the way you did before" instead of a 500.
    if (isEmailUniqueViolation(err)) {
      throw new EmailInUseError();
    }
    throw err;
  }

  const id = await resolveUserIdForUser(identity.externalAuthId, database);
  if (!id) {
    throw new Error(`ensureUserRow: no users row after upsert for ${identity.externalAuthId}`);
  }
  return id;
}

/** The signed-in identity's email already belongs to a users row under a DIFFERENT
 * auth identity (provider). Callers map this to an explicit "sign in the way you
 * did before" response — the email itself is deliberately not carried (rule #1:
 * never in logs or error text). */
export class EmailInUseError extends Error {
  constructor() {
    super('email already belongs to another auth identity');
    this.name = 'EmailInUseError';
  }
}

function isEmailUniqueViolation(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause as Error) {
    const pg = e as Error & { code?: string; constraint_name?: string };
    if (pg.code === '23505' && pg.constraint_name === 'users_email_unique') {
      return true;
    }
  }
  return false;
}
