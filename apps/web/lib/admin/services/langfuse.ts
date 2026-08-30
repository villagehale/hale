import { SERVICE_TIMEOUT_MS, notConfigured, type ServiceOutcome, unreachable } from './outcome';

/**
 * Langfuse daily metrics — the cross-check beside agent_runs' own numbers. If
 * the two disagree, tracing is dropping runs (or runs are dropping rows).
 */
export interface LangfuseDay {
  day: string;
  traces: number;
  costUsd: number;
}

export const LANGFUSE_METRIC_DAYS = 30;

export async function fetchLangfuseDaily(
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceOutcome<LangfuseDay[]>> {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = process.env;
  const host = process.env.LANGFUSE_HOST;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY || !host) {
    return notConfigured('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_HOST not set');
  }
  const from = new Date(Date.now() - LANGFUSE_METRIC_DAYS * 86_400_000).toISOString();
  try {
    const res = await fetchImpl(
      `${host}/api/public/metrics/daily?fromTimestamp=${encodeURIComponent(from)}&limit=${LANGFUSE_METRIC_DAYS + 1}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
      },
    );
    if (!res.ok) return unreachable(`Langfuse answered ${res.status}`);
    const body = (await res.json()) as {
      data?: { date?: string; countTraces?: number; totalCost?: number }[];
    };
    const rows = (body.data ?? [])
      .filter((r) => typeof r.date === 'string')
      .map(
        (r): LangfuseDay => ({
          day: (r.date as string).slice(0, 10),
          traces: r.countTraces ?? 0,
          costUsd: r.totalCost ?? 0,
        }),
      );
    return { ok: true, data: rows };
  } catch (error) {
    return unreachable(error instanceof Error ? error.name : 'fetch failed');
  }
}
