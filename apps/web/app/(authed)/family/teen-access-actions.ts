'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';
import { revokeTeenAccessGrant } from '~/lib/teen-access';

const grantIdSchema = z.string().uuid();

export type RevokeTeenAccessState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

/**
 * Closes an access window early. Scoped again to the signed-in parent's family
 * inside the write, and the store appends both the granted=false consent-ledger row
 * and the audit row (rule #6) — so a revocation is as provable as the grant was.
 */
export async function revokeTeenAccessAction(
  _previous: RevokeTeenAccessState,
  formData: FormData,
): Promise<RevokeTeenAccessState> {
  const parsed = grantIdSchema.safeParse(formData.get('grantId'));
  if (!parsed.success) {
    return { status: 'error', message: 'Hale could not identify that request.' };
  }

  const database = db();
  const [familyId, userId] = await Promise.all([
    currentFamilyId(database),
    currentUserId(database),
  ]);
  if (!familyId || !userId) {
    return { status: 'error', message: 'Sign in again before changing this.' };
  }

  const result = await revokeTeenAccessGrant(database, {
    familyId,
    grantId: parsed.data,
    revokedBy: userId,
  });
  if (result.status !== 'revoked') {
    return { status: 'error', message: 'This request is already closed.' };
  }

  revalidatePath('/family');
  return { status: 'success', message: 'Access closed.' };
}
