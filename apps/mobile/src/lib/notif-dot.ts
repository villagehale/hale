import { useSyncExternalStore } from 'react';

/**
 * The Home bell's unread dot is a DERIVED signal, not a stored boolean. It's lit
 * when there's real, unacknowledged activity — see `notifDotOn` for the rule. This
 * store holds only the session-scoped "acknowledged" flag: whether the parent has
 * tapped "Mark all read" since launch. It is never persisted, so it resets fresh
 * each launch (matching the prototype's session-only `notifRead`).
 *
 * Refines Task 6's honesty gap: the dot no longer defaults ON for a brand-new
 * family with nothing waiting — the bell combines this flag with the REAL
 * pending-approvals and message counts, so an empty inbox shows no dot.
 */
let acknowledged = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Marks the current notifications as seen for this session — the Notifications
 * page's "Mark all read" calls this. It quiets the informational message stream's
 * contribution to the bell dot; genuine pending approvals still keep the dot lit
 * (the dot must never hide actionable work — data honesty).
 */
export function markAllNotifsRead(): void {
  if (acknowledged) return;
  acknowledged = true;
  for (const l of listeners) l();
}

/** Reactive read of the session acknowledged flag, so the bell re-renders when it flips. */
export function useNotifsAcknowledged(): boolean {
  return useSyncExternalStore(subscribe, () => acknowledged);
}

/**
 * The bell-dot rule: lit iff there are pending approvals, OR there are messages the
 * parent hasn't acknowledged this session. Pending approvals ignore acknowledgement
 * on purpose — they are unresolved work the dot should surface until they're decided.
 */
export function notifDotOn(
  pendingApprovals: number,
  messageCount: number,
  acknowledgedThisSession: boolean,
): boolean {
  if (pendingApprovals > 0) return true;
  return messageCount > 0 && !acknowledgedThisSession;
}
