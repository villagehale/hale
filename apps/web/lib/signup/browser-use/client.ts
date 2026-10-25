/**
 * Minimal REST client for Browser Use Cloud API v4 (US region).
 *
 * Auth is the `X-Browser-Use-API-Key` header, read from BROWSER_USE_API_KEY on
 * the server only. `fetch` is injected so tests drive recorded fixtures and no
 * request leaves the process. Live-view and CDP URLs it returns are credentials:
 * never log them and never write them to audit rows.
 */
export const BROWSER_USE_API_KEY_ENV = 'BROWSER_USE_API_KEY';
export const BROWSER_USE_API_BASE = 'https://api.browser-use.com/api/v4';

export type BrowserUseRunStatus =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TERMINAL_RUN_STATUSES: readonly BrowserUseRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export interface BrowserUseRunRequest {
  task: string;
  outputSchema: Record<string, unknown>;
  sessionId?: string;
  browserSettings?: { profileId: string; record: boolean };
  keepAlive?: number;
  agentmail: false;
  maxCostUsd: number;
  /** Run-scoped secrets the agent types by alias. Never logged. */
  secretBindings?: BrowserUseSecretBinding[];
}

/** A credential typed by alias, only into fields on `allowedDomains`. */
export interface BrowserUseSecretBinding {
  alias: string;
  source: { type: 'inline'; value: string };
  allowedDomains: string[];
}

export interface BrowserUseRunSummary {
  id: string;
  status: BrowserUseRunStatus;
  sessionId: string;
  output: unknown;
  error: string | null;
  totalCostUsd: string | null;
}

export interface BrowserUseRunEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

export interface BrowserUseApi {
  createProfile(input: { name: string; userId: string }): Promise<{ id: string }>;
  deleteProfile(profileId: string): Promise<void>;
  createBrowser(input: { profileId: string; timeoutMinutes: number }): Promise<{
    id: string;
    cdpUrl: string | null;
  }>;
  stopBrowser(browserId: string): Promise<void>;
  createRun(input: BrowserUseRunRequest): Promise<{ id: string; sessionId: string }>;
  getRunStatus(runId: string): Promise<BrowserUseRunStatus>;
  getRun(runId: string): Promise<BrowserUseRunSummary>;
  getRunEvents(
    runId: string,
    after: number,
  ): Promise<{ events: BrowserUseRunEvent[]; nextAfter: number | null }>;
  cancelRun(runId: string): Promise<void>;
}

export class BrowserUseApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`browser use ${path} answered ${status}`);
    this.name = 'BrowserUseApiError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function browserUseApi(options: {
  apiKey: string;
  fetch: FetchLike;
  baseUrl?: string;
}): BrowserUseApi {
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
    async createProfile(input) {
      const profile = await call<{ id: string }>('POST', '/profiles', input);
      return { id: profile.id };
    },
    async deleteProfile(profileId) {
      await call('DELETE', `/profiles/${id(profileId)}`);
    },
    async createBrowser(input) {
      const browser = await call<{ id: string; cdpUrl?: string | null }>('POST', '/browsers', {
        profileId: input.profileId,
        timeout: input.timeoutMinutes,
        enableRecording: false,
      });
      return { id: browser.id, cdpUrl: browser.cdpUrl ?? null };
    },
    async stopBrowser(browserId) {
      await call('PATCH', `/browsers/${id(browserId)}`, { action: 'stop' });
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
      const run = await call<BrowserUseRunSummary>('GET', `/runs/${id(runId)}`);
      return {
        id: run.id,
        status: run.status,
        sessionId: run.sessionId,
        output: run.output ?? null,
        error: run.error ?? null,
        totalCostUsd: run.totalCostUsd ?? null,
      };
    },
    async getRunEvents(runId, after) {
      const page = await call<{ events?: BrowserUseRunEvent[]; nextAfter?: number | null }>(
        'GET',
        `/runs/${id(runId)}/events?after=${after}&include_output=false`,
      );
      return { events: page.events ?? [], nextAfter: page.nextAfter ?? null };
    },
    async cancelRun(runId) {
      await call('POST', `/runs/${id(runId)}/cancel`);
    },
  };
}

export type BrowserUseApiFromEnv =
  | { api: BrowserUseApi; skipped: null; missing: [] }
  | { api: null; skipped: 'not_configured'; missing: [typeof BROWSER_USE_API_KEY_ENV] };

/** The key is unset today, so this names its absence instead of returning a no-op. */
export function browserUseApiFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): BrowserUseApiFromEnv {
  const apiKey = (env[BROWSER_USE_API_KEY_ENV] ?? '').trim();
  if (!apiKey) return { api: null, skipped: 'not_configured', missing: [BROWSER_USE_API_KEY_ENV] };
  return { api: browserUseApi({ apiKey, fetch: fetchImpl }), skipped: null, missing: [] };
}
