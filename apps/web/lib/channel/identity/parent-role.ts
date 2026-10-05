import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';

/**
 * VIL-417. A soft guess at which parent is texting.
 *
 * The onboarding model returns `parentRole` with its structured capture, read
 * off the parent's first name and anything they said ("my wife", "I'm his
 * mom"). Code validates the enum, remembers how it was reached, and stores it.
 * There is no name list and no heuristic here: the model makes the judgment.
 *
 * It is a guess. Parent-facing copy never states it as fact, nothing is gated
 * on it, an ambiguous or unisex name stays `unknown`, and a role the parent
 * stated outranks one that was only inferred.
 */

export const PARENT_ROLES = ['mother', 'father', 'unknown'] as const;
export type ParentRole = (typeof PARENT_ROLES)[number];

export const PARENT_ROLE_BASES = ['stated', 'guessed'] as const;
export type ParentRoleBasis = (typeof PARENT_ROLE_BASES)[number];

export interface ParentRoleGuess {
  role: ParentRole;
  basis: ParentRoleBasis;
}

function isParentRole(value: unknown): value is ParentRole {
  return typeof value === 'string' && (PARENT_ROLES as readonly string[]).includes(value);
}

function isParentRoleBasis(value: unknown): value is ParentRoleBasis {
  return typeof value === 'string' && (PARENT_ROLE_BASES as readonly string[]).includes(value);
}

/**
 * Keep the model's role only when it is one of the three words. A role with no
 * usable basis is kept as a guess, which is the weaker of the two readings.
 */
export function acceptParentRole(roleRaw: unknown, basisRaw: unknown): ParentRoleGuess | null {
  if (!isParentRole(roleRaw)) return null;
  return { role: roleRaw, basis: isParentRoleBasis(basisRaw) ? basisRaw : 'guessed' };
}

/**
 * Which of two readings to keep. A stated role wins over anything inferred. A
 * later guess replaces an earlier guess. Nothing replaces a stated role except
 * a later statement.
 */
export function preferParentRole(
  prior: ParentRoleGuess | null | undefined,
  next: ParentRoleGuess | null | undefined,
): ParentRoleGuess | null {
  if (next?.basis === 'stated') return next;
  if (prior?.basis === 'stated') return prior;
  return next ?? prior ?? null;
}

/** The role the other parent most likely holds. Unknown stays unknown. */
export function likelyCoParentRole(guess: ParentRoleGuess | null | undefined): ParentRole {
  if (guess?.role === 'mother') return 'father';
  if (guess?.role === 'father') return 'mother';
  return 'unknown';
}

/**
 * `column_missing` is the deploy window before migration 0153 has run: the
 * guess is dropped, logged, and named here rather than crashing the turn that
 * carried it. Nothing is gated on the role, so losing it costs one soft read.
 */
export type ParentRoleWrite = 'stored' | 'unchanged' | 'kept_stated' | 'column_missing';

/** Postgres 42703, undefined_column, as drizzle surfaces it from pg or pglite. */
function isUndefinedColumn(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const seen = new Set<object>();
  let cursor: unknown = err;
  while (cursor && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const row = cursor as { code?: unknown; message?: unknown; cause?: unknown };
    if (row.code === '42703') return true;
    if (typeof row.message === 'string' && /column .* does not exist/i.test(row.message)) {
      return true;
    }
    cursor = row.cause;
  }
  return false;
}

type ParentRoleRow = Pick<
  typeof schema.users.$inferSelect,
  'id' | 'parentRole' | 'parentRoleBasis'
>;

async function readParentRoleRow(
  database: Database,
  parentUserId: string,
): Promise<ParentRoleRow | 'column_missing' | null> {
  try {
    const rows = await database
      .select({
        id: schema.users.id,
        parentRole: schema.users.parentRole,
        parentRoleBasis: schema.users.parentRoleBasis,
      })
      .from(schema.users)
      .where(eq(schema.users.id, parentUserId));
    return rows.find((row) => row.id === parentUserId) ?? null;
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    console.warn({ parentUserId }, 'parent-role: users.parent_role is not migrated yet');
    return 'column_missing';
  }
}

/**
 * Store the role on the parent's row. A guess does not overwrite a stated
 * role. The same reading twice writes nothing and audits nothing.
 */
export async function storeParentRole(
  database: Database,
  input: { familyId: string; parentUserId: string; guess: ParentRoleGuess },
): Promise<ParentRoleWrite> {
  const user = await readParentRoleRow(database, input.parentUserId);
  if (user === 'column_missing') return 'column_missing';
  if (!user) return 'unchanged';
  const current: ParentRoleGuess | null =
    user.parentRole && user.parentRoleBasis
      ? { role: user.parentRole, basis: user.parentRoleBasis }
      : null;
  const kept = preferParentRole(current, input.guess);
  if (!kept) return 'unchanged';
  if (kept !== input.guess) return 'kept_stated';
  if (current && current.role === kept.role && current.basis === kept.basis) return 'unchanged';
  await database
    .update(schema.users)
    .set({ parentRole: kept.role, parentRoleBasis: kept.basis, updatedAt: new Date() })
    .where(eq(schema.users.id, input.parentUserId));
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'parent_role_recorded',
    targetTable: 'users',
    targetId: input.parentUserId,
    after: { role: kept.role, basis: kept.basis },
  });
  return 'stored';
}

/** The stored reading for a parent, or null; null too while the column is not migrated. */
export async function loadParentRole(
  database: Database,
  parentUserId: string,
): Promise<ParentRoleGuess | null> {
  const user = await readParentRoleRow(database, parentUserId);
  if (user === 'column_missing' || !user?.parentRole || !user.parentRoleBasis) return null;
  return { role: user.parentRole, basis: user.parentRoleBasis };
}
