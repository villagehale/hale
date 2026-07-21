/**
 * The moment-of-value push-permission decision, factored out of the screens so the
 * "should we ask now?" logic is unit-tested without a native runtime. Hale never asks
 * at launch: it asks at a moment of value (a first approval, a Sunday plan enrollment)
 * with an explainer, and remembers a decline so it doesn't nag every launch.
 */

/** The OS-level notification permission, as expo-notifications reports it. */
export type OsPermission = 'undetermined' | 'granted' | 'denied';

/** What the app remembers about the parent's own choice (persisted). A decline carries
 * when it happened so the re-ask window can elapse; null means never asked/declined. */
export type PushDecision = { kind: 'declined'; at: string } | null;

/**
 * What to do next given the OS state and the parent's remembered choice:
 * - `register`: the OS already granted — just (re)register/refresh the token, no prompt.
 * - `offer`: show the explainer sheet (the OS prompt follows on accept).
 * - `idle`: do nothing here — either the OS denied (only the Settings deep-link helps)
 *   or the parent declined within the re-ask window.
 */
export type PromptAction = 'register' | 'offer' | 'idle';

/** After a decline, don't re-offer for 30 days (spec). */
export const REASK_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export function nextPromptAction(os: OsPermission, stored: PushDecision, now: Date): PromptAction {
  if (os === 'granted') return 'register';
  // Denied is terminal for in-app prompting — iOS won't show the OS prompt again, so the
  // only path back on is the phone's Settings (surfaced separately). Never re-prompt.
  if (os === 'denied') return 'idle';
  // Undetermined: offer, unless the parent declined our explainer within the window.
  if (stored?.kind === 'declined') {
    return now.getTime() - Date.parse(stored.at) >= REASK_AFTER_MS ? 'offer' : 'idle';
  }
  return 'offer';
}
