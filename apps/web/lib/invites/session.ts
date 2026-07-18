import type { Database } from '@hale/db';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { createFamilyInvite } from './create.js';

/**
 * Session-level orchestration for minting a co-parent invite: resolve the caller's
 * family + user id (the membership proof for rule #5 — a member only ever invites
 * into their own household) and delegate to createFamilyInvite (which writes the
 * rule-#6 audit row). Owns the db handle so the CALLING route never has to — the
 * mobile /api/mobile/invite route stays free of any direct DB access (enforced by
 * mobile-no-raw-db.test). Returns a typed result the route maps to HTTP statuses;
 * never throws for the expected "not a member yet" cases.
 */
export type CreateInviteForSessionResult =
  | { status: 'created'; token: string }
  | { status: 'no_family' }
  | { status: 'no_user' };

export async function createInviteForSession(
  externalAuthId: string,
  email: string | undefined,
  database: Database = db(),
): Promise<CreateInviteForSessionResult> {
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return { status: 'no_family' };
  }
  const creatorUserId = await resolveUserIdForUser(externalAuthId, database);
  if (!creatorUserId) {
    return { status: 'no_user' };
  }
  const { token } = await createFamilyInvite(database, { familyId, creatorUserId, email });
  return { status: 'created', token };
}
