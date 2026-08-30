import { unstable_cache } from 'next/cache';
import { loadAgentSpend } from './queries/agent-spend';
import { loadAuditMix } from './queries/audit-mix';
import { loadDbErrors } from './queries/errors';
import { loadGrowth } from './queries/growth';
import { loadIntakeFunnel } from './queries/intake-funnel';
import { loadPulse } from './queries/pulse';
import { loadRadar } from './queries/radar';
import { loadTextingTrends } from './queries/texting';
import { fetchLangfuseDaily } from './services/langfuse';
import { fetchReplays, fetchSiteFunnel } from './services/posthog';
import { fetchTwilioAlerts } from './services/twilio';

/**
 * Every panel load behind a 300s server cache — a reload (or a bot) can never
 * hammer the DB with 365-day aggregates or Twilio/PostHog/Langfuse with a
 * request per render. Keys are static: the data is global (one founder, one
 * line), never per-user.
 */
const REVALIDATE_SECONDS = 300;

function cached<T>(key: string, fn: () => Promise<T>): () => Promise<T> {
  return unstable_cache(fn, [key], { revalidate: REVALIDATE_SECONDS });
}

export const cachedPulse = cached('admin-pulse', () => loadPulse());
export const cachedTextingTrends = cached('admin-texting', () => loadTextingTrends());
export const cachedGrowth = cached('admin-growth', () => loadGrowth());
export const cachedIntakeFunnel = cached('admin-intake-funnel', () => loadIntakeFunnel());
export const cachedRadar = cached('admin-radar', () => loadRadar());
export const cachedAuditMix = cached('admin-audit-mix', () => loadAuditMix());
export const cachedAgentSpend = cached('admin-agent-spend', () => loadAgentSpend());
export const cachedDbErrors = cached('admin-db-errors', () => loadDbErrors());
export const cachedTwilioAlerts = cached('admin-twilio-alerts', () => fetchTwilioAlerts());
export const cachedSiteFunnel = cached('admin-site-funnel', () => fetchSiteFunnel());
export const cachedReplays = cached('admin-replays', () => fetchReplays());
export const cachedLangfuseDaily = cached('admin-langfuse-daily', () => fetchLangfuseDaily());
