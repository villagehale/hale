/**
 * VIL-93 · Google Calendar writes and Gmail drafts.
 *
 * Dark by default. The literal string `true` is the only on value — a trailing
 * newline (what `vercel env add` stores from a piped echo) stays OFF, the same
 * strict read as every other Hale flag. Production leaves this unset. Preview
 * sets it so a verification demo can request the two extra scopes. The scopes
 * stored on the integration are checked again at write time; the flag alone
 * never mutates a parent's Google data.
 */
export const GOOGLE_WRITE_SCOPES_ENABLED_ENV = 'GOOGLE_WRITE_SCOPES_ENABLED';

export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

/** Process env, or a test double that only sets the keys under test. */
export type WriteScopeEnv = Record<string, string | undefined>;

export function googleWriteScopesEnabled(env: WriteScopeEnv = process.env): boolean {
  return env[GOOGLE_WRITE_SCOPES_ENABLED_ENV] === 'true';
}

/**
 * Scopes a stored grant may contain beyond the readonly connector set and the
 * optional profile scope. Empty when the flag is off, so a grant that carries
 * either write scope is still "broader than we asked" and is stored nowhere.
 */
export function grantedWriteScopesAllowed(env: WriteScopeEnv = process.env): readonly string[] {
  return googleWriteScopesEnabled(env) ? [CALENDAR_EVENTS_SCOPE, GMAIL_COMPOSE_SCOPE] : [];
}

export function grantIncludesScope(
  scopes: readonly string[] | null | undefined,
  scope: string,
): boolean {
  return (scopes ?? []).includes(scope);
}
