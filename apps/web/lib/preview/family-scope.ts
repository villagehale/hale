/**
 * Preview family scope: what a Preview deploy may touch.
 *
 * Preview shares prod's database today, so a Preview cron that walked every family
 * would do real work for real families. On a deploy where VERCEL_ENV is exactly
 * `preview`:
 *
 * - A cron runs only if it is listed `family_scoped` in PREVIEW_CRON_POLICY AND
 *   PREVIEW_FAMILY_ALLOWLIST names at least one family AND the #913 capture
 *   transport is on. Any other cron answers 200 with a skip and does nothing.
 *   An unlisted cron is skipped (fail closed).
 * - A family-scoped cron keeps only allowlisted families in its loop.
 * - Outbound sends go only through the capture transport, and only to reserved
 *   fictional numbers (+1 NPA 555-0100..0199).
 *
 * Off preview (production, local, CI) every function here is a no-op, so prod
 * behaviour is unchanged.
 */
type Env = Readonly<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** NANP numbers reserved for fiction: 555-0100 through 555-0199 in any area code. */
const FICTIONAL_E164 = /^\+1[2-9]\d{2}55501\d{2}$/;

export function isPreviewDeploy(env: Env = process.env): boolean {
  return env.VERCEL_ENV === 'preview';
}

/** Allowlisted test family ids. Entries that are not UUIDs are ignored. */
export function previewTestFamilyIds(env: Env = process.env): ReadonlySet<string> {
  const raw = env.PREVIEW_FAMILY_ALLOWLIST ?? '';
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID.test(id)),
  );
}

/** True off preview; on preview, true only for an allowlisted test family. */
export function familyInPreviewScope(familyId: string, env: Env = process.env): boolean {
  if (!isPreviewDeploy(env)) return true;
  return previewTestFamilyIds(env).has(familyId.trim().toLowerCase());
}

/** Keep only in-scope rows. Returns the input untouched off preview. */
export function scopeFamilies<T extends { familyId: string }>(
  rows: readonly T[],
  env: Env = process.env,
): T[] {
  if (!isPreviewDeploy(env)) return [...rows];
  return rows.filter((row) => familyInPreviewScope(row.familyId, env));
}

export function isFictionalPhone(e164: string): boolean {
  return FICTIONAL_E164.test(e164.trim());
}

/**
 * How each cron behaves on Preview. `family_scoped` crons filter their family
 * loop through {@link scopeFamilies}; `skip` crons touch shared state (the
 * pg-boss queue, retention, ops paging) or run sweeps not yet scoped, so they
 * do nothing on Preview.
 */
export const PREVIEW_CRON_POLICY: Readonly<Record<string, 'family_scoped' | 'skip'>> = {
  reminders: 'family_scoped',
  'registration-sequence': 'family_scoped',
  // Claims jobs from the shared pg-boss queue; a Preview claim would steal prod jobs.
  drain: 'skip',
  'queue-maintenance': 'skip',
  // Runs eight family sweeps (follow-ups, check-ins, duty asks, ...) not yet scoped.
  nudge: 'skip',
  'intake-sitting-reminder': 'skip',
  'proactive-review': 'skip',
  'social-watch': 'skip',
  'party-reminders': 'skip',
  'spend-alert': 'skip',
  'delete-sweep': 'skip',
  'attachment-sweep': 'skip',
  inference: 'skip',
  'memory-digest': 'skip',
  'ops-daily': 'skip',
  'registration-verify': 'skip',
  'watched-spots': 'skip',
  'failure-page': 'skip',
  'connector-sync': 'skip',
  'inbound-canary': 'skip',
  'browser-use-watch': 'skip',
};

export type PreviewCronSkip =
  | 'preview_cron_not_scoped'
  | 'preview_no_test_families'
  | 'preview_capture_off';

/** Null when the cron may run; otherwise why it is skipped on Preview. */
export function previewCronSkipReason(
  name: string,
  env: Env = process.env,
): PreviewCronSkip | null {
  if (!isPreviewDeploy(env)) return null;
  if (PREVIEW_CRON_POLICY[name] !== 'family_scoped') return 'preview_cron_not_scoped';
  if (previewTestFamilyIds(env).size === 0) return 'preview_no_test_families';
  if (env.PREVIEW_CAPTURE_TRANSPORT?.trim() !== 'on') return 'preview_capture_off';
  return null;
}
