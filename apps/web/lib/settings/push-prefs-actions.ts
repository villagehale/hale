'use server';

import {
  type PushPref,
  type SetPushPrefResult,
  setPushNotificationPref,
} from '~/lib/settings/push-notification-prefs';

/**
 * The web Settings → Notifications toggle. A thin server-action seam over the
 * shared push-prefs lib (the same one the mobile route calls): the lib resolves
 * the caller's family from the session — never a fabricated id (rule #1) — and
 * writes an immutable audit_log row alongside the upsert (rule #6). Kept as a
 * passthrough so the audit/auth/degradation contract lives in exactly one place.
 */
export async function setPushNotificationPrefAction(
  pref: PushPref,
  enabled: boolean,
): Promise<SetPushPrefResult> {
  return setPushNotificationPref(pref, enabled);
}
