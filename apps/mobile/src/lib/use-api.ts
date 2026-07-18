import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

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

export interface UseApiOptions {
  /** Re-read the endpoint whenever the screen regains focus, so a list reflects a
   * change made on a pushed detail (a deleted doc drops, a marked-done item updates)
   * the moment you navigate back. The refetch is SILENT — it updates data in place
   * with no loading/refreshing flip (no phantom RefreshControl spinner) and keeps the
   * shown data on a transient failure. Off by default. */
  refetchOnFocus?: boolean;
}

/**
 * Fetches a GET endpoint through the shared api() client, tracking loading, a
 * user-facing error (for the retry state), and a separate pull-to-refresh flag so
 * a refresh keeps the current data on screen. A 401 is handled by the client
 * (clears the session, bounces to sign-in), so it never lands here as an error.
 */
export function useApi<T>(path: string, opts?: UseApiOptions): UseApi<T> {
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

  // Opt-in silent refetch-on-focus. useFocusEffect also fires on the initial mount
  // focus, where the effect above already loaded, so the ref skips that first run and
  // only re-reads on a SUBSEQUENT focus (i.e. returning from a pushed detail).
  const refetchOnFocus = opts?.refetchOnFocus ?? false;
  const skipInitialFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (!refetchOnFocus) return;
      if (skipInitialFocus.current) {
        skipInitialFocus.current = false;
        return;
      }
      let live = true;
      api<T>(path)
        .then((data) => {
          if (live) setState({ status: 'ready', data, error: null });
        })
        .catch((e) => {
          // 401 already redirected; on any other transient failure keep the shown
          // data rather than flipping a healthy list into an error state.
          if (e instanceof ApiError && e.status === 401) return;
        });
      return () => {
        live = false;
      };
    }, [refetchOnFocus, path]),
  );

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
