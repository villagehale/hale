import {
  BROWSER_USE_API_BASE,
  BROWSER_USE_API_KEY_ENV,
  BrowserUseApiError,
  type BrowserUseRunStatus,
  type FetchLike,
} from '../client';

/**
 * The V4 calls the watch job needs and the signup client does not: workspaces, runs
 * pinned to a workspace with an explicit model, and the session's full recorded cost
 * (`GET /sessions/{id}/cost`; a run's `totalCostUsd` is its model charge only).
 * Same header, same error type, same injected `fetch` as ../client.ts.
 */
export interface WatchRunRequest {
  task: string;
  outputSchema: Record<string, unknown>;
  workspaceId: string;
  model: string;
  modelParams: Record<string, unknown>;
  maxCostUsd: number;
  agentmail: false;
  browserSettings: { proxyCountryCode: string | null; record: false };
}

export interface WatchRunSummary {
  status: BrowserUseRunStatus;
  sessionId: string;
  output: unknown;
  totalCostUsd: string | null;
}

export interface BrowserUseWatchApi {
  createWorkspace(name: string): Promise<{ id: string }>;
  createRun(input: WatchRunRequest): Promise<{ id: string; sessionId: string }>;
  getRunStatus(runId: string): Promise<BrowserUseRunStatus>;
  getRun(runId: string): Promise<WatchRunSummary>;
  cancelRun(runId: string): Promise<void>;
  /** Null when the endpoint does not answer with a number. */
  getSessionCostUsd(sessionId: string): Promise<number | null>;
}

export function browserUseWatchApi(options: {
  apiKey: string;
  fetch: FetchLike;
  baseUrl?: string;
}): BrowserUseWatchApi {
  const base = (options.baseUrl ?? BROWSER_USE_API_BASE).replace(/\/+$/, '');
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await options.fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Browser-Use-API-Key': options.apiKey,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new BrowserUseApiError(response.status, path.split('?')[0] ?? path);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const id = (value: string) => encodeURIComponent(value);
  return {
    async createWorkspace(name) {
      const workspace = await call<{ id: string }>('POST', '/workspaces', { name });
      return { id: workspace.id };
    },
    async createRun(input) {
      const run = await call<{ id: string; sessionId: string }>('POST', '/runs', input);
      return { id: run.id, sessionId: run.sessionId };
    },
    async getRunStatus(runId) {
      const status = await call<{ status: BrowserUseRunStatus }>(
        'GET',
        `/runs/${id(runId)}/status`,
      );
      return status.status;
    },
    async getRun(runId) {
      const run = await call<Partial<WatchRunSummary>>('GET', `/runs/${id(runId)}`);
      return {
        status: run.status ?? 'failed',
        sessionId: run.sessionId ?? '',
        output: run.output ?? null,
        totalCostUsd: run.totalCostUsd ?? null,
      };
    },
    async cancelRun(runId) {
      await call('POST', `/runs/${id(runId)}/cancel`);
    },
    async getSessionCostUsd(sessionId) {
      const cost = await call<{ totalCostUsd?: unknown }>('GET', `/sessions/${id(sessionId)}/cost`);
      return usd(cost?.totalCostUsd);
    },
  };
}

/** A dollar amount as Browser Use writes it (a decimal string), or null. */
export function usd(value: unknown): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type BrowserUseWatchApiFromEnv =
  | { api: BrowserUseWatchApi; skipped: null }
  | { api: null; skipped: 'not_configured' };

export function browserUseWatchApiFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): BrowserUseWatchApiFromEnv {
  const apiKey = (env[BROWSER_USE_API_KEY_ENV] ?? '').trim();
  if (!apiKey) return { api: null, skipped: 'not_configured' };
  return { api: browserUseWatchApi({ apiKey, fetch: fetchImpl }), skipped: null };
}
