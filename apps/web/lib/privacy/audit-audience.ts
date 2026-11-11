/**
 * VIL-635 · audit_log.audience is filtered on History and the access export.
 *
 * Off unless `AUDIT_LOG_AUDIENCE_ENABLED` is exactly `true`. A trailing
 * newline, `TRUE`, `on`, and `1` stay off. Unset stays off. Lit, a row with an
 * audience shows only to that adult. Unlit, History and the export keep the
 * pre-VIL-635 family-wide reads (INTERNAL_TRAIL_VERBS / NOT_IN_FAMILY_EXPORT).
 * Writers always set the column; the flag only gates the read.
 */

export const AUDIT_LOG_AUDIENCE_ENABLED_ENV = 'AUDIT_LOG_AUDIENCE_ENABLED';

export function auditLogAudienceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[AUDIT_LOG_AUDIENCE_ENABLED_ENV] === 'true';
}
