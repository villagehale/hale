import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { CHANNEL_MESSAGE_RECEIVED_QUEUE } from '~/lib/channel/config';
import { createIntakeExtractor } from '~/lib/channel/intake/extract';
import { createReplyIntentReader } from '~/lib/channel/intake/intent';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { createRadarComposer } from '~/lib/channel/intake/radar';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';
import { db } from '~/lib/db';
import { getQueue } from '~/lib/queue';
import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import { createOpenMeteoWeather } from '~/lib/weather/open-meteo';
import type { ChannelMessageReceivedJob, TwilioInboundDeps } from './inbound';
import { createTwilioTransport } from './transport';

/**
 * VIL-214 · A3 — the production wiring for the inbound webhook. The one place the
 * intake machine meets a real provider, a real model, and a real queue; every other
 * module in this folder takes its collaborators as arguments so the tests never do.
 */

let cachedClient: Anthropic | undefined;

function anthropicClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  cachedClient ??= new Anthropic({ apiKey });
  return cachedClient;
}

/** M2's deps, built for real. Called only AFTER the signature passes (see inbound.ts),
 * so a forged request never constructs a model client. */
export function buildIntakeDeps(): IntakeDeps {
  const database = db();
  const client = anthropicClient();
  return {
    transport: createTwilioTransport(),
    extractor: createIntakeExtractor(client),
    intentReader: createReplyIntentReader(client),
    radar: createRadarComposer({ database, weather: createOpenMeteoWeather(), client }),
    limiter: new PostgresRateLimiter(database),
  };
}

/**
 * Enqueue one conversation turn for C1.
 *
 * `createQueue` first because pg-boss 10 refuses to send to a queue that does not exist,
 * and A3 ships the PRODUCER before C1 ships the consumer — so nothing else would have
 * created it. It is idempotent (ON CONFLICT DO NOTHING in pg-boss's own DDL), and
 * cached per process so it costs one statement per cold start rather than one per text.
 *
 * `singletonKey` carries the provider message id as GROUNDWORK, and is deliberately
 * described as nothing more: pg-boss only enforces singleton-key uniqueness on queues
 * whose policy is 'short' / 'singleton' / 'stately' (the unique index is `WHERE policy =
 * …`), and this queue is 'standard', so the key is recorded and enforces nothing today.
 * The real duplicate guard is the ledger's provider_message_id lookup in inbound.ts,
 * which is what the retry test actually exercises. C1 owns the policy choice, because
 * the useful key there is probably per-CONVERSATION (serialize a family's turns), not
 * per-message — and picking 'short' now would also silently throttle any keyless job a
 * future producer sends to this queue.
 */
let queueEnsured = false;

export async function enqueueChannelMessageReceived(job: ChannelMessageReceivedJob): Promise<void> {
  const queue = await getQueue();
  if (!queueEnsured) {
    await queue.createQueue(CHANNEL_MESSAGE_RECEIVED_QUEUE, {
      name: CHANNEL_MESSAGE_RECEIVED_QUEUE,
      expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
    });
    queueEnsured = true;
  }
  await queue.send(CHANNEL_MESSAGE_RECEIVED_QUEUE, job, {
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
    singletonKey: job.provider_message_id,
  });
}

export function twilioInboundDeps(): TwilioInboundDeps {
  return {
    database: db(),
    intake: buildIntakeDeps,
    enqueue: enqueueChannelMessageReceived,
  };
}
