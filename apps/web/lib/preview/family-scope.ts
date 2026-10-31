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
 * - Outbound sends go only through the capture transport, which itself refuses
 *   any recipient outside the synthetic fake-family range (isSyntheticProbeNumber).
 *
 * Off preview (production, local, CI) every function here is a no-op, so prod
 * behaviour is unchanged.
 */
type Env = Readonly<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * How each cron behaves on Preview. `family_scoped` crons filter their family
 * loop through {@link scopeFamilies}; `skip` crons touch shared state (the
 * pg-boss queue, retention, ops paging) or run sweeps not yet scoped, so they
 * do nothing on Preview.
 */
/**
 * The pg-boss schema this deploy enqueues into and drains from. Preview gets its own
 * schema so production never claims a Preview job and Preview never claims a
 * production one: whatever a Preview producer enqueues (a fake family's inbound turn,
 * a Preview reminder send) can only be drained by Preview itself.
 */
export const PROD_QUEUE_SCHEMA = 'pgboss';
export const PREVIEW_QUEUE_SCHEMA = 'pgboss_preview';
export function queueSchema(env: Env = process.env): string {
  return isPreviewDeploy(env) ? PREVIEW_QUEUE_SCHEMA : PROD_QUEUE_SCHEMA;
}

/**
 * `own_queue` crons touch only this deploy's pg-boss schema ({@link queueSchema}), so
 * on Preview they run against Preview's own queue and nothing shared.
 */
export const PREVIEW_CRON_POLICY: Readonly<Record<string, 'family_scoped' | 'own_queue' | 'skip'>> =
  {
    reminders: 'family_scoped',
    'registration-sequence': 'family_scoped',
    // Preview drains and maintains its OWN pg-boss schema (queueSchema), never prod's.
    // The drain's shared-table legs (first-reply, group reminders, signup watches) are
    // skipped on Preview inside the route.
    drain: 'own_queue',
    'queue-maintenance': 'own_queue',
    // Runs eight family sweeps (follow-ups, check-ins, duty asks, ...) not yet scoped.
    nudge: 'skip',
    'intake-sitting-reminder': 'skip',
    'proactive-review': 'skip',
    'social-watch': 'skip',
    'party-reminders': 'skip',
    // Carpool and group-plan family sweeps, not yet scoped.
    'carpool-reminders': 'skip',
    'group-plan-rsvp-followups': 'skip',
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
  const policy = PREVIEW_CRON_POLICY[name];
  if (policy !== 'family_scoped' && policy !== 'own_queue') return 'preview_cron_not_scoped';
  if (previewTestFamilyIds(env).size === 0) return 'preview_no_test_families';
  if (env.PREVIEW_CAPTURE_TRANSPORT?.trim() !== 'on') return 'preview_capture_off';
  return null;
}
