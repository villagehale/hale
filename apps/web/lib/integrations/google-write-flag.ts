/**
 * VIL-93 · Google Calendar writes and Gmail drafts.
 *
 * Dark by default. The literal string `true` is the only on value — a trailing
 * newline (what `vercel env add` stores from a piped echo) stays OFF, the same
 * strict read as every other Hale flag. Production leaves the flag unset.
 * Linq delivers parent texts to the production webhook, so a preview URL cannot
 * receive the demo. `GOOGLE_WRITE_SCOPES_ALLOWLIST` is comma-separated Hale user
 * ids: only those accounts are asked for the extra scopes, and only their writes
 * reach Google. Everyone else stays on today's readonly grant. The scopes stored
 * on the integration are checked again at write time.
 */
export const GOOGLE_WRITE_SCOPES_ENABLED_ENV = 'GOOGLE_WRITE_SCOPES_ENABLED';
export const GOOGLE_WRITE_SCOPES_ALLOWLIST_ENV = 'GOOGLE_WRITE_SCOPES_ALLOWLIST';

export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

/** Process env, or a test double that only sets the keys under test. */
export type WriteScopeEnv = Record<string, string | undefined>;

export function googleWriteScopesEnabled(env: WriteScopeEnv = process.env): boolean {
  return env[GOOGLE_WRITE_SCOPES_ENABLED_ENV] === 'true';
}

/** Hale user ids armed while the global flag is unset. Empty tokens are dropped. */
export function googleWriteScopesAllowlist(env: WriteScopeEnv = process.env): Set<string> {
  return new Set(
    (env[GOOGLE_WRITE_SCOPES_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/**
 * Armed for this user when the global flag is exactly `true`, or when their
 * Hale user id is on the allowlist. A missing id is armed only by the global
 * flag — an autonomous placement with no actor does not inherit someone else's
 * allowlist entry.
 */
export function googleWriteScopesEnabledFor(
  userId: string | null | undefined,
  env: WriteScopeEnv = process.env,
): boolean {
  if (googleWriteScopesEnabled(env)) return true;
  if (!userId) return false;
  return googleWriteScopesAllowlist(env).has(userId);
}

/**
 * Scopes a stored grant may contain beyond the readonly connector set and the
 * optional profile scope. Empty unless this user is armed, so a grant that
 * carries either write scope for anyone else is still "broader than we asked"
 * and is stored nowhere. `gmail.send` is never in this set.
 */
export function grantedWriteScopesAllowed(
  env: WriteScopeEnv = process.env,
  userId?: string | null,
): readonly string[] {
  return googleWriteScopesEnabledFor(userId, env)
    ? [CALENDAR_EVENTS_SCOPE, GMAIL_COMPOSE_SCOPE]
    : [];
}

export function grantIncludesScope(
  scopes: readonly string[] | null | undefined,
  scope: string,
): boolean {
  return (scopes ?? []).includes(scope);
}
