import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import {
  CHANNEL_MESSAGE_RECEIVED_POLICY,
  CHANNEL_MESSAGE_RECEIVED_QUEUE,
} from '~/lib/channel/config';
import { createIntakeExtractor } from '~/lib/channel/intake/extract';
import { createIntakeAckComposer } from '~/lib/channel/intake/intake-voice';
import { createReplyIntentReader } from '~/lib/channel/intake/intent';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { createRadarComposer } from '~/lib/channel/intake/radar';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
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
    ackComposer: createIntakeAckComposer(client),
    limiter: new PostgresRateLimiter(database),
  };
}

/** The slice of pg-boss the producer uses, injected so the key and the policy are
 * assertable without a live queue (the ApproveQueue pattern). */
export interface QueueOptions {
  name?: string;
  expireInSeconds?: number;
  policy?: string;
}

export interface MessageQueue {
  createQueue(name: string, options?: QueueOptions): Promise<void>;
  updateQueue(name: string, options?: QueueOptions): Promise<void>;
  send(
    name: string,
    data: ChannelMessageReceivedJob,
    options?: { expireInSeconds?: number; singletonKey?: string },
  ): Promise<string | null>;
}

/**
 * The send options, in one place because two call sites use them.
 *
 * The key is the CONVERSATION anchor — the same string the router threads on — not the
 * provider message id A3 shipped. A per-message key serializes nothing, because every
 * message has a different one. Per-PARENT rather than per-family, so a co-parent's text
 * never waits behind a turn that has nothing to do with them.
 *
 * This is ordering, not deduplication: the duplicate guard remains the ledger's
 * provider_message_id lookup in inbound.ts, which runs before this is ever reached.
 */
function sendOptions(job: ChannelMessageReceivedJob) {
  return {
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
    singletonKey: channelSmsNoteKey(job.parent_user_id),
  };
}

/**
 * Enqueue one conversation turn for C1, ensuring the queue exists AND carries the
 * policy the key needs.
 *
 * Both statements are required, and `updateQueue` is the one that is easy to miss.
 * pg-boss's `create_queue` ends in ON CONFLICT DO NOTHING, so it cannot change the
 * policy of a queue that already exists — and A3 already shipped this queue, which
 * means production may well hold a `standard` row that would silently ignore every
 * singleton key we send it. `updateQueue` converges it, and is a no-op UPDATE when the
 * row is absent, so the pair is correct from either starting state.
 */
export async function sendChannelMessageReceived(
  queue: MessageQueue,
  job: ChannelMessageReceivedJob,
): Promise<void> {
  const options: QueueOptions = {
    name: CHANNEL_MESSAGE_RECEIVED_QUEUE,
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
    policy: CHANNEL_MESSAGE_RECEIVED_POLICY,
  };
  await queue.createQueue(CHANNEL_MESSAGE_RECEIVED_QUEUE, options);
  await queue.updateQueue(CHANNEL_MESSAGE_RECEIVED_QUEUE, options);
  await queue.send(CHANNEL_MESSAGE_RECEIVED_QUEUE, job, sendOptions(job));
}

/** Production entrypoint. The queue setup is cached per process (A3's discipline): one
 * pair of statements per cold start rather than per text. */
let queueEnsured = false;

export async function enqueueChannelMessageReceived(job: ChannelMessageReceivedJob): Promise<void> {
  const queue = (await getQueue()) as unknown as MessageQueue;
  if (queueEnsured) {
    await queue.send(CHANNEL_MESSAGE_RECEIVED_QUEUE, job, sendOptions(job));
    return;
  }
  await sendChannelMessageReceived(queue, job);
  queueEnsured = true;
}

export function twilioInboundDeps(): TwilioInboundDeps {
  return {
    database: db(),
    intake: buildIntakeDeps,
    enqueue: enqueueChannelMessageReceived,
  };
}
