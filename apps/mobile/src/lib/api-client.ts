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

async function handleUnauthorized(): Promise<never> {
  await tokenStorage.remove(TOKEN_KEY);
  onUnauthorized?.();
  throw new ApiError(401, 'Your session has expired. Please sign in again.');
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE) {
    throw new ApiError(0, 'API base URL is not configured.');
  }

  const token = await tokenStorage.get(TOKEN_KEY);
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
