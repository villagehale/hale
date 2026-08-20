import {
  type AgentClient,
  type GuardDeps,
  type RegisteredTool,
  type RunAgentResult,
  type RunAgentStreamingArgs,
  type Skill,
  agentRunCostUsd,
  pickModel,
} from '@hale/agent';
import type { AgentContext, LoadAgentContextInput } from '~/lib/coach/context';
import type { TranscriptMessage } from '~/lib/coach/conversation';
import { VOICE_TOOL_ACK, voiceDraftedButFailed } from './copy';
import type { VoiceTurnInput, VoiceTurnStream } from './relay-session';
import type { SpokenAnswer, SpokenTurn } from './voice-answer';

/**
 * Voice v2 — one spoken turn, over the same brain, the same thread AND the same verbs as
 * a text.
 *
 * v1 answered conversationally and deferred every real job to the text thread ("text me
 * after this call and I'll pick it up"). The founder's verdict after the first live call
 * was that this is not a product: a parent who phones the number they already text should
 * be able to get the same thing done, and being told to hang up and type is the worst
 * version of "I answer".
 *
 * So a call now reaches the same capabilities a text does, by the same seams:
 *
 *   THE SAME VERBS. `buildTools` is the SMS coach's own tool builder
 *   (channel/coach/tools.ts) — the same week reader, the same three propose_* drafts
 *   through the same reviewer-gated draft port, the same Village search. Nothing here is
 *   a voice-only capability, and nothing bypasses a gate: a spoken "move swim" produces
 *   the identical drafted_for_approval row a texted one does (rules #3/#4/#6).
 *
 *   THE SAME CONSENT. A spoken "yes" is settled BEFORE the model by the router's own
 *   approval handler and reply resolver (voice-answer.ts), so consent is read by one
 *   grammar across both surfaces and a model never paraphrases it.
 *
 *   THE SAME REDACTION. `loadTranscript` and `loadAgentContext` are the identical calls
 *   the SMS coach makes, so teen redaction happens at the source (rule #1), and the
 *   propose_* tools carry their own teen refusals down into the guarded invoker.
 *
 * WHAT THE CALL STILL CHANGES is the shape, not the reach. It STREAMS, because a parent
 * hears words as they arrive; there is no segment budget, because carriers are not
 * involved; and — the one thing a call has that a text does not — a pause is a failure
 * state. See {@link VOICE_TOOL_ACK}.
 *
 * TWO VERBS THE TEXT LANE HAS ARE DELIBERATELY NOT REGISTERED HERE, and they drop out by
 * construction rather than by instruction (tools.ts registers each only when its
 * collector is passed): `offer_full_plan`, whose ledger row is minted against a SENT
 * message and whose payoff is three texts, and `share_referral_link`, whose whole content
 * is a URL — unusable read aloud.
 */

/** The agent_runs name for a spoken turn (migration 0091). */
export const VOICE_AGENT_NAME = 'voice-turn' as const;

/**
 * Enough steps for lookup_week → a draft → the answer, with one spare, and a hard stop
 * well short of a caller listening to a loop think. The SMS coach affords six; a text
 * that takes twelve seconds is slow and a call that does is dead air.
 */
const MAX_STEPS = 4;

/**
 * The per-turn token ceiling. Raised from v1's 160 for one reason that has nothing to do
 * with how long an answer may be: a turn now emits TOOL ARGUMENTS as well as speech, and
 * a max_tokens that truncates a tool_use mid-JSON is a broken turn rather than a long
 * answer. The length of what is SPOKEN is held where it belongs — by the skill (about
 * forty words) and by the eval's hard word gate.
 */
const MAX_TOKENS = 240;

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

/** What the tool builder needs to know about the call it is being built for. Per TURN,
 * never per process: the two-draft cap is a closure inside the set. */
export interface VoiceToolTurn {
  familyId: string;
  parentUserId: string;
  conversationId: string;
  now: Date;
}

/**
 * Everything the turn needs from outside. All injected — so the readers, the budgets, the
 * consent stage and the failure behaviour are provable without a model, and so this list
 * IS the complete account of what a spoken turn can touch.
 */
