import Anthropic from '@anthropic-ai/sdk';
import {
  type AgentClient,
  type GuardDeps,
  type RegisteredTool,
  type RunAgentArgs,
  type RunAgentResult,
  type Skill,
  pickModel,
  runAgent,
} from '@hale/agent';
import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { recordAgentRun } from '~/lib/agent-run';
import {
  type ChannelCoachRuntime,
  type ChannelTurn,
  ChannelTurnFailed,
} from '~/lib/channel/router/coach-runtime';
import { type AgentContext, type LoadAgentContextInput, loadAgentContext } from '~/lib/coach/context';
import { type TranscriptMessage, loadTranscript } from '~/lib/coach/conversation';
import { buildGuardDeps } from '~/lib/coach/guards';
import { searchVillageTool } from '~/lib/coach/tools';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import { loadCronSkill } from '~/lib/cron/skill';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { productionChannelDraftPort } from './draft';
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
/** Deliberately below Ask's 1024: a two-segment reply is ~40 tokens, and the ceiling is
 * a real backstop against an answer the post-processor would have to amputate. */
const MAX_TOKENS = 400;

/** Sonnet rates, USD per 1M — mirrors coach/agent.ts and the worker cost table. */
const SONNET_RATE = { inputPerMTok: 3, outputPerMTok: 15 } as const;
const PER_MTOK = 1_000_000;

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
  /** `onDraft` is called with every actionId the turn mints, so a failure can say what
   * it already committed rather than claiming nothing happened (VIL-260). */
  buildTools(turn: ChannelTurn, onDraft: (actionId: string) => void): RegisteredTool[];
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
  appLink(): string;
  now(): Date;
}

export function channelCoachRuntime(ports: ChannelCoachPorts): ChannelCoachRuntime {
  return {
    async respond(turn: ChannelTurn): Promise<{ reply: string }> {
      // This turn's own ledger of committed drafts. Every exit that is not an answer
      // carries it out (see `failed` below) — a draft is a row the parent can approve,
      // so a failure that hid it would leave them holding an action they never heard of.
      const draftedActionIds: string[] = [];
      const failed = (message: string, cause?: unknown): ChannelTurnFailed =>
        new ChannelTurnFailed(message, { cause, draftedActionIds });

      const [skill, transcript, children] = await Promise.all([
        ports.loadSkill(),
        ports.loadTranscript(turn.conversationId),
        ports.loadChildren(turn.familyId),
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

      const now = ports.now();
      const context = {
        ...familyContext,
        channel: 'sms' as const,
        appLink: ports.appLink(),
        nowIso: now.toISOString(),
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
          const tools = ports.buildTools(turn, (actionId) => draftedActionIds.push(actionId));
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

          trace.recordGeneration(`${CHANNEL_AGENT_NAME}-loop`, {
            model: pickModel(skill.meta.task),
            usage: result.usage,
          });

          const record = (status: 'completed' | 'failed'): ChannelRunRecord => ({
            familyId: turn.familyId,
            agentName: CHANNEL_AGENT_NAME,
            status,
            latencyMs: Date.now() - startedAt,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            costUsd:
              (result.usage.promptTokens * SONNET_RATE.inputPerMTok) / PER_MTOK +
              (result.usage.completionTokens * SONNET_RATE.outputPerMTok) / PER_MTOK,
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

          const reply = toSmsReply(result.answer, {
            children,
            appLink: ports.appLink(),
            now,
          });
          await ports.recordRun(record('completed'));
          return { reply };
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
  defaultClient ??= new Anthropic({ apiKey });
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
    buildTools: (turn, onDraft) =>
      buildChannelCoachTools({
        familyId: turn.familyId,
        reader: channelScheduleReader(database),
        draftPort: productionChannelDraftPort(database, anthropicClient(), turn.now),
        villageTool: searchVillageTool(database),
        onDraft,
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
        status: run.status,
        langfuseTraceId: run.langfuseTraceId,
      });
    },
    appLink: appBaseUrl,
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
