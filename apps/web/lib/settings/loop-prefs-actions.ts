'use server';

import { type LoopPrefUpdate, type SetLoopPrefResult, setLoopPref } from '~/lib/settings/loop-prefs';

/**
 * The web Settings → Notifications loop-prefs control. A thin server-action seam
 * over the shared loop-prefs lib (the same one the mobile route calls): the lib
 * resolves the caller's family from the session — never a fabricated id (rule #1) —
 * validates the value, and writes an immutable audit_log row alongside the upsert
 * (rule #6). Kept as a passthrough so the audit/auth/degradation/validation
 * contract lives in exactly one place.
 */
export async function setLoopPrefAction(update: LoopPrefUpdate): Promise<SetLoopPrefResult> {
  return setLoopPref(update);
}
