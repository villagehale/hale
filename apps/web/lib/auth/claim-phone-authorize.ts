import { verifyClaimCode } from '~/lib/auth/claim-by-phone';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { db } from '~/lib/db';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';

/**
 * The request/auth wrapper the `claim-phone` Auth.js provider's authorize delegates
 * to — the same split channels/sms-consent.ts uses: the core (claim-by-phone.ts) owns
 * the gates and the DB writes and takes a handle, this layer owns the flag, the
 * throttle, and the mapping to an Auth.js identity.
 *
 * It is a separate module for one reason: authorize is the chokepoint for EVERY
 * claim — the /sign-in form AND a direct POST to /api/auth/callback/claim-phone — so
 * the flag check and the rate limit have to live here rather than in the page, and a
 * chokepoint that can only be exercised by standing up NextAuth is a chokepoint nobody
 * tests.
 *
 * Returns null on ANY failure. Auth.js turns that into one CredentialsSignin the page
 * maps to a single generic message: never which gate closed, never whether the number
 * has an account, never that the number belongs to a caregiver (rule #1).
 */
export interface ClaimPhoneIdentity {
  /** The external_auth_id the account ALREADY has — the session subject. */
  id: string;
  email: null;
}

export async function authorizeClaimByPhone(
  raw: Partial<Record<string, unknown>> | undefined,
): Promise<ClaimPhoneIdentity | null> {
  if (!receiptsIaEnabled()) {
    return null;
  }
  const phone = typeof raw?.phone === 'string' ? raw.phone : '';
  const code = typeof raw?.code === 'string' ? raw.code : '';
  if (!phone || !code) {
    return null;
  }
  if (await authRateLimited()) {
    return null;
  }

  const result = await verifyClaimCode(db(), { phoneRaw: phone, code });
  if (result.status !== 'claimed') {
    // The label only — the number and the code never reach a log line (rule #1).
    console.info({ reason: result.reason }, 'claim-by-phone: claim refused');
    return null;
  }

  // The account's OWN identity, never a fresh one. This return value IS the anti-fork
  // property: the jwt callback pins it as `sub`, and resolveFamilyForUser keys on it,
  // so the session lands in the family the number already belongs to.
  //
  // `email` is null and stays null: a text-onboarded parent has no address, and
  // inventing one here would be a fabricated identity. Account LINKING — attaching this
  // phone to an existing email account, or the reverse — is deliberately out of scope.
  return { id: result.externalAuthId, email: null };
}
