import Anthropic from '@anthropic-ai/sdk';
import {
  type AgentClient,
  pickModel,
  runAgent,
  runAgentStreaming,
  type ToolCallEvent,
  type ToolResultEvent,
} from '@hale/agent';
import type { Database } from '@hale/db';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { type ActionIntent, detectActionIntents } from './action-intent';
import type { CoachRunMetrics } from './coach';
import { loadAgentContext } from './context';
import {
  appendMessage,
  createConversation,
  loadTranscript,
  resolveConversationForFamily,
} from './conversation';
import { buildGuardDeps } from './guards';
import { recordCoachRun } from './record-run';
import { loadConciergeSkill } from './skill';
import { buildConciergeTools } from './tools';
import { tagTopic } from './topic';

/**
 * The Concierge on the @hale/agent harness — multi-turn, memory-backed, fully
 * family-scoped. This REPLACES the old single Anthropic call (coach.ts).
 *
 * The flow: resolve (or open) the family's conversation, load its transcript,
 * persist the new question, assemble the family context (parent, non-teen child
 * detail, location, plan, memory, transcript — rule #1), then run the agent loop.
 * The harness picks the model from the skill's task (converse → Sonnet), dispatches
 * every tool through the GUARDED invoker (cap / audit / teen-redaction), and hard-
 * stops at maxSteps. The assistant answer is persisted, the run cost recorded.
 *
 * The Anthropic client is injected so tests drive the loop MECHANICS with a fake;
 * agent QUALITY is an eval against real cached Claude (rule #8), not asserted here.
 */

const MAX_STEPS = 6;
const MAX_TOKENS = 1024;

/** Sonnet token rates, USD per 1M — mirrors coach.ts / the worker cost table. */
const SONNET_RATE = { inputPerMTok: 3, outputPerMTok: 15 } as const;
const PER_MTOK = 1_000_000;

export interface ConciergeInput {
  familyId: string;
  question: string;
  intent: string | null;
  /** Continue an existing thread, or null to start a fresh one. */
  conversationId: string | null;
  /** Which child the parent has focused on (the per-child chip), or null for the family. */
  focusedChildId: string | null;
  /** The acting parent's user id — written to audit_log.actor (rule #6 / PIPEDA). */
  actor: string;
}

export interface ConciergeResult {
  answer: string;
  conversationId: string;
  /** Gated action chips the answer implied — drafts, never auto-executed (rule #4). */
  actionIntents: ActionIntent[];
  metrics: CoachRunMetrics;
}

/**
 * Optional streaming hooks. When passed, runConcierge runs the STREAMING agent loop and
 * forwards the final answer's text token-by-token via `onTextDelta`; `onTurnReset`
 * fires when an intermediate (tool-calling) turn streamed text that is NOT the
 * answer, so the consumer drops it. Absent → the original non-streaming loop. The
 * persisted answer, action intents, metrics, and trace are identical either way.
 *
 * The step/tool hooks make the guarded loop's work observable so the chat can show
 * a live activity trail: `onStep` per model round-trip, `onToolCall` per tool
 * (name only — rule #1), `onToolResult` per tool (ok + content-free preview —
 * rule #1). They are forwarded verbatim from the agent harness, which guarantees
 * no raw args or tool output ever reach them.
 */
export interface ConciergeStreamHooks {
  onTextDelta: (delta: string) => void;
  onTurnReset: () => void;
  onStep?: (step: number) => void;
  onToolCall?: (event: ToolCallEvent) => void;
  onToolResult?: (event: ToolResultEvent) => void;
}

let defaultClient: Anthropic | undefined;

function anthropicClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  defaultClient ??= new Anthropic({ apiKey });
  return defaultClient;
}

export async function runConcierge(
  input: ConciergeInput,
  database: Database,
  client: AgentClient = anthropicClient(),
  streamHooks?: ConciergeStreamHooks,
): Promise<ConciergeResult> {
  // Continue the caller's thread only if it exists AND belongs to their family
  // (rule #1); an unknown or cross-family id is not an error — it starts a fresh
  // thread rather than leaking into another family's conversation.
  const existing = input.conversationId
    ? await resolveConversationForFamily(input.conversationId, input.familyId, database)
    : null;
  const conversationId = existing ?? (await createConversation(input.familyId, database));

  const transcript = await loadTranscript(conversationId, database);
  // Persist the parent turn with its scope so the timeline can filter on child +
  // topic; topic is keyword-tagged (no LLM), child is the focused chip.
  await appendMessage(conversationId, 'user', input.question, database, {
    childId: input.focusedChildId,
    topic: tagTopic(input.question),
  });

  const context = await loadAgentContext(
    {
      familyId: input.familyId,
      question: input.question,
      intent: input.intent,
      focusedChildId: input.focusedChildId,
      transcript,
    },
    database,
  );

  const skill = await loadConciergeSkill();
  const tools = buildConciergeTools(database);
  const guardDeps = buildGuardDeps(database);
  const modelUsed = pickModel(skill.meta.task);

  // Trace the multi-turn run: sessionId = conversationId groups the thread, the
  // acting parent is userId, familyId is correlating metadata, planTier is a
  // filterable segment. The mask keeps teen/PII out of the trace (rule #1).
  return traceAgentRun(
    {
      name: 'ask-hale',
      sessionId: conversationId,
      userId: input.actor,
      tags: ['ask-hale', context.planTier],
      metadata: { familyId: input.familyId },
    },
    async (trace) => {
      const startedAt = Date.now();
      const runArgs = {
        skill,
        context,
        tools,
        client,
        maxSteps: MAX_STEPS,
        maxTokens: MAX_TOKENS,
        toolContext: { familyId: input.familyId, actor: input.actor },
        guardDeps,
      };
      const result = streamHooks
        ? await runAgentStreaming({ ...runArgs, ...streamHooks })
        : await runAgent(runArgs);

      trace.recordGeneration('ask-hale-loop', { model: modelUsed, usage: result.usage });

      const costUsd =
        (result.usage.promptTokens * SONNET_RATE.inputPerMTok) / PER_MTOK +
        (result.usage.completionTokens * SONNET_RATE.outputPerMTok) / PER_MTOK;
      const metrics: CoachRunMetrics = {
        modelUsed,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd,
        latencyMs: Date.now() - startedAt,
      };

      if (result.answer === null) {
        // Rule #8: a run that produced no answer is a failed run — record it as such
        // (real model + accumulated usage), then surface the error rather than swallow.
        await recordCoachRun(input.familyId, metrics, database, 'failed', trace.traceId);
        throw new Error(
          result.hitMaxSteps
            ? 'runConcierge: agent hit maxSteps without an answer'
            : 'runConcierge: agent returned no answer',
        );
      }

      await appendMessage(conversationId, 'assistant', result.answer, database, {
        childId: input.focusedChildId,
        topic: tagTopic(result.answer) ?? tagTopic(input.question),
      });
      await recordCoachRun(input.familyId, metrics, database, 'completed', trace.traceId);

      // Surface gated action chips the answer implied — these create DRAFTS the
      // parent must approve (rule #4); the agent never auto-acts.
      const actionIntents = detectActionIntents(result.answer);

      return { answer: result.answer, conversationId, actionIntents, metrics };
    },
  );
}
