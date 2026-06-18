import { type Database, schema } from '@hale/db';
import { type InviteStore, createInviteStore, inviteDbFromDatabase } from './invite-store.js';

/**
 * Mints a co-parent invite for `familyId` on behalf of `creatorUserId` (an
 * existing member — rule #5: only members invite) and writes the membership-
 * affecting audit_log row (rule #6). Returns the token; the route builds the
 * link. The store generates the cryptographic token and 14-day expiry.
 */
export async function createFamilyInvite(
  database: Database,
  args: { familyId: string; creatorUserId: string; email?: string },
  store: InviteStore = createInviteStore(inviteDbFromDatabase(database)),
): Promise<{ token: string }> {
  const { id, token } = await store.createInvite({
    familyId: args.familyId,
    createdByUserId: args.creatorUserId,
    email: args.email,
  });

  await database.insert(schema.auditLog).values({
    familyId: args.familyId,
    actor: args.creatorUserId,
    actionTaken: 'invite_created',
    targetTable: 'family_invites',
    targetId: id,
  });

  return { token };
}
