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

/**
 * VIL-382 — actually sending duty asks. Separate from the shadow flag so
 * parsing can be armed without a single text leaving.
 *
 * Same shape as {@link COPARENT_DUTY_ASKS_ALLOWLIST_ENV}: comma-separated
 * family ids, trimmed. The global flag is strict equality on `true`.
 * Single-parent households are refused by the sweep, even when listed here.
 */

export const COPARENT_DUTY_SENDS_ENABLED_ENV = 'COPARENT_DUTY_SENDS_ENABLED';
export const COPARENT_DUTY_SENDS_ALLOWLIST_ENV = 'COPARENT_DUTY_SENDS_FAMILY_ALLOWLIST';

export function coparentDutySendsEnabled(): boolean {
  return process.env[COPARENT_DUTY_SENDS_ENABLED_ENV] === 'true';
}

export function coparentDutySendsAllowlist(): Set<string> {
  return new Set(
    (process.env[COPARENT_DUTY_SENDS_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** Global send flag, or a non-empty send allowlist. False means the sweep does nothing. */
export function coparentDutySendsArmed(): boolean {
  return coparentDutySendsEnabled() || coparentDutySendsAllowlist().size > 0;
}

/** This family may be considered for a duty send. Single-parent is a separate refusal. */
export function coparentDutySendsActive(familyId: string): boolean {
  if (coparentDutySendsEnabled()) return true;
  return coparentDutySendsAllowlist().has(familyId);
}

/**
 * VIL-383 — write duty onto family_events / ICS, undo, the 1:1 sync echo,
 * internal burden counts, and the ack. Strict `true`. Unset is off.
 * Does not change any other flag.
 */
export const COPARENT_DUTY_MEMORY_ENABLED_ENV = 'COPARENT_DUTY_MEMORY_ENABLED';

export function coparentDutyMemoryEnabled(): boolean {
  return process.env[COPARENT_DUTY_MEMORY_ENABLED_ENV] === 'true';
}

/**
 * The lopsided nudge. Separate from memory, and off unless this is exactly
 * `true`. Consent, the monthly cap, and "no numbers" are checked as well.
 */
export const COPARENT_DUTY_LOPSIDED_ENABLED_ENV = 'COPARENT_DUTY_LOPSIDED_ENABLED';

export function coparentDutyLopsidedEnabled(): boolean {
  return process.env[COPARENT_DUTY_LOPSIDED_ENABLED_ENV] === 'true';
}

/**
 * A parent asked who has been doing more. Off unless exactly `true`.
 * The answer string is still a design placeholder, so it does not leave
 * even when this is on.
 */
export const COPARENT_DUTY_BURDEN_SURFACE_ENABLED_ENV = 'COPARENT_DUTY_BURDEN_SURFACE_ENABLED';

export function coparentDutyBurdenSurfaceEnabled(): boolean {
  return process.env[COPARENT_DUTY_BURDEN_SURFACE_ENABLED_ENV] === 'true';
}
