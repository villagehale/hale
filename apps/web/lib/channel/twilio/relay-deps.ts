import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel, runAgentStreaming } from '@hale/agent';
import { recordAgentRun } from '~/lib/agent-run';
import { productionChannelDraftPort } from '~/lib/channel/coach/draft';
import { buildChannelCoachTools, channelScheduleReader } from '~/lib/channel/coach/tools';
import { defaultHandlers, defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { createReplyResolver } from '~/lib/channel/router/resolve';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { loadAgentContext } from '~/lib/coach/context';
import { loadTranscript } from '~/lib/coach/conversation';
import { buildGuardDeps } from '~/lib/coach/guards';
import { searchVillageTool } from '~/lib/coach/tools';
import { loadCronSkill } from '~/lib/cron/skill';
import { db } from '~/lib/db';
import { HOT_SMS_CLIENT_OPTIONS } from '~/lib/pipeline/client';
import { claimRelayCall } from './relay-claim';
import type { RelaySessionDeps, RelaySocket } from './relay-session';
import { answerSpokenReply } from './voice-answer';
import { voiceCallRecorder } from './voice-record';
import { voiceTurnStream } from './voice-turn';

/**
 * Voice v2 — the production wiring for one call.
 *
 * The one place the relay meets real tables, the real skill file and a real model.
 * Everything upstream of it takes its collaborators as arguments, so the state machine,
 * the turn, the answer stage and the recorder are all provable without any of the four.
 *
 * EVERY COLLABORATOR HERE IS THE TEXT LANE'S OWN. The tools come from the SMS coach's
 * builder, the draft port is the reviewer-gated one the app's chips use, the handler
 * chain and the open-question reader are the router's (`defaultHandlers`,
 * `defaultOpenQuestionReader`), and the resolver is the same one that reads a texted
 * "yeah go ahead". That is what "a call can do what a text can" means in wiring terms:
 * not a second implementation with the same behaviour, but the same implementation.
 *
 * Built per SOCKET, not per process: a session holds the identity of one call, and the
 * recorder memoizes nothing across calls. The Anthropic client is the exception and is
 * process-cached, the same as every other hot path — a new HTTPS pool per phone call
 * would spend the latency budget on a handshake.
 */

let cachedClient: Anthropic | undefined;

function anthropicClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  cachedClient ??= new Anthropic({ apiKey, ...HOT_SMS_CLIENT_OPTIONS });
  return cachedClient;
}

export function voiceRelayDeps(socket: RelaySocket, token: string | null): RelaySessionDeps {
  const database = db();
  return {
    socket,
    token,
    recorder: voiceCallRecorder(database),
    claimCall: (ticket, at) => claimRelayCall(database, ticket, at),
    turn: voiceTurnStream({
      loadSkill: () => loadCronSkill('voice-turn'),
      loadTranscript: (conversationId) => loadTranscript(conversationId, database),
      loadContext: (input) => loadAgentContext(input, database),
      // The router's own chain, reader and resolver — see voice-answer.ts for which of
      // the questions they surface a CALL is allowed to settle.
      answerSpoken: (turn) =>
        answerSpokenReply(
          {
            database,
            handlers: defaultHandlers(),
            questions: defaultOpenQuestionReader(),
            replyResolver: createReplyResolver(anthropicClient),
            sendablePhone: (parentUserId) => resolveSendablePhone(database, parentUserId),
            log: console,
          },
          turn,
        ),
      // The SMS coach's verbs, minus the two whose payoff is a text (the plan offer and
      // the referral link): tools.ts registers each of those only when a collector is
      // passed, so not passing one removes the VERB rather than discarding what it
      // produces (rule #11).
      buildTools: (turn, onDraft) =>
        buildChannelCoachTools({
          familyId: turn.familyId,
          reader: channelScheduleReader(database),
          draftPort: productionChannelDraftPort(database, anthropicClient(), turn.now),
          villageTool: searchVillageTool(database),
          onDraft,
          now: turn.now,
        }),
      client: anthropicClient,
      runStreaming: runAgentStreaming,
      guardDeps: buildGuardDeps(database),
      log: console,
      recordRun: async (run) => {
        await recordAgentRun(database, {
          familyId: run.familyId,
          agentName: run.agentName,
          modelUsed: pickModel('speak'),
          promptTokens: run.promptTokens,
          completionTokens: run.completionTokens,
          costUsd: run.costUsd,
          latencyMs: run.latencyMs,
          promptCacheHit: run.promptCacheHit,
          status: run.status,
        });
      },
      now: () => new Date(),
    }),
    log: console,
    now: () => new Date(),
  };
}
