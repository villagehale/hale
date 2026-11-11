/**
 * VIL-638 · access export round 2, dark.
 *
 * Off unless `ACCESS_EXPORT_ROUND_2_ENABLED` is exactly `true`. A trailing
 * newline, `TRUE`, `on`, and `1` stay off. Unset stays off. Lit: held coach notes
 * leave the requester thread, bookings are requester-scoped with a teen-name
 * check on the title, the household calendar genericizes a sensitive row and
 * carries the source-changed columns, consent evidence runs through the teen
 * gate, and the privacy page says removed lines are in the copy.
 */

export const ACCESS_EXPORT_ROUND_2_ENABLED_ENV = 'ACCESS_EXPORT_ROUND_2_ENABLED';

export function accessExportRound2Enabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ACCESS_EXPORT_ROUND_2_ENABLED_ENV] === 'true';
}

/** The privacy-page line under Export. Lit, it also says removed lines are included. */
export function accessExportBlurb(env: Record<string, string | undefined> = process.env): string {
  if (accessExportRound2Enabled(env)) {
    return 'A copy of everything Hale holds, including lines you removed.';
  }
  return 'A copy of everything Hale holds.';
}
