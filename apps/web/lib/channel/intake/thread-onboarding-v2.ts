import { isEnabled } from '@hale/flags';
import { coldStartLadderEnabled } from './cold-start/flags';

/**
 * VIL-721 — onboarding in the thread, v2.
 *
 * Off unless THREAD_ONBOARDING_V2_ENABLED is exactly `true`. A trailing newline,
 * `TRUE`, and `1` stay off. Unset stays off.
 *
 * Dark, the walk is today's: postal, kids, ages, the map, name, Gmail in its own
 * turn with its own link, the calendar in its own turn with its own link,
 * schedule, co-parent. Every prompt, tool schema and eval cache key keeps its
 * bytes.
 *
 * Lit, two things change and nothing else:
 *  - After the ages (and the map), Hale asks what the kids already do. The model
 *    reads the answer into `activities`; code keeps each one as a family memory
 *    fact with its provenance (the parent's own message, who said it, when).
 *  - Gmail and the calendar are ONE item and ONE link. The link opens one Google
 *    consent that asks for both read scopes, so the parent meets Google's
 *    unverified-app screen once. The model is handed that screen as a fact
 *    (GOOGLE_UNVERIFIED_APP_FACT) and prepares the parent for it in its own words.
 *
 * Every message on either path is the model's. When the model cannot write one,
 * nothing is sent and #ops is paged (friend-voice.ts); this module writes no
 * sentence of its own.
 *
 * It rides the friend walk: COLD_START_LADDER_ENABLED must be on too. Without it,
 * provisioning runs the older ladder, whose name ask and per-provider cards this
 * walk does not replace, so the v2 order would put the wrong question under them.
 */
export const THREAD_ONBOARDING_V2_ENABLED_ENV = 'THREAD_ONBOARDING_V2_ENABLED';

/** Exact `true`, and the friend walk on. A trailing newline stays off. */
export function threadOnboardingV2Enabled(): boolean {
  return isEnabled('thread-onboarding-v2') && coldStartLadderEnabled();
}
