import type { schema } from '@hale/db';

export type FamilyRole = (typeof schema.familyMembers.$inferSelect)['role'];

export interface MemberView {
  /** Display name; null when the mirrored Google profile carries no name yet. */
  name: string | null;
  email: string;
  role: FamilyRole;
}

export interface FamilyMembersView {
  /** The primary parent, when one is resolved. */
  primary: MemberView | null;
  /** The co-parent, when a second parent has joined. Null → "invite pending". */
  coParent: MemberView | null;
}

/**
 * Folds a family's member rows (joined to their user identity) into the two
 * parent slots the settings page shows. A family always has a primary parent
 * once onboarding completes; the co-parent slot stays null until a second parent
 * accepts an invite (rule #5: single-parent households work). Extended/service
 * members aren't parents and are excluded here.
 */
export function toFamilyMembersView(
  rows: ReadonlyArray<{ name: string | null; email: string; role: FamilyRole }>,
): FamilyMembersView {
  const primary = rows.find((r) => r.role === 'primary_parent') ?? null;
  const coParent = rows.find((r) => r.role === 'co_parent') ?? null;
  return {
    primary: primary ? { name: primary.name, email: primary.email, role: primary.role } : null,
    coParent: coParent ? { name: coParent.name, email: coParent.email, role: coParent.role } : null,
  };
}
