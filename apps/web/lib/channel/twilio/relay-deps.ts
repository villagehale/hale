import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel, runAgentStreaming } from '@hale/agent';
import { recordAgentRun } from '~/lib/agent-run';
import { loadAgentContext } from '~/lib/coach/context';
import { loadTranscript } from '~/lib/coach/conversation';
import { buildGuardDeps } from '~/lib/coach/guards';
import { loadCronSkill } from '~/lib/cron/skill';
import { db } from '~/lib/db';
import { HOT_SMS_CLIENT_OPTIONS } from '~/lib/pipeline/client';
import type { RelaySessionDeps, RelaySocket } from './relay-session';
import { voiceCallRecorder } from './voice-record';
import { voiceTurnStream } from './voice-turn';

/**
 * Voice v1 — the production wiring for one call.
 *
 * The one place the relay meets real tables, the real skill file and a real model.
 * Everything upstream of it takes its collaborators as arguments, so the state machine,
 * the turn, and the recorder are all provable without any of the three.
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
    turn: voiceTurnStream({
      loadSkill: () => loadCronSkill('voice-turn'),
      loadTranscript: (conversationId) => loadTranscript(conversationId, database),
      loadContext: (input) => loadAgentContext(input, database),
      client: anthropicClient,
      runStreaming: runAgentStreaming,
      guardDeps: buildGuardDeps(database),
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
