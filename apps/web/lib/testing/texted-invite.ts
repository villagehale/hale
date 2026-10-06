import { type Database, schema } from '@hale/db';
import { INVITE_SILENCE_MS } from '~/lib/channel/caregiver/invites';
import type { AddRole } from '~/lib/channel/caregiver/parse';
import { CO_PARENT_GRANT_SCOPE } from '~/lib/channel/role-scope';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';

// The seeded consent row carries a fabricated 'yes' verbatim; it must never reach a real ledger.
if (process.env.NODE_ENV === 'production') {
  throw new Error('lib/testing/texted-invite is test-only and cannot load in production');
}

/**
 * An invite Hale texted before it stopped texting people first: the parent's grant and
 * the row waiting on the invitee's reply. Hale no longer opens these, but the accept,
 * decline, STOP and lapse code still answers the ones already out there.
 */
export async function seedTextedInvite(
  database: Database,
  input: {
    familyId: string;
    invitedByUserId: string;
    role: AddRole;
    displayName: string;
    phoneE164: string;
    now: Date;
  },
): Promise<string> {
  const [row] = await database
    .insert(schema.caregiverInvites)
    .values({
      familyId: input.familyId,
      invitedByUserId: input.invitedByUserId,
      role: input.role,
      displayName: input.displayName,
      phoneE164Encrypted: encryptString(input.phoneE164),
      phoneE164Hash: phoneBlindIndex(input.phoneE164),
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(input.now.getTime() + INVITE_SILENCE_MS),
      createdAt: input.now,
    })
    .returning({ id: schema.caregiverInvites.id });
  const id = row?.id;
  if (!id) throw new Error('seedTextedInvite: caregiver_invites insert returned no row');
  const coParent = input.role === 'co_parent';
  await database.insert(schema.consentRecords).values({
    userId: input.invitedByUserId,
    familyId: input.familyId,
    consentType: coParent ? 'co_parent_access_grant' : 'caregiver_access_grant',
    granted: true,
    consentScope: coParent ? CO_PARENT_GRANT_SCOPE : `caregiver:${input.role}`,
    policyVersion: POLICY_VERSION,
    evidence: { verbatimReply: 'yes' },
  });
  return id;
}
