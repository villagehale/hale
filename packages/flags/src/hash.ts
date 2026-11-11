import { createHash, createHmac } from 'node:crypto';

export const POSTHOG_ID_SALT_ENV = 'POSTHOG_ID_SALT';

/**
 * Family id for PostHog *feature-flag* evaluation. HMAC-SHA256 with
 * {@link POSTHOG_ID_SALT_ENV} so the distinct_id (and the `family` group key)
 * cannot be reversed to a Hale family uuid.
 *
 * Product-event hashing stays unsalted in {@link hashFamilyIdForEvents}: a salt
 * would change every historical distinct_id the funnel already recorded.
 */
export function hashFamilyIdForFlags(familyId: string, salt: string): string {
  return createHmac('sha256', salt).update(familyId).digest('hex');
}

/**
 * Family id for PostHog *product events*. sha256 over a 128-bit random uuid is
 * not enumerable, so no salt is doing work the id's own entropy is not already
 * doing. Truncated to 16 hex chars — the shape `apps/web` already ships.
 *
 * Shared here so the events PRs import one helper rather than copying the
 * digest. Do not swap this onto flag evaluation: flags need the HMAC above.
 */
export function hashFamilyIdForEvents(familyId: string): string {
  return createHash('sha256').update(familyId).digest('hex').slice(0, 16);
}
