import Anthropic from '@anthropic-ai/sdk';
import { HOT_SMS_CLIENT_OPTIONS, activityClient } from '~/lib/pipeline/client';
import {
  type AgentClient,
  type GuardDeps,
  type RegisteredTool,
  type RunAgentArgs,
  type RunAgentResult,
  type Skill,
  agentRunCostUsd,
  pickModel,
  runAgent,
} from '@hale/agent';
import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { recordAgentRun } from '~/lib/agent-run';
import { captureAgentError } from '~/lib/analytics/server-capture';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import {
  type ChannelCoachRuntime,
  type ChannelTurn,
  type ChannelTurnResult,
  ChannelTurnFailed,
} from '~/lib/channel/router/coach-runtime';
import type { ActivityPromise } from '~/lib/channel/activity/commitment';
import { createActivityFinder } from '~/lib/channel/activity/lane';
import { bindActivityReader, productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import type { PlanOffer } from '~/lib/channel/plan/offer';
import { type ReferralShare, referralBlock } from '~/lib/channel/referral/share';
import { type AgentContext, type LoadAgentContextInput, loadAgentContext } from '~/lib/coach/context';
import { type TranscriptMessage, loadTranscript } from '~/lib/coach/conversation';
import { buildGuardDeps } from '~/lib/coach/guards';
import { searchVillageTool } from '~/lib/coach/tools';
import { loadCronSkill } from '~/lib/cron/skill';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { productionChannelDraftPort } from './draft';
import {
  type RegistrationWindowContext,
  loadRegistrationWindows,
  productionRegistrationContextPorts,
} from './registration-context';
import { type ReplyChild, toSmsReply } from './reply';
import { buildChannelCoachTools, channelScheduleReader } from './tools';

/**
 * VIL-221 · C2 — the coach, over SMS.
 *
 * This is the SAME brain the app's Ask runs: the same harness, the same guarded
 * invoker, the same family context assembly, the same teen redaction at the source.
 * What changes is only what a text can afford, and each difference below is a
 * consequence of the surface rather than a second product:
 *
 *   NO STREAMING. A carrier takes one body, once. So the loop is `runAgent`, not
 *   `runAgentStreaming`, and the answer is assembled before anything is sent — which
 *   is also why the post-processor can hold a segment budget at all.
 *
 *   A TERSER VOICE. The `coach-channel-sms` skill, not `ask-hale`. Same instructions
 *   about honesty and scope, a different answer shape, because markdown and a
 *   four-paragraph answer are a worse artifact on a phone than a short one.
 *
 *   SCHEDULE VERBS. The three propose_* tools plus lookup_week, none of which exist in
 *   the app's Ask because the app has buttons for them. Every one drafts (rule #4).
 *
 * WHAT THIS DOES NOT DO, deliberately: it never touches `messages`. C1 appends the
 * parent's turn before calling in, and appends the reply after the transport accepts
 * it, so the thread reflects what was actually SENT. A write here would put Hale's
 * answer in the parent's history before it existed. Nothing in {@link ChannelCoachPorts}
 * can write to that table, which is the structural half of the promise.
 *
 * A failed turn THROWS. The router owns the honesty template ("nothing was changed"),
 * and it can only use it if a failure looks like one — see route.ts runAgentTurn.
 */

/** The whole turn's model budget. Six steps is enough for lookup_week → resolve → two
 * drafts → answer, and a hard stop short of a loop that would outrun the ack. */
const MAX_STEPS = 6;
/**
 * The whole COMPLETION budget for one step — thinking and text share it.
 *
 * Left at 400, and that is a decision rather than an omission. 400 was set as a reply
 * ceiling when this lane emitted text and nothing else: a two-segment reply is ~40
 * tokens, so 400 was ten times what an answer could need. Then `converse` became
 * `{ thinking: 'adaptive', effort: 'high' }` (packages/agent/src/model.ts) and it stopped
 * being a reply ceiling — it became the ceiling on thinking PLUS reply, spent in that
 * order, and a hard turn spends all of it thinking and emits no text at all. That is
 * prod's one failed `coach-channel-sms` run, 2026-08-22 17:41: 16,828 prompt tokens, 400
 * completion tokens, 399 of them thinking, zero text blocks — the founder's own "Tiny
 * gym" follow-up, whose antecedent was in the transcript at index 17 of 20 the whole
 * time. The context was never the problem on that turn. The budget was.
 *
 * THE FIX IS NOT A BIGGER NUMBER HERE, and the corpus is what settled that. Raising this
 * to 1,024 does cure the truncation, and it also makes the model reason its way past its
 * second source: across live re-records `registration-window-plus-a-find` went from 0/3
 * to 2/4 failures on "never called find_activities", and `village-one-verified-one-not`
 * from 2/3 to 4/4 on "never called search_village". 700 splits the difference and gets
 * neither — it still truncated `yes-with-nothing-open` on the full corpus run. Room given
 * to every turn is room the model finds something to do with.
 *
 * So the room goes to the turn that PROVED it needed it: `runAgent` re-asks a step that
 * hit the ceiling before saying anything, once, at three times the budget
 * (packages/agent/src/agent.ts `isTruncatedBeforeSpeaking`). Ordinary turns keep the
 * ceiling — and their prompt-cache keys — untouched.
 */
const MAX_TOKENS = 400;

/** The agent_runs name for a texted turn (migration 0075). Separate from 'ask-hale'
 * because the two surfaces have different latency and cost shapes over one brain. */
export const CHANNEL_AGENT_NAME = 'coach-channel-sms';

export interface ChannelRunRecord {
  familyId: string;
  agentName: typeof CHANNEL_AGENT_NAME;
  status: 'completed' | 'failed';
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Any turn of the loop read from the prompt cache (MEM-9 telemetry). */
  promptCacheHit: boolean;
  langfuseTraceId: string | null;
}

/**
 * Everything the runtime needs from the outside world. All of it is injected so the
 * plumbing is testable without a database, a network, or a model — and, just as
 * importantly, so the set is READABLE as the complete list of what a texted turn can
 * touch. There is no write port here, and that is the point.
 */
export interface ChannelCoachPorts {
  loadSkill(): Promise<Skill>;
  loadTranscript(conversationId: string): Promise<TranscriptMessage[]>;
  loadContext(input: LoadAgentContextInput): Promise<AgentContext>;
  /** Every child of the family, un-redacted — the redactor needs the real names to
   * find them in the answer, and it is the only consumer. */
  loadChildren(familyId: string): Promise<ReplyChild[]>;
  /** The municipal registration windows this family can still act on, and whether the
   * ladder is armed for them — Hale's flagship job, made visible to a turn that is
   * being asked about it (see registration-context.ts). */
  loadRegistrationWindows(familyId: string, now: Date): Promise<RegistrationWindowContext[]>;
  /** `onDraft` is called with every actionId the turn mints, so a failure can say what
   * it already committed rather than claiming nothing happened (VIL-260); `onOffer`
   * with the full plan the turn offered, which the router writes down after the send;
   * `onShare` with the referral line and link, which never leaves this runtime — it is
   * appended to the reply, and a link a parent forwards is not a thing to persist. */
  buildTools(
    turn: ChannelTurn,
    onDraft: (actionId: string) => void,
    onOffer: (offer: PlanOffer) => void,
    onShare: (share: ReferralShare) => void,
    onPromise: (promise: ActivityPromise) => void,
  ): RegisteredTool[];
  guardDeps: GuardDeps;
  /**
   * The Anthropic client the loop drives, resolved LAZILY — a function, not a value.
   *
   * The router builds its deps for EVERY inbound text, including the ones a
   * deterministic handler answers without a model ("YES 2", "done", a waitlist report).
   * Constructing the client at wiring time would make a missing ANTHROPIC_API_KEY throw
   * before those handlers ever ran, turning a config gap into "Hale stopped accepting
   * approvals". Deferring it means the key is only required by the turn that needs one.
   */
  client(): AgentClient;
  runAgent(args: RunAgentArgs): Promise<RunAgentResult>;
  recordRun(run: ChannelRunRecord): Promise<void>;
  now(): Date;
}

export function channelCoachRuntime(ports: ChannelCoachPorts): ChannelCoachRuntime {
  return {
    async respond(
      turn: ChannelTurn,
      rejectedLastAttempt: readonly string[],
    ): Promise<ChannelTurnResult> {
      // This turn's own ledger of committed drafts. Every exit that is not an answer
      // carries it out (see `failed` below) — a draft is a row the parent can approve,
      // so a failure that hid it would leave them holding an action they never heard of.
      const draftedActionIds: string[] = [];
      // The plan this turn offered, if it offered one. LAST CALL WINS rather than a
      // list: the skill allows exactly one question per message, so a second offer in
      // one turn is a model that changed its mind mid-compose, and the offer the parent
      // can actually see is the one in the sentence it ended up writing.
      let planOffer: PlanOffer | null = null;
      // The referral link this turn handed over, if it did. Local to the runtime: unlike
      // an offer, nothing later resolves against it — there is no YES to match and no
      // ledger row to mint, because the parent forwarding a message is not a promise
      // Hale owes them.
      let referral: ReferralShare | null = null;
      // The "I'll come back to you" this turn said, if it said one. LAST CALL WINS, for
      // the reason the offer's does: the ledger permits one open activity promise per
      // family, so a turn that registered two changed its mind mid-compose and the one
      // the parent can read is the one in the sentence it ended up writing.
      let activityPromise: ActivityPromise | null = null;
      const failed = (message: string, cause?: unknown): ChannelTurnFailed =>
        new ChannelTurnFailed(message, { cause, draftedActionIds });

      const now = ports.now();
      const [skill, transcript, children, registrationWindows] = await Promise.all([
        ports.loadSkill(),
        ports.loadTranscript(turn.conversationId),
        ports.loadChildren(turn.familyId),
        ports.loadRegistrationWindows(turn.familyId, now),
      ]);

      const familyContext = await ports.loadContext({
        familyId: turn.familyId,
        question: turn.body,
        intent: null,
        // A text has no per-child chip to focus, so the turn is whole-family and the
        // model resolves who is meant from the words and the schedule.
        focusedChildId: null,
        transcript,
        sourceNote: null,
      });

      // NO app link anywhere on this path, deliberately. The thread does the work and
      // the app is the receipts room a parent never needs, so a reply that sends them
      // there hands the job back to the person who texted to be rid of it — which is
      // what happened on launch day ("You can also add anything manually in the app:
      // https://…"). The skill says not to; a skill is a request. Holding no URL at all
      // is the guarantee: the model composes no link because it was handed none, and
      // the post-processor cannot append one to an over-budget reply because it no
      // longer takes one either (skill audit P0 #4).
      //
      // THE REFERRAL LINK DID NOT BREAK THAT, which is the whole reason it is shaped the
      // way it is. `share_referral_link` returns `{ shared: true }` and nothing else —
      // the URL is assembled down in this function, after the fit, from the family id.
      // So the invariant still reads exactly as it did: a URL in a model's answer is a
      // URL it invented. The one link Hale now sends is the one it was never in a
      // position to get wrong, and it points at /text (a stranger's front door) rather
      // than at the app.
      const context = {
        ...familyContext,
        channel: 'sms' as const,
        nowIso: now.toISOString(),
        // What Hale is holding an answer for, in Hale's own words (see ChannelTurn). A
        // FACT about state, handed to the model the same way the family's schedule is —
        // so a turn that is plainly an answer to one of them can be treated as one, and a
        // turn that is not can stop claiming nothing is pending when something is.
        standingQuestions: turn.standingQuestions,
        // WHAT THE LAST ATTEMPT CLAIMED AND COULD NOT BACK (VIL-293). Absent on every
        // first attempt — the key does not appear at all rather than appearing empty, so
        // the ordinary turn's prompt bytes, and its cache prefix, are untouched.
        ...(rejectedLastAttempt.length > 0 ? { rejectedLastAttempt } : {}),
        // The hand-verified municipal open dates this family must act on, soonest
        // first, each saying whether Hale's ladder is already on it. Empty for a family
        // outside the covered set — and then the skill has nothing to claim.
        registrationWindows,
      };

      return traceAgentRun(
        {
          name: CHANNEL_AGENT_NAME,
          sessionId: turn.conversationId,
          userId: turn.parentUserId,
          tags: [CHANNEL_AGENT_NAME, familyContext.planTier].filter(Boolean) as string[],
          metadata: { familyId: turn.familyId },
        },
        async (trace) => {
          const startedAt = Date.now();
          // A fresh tool set per turn: the two-draft cap is a closure inside it, so a
          // reused set would spend this text's budget on the last one's.
          const tools = ports.buildTools(
            turn,
            (actionId) => draftedActionIds.push(actionId),
            (offer) => {
              planOffer = offer;
            },
            (share) => {
              referral = share;
            },
            (promise) => {
              activityPromise = promise;
            },
          );
          // A tool that throws, a provider that times out, a step that runs long: the
          // loop can break anywhere, and by then the drafts it made are already rows.
          // Re-thrown rather than handled — the router owns what a parent is told.
          const result = await ports
            .runAgent({
              skill,
              context,
              tools,
              client: ports.client(),
              maxSteps: MAX_STEPS,
              maxTokens: MAX_TOKENS,
              toolContext: { familyId: turn.familyId, actor: turn.parentUserId },
              guardDeps: ports.guardDeps,
            })
            .catch((err: unknown) => {
              throw failed(
                err instanceof Error ? err.message : 'channel coach: agent loop failed',
                err,
              );
            });

          const modelUsed = pickModel(skill.meta.task);
          trace.recordGeneration(`${CHANNEL_AGENT_NAME}-loop`, {
            model: modelUsed,
            usage: result.usage,
          });

          const record = (status: 'completed' | 'failed'): ChannelRunRecord => ({
            familyId: turn.familyId,
            agentName: CHANNEL_AGENT_NAME,
            status,
            latencyMs: Date.now() - startedAt,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            costUsd: agentRunCostUsd(modelUsed, result.usage),
            promptCacheHit: result.usage.cacheReadTokens > 0,
            langfuseTraceId: trace.traceId,
          });

          if (result.answer === null) {
            await ports.recordRun(record('failed'));
            throw failed(
              result.hitMaxSteps
                ? 'channel coach: agent hit maxSteps without an answer'
                : 'channel coach: agent returned no answer',
            );
          }

          const share = referral as ReferralShare | null;
          // What the trim threw away, reported HERE rather than from inside the string
          // function: an answer past the two-segment ceiling is work this turn already
          // paid a model (and sometimes a 50s web search) for, and nothing downstream can
          // tell a trimmed reply from one that fit. A count makes it a rate.
          let trimmedOverBy: number | null = null;
          const reply = toSmsReply(result.answer, {
            children,
            now,
            planOffer: (planOffer as PlanOffer | null)?.sentence,
            referral: share ? referralBlock(share) : undefined,
            onTrimmed: (overBy) => {
              trimmedOverBy = overBy;
            },
          });
          if (trimmedOverBy !== null) {
            await captureAgentError({
              lane: 'reply_budget',
              overBy: trimmedOverBy,
              familyId: turn.familyId,
            });
          }
          await ports.recordRun(record('completed'));
          return { reply, planOffer, activityPromise };
        },
      );
    },
  };
}

let defaultClient: Anthropic | undefined;

function anthropicClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  defaultClient ??= new Anthropic({ apiKey, ...HOT_SMS_CLIENT_OPTIONS });
  return defaultClient;
}

