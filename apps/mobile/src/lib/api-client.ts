import Constants from 'expo-constants';

import { TOKEN_KEY, tokenStorage } from './token-storage';

/**
 * The Hale mobile HTTP client. Reads the persisted session token and sends it as
 * `Authorization: Bearer` — the web Edge middleware bridges that to the session
 * cookie so every /api route works unchanged. JSON in/out, a bounded timeout, and
 * a structured ApiError. On 401 it clears the stored token and calls the
 * registered onUnauthorized handler so the app returns to sign-in.
 */

export const API_BASE =
  (Constants.expoConfig?.extra?.apiBase as string | undefined) ?? process.env.EXPO_PUBLIC_API_BASE;

const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The auth provider registers this once so a 401 anywhere returns to sign-in. */
let onUnauthorized: (() => void) | null = null;
export function registerOnUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

/** Clear the persisted token and drop in-memory session state → useProtectedRoute bounces to /sign-in. */
export async function signalUnauthorized(): Promise<void> {
  await tokenStorage.remove(TOKEN_KEY);
  onUnauthorized?.();
}

async function handleUnauthorized(): Promise<never> {
  await signalUnauthorized();
  throw new ApiError(401, 'Your session has expired. Please sign in again.');
}

export async function api<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  if (!API_BASE) {
    throw new ApiError(0, 'API base URL is not configured.');
  }

  // A per-call timeout override: most routes want the tight default, but a season
  // search re-runs discovery (an LLM agent call) and legitimately needs longer than
  // 15s — otherwise the client aborts a working request and reports "Network error".
  const { timeoutMs, ...requestInit } = init ?? {};
  const token = await tokenStorage.get(TOKEN_KEY);
  const headers = new Headers(requestInit.headers);
  headers.set('accept', 'application/json');
  // A multipart upload (FormData) must let fetch set content-type so it can add the
  // boundary; only stamp JSON when the body is not FormData.
  if (requestInit.body !== undefined && !(requestInit.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  if (token) headers.set('authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...requestInit,
      headers,
      signal: AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again.');
  }

  if (res.status === 401) return handleUnauthorized();

  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: { error?: string }) => b?.error)
      .catch(() => undefined);
    throw new ApiError(res.status, detail ?? `Request failed (${res.status}).`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
