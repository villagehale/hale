import { type Database, schema } from '@hale/db';
import {
  INVITE_SILENCE_MS,
  recordCoParentAssent,
  recordParentAssent,
} from '~/lib/channel/caregiver/invites';
import type { AddRole } from '~/lib/channel/caregiver/parse';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';

// The grant it records carries a fabricated 'yes' verbatim; it must never reach a real ledger.
if (process.env.NODE_ENV === 'production') {
  throw new Error('lib/testing/seat-grant is test-only and cannot load in production');
}

const INVITE_TEXT = 'test invite text';

/**
 * A household parent's recorded yes for this phone in this role, written by the REAL
 * 1:1 grant writers: the invite starts awaiting the parent, and their yes advances it
 * and writes the grant consent and audit rows. Only the ask writer is a fake.
 */
export async function recordSeatGrant(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    phoneE164: string;
    role: AddRole;
    now: Date;
  },
): Promise<string> {
  const expiresAt = new Date(input.now.getTime() + INVITE_SILENCE_MS);
  const displayName = 'Test invitee';
  const [row] = await database
    .insert(schema.caregiverInvites)
    .values({
      familyId: input.familyId,
      invitedByUserId: input.parentUserId,
      role: input.role,
      displayName,
      phoneE164Encrypted: encryptString(input.phoneE164),
      phoneE164Hash: phoneBlindIndex(input.phoneE164),
      state: 'awaiting_parent_assent',
      expiresAt,
      createdAt: input.now,
    })
    .returning({ id: schema.caregiverInvites.id });
  const id = row?.id;
  if (!id) throw new Error('recordSeatGrant: caregiver_invites insert returned no row');
  const fields = {
    id,
    familyId: input.familyId,
    invitedByUserId: input.parentUserId,
    displayName,
    phoneE164: input.phoneE164,
    state: 'awaiting_parent_assent' as const,
    expiresAt,
  };
  const role = input.role;
  const result =
    role === 'co_parent'
      ? await recordCoParentAssent(database, {
          invite: { ...fields, role },
          inviterName: 'Test parent',
          language: null,
          verbatimReply: 'yes',
          channelMessageId: null,
          now: input.now,
          prepared: INVITE_TEXT,
        })
      : await recordParentAssent(database, {
          invite: { ...fields, role },
          inviterName: null,
          verbatimReply: 'yes',
          channelMessageId: null,
          now: input.now,
          ask: { write: async () => INVITE_TEXT },
        });
  if (result.status !== 'ready') throw new Error(`recordSeatGrant: ${result.status}`);
  return id;
}