/**
 * The production wiring: the one place the runtime meets real tables, the real skill
 * file, and the real reviewer. The draft port is bound to the SAME approval engine the
 * app's chips and the MCP proposals use, so a change asked for by text lands in the
 * queue indistinguishable from one asked for by tap (rule #3/#4/#6).
 */
export function productionChannelCoach(database: Database): ChannelCoachRuntime {
  return channelCoachRuntime({
    client: anthropicClient,
    loadSkill: () => loadCronSkill('coach-channel-sms'),
    loadTranscript: (conversationId) => loadTranscript(conversationId, database),
    loadContext: (input) => loadAgentContext(input, database),
    loadChildren: (familyId) => loadReplyChildren(database, familyId),
    loadRegistrationWindows: (familyId, now) =>
      loadRegistrationWindows(
        productionRegistrationContextPorts(database),
        familyId,
        DEFAULT_TIMEZONE,
        now,
      ),
    buildTools: (turn, onDraft, onOffer, onShare, onPromise) =>
      buildChannelCoachTools({
        familyId: turn.familyId,
        reader: channelScheduleReader(database),
        draftPort: productionChannelDraftPort(database, anthropicClient(), turn.now),
        villageTool: searchVillageTool(database),
        // The second activity source. Same key, same fail-closed resolver shape as the
        // loop's — a turn that could reach Anthropic for the loop and not for the search
        // is not a state worth being able to represent.
        activity: {
          reader: bindActivityReader(database, productionActivityFamilyReader()),
          // NOT the coach's client. A web-grounded search is a different job with a
          // different duration, and running it on the coach's 30s-plus-a-retry budget
          // meant the calls that needed forty seconds were killed twice before the lane
          // had its own go (see ACTIVITY_CLIENT_OPTIONS).
          finder: createActivityFinder(activityClient),
        },
        onDraft,
        onOffer,
        onShare,
        onPromise,
        now: turn.now,
      }),
    guardDeps: buildGuardDeps(database),
    runAgent,
    recordRun: async (run) => {
      await recordAgentRun(database, {
        familyId: run.familyId,
        agentName: run.agentName,
        modelUsed: pickModel('converse'),
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        costUsd: run.costUsd,
        latencyMs: run.latencyMs,
        promptCacheHit: run.promptCacheHit,
        status: run.status,
        langfuseTraceId: run.langfuseTraceId,
      });
    },
    now: () => new Date(),
  });
}

async function loadReplyChildren(database: Database, familyId: string): Promise<ReplyChild[]> {
  return database
    .select({
      name: schema.children.name,
      gender: schema.children.gender,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
}
