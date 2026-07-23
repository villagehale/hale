import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, type Skill, pickModel, runAgent } from '@hale/agent';
import type { Database } from '@hale/db';
import { type RecordAgentRunInput, recordAgentRun, sonnetCostUsd } from '~/lib/agent-run';
import { buildCronGuardDeps } from '~/lib/cron/guards';
import { type AgentTraceName, traceAgentRun } from '~/lib/telemetry/langfuse';
import { findInventedFacts } from './facts-lint';

/**
 * VIL-229 · the shared voice composer — the house agent seam for user-facing copy.
 *
 * It is the exact structured-output-with-deterministic-fallback shape as
 * parseVillageSearchIntent (apps/web/lib/village/ai-search-parse.ts): the skill is
 * loaded by the CALLER, OUTSIDE this boundary (a missing skill file is a deploy bug
 * that must surface, not degrade); this runs the REAL `runAgent` seam — pickModel by
 * the skill's task, no tools, the guarded invoker, one round-trip — over the
 * already-redacted context, parses the JSON answer into the caller's typed TVoice,
 * and lints every voice string against the injected fact slots.
 *
 * Fail-open by construction (rule #8): the model composes only the WORDS. On ANY
 * failure — an unparseable/extra-field answer, a fact the model invented (a time or
 * link not in the slots), or the model call itself throwing — it returns
 * `{ voice: null, degraded: true }` and logs. It NEVER throws out of this stage, so
 * the caller always falls back to its deterministic copy and the send is never
 * blocked on model availability. Facts (times, dates, names, links) are INJECTED by
 * the deterministic shell; the model only writes around them.
 *
 * Rule #1: the caller passes the SAME redacted view the template renders (teen-gated,
 * sensitive-genericized, name-leveled). The model never sees more than the email will.
 */

const MAX_STEPS = 1;

/**
 * The first balanced `{…}` object literal in a string, or null. The voice skills are
 * instructed to answer with a single JSON object; a model sometimes wraps it in prose,
 * so we take the first object literal (same technique as the village intent parse).
 * Shared by every voice parser so JSON extraction never drifts between them.
 */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

let defaultClient: Anthropic | undefined;

/**
 * The shared voice client, or null when voice is unavailable (no API key, or the
 * VOICE_DISABLED kill switch). A null client means the caller skips composeVoice
 * entirely and renders the deterministic copy — the send still goes (rule #8).
 */
export function voiceClient(): AgentClient | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || process.env.VOICE_DISABLED === 'true') return null;
  defaultClient ??= new Anthropic({ apiKey });
  return defaultClient;
}

export interface ComposeVoiceArgs<TVoice> {
  /** The voice skill, loaded by the caller OUTSIDE the fallback boundary (rule #8). */
  skill: Skill;
  /** The already-redacted view the template renders — the model sees no more (rule #1). */
  context: unknown;
  /** The injected facts (titles, dates, times, links) the model may reuse but never
   * invent — a voice string carrying a time/link absent from every slot is rejected. */
  factSlots: string[];
  /** Parse+validate the model's JSON answer into the typed voice, rejecting unknown/
   * extra fields; null on a structurally-broken answer. */
  parse: (answer: string | null) => TVoice | null;
  /** Every user-facing string in the voice, for the invented-fact lint. */
  voiceStrings: (voice: TVoice) => string[];
  client: AgentClient;
  database: Database;
  familyId: string;
  agentName: RecordAgentRunInput['agentName'];
  traceName: AgentTraceName;
  maxTokens: number;
}

export interface ComposedVoice<TVoice> {
  /** The composed voice, or null when the stage degraded to the deterministic copy. */
  voice: TVoice | null;
  /** True when the model call/parse/lint failed and the caller must render deterministically. */
  degraded: boolean;
}

/** Parse the answer, then lint every voice string against the fact slots. Returns null
 * (degrade) on a broken parse OR any invented time/link, logging which (never PII). */
function validateVoice<TVoice>(
  args: ComposeVoiceArgs<TVoice>,
  answer: string | null,
): TVoice | null {
  const voice = args.parse(answer);
  if (!voice) {
    console.error(
      { familyId: args.familyId, voice: args.traceName },
      'voice: model answer failed to parse — sending deterministic copy',
    );
    return null;
  }
  for (const text of args.voiceStrings(voice)) {
    const invented = findInventedFacts(text, args.factSlots);
    if (invented.length > 0) {
      console.error(
        { familyId: args.familyId, voice: args.traceName, invented },
        'voice: model invented a fact not in slots — sending deterministic copy',
      );
      return null;
    }
  }
  return voice;
}

export async function composeVoice<TVoice>(
  args: ComposeVoiceArgs<TVoice>,
): Promise<ComposedVoice<TVoice>> {
  const modelUsed = pickModel(args.skill.meta.task);
  const guardDeps = buildCronGuardDeps(args.database);

  try {
    return await traceAgentRun(
      {
        name: args.traceName,
        userId: 'system',
        tags: [args.traceName],
        metadata: { familyId: args.familyId },
      },
      async (trace) => {
        const startedAt = Date.now();
        const result = await runAgent({
          skill: args.skill,
          context: args.context,
          tools: [],
          client: args.client,
          maxSteps: MAX_STEPS,
          maxTokens: args.maxTokens,
          toolContext: { familyId: args.familyId, actor: 'system' },
          guardDeps,
        });
        trace.recordGeneration(`${args.traceName}-compose`, { model: modelUsed, usage: result.usage });

        const voice = validateVoice(args, result.answer);
        await recordAgentRun(args.database, {
          familyId: args.familyId,
          agentName: args.agentName,
          modelUsed,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          costUsd: sonnetCostUsd(result.usage),
          latencyMs: Date.now() - startedAt,
          status: voice ? 'completed' : 'failed',
          langfuseTraceId: trace.traceId,
        });
        return { voice, degraded: voice === null };
      },
    );
  } catch (err) {
    // The model call itself failed (network/API/timeout) — the send must still go on
    // the deterministic copy rather than error out (rule #8: log, never throw/block).
    console.error(
      { err, familyId: args.familyId, voice: args.traceName },
      'voice: compose call failed — sending deterministic copy',
    );
    return { voice: null, degraded: true };
  }
}
