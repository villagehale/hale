import { pickModel, runAgentStreaming } from '@hale/agent';
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
import { pipelineClient, voiceClient, voiceLookupClient } from '~/lib/pipeline/client';
import { createActivityFinder } from '~/lib/channel/activity/lane';
import { bindActivityReader, productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import { claimRelayCall } from './relay-claim';
import { defaultVoiceLookupPorts, withVoiceLookupBudget } from './voice-lookup';
import type { RelaySessionDeps, RelaySocket } from './relay-session';
import { answerSpokenReply } from './voice-answer';
import { defaultVoicePromisePorts, voicePromiseRecorder } from './voice-promise';
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
 * recorder memoizes nothing across calls. The Anthropic clients are the exception and are
 * process-cached, the same as every other hot path — a new HTTPS pool per phone call
 * would spend the latency budget on a handshake.
 *
 * TWO CLIENTS, because a call asks the model two questions with different costs of being
 * slow, and one timeout cannot answer both honestly.
 *
 *   `voiceClient` — the turn's own stream and the reply resolver ahead of it. Nothing is
 *   coming out of the speaker while either runs, so their ceiling is how long a parent
 *   holds a silent line: eight seconds, no retry (VOICE_CLIENT_OPTIONS).
 *
 *   `pipelineClient` — the reviewer inside a propose_* draft. It runs AFTER the ack line
 *   has been spoken, and it is a safety gate (rule #3): timing it out saves the caller
 *   nothing and loses a draft they asked for out loud. Measured 2026-08-20 at 6.5-6.9s
 *   per request on claude-sonnet-5, which an eight-second budget would sit right on top
 *   of, so it keeps the queue-backed 30s the texting lane gives the same reviewer.
 */

export function voiceRelayDeps(socket: RelaySocket, token: string | null): RelaySessionDeps {
  const database = db();
  const activityReader = bindActivityReader(database, productionActivityFamilyReader());
  // Per SOCKET, like every other collaborator here: it holds the subject THIS call's
  // search verb registered, and hands it to the row written after the words were spoken.
  const promises = voicePromiseRecorder(database, defaultVoicePromisePorts(activityReader));
  return {
    socket,
    token,
    recorder: voiceCallRecorder(database),
    claimCall: (ticket, at) => claimRelayCall(database, ticket, at),
    promiseSpoken: (input) => promises.record(input),
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
            replyResolver: createReplyResolver(voiceClient),
            sendablePhone: (parentUserId) => resolveSendablePhone(database, parentUserId),
            log: console,
          },
          turn,
        ),
      // The SMS coach's verbs, minus the two whose payoff is a text (the plan offer and
      // the referral link): tools.ts registers each of those only when a collector is
      // passed, so not passing one removes the VERB rather than discarding what it
      // produces (rule #11).
      //
      // THE WEB VERBS ARE HERE NOW (VIL-313), and they are the same two the texting lane
      // registers, over the same lane and the same de-identification. What is different is
      // one wrapper: the finder is walled at VOICE_LOOKUP_BUDGET_MS, because a caller is
      // holding a silent line and the lane's own budget is fifty seconds. `onPromise` is
      // the promise recorder's collector — not a listener that discards, but the thing
      // that supplies the subject the ledger row is searched on (voice-promise.ts).
      buildTools: (turn, onDraft) =>
        buildChannelCoachTools({
          familyId: turn.familyId,
          reader: channelScheduleReader(database),
          draftPort: productionChannelDraftPort(database, pipelineClient(), turn.now),
          activity: {
            reader: activityReader,
            finder: withVoiceLookupBudget(
              createActivityFinder(voiceLookupClient),
              defaultVoiceLookupPorts(),
            ),
          },
          onPromise: promises.collect,
          villageTool: searchVillageTool(database),
          onDraft,
          now: turn.now,
        }),
      client: voiceClient,
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
