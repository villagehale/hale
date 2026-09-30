/**
 * VIL-381 — co-parent duty asks, dark.
 *
 * Same shape as FOLLOWUP_ASKS_ENABLED: the global flag is strict equality on
 * the literal `true` (a trailing newline from `vercel env add` must stay off),
 * and the allowlist can name families while the global flag is still off.
 * Single-parent households are refused later, even when listed here.
 */

export const COPARENT_DUTY_ASKS_ENABLED_ENV = 'COPARENT_DUTY_ASKS_ENABLED';
export const COPARENT_DUTY_ASKS_ALLOWLIST_ENV = 'COPARENT_DUTY_ASKS_FAMILY_ALLOWLIST';

export function coparentDutyAsksEnabled(): boolean {
  return process.env[COPARENT_DUTY_ASKS_ENABLED_ENV] === 'true';
}

export function coparentDutyAsksAllowlist(): Set<string> {
  return new Set(
    (process.env[COPARENT_DUTY_ASKS_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** Global flag, or a non-empty allowlist. False means the door does no extra work. */
export function coparentDutyAsksArmed(): boolean {
  return coparentDutyAsksEnabled() || coparentDutyAsksAllowlist().size > 0;
}

/** This family is inside the dark launch. Single-parent is a separate refusal. */
export function coparentDutyAsksActive(familyId: string): boolean {
  if (coparentDutyAsksEnabled()) return true;
  return coparentDutyAsksAllowlist().has(familyId);
}
