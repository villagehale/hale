import { type AgentClient, type AgentUsage, type Skill, agentRunCostUsd, pickLane, pickModel } from '@hale/agent';
import type Anthropic from '@anthropic-ai/sdk';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { recordAgentRun } from '~/lib/agent-run';
import { plainText } from '~/lib/channel/coach/reply';
import { forceToolJson } from '~/lib/pipeline/structured';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { voicePassEnabledFor } from './flag';
import {
  type Aside,
  type AsideContext,
  type AsideLane,
  type AsideRefusal,
  asideUserMessage,
  asideViolations,
  assembleWithAside,
} from './guard';

/**
 * THE ONE MODEL CALL IN THE VOICE PASS, and everything it is allowed not to do.
 *
 * It composes at most one short clause and hands back the assembled body. It NEVER
 * composes the message: `assembleWithAside` puts the lane's own deterministic sentence
 * and the clause together, so every fact in the alert survives by construction rather
 * than by a check (see guard.ts).
 *
 * EVERY ABSENCE IS A NAMED OUTCOME (rule #11). The port is non-nullable — a lane does not
 * take `voicePass: VoicePass | null` and quietly skip; it takes a `VoicePass` whose own
 * result says which of the eight things happened. All seven `NoAside` values return the
 * core VERBATIM, so nothing is left unspent, no claim is held and the send path is
 * unchanged. That is the whole reason a refusal here is free, and the reason the guard
 * can afford to be as strict as it is.
 *
 * ONE ATTEMPT. The follow-up ask recomposes three times because its refusal is a MISSING
 * message; this one's refusal is today's message, which ships either way. A second round
 * trip would double the spend on the highest-volume proactive class to recover a clause
 * nobody will miss.
 */

/** Why no clause went out. The first four are the follow-up's deferral vocabulary, name
 * for name, so an operator reading two lanes' logs reads one vocabulary — the difference
 * being that none of these defers anything. */
export type NoAside =
  /** `VOICE_PASS_LANES` does not name this lane. Non-zero on a dark deploy is the proof
   * the pass is wired at all, which is why it is an outcome and not an early return. */
  | 'lane_dark'
  /** Rule #1. A 13+ child's alert is rendered category-only, with the sender and the time
   * deliberately dropped; a warm clause on a blanked message is a re-disclosure surface
   * with nothing to gain. A subtraction, not a second filter — the model is never called. */
  | 'teen_redacted'
  /** No API key, or `VOICE_DISABLED`. Configuration. */
  | 'client_unavailable'
  /** The skill file did not load. A deploy bug, and it must look like one. */
  | 'skill_unavailable'
  /** The call threw, or the composer's own deadline fired. */
  | 'model_failed'
  /** The model had nothing to add. The right answer most of the time. */
  | 'empty'
  /** The guard said no. The refusals ride the tally and the log line, never the clause. */
  | 'refused';

/** What the sweep tallies. `aside` is an outcome like the other seven, not the absence of
 * one, so the histogram's keys sum to the number of alerts that reached the pass. */
export type AsideOutcomeName = NoAside | 'aside';

export type AsideOutcome =
  /** Assembled: clause plus core, or core plus clause. The core is inside it, verbatim. */
  | { status: 'aside'; body: string }
  /** The body is unchanged — the core, byte for byte. */
  | { status: 'no_aside'; reason: NoAside; refusals: readonly AsideRefusal[] };

/** One alert's answer, as the sweep reports it upward. The refusal list travels with it
 * because `refusals.too_many_segments` sitting at 95% is the number that would say this
 * feature is off in practice, and nobody would otherwise find out. */
export interface AsideTally {
  outcome: AsideOutcomeName;
  refusals: readonly AsideRefusal[];
}

export function asideTally(outcome: AsideOutcome): AsideTally {
  return outcome.status === 'aside'
    ? { outcome: 'aside', refusals: [] }
    : { outcome: outcome.reason, refusals: outcome.refusals };
}

export interface ComposeAsideInput extends AsideContext {
  familyId: string;
  /** Rule #1 — see `teen_redacted`. Threaded in rather than inferred from the core,
   * because the core a teen alert renders is deliberately indistinguishable. */
  teenContent: boolean;
}

export interface VoicePass {
  compose(input: ComposeAsideInput): Promise<AsideOutcome>;
}

export interface VoicePassDeps {
  database: Database;
  /**
   * The SHARED voice client resolver (`loop/voice/compose.ts`), which answers null for a
   * missing key or `VOICE_DISABLED`. A resolver rather than a client because the sweep
   * builds its dependencies on every cron tick including the many where nothing is due,
   * and because this lane must inherit that one kill switch rather than re-implement it.
   */
  client: () => AgentClient | null;
  /** Injected so `skill_unavailable` is a state a test can actually reach. An outcome
   * nothing can produce is a claim, not an outcome. */
  loadSkill: () => Promise<Skill>;
}

/**
 * EIGHT SECONDS, and it is the composer's own rather than the client's.
 *
 * `voiceClient()` is `HOT_SMS_CLIENT_OPTIONS` — 30s and one retry — sized for a parent
 * holding a phone. Three aside calls per connection on a slow-provider day is up to +60s
 * inside a 300s cron that already carries a triage and an extraction for ten messages,
 * and nothing here is waiting: the fallback is the message that was going out anyway.
 * Eight is the number the spoken lane already uses for a caller waiting in silence, and
 * this deadline is cheaper than either.
 *
 * It bounds THE COMPOSER'S WAIT, not the HTTP request — `forceToolJson` takes no signal,
 * and threading one through the shared chokepoint for this lane alone is a wider change
 * than the problem. A request still in flight when the deadline fires costs at most one
 * Haiku call and is recorded as `model_failed` with a real `latency_ms`, so it is visible
 * rather than free.
 */
