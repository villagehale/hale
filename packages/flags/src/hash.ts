import { createHash, createHmac } from 'node:crypto';

export const POSTHOG_ID_SALT_ENV = 'POSTHOG_ID_SALT';

/**
 * The ONE PostHog family id. HMAC-SHA256 (full hex) with {@link POSTHOG_ID_SALT_ENV},
 * so the distinct_id (and the `family` group key) cannot be reversed to a Hale
 * family uuid. Flag evaluation, product events, the portal identify, and LLM
 * traces all use this value, so a flag targeted at a person matches the same
 * person the events recorded. Never rotate the salt: that forks every person.
 */
export function hashFamilyIdForFlags(familyId: string, salt: string): string {
  return createHmac('sha256', salt).update(familyId).digest('hex');
}

/**
 * Family id for PostHog product events and the portal identify. With the salt
 * set this is exactly {@link hashFamilyIdForFlags}. Without it, the historical
 * unsalted sha256 truncated to 16 hex (sha256 over a 128-bit random uuid is not
 * enumerable), so pre-launch SMS-side rows keep matching until the salt is set.
 */
export function hashFamilyIdForEvents(
  familyId: string,
  salt: string | undefined = process.env[POSTHOG_ID_SALT_ENV],
): string {
  if (salt) return hashFamilyIdForFlags(familyId, salt);
  return createHash('sha256').update(familyId).digest('hex').slice(0, 16);
}
