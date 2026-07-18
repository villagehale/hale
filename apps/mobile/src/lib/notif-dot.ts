import { useSyncExternalStore } from 'react';

/**
 * The Home bell's unread dot — a session-scoped client flag, not a server read. It
 * shows until the Notifications page marks everything read (Task 12 wires that
 * action); it is never persisted, so it resets fresh each launch. Lives here so the
 * bell (Home) and the future Notifications page observe the same state.
 */
let hasUnread = true;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clears the Home bell dot — the Notifications page's "Mark all read" calls this. */
export function markAllNotifsRead(): void {
  if (!hasUnread) return;
  hasUnread = false;
  for (const l of listeners) l();
}

/** Reactive read of the unread-dot flag, so the bell re-renders when it clears. */
export function useHasUnreadNotifs(): boolean {
  return useSyncExternalStore(subscribe, () => hasUnread);
}
