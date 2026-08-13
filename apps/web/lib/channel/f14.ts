/**
 * F14's dark-launch gate (D21) — the flag that decides whether Hale may start a
 * conversation at all, and the allowlist that arms it for one household at a time.
 *
 * It lived inside the nudge sweep because the nudge sweep was the only thing it gated.
 * It is not the nudge sweep's: the registration ladder, the party reminders and the
 * coaching plan check-in all read it too, and a second proactive surface importing
 * `~/lib/channel/nudge/run` for a boolean drags a whole sweep — its transport, its
 * weather port, its voice client — into that module's graph. The cron route's own test
 * is where that surfaced: it mocks the nudge module wholesale, and the check-in sweep's
 * flag read vanished with it.
 *
 * `~/lib/channel/nudge/run` re-exports these so its existing callers are unchanged.
 */

export const F14_ENABLED_ENV = 'F14_ENABLED';
export const F14_ALLOWLIST_ENV = 'F14_FAMILY_ALLOWLIST';

/**
 * STRICT equality on the literal 'true': `vercel env add` from a piped `echo` stores a
 * TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'` — and a
 * truthiness check would read that as ON and ship an unprompted SMS campaign nobody
 * armed. Strict comparison fails closed on exactly that shape.
 */
export function f14Enabled(): boolean {
  return process.env[F14_ENABLED_ENV] === 'true';
}

/** The comma-separated family ids allowed through while the flag is off. */
export function f14Allowlist(): Set<string> {
  return new Set(
    (process.env[F14_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export function f14EnabledFor(familyId: string): boolean {
  return f14Enabled() || f14Allowlist().has(familyId);
}
