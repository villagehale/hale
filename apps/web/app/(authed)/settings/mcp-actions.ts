'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';
import { revokeMcpGrant } from '~/lib/mcp/oauth-store';

const grantIdSchema = z.string().uuid();

export type RevokeMcpConnectionState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

/** Revocation is scoped again to the signed-in parent and family inside the write. */
export async function revokeMcpConnectionAction(
  _previous: RevokeMcpConnectionState,
  formData: FormData,
): Promise<RevokeMcpConnectionState> {
  const parsed = grantIdSchema.safeParse(formData.get('grantId'));
  if (!parsed.success) {
    return { status: 'error', message: 'Hale could not identify that connection.' };
  }

  const database = db();
  const [familyId, userId, requestHeaders] = await Promise.all([
    currentFamilyId(database),
    currentUserId(database),
    headers(),
  ]);
  if (!familyId || !userId) {
    return { status: 'error', message: 'Sign in again before changing this connection.' };
  }

  const result = await revokeMcpGrant(database, {
    grantId: parsed.data,
    familyId,
    userId,
    ip: requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
    userAgent: requestHeaders.get('user-agent') ?? undefined,
  });
  if (result.status !== 'revoked') {
    return { status: 'error', message: 'This connection is already inactive.' };
  }

  revalidatePath('/settings');
  return { status: 'success', message: 'Access revoked.' };
}
