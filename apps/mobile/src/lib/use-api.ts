import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from './api-client';

type ApiState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: string };

export interface UseApi<T> {
  status: ApiState<T>['status'];
  data: T | null;
  error: string | null;
  /** True during a pull-to-refresh (data already shown). */
  refreshing: boolean;
  /** Retry after an error / initial load. Awaitable so a caller can wait for the
   * re-read before clearing a transient UI state (e.g. a connector's "Checking…"). */
  reload: () => Promise<void>;
  /** Pull-to-refresh: re-fetch without clearing the visible data. Awaitable. */
  refresh: () => Promise<void>;
}

/**
 * Fetches a GET endpoint through the shared api() client, tracking loading, a
 * user-facing error (for the retry state), and a separate pull-to-refresh flag so
 * a refresh keeps the current data on screen. A 401 is handled by the client
 * (clears the session, bounces to sign-in), so it never lands here as an error.
 */
export function useApi<T>(path: string): UseApi<T> {
  const [state, setState] = useState<ApiState<T>>({ status: 'loading', data: null, error: null });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (isRefresh: boolean) => {
      if (isRefresh) setRefreshing(true);
      else setState({ status: 'loading', data: null, error: null });
      try {
        const data = await api<T>(path);
        setState({ status: 'ready', data, error: null });
      } catch (e) {
        // A 401 already redirected; swallow it so we don't flash an error on the
        // way out. Everything else surfaces as a retryable error.
        if (e instanceof ApiError && e.status === 401) return;
        setState({ status: 'error', data: null, error: (e as Error).message });
      } finally {
        if (isRefresh) setRefreshing(false);
      }
    },
    [path],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const reload = useCallback(() => load(false), [load]);
  const refresh = useCallback(() => load(true), [load]);

  return {
    status: state.status,
    data: state.data,
    error: state.error,
    refreshing,
    reload,
    refresh,
  };
}
