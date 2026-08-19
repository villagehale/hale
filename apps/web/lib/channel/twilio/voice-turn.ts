import {
  type AgentClient,
  type GuardDeps,
  type RunAgentResult,
  type RunAgentStreamingArgs,
  type Skill,
  agentRunCostUsd,
  pickModel,
} from '@hale/agent';
import type { AgentContext, LoadAgentContextInput } from '~/lib/coach/context';
import type { TranscriptMessage } from '~/lib/coach/conversation';
import type { VoiceTurnInput, VoiceTurnStream } from './relay-session';

/**
 * Voice v1 — one spoken turn, over the same brain and the same thread as a text.
 *
 * WHY THIS IS NOT `ChannelCoachRuntime.respond()`. That runtime is shaped for SMS in two
 * ways a call cannot use. It returns a FINISHED STRING, which on a phone means the parent
 * hears nothing at all until the whole answer exists; and it post-processes that string
 * to a two-segment budget, a constraint of carriers that has no meaning out loud. So this
 * is a different loop over the SAME readers — `loadTranscript` and `loadAgentContext`,
 * the identical calls the SMS coach makes, which is what puts a call and a text in one
 * conversation and gets teen redaction for free at the source (rule #1).
 *
 * NO TOOLS, deliberately, and it is a product decision rather than a stub. A call cannot
 * change anything: the skill says so out loud ("text me after this call and I'll pick it
 * up"), and handing the model an empty tool list is what makes that sentence true rather
 * than merely requested. It also means the loop is exactly one round trip, which is the
 * only shape that answers inside a pause a person would tolerate.
 */

/** The agent_runs name for a spoken turn (migration 0091). */
export const VOICE_AGENT_NAME = 'voice-turn' as const;

/**
 * One round trip. There are no tools to call, so there is nothing a second step could do
 * except talk to itself while a parent listens to silence.
 */
const MAX_STEPS = 1;

/**
 * About forty words of speech, with room to finish a sentence. Deliberately far below the
 * SMS coach's 400: the ceiling is not a budget here, it is a backstop against a model
 * that starts reciting the week to somebody holding a phone.
 */
const MAX_TOKENS = 160;

export interface VoiceRunRecord {
  familyId: string;
  agentName: typeof VOICE_AGENT_NAME;
  status: 'completed' | 'failed';
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  promptCacheHit: boolean;
}

/**
 * Everything the turn needs from outside. All injected — so the readers, the budgets and
 * the failure behaviour are provable without a model, and so this list IS the complete
 * account of what a spoken turn can touch. There is no write port and no tool port.
 */
export interface VoiceTurnPorts {
  loadSkill(): Promise<Skill>;
  loadTranscript(conversationId: string): Promise<TranscriptMessage[]>;
  loadContext(input: LoadAgentContextInput): Promise<AgentContext>;
  /** Resolved LAZILY, for the reason every other channel path resolves it lazily: a
   * missing ANTHROPIC_API_KEY should break the turn that needs a model, not the wiring. */
  client(): AgentClient;
  runStreaming(args: RunAgentStreamingArgs): Promise<RunAgentResult>;
  guardDeps: GuardDeps;
  recordRun(run: VoiceRunRecord): Promise<void>;
  now(): Date;
}

export function voiceTurnStream(ports: VoiceTurnPorts): VoiceTurnStream {
  return {
    async respond(input: VoiceTurnInput, emit: (token: string) => void): Promise<void> {
      const [skill, transcript] = await Promise.all([
        ports.loadSkill(),
        ports.loadTranscript(input.conversationId),
      ]);

      const familyContext = await ports.loadContext({
        familyId: input.ticket.familyId,
        question: input.prompt,
        intent: null,
        // A call has no per-child chip, so the turn is whole-family and the model works
        // out who is meant from the words — the same as a text.
        focusedChildId: null,
        transcript,
        sourceNote: null,
      });

      const now = ports.now();
      const startedAt = Date.now();
      let result: RunAgentResult | null = null;
      try {
        result = await ports.runStreaming({
          skill,
          context: { ...familyContext, channel: 'voice' as const, nowIso: now.toISOString() },
          // Empty, and load-bearing: see the module note. Nothing can be done from a call.
          tools: [],
          client: ports.client(),
          maxSteps: MAX_STEPS,
          maxTokens: MAX_TOKENS,
          toolContext: { familyId: input.ticket.familyId, actor: input.ticket.parentUserId },
          guardDeps: ports.guardDeps,
          onTextDelta: emit,
          // Unreachable while `tools` is empty: a turn can only be reset by deciding to
          // call one. It is also the reason voice must stay tool-free — a spoken token
          // cannot be taken back, so a reset would arrive after the parent already heard
          // the words it wants discarded.
          onTurnReset: () => {},
        });
      } finally {
        await ports.recordRun(
          record(input.ticket.familyId, skill, result, Date.now() - startedAt),
        );
      }

      if (result.answer === null) {
        throw new Error('voice turn: the model produced no answer');
      }
    },
  };
}

/**
 * The cost of a turn, recorded on BOTH paths.
 *
 * A failed turn still burned tokens and still cost the caller seven cents a minute of
 * carrier time to sit through, so a run row that only exists for successes would make
 * voice look cheaper than it is exactly when it is going wrong. A run that threw before
 * the model answered has no usage to report, and zeroes are the honest number there.
 */
function record(
  familyId: string,
  skill: Skill,
  result: RunAgentResult | null,
  latencyMs: number,
): VoiceRunRecord {
  const usage = result?.usage ?? {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  return {
    familyId,
    agentName: VOICE_AGENT_NAME,
    status: result?.answer ? 'completed' : 'failed',
    latencyMs,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    costUsd: agentRunCostUsd(pickModel(skill.meta.task), usage),
    promptCacheHit: usage.cacheReadTokens > 0,
  };
}
