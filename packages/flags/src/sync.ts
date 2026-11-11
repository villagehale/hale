import { FLAGS, type FlagSpec, PAYMENT_ENV_ONLY } from './catalog.js';
import { posthogHost } from './client.js';

export interface SyncOptions {
  dry?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export interface SyncFlagResult {
  key: string;
  env: string;
  action: 'create' | 'update' | 'unchanged' | 'would-create' | 'would-update';
}

export interface SyncResult {
  dry: boolean;
  flags: SyncFlagResult[];
  skippedPayments: readonly string[];
  familyGroupIndex: number | null;
}

interface RemoteFlag {
  id: number;
  key: string;
  name: string;
  active: boolean;
  filters: Record<string, unknown>;
}

function apiOrigin(env: Record<string, string | undefined>): string {
  if (env.POSTHOG_API_HOST) return env.POSTHOG_API_HOST.replace(/\/$/, '');
  return posthogHost(env).replace('.i.posthog.com', '.posthog.com').replace(/\/$/, '');
}

async function api<T>(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const projectId = env.POSTHOG_PROJECT_ID;
  const token = env.POSTHOG_PERSONAL_API_KEY;
  if (!projectId || !token) {
    throw new Error('POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are required to sync flags');
  }
  const url = `${apiOrigin(env)}/api/projects/${projectId}${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PostHog ${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function booleanFilters(familyGroupIndex: number | null): Record<string, unknown> {
  const filters: Record<string, unknown> = {
    groups: [{ properties: [], rollout_percentage: 100 }],
  };
  if (familyGroupIndex !== null) filters.aggregation_group_type_index = familyGroupIndex;
  return filters;
}

function multivariateFilters(
  spec: FlagSpec,
  familyGroupIndex: number | null,
): Record<string, unknown> {
  const onVariant = spec.onVariant ?? spec.variants?.[spec.variants.length - 1];
  const variants = (spec.variants ?? []).map((key) => ({
    key,
    name: key,
    rollout_percentage: key === onVariant ? 100 : 0,
  }));
  const filters: Record<string, unknown> = {
    multivariate: { variants },
    groups: [{ properties: [], rollout_percentage: 100, variant: onVariant }],
  };
  if (familyGroupIndex !== null) filters.aggregation_group_type_index = familyGroupIndex;
  return filters;
}

function desiredPayload(spec: FlagSpec, familyGroupIndex: number | null): Record<string, unknown> {
  return {
    key: spec.posthogKey,
    name: `${spec.posthogKey} (${spec.env})`,
    active: true,
    ensure_experience_continuity: false,
    filters:
      spec.type === 'multivariate'
        ? multivariateFilters(spec, familyGroupIndex)
        : booleanFilters(familyGroupIndex),
  };
}

function sameFilters(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function listAllFlags(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<RemoteFlag[]> {
  const out: RemoteFlag[] = [];
  let path: string | null = '/feature_flags?limit=100';
  while (path) {
    const page: { results: RemoteFlag[]; next: string | null } = await api(
      env,
      fetchImpl,
      'GET',
      path.startsWith('http') ? path.replace(/^.*\/api\/projects\/[^/]+/, '') : path,
    );
    out.push(...(page.results ?? []));
    if (!page.next) break;
    const origin = apiOrigin(env);
    const next = page.next.startsWith('http')
      ? page.next.slice(origin.length).replace(/^\/api\/projects\/[^/]+/, '')
      : page.next;
    path = next.length > 0 ? next : null;
  }
  return out;
}

async function familyGroupIndex(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  try {
    const types = await api<Array<{ group_type: string; group_type_index: number }>>(
      env,
      fetchImpl,
      'GET',
      '/groups_types/',
    );
    const family = types.find((row) => row.group_type === 'family');
    return family?.group_type_index ?? null;
  } catch {
    return null;
  }
}

/**
 * Create or update every catalog flag at 100% rollout (Barton's rule). Idempotent.
 * Payment env vars are never created. `--dry` prints the plan and writes nothing.
 */
export async function syncFlags(options: SyncOptions = {}): Promise<SyncResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const dry = options.dry === true;
  const groupIndex = dry ? null : await familyGroupIndex(env, fetchImpl);
  const existing = dry ? [] : await listAllFlags(env, fetchImpl);
  const byKey = new Map(existing.map((flag) => [flag.key, flag]));
  const results: SyncFlagResult[] = [];

  for (const spec of FLAGS) {
    const payload = desiredPayload(spec, groupIndex);
    const remote = byKey.get(spec.posthogKey);
    if (!remote) {
      if (dry) {
        results.push({ key: spec.posthogKey, env: spec.env, action: 'would-create' });
        continue;
      }
      await api(env, fetchImpl, 'POST', '/feature_flags/', payload);
      results.push({ key: spec.posthogKey, env: spec.env, action: 'create' });
      continue;
    }
    const needs =
      remote.active !== true ||
      remote.name !== payload.name ||
      !sameFilters(remote.filters, payload.filters);
    if (!needs) {
      results.push({ key: spec.posthogKey, env: spec.env, action: 'unchanged' });
      continue;
    }
    if (dry) {
      results.push({ key: spec.posthogKey, env: spec.env, action: 'would-update' });
      continue;
    }
    await api(env, fetchImpl, 'PATCH', `/feature_flags/${remote.id}/`, payload);
    results.push({ key: spec.posthogKey, env: spec.env, action: 'update' });
  }

  return {
    dry,
    flags: results,
    skippedPayments: PAYMENT_ENV_ONLY.map((row) => row.env),
    familyGroupIndex: groupIndex,
  };
}
