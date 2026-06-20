import { type Database, schema } from '@hale/db';
import {
  type AcceptResult,
  type InviteStore,
  createInviteStore,
  inviteDbFromDatabase,
} from './invite-store.js';

/**
 * Redeems an invite for `userId` (an internal users.id, already resolved from
 * the Auth.js/Google session by the route). On a genuine new membership it writes the membership-
 * affecting audit_log row (rule #6); an idempotent re-accept by the same user
 * changes nothing, so it adds no duplicate audit row. Returns the store's
 * discriminated result for the route to map to HTTP.
 */
export async function acceptFamilyInvite(
  database: Database,
  args: { token: string; userId: string; email: string },
  store: InviteStore = createInviteStore(inviteDbFromDatabase(database)),
): Promise<AcceptResult> {
  const result = await store.acceptInvite({
    token: args.token,
    userId: args.userId,
    email: args.email,
  });

  if (result.status === 'accepted' && !result.alreadyMember) {
    await database.insert(schema.auditLog).values({
      familyId: result.familyId,
      actor: args.userId,
      actionTaken: 'invite_accepted',
      targetTable: 'family_members',
      targetId: args.userId,
    });
  }

  return result;
}