export const ASIDE_DEADLINE_MS = 8_000;

const MAX_TOKENS = 128;

const asideSchema = z.object({
  clause: z.string(),
  place: z.union([z.literal('before'), z.literal('after')]),
});

const asideJsonSchema = {
  type: 'object',
  properties: {
    clause: { type: 'string' },
    place: { type: 'string', enum: ['before', 'after'] },
  },
  required: ['clause', 'place'],
} as const;

/**
 * The count as the SKILL may see it: present only when at least one prior alert of this
 * class reached this household in the window.
 *
 * A zero handed over as a number is an invitation to say "the first one today", which is
 * a claim about a household's day dressed as an ordinal. The radar's `FIRST_FIND_BEAT`
 * precedent: an absent block is absent so the skill can say the honest thing about it
 * rather than guess it away.
 */
export function priorAlertsForAside(priorSendsInWindow: number | null): number | null {
  return priorSendsInWindow !== null && priorSendsInWindow >= 1 ? priorSendsInWindow : null;
}

function noAside(reason: NoAside, refusals: readonly AsideRefusal[] = []): AsideOutcome {
  return { status: 'no_aside', reason, refusals };
}

/** THE CLASS ONLY, never `err.message`. A provider 4xx echoes the request, and the request
 * carries the core — which carries a sender's display name and a vendor's title (rule #1).
 * This is the rule `email-alert.ts` already keeps around its own model call; the follow-up
 * composer's `deferred()` does NOT, which is why none of it is copied here. */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

class AsideDeadlineError extends Error {}

/**
 * Bounds the wait, not the request. See {@link ASIDE_DEADLINE_MS}.
 *
 * The composer's OWN signal, driven by its own timer and cleared on the way out, rather
 * than `AbortSignal.timeout`: that one is armed by a Node-internal timer no test clock can
 * advance, and a deadline nothing can drive is a deadline nothing has ever seen fire.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new AsideDeadlineError('aside deadline')),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function usageOf(usage: Anthropic.Usage): AgentUsage {
  return {
    promptTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
    completionTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

const EMPTY_USAGE: AgentUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export function createVoicePass(deps: VoicePassDeps): VoicePass {
  return {
    async compose(input) {
      if (!voicePassEnabledFor(input.lane)) return noAside('lane_dark');
      if (input.teenContent) return noAside('teen_redacted');

      const client = deps.client();
      if (client === null) return noAside('client_unavailable');

      let skill: Skill;
      try {
        skill = await deps.loadSkill();
      } catch (err) {
        console.error(
          { familyId: input.familyId, lane: input.lane, err: errorClass(err) },
          'voice pass: the aside skill did not load - the alert goes out as written',
        );
        return noAside('skill_unavailable');
      }

      // FROM HERE ON THE MODEL IS REACHED, so from here on there is exactly one
      // `agent_runs` row. The four outcomes above write none, because the model was never
      // called and a row would say it was — which is the per-alert cost number this
      // feature's whole justification rests on being answerable from.
      const modelUsed = pickModel(skill.meta.task);
      return await traceAgentRun(
        {
          name: 'voice-pass',
          userId: 'system',
          tags: ['voice-pass'],
          metadata: { familyId: input.familyId, lane: input.lane },
        },
        async (trace) => {
          const startedAt = Date.now();
          const record = async (
            status: 'completed' | 'failed',
            usage: AgentUsage,
          ): Promise<void> => {
            await recordAgentRun(deps.database, {
              familyId: input.familyId,
              agentName: 'voice-pass',
              modelUsed,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              costUsd: agentRunCostUsd(modelUsed, usage),
              latencyMs: Date.now() - startedAt,
              status,
              langfuseTraceId: trace.traceId,
            });
          };

          let value: z.infer<typeof asideSchema>;
          let usage: AgentUsage;
          try {
            const result = await withDeadline(
              forceToolJson({
                client,
                lane: pickLane(skill.meta.task),
                system: skill.instructions,
                userMessage: asideUserMessage(input),
                toolName: 'aside',
                toolDescription: 'Return the one short clause, or an empty clause to add nothing.',
                inputJsonSchema: asideJsonSchema,
                schema: asideSchema,
                maxTokens: MAX_TOKENS,
              }),
              ASIDE_DEADLINE_MS,
            );
            value = result.value;
            usage = usageOf(result.usage);
          } catch (err) {
            await record('failed', EMPTY_USAGE);
            console.error(
              { familyId: input.familyId, lane: input.lane, err: errorClass(err) },
              'voice pass: no clause composed - the alert goes out as written',
            );
            return noAside('model_failed');
          }

          trace.recordGeneration('voice-pass-compose', { model: modelUsed, usage });

          // BEFORE THE GUARD, the way the follow-up runs it before its own refusals: `*`
          // and `_` are GSM-7 basic characters, so a markdown-wrapped clause would ship
          // its asterisks to a phone. The guard's contract is that what reaches it is
          // already plain, which is also what lets it stay alias-free.
          const clause = plainText(value.clause);
          if (clause === '') {
            await record('completed', usage);
            return noAside('empty');
          }

          const aside: Aside = { clause, place: value.place };
          const refusals = asideViolations(aside, input);
          if (refusals.length > 0) {
            await record('failed', usage);
            // The enums and the lane. NEVER the clause, never the core, never a title.
            console.warn(
              { familyId: input.familyId, lane: input.lane, refusals },
              'voice pass: the clause was refused - the alert goes out as written',
            );
            return noAside('refused', refusals);
          }

          await record('completed', usage);
          return { status: 'aside', body: assembleWithAside(input.core, aside) };
        },
      );
    },
  };
}

export type { AsideLane };
