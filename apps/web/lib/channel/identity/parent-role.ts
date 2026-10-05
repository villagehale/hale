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

export type ParentRoleWrite = 'stored' | 'unchanged' | 'kept_stated';

/**
 * Store the role on the parent's row. A guess does not overwrite a stated
 * role. The same reading twice writes nothing and audits nothing.
 */
export async function storeParentRole(
  database: Database,
  input: { familyId: string; parentUserId: string; guess: ParentRoleGuess },
): Promise<ParentRoleWrite> {
  const rows = await database
    .select({
      id: schema.users.id,
      parentRole: schema.users.parentRole,
      parentRoleBasis: schema.users.parentRoleBasis,
    })
    .from(schema.users)
    .where(eq(schema.users.id, input.parentUserId));
  const user = rows.find((row) => row.id === input.parentUserId);
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

/** The stored reading for a parent, or null. */
export async function loadParentRole(
  database: Database,
  parentUserId: string,
): Promise<ParentRoleGuess | null> {
  const rows = await database
    .select({
      id: schema.users.id,
      parentRole: schema.users.parentRole,
      parentRoleBasis: schema.users.parentRoleBasis,
    })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  const user = rows.find((row) => row.id === parentUserId);
  if (!user?.parentRole || !user.parentRoleBasis) return null;
  return { role: user.parentRole, basis: user.parentRoleBasis };
}
