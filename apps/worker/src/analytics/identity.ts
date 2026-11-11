import { createHmac } from 'node:crypto';

/**
 * One-way family / group-chat ids for PostHog. HMAC-SHA256 with POSTHOG_ID_SALT so a
 * leaked project cannot be joined back to Hale rows. Unset salt → null, and the
 * caller skips the event (named absence, rule #11).
 *
 * Keep identical to apps/web/lib/analytics/identity.ts.
 */

export const POSTHOG_ID_SALT_ENV = 'POSTHOG_ID_SALT';

export function posthogIdSalt(env: Record<string, string | undefined> = process.env): string | null {
  const salt = env[POSTHOG_ID_SALT_ENV];
  return salt && salt.length > 0 ? salt : null;
}

/** Hex HMAC-SHA256 of a family id or Linq chat id. Null when the salt is missing. */
export function hashTelemetryId(
  rawId: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const salt = posthogIdSalt(env);
  if (!salt || !rawId) return null;
  return createHmac('sha256', salt).update(rawId, 'utf8').digest('hex');
}