export interface VoiceTurnPorts {
  loadSkill(): Promise<Skill>;
  loadTranscript(conversationId: string): Promise<TranscriptMessage[]>;
  loadContext(input: LoadAgentContextInput): Promise<AgentContext>;
  /**
   * Did the caller just ANSWER something Hale is holding? Runs before the model, for the
   * reason the router's handlers run before the coach (voice-answer.ts). Non-nullable
   * (rule #11): a call with no answer stage silently stops understanding every "yes",
   * and it would look exactly like a working call.
   */
  answerSpoken(turn: SpokenTurn): Promise<SpokenAnswer>;
  /** The SMS coach's own verbs, built fresh per turn. `onDraft` is told about every
   * action this turn actually minted, so a turn that breaks later can still say what it
   * already committed (VIL-260) instead of claiming nothing happened. */
  buildTools(turn: VoiceToolTurn, onDraft: (actionId: string) => void): RegisteredTool[];
  /** Resolved LAZILY, for the reason every other channel path resolves it lazily: a
   * missing ANTHROPIC_API_KEY should break the turn that needs a model, not the wiring. */
  client(): AgentClient;
  runStreaming(args: RunAgentStreamingArgs): Promise<RunAgentResult>;
  guardDeps: GuardDeps;
  recordRun(run: VoiceRunRecord): Promise<void>;
  /** Required, never nullable (rule #11): a turn that spoke a partial-failure line has
   * to be visible to an operator as one, and a call has no HTTP status to carry it. */
  log: Pick<Console, 'error'>;
  now(): Date;
}

export function voiceTurnStream(ports: VoiceTurnPorts): VoiceTurnStream {
  return {
    async respond(input: VoiceTurnInput, emit: (token: string) => void): Promise<void> {
      // CONSENT FIRST, and with no model in the loop. A "yes" is an answer to a question
      // Hale already asked, and the fastest, safest turn on a call is the one where the
      // approvals spine answers it directly.
      const settled = await ports.answerSpoken({
        familyId: input.ticket.familyId,
        parentUserId: input.ticket.parentUserId,
        conversationId: input.conversationId,
        utterance: input.prompt,
        now: ports.now(),
      });
      if (settled.status === 'answered') {
        emit(settled.spoken);
        return;
      }

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
      // This turn's own ledger of committed drafts. A draft is a row the parent can
      // approve the moment the tool returns, so a turn that breaks afterwards must say so
      // rather than let it sit unheard-of (VIL-260, out loud).
      const draftedActionIds: string[] = [];
      const tools = ports.buildTools(
        {
          familyId: input.ticket.familyId,
          parentUserId: input.ticket.parentUserId,
          conversationId: input.conversationId,
          now,
        },
        (actionId) => draftedActionIds.push(actionId),
      );

      // LATENCY MASKING. A tool turn costs a couple of seconds, and on a phone that is
      // not a pause, it is a call that has gone quiet. The skill asks the model to say
      // something first, which is the version that sounds like a person; this is the
      // guarantee under it — one fixed line, spoken only if the model reached for a tool
      // having said nothing at all, so a caller never hears both.
      let hasSpoken = false;
      const say = (token: string): void => {
        hasSpoken = true;
        emit(token);
      };

      const startedAt = Date.now();
      let result: RunAgentResult | null = null;
      try {
        result = await ports.runStreaming({
          skill,
          context: { ...familyContext, channel: 'voice' as const, nowIso: now.toISOString() },
          tools,
          client: ports.client(),
          maxSteps: MAX_STEPS,
          maxTokens: MAX_TOKENS,
          toolContext: { familyId: input.ticket.familyId, actor: input.ticket.parentUserId },
          guardDeps: ports.guardDeps,
          onTextDelta: say,
          onToolCall: () => {
            if (!hasSpoken) say(`${VOICE_TOOL_ACK} `);
          },
          // NOT a discard, and it must never become one. The loop fires this to say the
          // text of a tool turn was reasoning rather than the answer — but on a call
          // those words are already out of a speaker, so the only honest thing to do is
          // keep them: what the recorder writes down is what the caller actually heard.
          onTurnReset: () => {},
        });
      } catch (err) {
        if (draftedActionIds.length === 0) throw err;
        // The turn changed the family's queue and then broke. "Sorry, I lost that one"
        // would be false and would orphan real rows the parent can approve.
        ports.log.error(
          {
            familyId: input.ticket.familyId,
            callSid: input.ticket.callSid,
            draftedThisTurn: draftedActionIds.length,
            err: err instanceof Error ? err.message : String(err),
          },
          'voice turn: broke after drafting - the caller hears the count instead',
        );
        emit(voiceDraftedButFailed(draftedActionIds.length));
        return;
      } finally {
        await ports.recordRun(
          record(input.ticket.familyId, skill, result, Date.now() - startedAt),
        );
      }

      if (result.answer === null) {
        // Out of steps. Same trade as the throw above: a turn that drafted owes the
        // parent the count, and one that did not owes the session its fixed line.
        if (draftedActionIds.length > 0) {
          emit(voiceDraftedButFailed(draftedActionIds.length));
          return;
        }
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
 *
 * A turn SETTLED by the answer stage records nothing, and that is correct rather than a
 * gap: no agent ran, so there is no agent run. It leaves its own rows where it acted —
 * the approvals spine's audit trail (rule #6).
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
