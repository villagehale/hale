import { posthogProjectId } from '../links';
import { SERVICE_TIMEOUT_MS, notConfigured, type ServiceOutcome, unreachable } from './outcome';

/**
 * PostHog's PRIVATE query/replay API — needs a personal API key; the
 * NEXT_PUBLIC capture key can only write. Both reads are founder-facing
 * aggregates: a three-stage site funnel and the replay list. Nothing here
 * sends PostHog anything (read-only), and nothing PostHog returns carries
 * family data — visitors are pre-signup by construction.
 */
const POSTHOG_API_HOST = 'https://us.posthog.com';

/** The site's real event names (apps/site): provider-captured $pageview, the
 * sms: deep-link CTA, and the text-entry screen view. */
export const SITE_FUNNEL_STAGES = [
  { event: '$pageview', label: 'site views' },
  { event: 'cta_text_click', label: 'tapped "text Hale"' },
  { event: 'text_entry_viewed', label: 'reached text entry' },
] as const;

export const SITE_FUNNEL_DAYS = 30;

export interface SiteFunnelStage {
  label: string;
  count: number;
}

export interface ReplayRow {
  id: string;
  startedAt: string;
  durationSeconds: number;
  startUrl: string;
  clickCount: number;
}

function config(): { key: string; projectId: string } | null {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = posthogProjectId();
  if (!key || !projectId) return null;
  return { key, projectId };
}

async function posthogGet(
  path: string,
  fetchImpl: typeof fetch,
  init?: RequestInit,
): Promise<Response> {
  const conf = config();
  if (!conf) throw new Error('unconfigured');
  return fetchImpl(`${POSTHOG_API_HOST}/api/projects/${conf.projectId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${conf.key}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
  });
}

const NOT_CONFIGURED_DETAIL = 'POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set';

export async function fetchSiteFunnel(
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceOutcome<SiteFunnelStage[]>> {
  if (!config()) return notConfigured(NOT_CONFIGURED_DETAIL);
  const countIfs = SITE_FUNNEL_STAGES.map(
    (stage) => `count(distinct if(event = '${stage.event}', distinct_id, null))`,
  ).join(', ');
  const query = `select ${countIfs} from events where timestamp >= now() - interval ${SITE_FUNNEL_DAYS} day`;
  try {
    const res = await posthogGet('/query/', fetchImpl, {
      method: 'POST',
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    });
    if (!res.ok) return unreachable(`PostHog answered ${res.status}`);
    const body = (await res.json()) as { results?: unknown[][] };
    const row = body.results?.[0] ?? [];
    return {
      ok: true,
      data: SITE_FUNNEL_STAGES.map((stage, i) => ({
        label: stage.label,
        count: typeof row[i] === 'number' ? (row[i] as number) : 0,
      })),
    };
  } catch (error) {
    return unreachable(error instanceof Error ? error.name : 'fetch failed');
  }
}

export async function fetchReplays(
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceOutcome<ReplayRow[]>> {
  if (!config()) return notConfigured(NOT_CONFIGURED_DETAIL);
  try {
    const res = await posthogGet('/session_recordings/?limit=50', fetchImpl);
    if (!res.ok) return unreachable(`PostHog answered ${res.status}`);
    const body = (await res.json()) as {
      results?: {
        id?: string;
        start_time?: string;
        recording_duration?: number;
        start_url?: string | null;
        click_count?: number;
      }[];
    };
    const rows = (body.results ?? [])
      .filter((r) => typeof r.id === 'string')
      .map(
        (r): ReplayRow => ({
          id: r.id as string,
          startedAt: r.start_time ?? '',
          durationSeconds: r.recording_duration ?? 0,
          startUrl: r.start_url ?? '',
          clickCount: r.click_count ?? 0,
        }),
      );
    return { ok: true, data: rows };
  } catch (error) {
    return unreachable(error instanceof Error ? error.name : 'fetch failed');
  }
}
