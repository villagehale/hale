import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  getActiveTraceId,
  propagateAttributes,
  startActiveObservation,
  startObservation,
} from '@langfuse/tracing';
import { haleMask } from './mask';

/**
 * The single shared Langfuse wiring for every web-side agent path (hard rules
 * #1, #6, #8).
 *
 * - ONE span processor, initialised with EXPLICIT { publicKey, secretKey, baseUrl }
 *   from env (the HIPAA instance) — no env-name autodetection — and the ONE shared
 *   `haleMask` so teen raw content + contact PII never leave the process (rule #1).
 *   Exported so `instrumentation.ts` registers it and route handlers flush it.
 * - `exportMode: 'immediate'` because the web app runs on short-lived Vercel
 *   functions; combined with `flushTelemetry()` before each entry path returns,
 *   this is the serverless flush the Langfuse docs call the #1 mistake to miss.
 * - `traceAgentRun` wraps an agent path in a named trace + propagated correlating
 *   attributes and hands back the Langfuse trace id so the caller can close the
 *   loop into agent_runs.langfuse_trace_id (rule #6 — telemetry stays observable).
 * - Tracing is BEST-EFFORT (rule #8): a Langfuse/OTel error is caught and logged,
 *   never propagated to the user-facing agent response. The work always runs.
 */

export const langfuseSpanProcessor = new LangfuseSpanProcessor({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL,
  mask: haleMask,
  exportMode: 'immediate',
});

/** The trace name per agent path — descriptive, filterable (Langfuse baseline). */
export type AgentTraceName =
  | 'ask-hale'
  | 'daily-brief'
  | 'infer-memory'
  | 'discovery'
  | 'rank-recommendations'
  | 'curate-shortlist'
  | 'classify-event'
  | 'draft-action'
  | 'review-action';

export interface AgentTraceContext {
  name: AgentTraceName;
  /** Groups multi-turn runs (Ask Hale conversation); omit for one-shot paths. */
  sessionId?: string;
  /** The acting parent's user id; 'system' for scheduled runs. */
  userId?: string;
  /** [feature, planTier?] — filterable segments. */
  tags?: string[];
  /** Correlating, non-PII metadata (familyId). Values must be strings ≤200 chars. */
  metadata?: Record<string, string>;
}

export interface AgentGeneration {
  model: string;
  /** Token counts → usageDetails so Langfuse computes cost. */
  usage: { promptTokens: number; completionTokens: number };
  latencyMs?: number;
}

export interface AgentTrace {
  /** The Langfuse trace id, or null when tracing is unavailable (best-effort). */
  traceId: string | null;
  /** Record one LLM call as a generation observation under this trace. */
  recordGeneration: (name: string, generation: AgentGeneration) => void;
}

function logTelemetryError(where: string, err: unknown): void {
  console.error(`[langfuse] ${where} failed (tracing is best-effort):`, err);
}

/**
 * Run `work` inside a named Langfuse trace with correlating attributes propagated
 * to every child observation. `work` receives an `AgentTrace` it can use to record
 * generations and read the trace id. ALL tracing failures are swallowed (rule #8):
 * if Langfuse is misconfigured or throws, `work` still runs and its result is
 * returned with `traceId: null`.
 */
export async function traceAgentRun<T>(
  ctx: AgentTraceContext,
  work: (trace: AgentTrace) => Promise<T>,
): Promise<T> {
  // `entered` distinguishes a tracing-SETUP failure (run `work` uninstrumented as a
  // fallback) from a genuine `work` error (must propagate, and `work` must not re-run).
  let entered = false;

  try {
    return await startActiveObservation(ctx.name, async () => {
      const attributes: Parameters<typeof propagateAttributes>[0] = { traceName: ctx.name };
      if (ctx.userId) attributes.userId = ctx.userId;
      if (ctx.sessionId) attributes.sessionId = ctx.sessionId;
      if (ctx.tags) attributes.tags = ctx.tags;
      if (ctx.metadata) attributes.metadata = ctx.metadata;

      return await propagateAttributes(attributes, async () => {
        let traceId: string | null = null;
        try {
          traceId = getActiveTraceId() ?? null;
        } catch (err) {
          logTelemetryError('getActiveTraceId', err);
        }

        const trace: AgentTrace = { traceId, recordGeneration: recordGenerationSafe };
        entered = true;
        return await work(trace);
      });
    });
  } catch (err) {
    if (entered) {
      // The error came from `work`, not from tracing — propagate it (rule #8 is
      // about not letting TELEMETRY break the agent, not about swallowing real errors).
      throw err;
    }
    logTelemetryError('traceAgentRun setup', err);
    return work({ traceId: null, recordGeneration: () => {} });
  }
}

function recordGenerationSafe(name: string, generation: AgentGeneration): void {
  try {
    startObservation(
      name,
      {
        model: generation.model,
        usageDetails: {
          input: generation.usage.promptTokens,
          output: generation.usage.completionTokens,
        },
      },
      { asType: 'generation' },
    ).end();
  } catch (err) {
    logTelemetryError('recordGeneration', err);
  }
}

/**
 * Flush buffered spans before a short-lived function returns (the serverless flush
 * the docs call the #1 mistake to skip). Best-effort: a flush failure is logged,
 * never surfaced — wire this into every web entry path that runs an agent.
 */
export async function flushTelemetry(): Promise<void> {
  try {
    await langfuseSpanProcessor.forceFlush();
  } catch (err) {
    logTelemetryError('flushTelemetry', err);
  }
}
