/**
 * VIL-662 — team schedule changes from a connected Gmail, dark.
 *
 * Same shape as FOLLOWUP_ASKS_ENABLED / COPARENT_DUTY_ASKS_ENABLED: the global
 * flag is strict equality on the literal `true` (a trailing newline from
 * `vercel env add` must stay off), and the allowlist can name families while
 * the global flag is still off.
 */

export const TEAM_SCHEDULE_CHANGES_ENABLED_ENV = 'TEAM_SCHEDULE_CHANGES_ENABLED';
export const TEAM_SCHEDULE_CHANGES_ALLOWLIST_ENV = 'TEAM_SCHEDULE_CHANGES_FAMILY_ALLOWLIST';

export function teamScheduleChangesEnabled(): boolean {
  return process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] === 'true';
}

export function teamScheduleChangesAllowlist(): Set<string> {
  return new Set(
    (process.env[TEAM_SCHEDULE_CHANGES_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** Global flag, or a non-empty allowlist. False means the Gmail sweep does no extra work. */
export function teamScheduleChangesArmed(): boolean {
  return teamScheduleChangesEnabled() || teamScheduleChangesAllowlist().size > 0;
}

/** This family is inside the dark launch. */
export function teamScheduleChangesActive(familyId: string): boolean {
  if (teamScheduleChangesEnabled()) return true;
  return teamScheduleChangesAllowlist().has(familyId);
}
