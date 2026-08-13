import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { HOT_SMS_CLIENT_OPTIONS } from '~/lib/pipeline/client';
import {
  CHANNEL_MESSAGE_RECEIVED_DLQ,
  CHANNEL_MESSAGE_RECEIVED_POLICY,
  CHANNEL_MESSAGE_RECEIVED_QUEUE,
  CHANNEL_MESSAGE_RECEIVED_RETRY,
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
import type { TwilioVoiceDeps } from './voice';

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
  cachedClient ??= new Anthropic({ apiKey, ...HOT_SMS_CLIENT_OPTIONS });
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
  /** The defer arc's ceiling, declared on the QUEUE so it converges on an environment
   * where the queue already exists (see the pair below). */
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  deadLetter?: string;
}

export interface MessageQueue {
  createQueue(name: string, options?: QueueOptions): Promise<void>;
  updateQueue(name: string, options?: QueueOptions): Promise<void>;
  send(
    name: string,
    data: ChannelMessageReceivedJob,
    options?: { expireInSeconds?: number; singletonKey?: string; id?: string },
  ): Promise<string | null>;
  /** The only thing that can tell an idempotent no-op from a send that went nowhere. */
  getJobById(
    name: string,
    id: string,
    options?: { includeArchive: boolean },
  ): Promise<{ id: string } | null>;
}

/**
 * The send options, in one place because two call sites use them.
 *
 * The KEY is the CONVERSATION anchor — the same string the router threads on — not the
 * provider message id A3 shipped. A per-message key serializes nothing, because every
 * message has a different one. Per-PARENT rather than per-family, so a co-parent's text
 * never waits behind a turn that has nothing to do with them. That is ordering, not
 * deduplication.
 *
 * The ID is the deduplication, and it is deliberately the channel message id rather than
 * a key of its own: one text is one row is one job, an identity that already exists, is
 * already a uuid, and is already the pointer the payload carries. It matters because the
 * webhook is no longer the only producer — the reconciler re-drives rows that were never
 * marked handed off, and it cannot distinguish "the enqueue failed" from "the enqueue
 * worked and the mark didn't". Under a stable id it does not have to: pg-boss's insert
 * ends in ON CONFLICT DO NOTHING, so the second attempt creates nothing.
 */
function sendOptions(job: ChannelMessageReceivedJob) {
  return {
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
    singletonKey: channelSmsNoteKey(job.parent_user_id),
    id: job.channel_message_id,
  };
}

/**
 * Send it, then make sure it is actually there.
 *
 * pg-boss returns null from `send` for two opposite reasons: a job with this id already
 * exists (idempotency working exactly as intended) or nothing was inserted at all —
 * its insert SELECTs through a join on the queue table, so a missing or mistyped queue
 * silently yields zero rows. Treating both as success is how a caller ends up writing
 * `handed_off_at` over a job that does not exist, which is the swallowed-text bug one
 * layer further down. The job table is the only thing that can tell them apart, so on
 * the null path we ask it — including the archive, since a job that already ran and was
 * archived is still a text that was delivered to C1.
 */
async function sendAndConfirm(
  queue: MessageQueue,
  job: ChannelMessageReceivedJob,
): Promise<void> {
  const created = await queue.send(CHANNEL_MESSAGE_RECEIVED_QUEUE, job, sendOptions(job));
  if (created) return;

  const existing = await queue.getJobById(
    CHANNEL_MESSAGE_RECEIVED_QUEUE,
    job.channel_message_id,
    { includeArchive: true },
  );
  if (!existing) {
    throw new Error(
      `${CHANNEL_MESSAGE_RECEIVED_QUEUE}: pg-boss created no job and none exists for channel message ${job.channel_message_id}`,
    );
  }
}

/**
 * Enqueue one conversation turn for C1, ensuring the queue exists AND carries the policy
 * the key needs, the retry ceiling the defer arc runs on, and somewhere to put a turn
 * that runs out of both.
 *
 * Both statements are required, and `updateQueue` is the one that is easy to miss.
 * pg-boss's `create_queue` ends in ON CONFLICT DO NOTHING, so it cannot change anything
 * about a queue that already exists — and A3 already shipped this queue, which means
 * production holds a row with the wrong policy AND pg-boss's default retry (two
 * attempts, no delay, three seconds of "waiting out" an outage). `updateQueue` converges
 * it, and is a no-op UPDATE when the row is absent, so the pair is correct from either
 * starting state.
 *
 * The dead-letter queue is created FIRST because `job.dead_letter` is a foreign key onto
 * `queue(name)`: naming a queue that does not exist yet is a constraint violation, not a
 * warning.
 */
export async function sendChannelMessageReceived(
  queue: MessageQueue,
  job: ChannelMessageReceivedJob,
): Promise<void> {
  await queue.createQueue(CHANNEL_MESSAGE_RECEIVED_DLQ, { name: CHANNEL_MESSAGE_RECEIVED_DLQ });

  const options: QueueOptions = {
    name: CHANNEL_MESSAGE_RECEIVED_QUEUE,
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
    policy: CHANNEL_MESSAGE_RECEIVED_POLICY,
    ...CHANNEL_MESSAGE_RECEIVED_RETRY,
    deadLetter: CHANNEL_MESSAGE_RECEIVED_DLQ,
  };
  await queue.createQueue(CHANNEL_MESSAGE_RECEIVED_QUEUE, options);
  await queue.updateQueue(CHANNEL_MESSAGE_RECEIVED_QUEUE, options);
  await sendAndConfirm(queue, job);
}

/** Production entrypoint. The queue setup is cached per process (A3's discipline): one
 * pair of statements per cold start rather than per text. */
let queueEnsured = false;

export async function enqueueChannelMessageReceived(job: ChannelMessageReceivedJob): Promise<void> {
  const queue = (await getQueue()) as unknown as MessageQueue;
  if (queueEnsured) {
    await sendAndConfirm(queue, job);
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
    log: console,
  };
}

/** The voice front door's wiring. Only a database and the SMS leg — the call itself is
 * answered with a static document, so no model and no queue is involved. */
export function twilioVoiceDeps(): TwilioVoiceDeps {
  return {
    database: db(),
    transport: () => createTwilioTransport(),
    log: console,
  };
}
