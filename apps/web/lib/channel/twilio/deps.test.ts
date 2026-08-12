import { describe, expect, it } from 'vitest';
import {
  CHANNEL_MESSAGE_RECEIVED_POLICY,
  CHANNEL_MESSAGE_RECEIVED_QUEUE,
} from '~/lib/channel/config';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';
import { type MessageQueue, sendChannelMessageReceived } from './deps';
import type { ChannelMessageReceivedJob } from './inbound';

/**
 * VIL-220 · C1 — the producer half of per-conversation FIFO.
 *
 * A3 shipped this send with `singletonKey: provider_message_id` and a comment saying
 * the key was groundwork that "enforces nothing today", because a `standard` queue
 * ignores it and because the useful key was C1's to choose. This is that choice, and
 * both halves of it are load-bearing: the KEY must name the conversation (a per-message
 * key serializes nothing — every message has a different one), and the POLICY must be
 * one pg-boss actually enforces the key on.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const OTHER_PARENT = '55555555-5555-4555-8555-555555555555';

interface Sent {
  name: string;
  data: unknown;
  options?: { expireInSeconds?: number; singletonKey?: string; id?: string };
}

/**
 * A pg-boss stand-in that models the ONE behaviour the producer has to get right:
 * `send` inserts ON CONFLICT DO NOTHING keyed on the job id, so a repeat of a job that
 * is still in the table returns null rather than creating a second one — and null is
 * ALSO what a send that landed nowhere returns. `existing` is the job table, which is
 * the only thing that can tell those two apart.
 */
function fakeQueue(
  options: { accepts?: boolean } = {},
): MessageQueue & {
  sent: Sent[];
  created: Array<{ name: string; policy?: string; expireInSeconds?: number }>;
  updated: Array<{ name: string; policy?: string }>;
  existing: Set<string>;
  lookups: string[];
} {
  const accepts = options.accepts ?? true;
  const sent: Sent[] = [];
  const created: Array<{ name: string; policy?: string; expireInSeconds?: number }> = [];
  const updated: Array<{ name: string; policy?: string }> = [];
  const existing = new Set<string>();
  const lookups: string[] = [];
  return {
    sent,
    created,
    updated,
    existing,
    lookups,
    async createQueue(name, opts) {
      created.push({ name, policy: opts?.policy, expireInSeconds: opts?.expireInSeconds });
    },
    async updateQueue(name, opts) {
      updated.push({ name, policy: opts?.policy });
    },
    async send(name, data, opts) {
      sent.push({ name, data, options: opts });
      const id = opts?.id;
      if (!accepts) return null;
      if (id && existing.has(id)) return null;
      if (id) existing.add(id);
      return id ?? 'job-id';
    },
    async getJobById(_name, id) {
      lookups.push(id);
      return existing.has(id) ? { id } : null;
    },
  };
}

function job(overrides: Partial<ChannelMessageReceivedJob> = {}): ChannelMessageReceivedJob {
  return {
    family_id: FAMILY,
    parent_user_id: PARENT,
    channel_message_id: '33333333-3333-4333-8333-333333333333',
    provider_message_id: 'SM1',
    received_at: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

describe('sendChannelMessageReceived', () => {
  /**
   * The proof that two texts a second apart serialize: they carry the SAME key. Under
   * the singleton policy pg-boss lets only one job per key be active at a time and
   * fetches them in created order, so the parent's second sentence can never overtake
   * their first — which is the whole point, because "move swim to Tuesday" followed by
   * "actually make it Wednesday" means the opposite when it arrives backwards.
   */
  it('keys two texts from one parent to the same conversation', async () => {
    const queue = fakeQueue();

    await sendChannelMessageReceived(queue, job({ provider_message_id: 'SM1' }));
    await sendChannelMessageReceived(queue, job({ provider_message_id: 'SM2' }));

    const keys = queue.sent.map((s) => s.options?.singletonKey);
    expect(keys).toEqual([channelSmsNoteKey(PARENT), channelSmsNoteKey(PARENT)]);
    expect(new Set(keys).size).toBe(1);
  });

  /** The key is the CONVERSATION anchor, so the queue and the thread cannot disagree
   * about which turns belong together. */
  it('uses the same key the router threads on', async () => {
    const queue = fakeQueue();
    await sendChannelMessageReceived(queue, job());

    expect(queue.sent[0]?.options?.singletonKey).toBe(channelSmsNoteKey(PARENT));
  });

  /** Two parents are two conversations, so they must NOT serialize against each other —
   * one parent mid-turn cannot be allowed to stall their co-parent's text. */
  it('gives a co-parent an independent key', async () => {
    const queue = fakeQueue();

    await sendChannelMessageReceived(queue, job({ parent_user_id: PARENT }));
    await sendChannelMessageReceived(queue, job({ parent_user_id: OTHER_PARENT }));

    const [a, b] = queue.sent.map((s) => s.options?.singletonKey);
    expect(a).not.toBe(b);
  });

  /**
   * Without this policy the key is inert: pg-boss's singleton index is declared
   * `WHERE policy = 'singleton'`, so a `standard` queue records the key and enforces
   * nothing. This assertion is the difference between FIFO and the appearance of it.
   */
  it('creates the queue under the policy that enforces the key', async () => {
    const queue = fakeQueue();
    await sendChannelMessageReceived(queue, job());

    expect(CHANNEL_MESSAGE_RECEIVED_POLICY).toBe('singleton');
    expect(queue.created).toContainEqual({
      name: CHANNEL_MESSAGE_RECEIVED_QUEUE,
      policy: CHANNEL_MESSAGE_RECEIVED_POLICY,
      expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
    });
  });

  /**
   * The landmine A3 left behind it: pg-boss's create_queue ends in ON CONFLICT DO
   * NOTHING, so on any environment where A3 already ran, the queue exists as 'standard'
   * and createQueue alone would leave it that way — the key would be sent forever and
   * enforced never. updateQueue is what converges an already-created queue.
   */
  it('CONVERGES the policy of a queue A3 already created as standard', async () => {
    const queue = fakeQueue();
    await sendChannelMessageReceived(queue, job());

    expect(queue.updated).toContainEqual({
      name: CHANNEL_MESSAGE_RECEIVED_QUEUE,
      policy: CHANNEL_MESSAGE_RECEIVED_POLICY,
    });
  });

  it('carries pointers only — never the text itself', async () => {
    const queue = fakeQueue();
    await sendChannelMessageReceived(queue, job());

    expect(JSON.stringify(queue.sent[0]?.data)).not.toMatch(/body|phone|\+1416/i);
    expect(queue.sent[0]?.data).toEqual(job());
  });
});

/**
 * Exactly-once, and the difference between asserting it and checking it.
 *
 * The webhook is no longer the only producer — the reconciler re-drives any inbound row
 * that was never marked handed off, and it cannot tell "the enqueue failed" from "the
 * enqueue worked and the mark didn't". Without a stable identity for the job those two
 * look the same and the parent gets answered twice. The channel message id IS that
 * identity: it is already a uuid, already one per text, and already the pointer the job
 * carries, so no new key format has to be invented or kept in sync.
 */
describe('the job id is the channel message id', () => {
  it('sends under the channel message id, so one text can only ever be one job', async () => {
    const queue = fakeQueue();
    await sendChannelMessageReceived(queue, job());

    expect(queue.sent[0]?.options?.id).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('re-driving the same message enqueues NOTHING the second time', async () => {
    const queue = fakeQueue();

    await sendChannelMessageReceived(queue, job());
    await sendChannelMessageReceived(queue, job());

    // Both calls reached pg-boss; only the first created a job.
    expect(queue.sent).toHaveLength(2);
    expect(queue.existing.size).toBe(1);
  });

  /**
   * pg-boss's insert ends in ON CONFLICT DO NOTHING and its SELECT joins the queue
   * table, so `send` returns null for BOTH "this job already exists" (idempotency
   * working) and "there was no queue row, nothing was inserted" (the text going
   * nowhere). Returning normally on that second case is how a caller comes to write
   * `handed_off_at` over a job that does not exist — the original bug, one layer down.
   */
  it('THROWS when pg-boss accepted nothing and no such job exists', async () => {
    const queue = fakeQueue({ accepts: false });

    await expect(sendChannelMessageReceived(queue, job())).rejects.toThrow(
      /33333333-3333-4333-8333-333333333333/,
    );
  });

  it('is SILENT when the null meant the job was already there', async () => {
    const queue = fakeQueue({ accepts: false });
    queue.existing.add('33333333-3333-4333-8333-333333333333');

    await expect(sendChannelMessageReceived(queue, job())).resolves.toBeUndefined();
    expect(queue.lookups).toEqual(['33333333-3333-4333-8333-333333333333']);
  });

  /** The happy path must not pay for the check — the job table is consulted only when
   * pg-boss said nothing was created. */
  it('does not consult the job table when the send created a job', async () => {
    const queue = fakeQueue();
    await sendChannelMessageReceived(queue, job());

    expect(queue.lookups).toEqual([]);
  });
});
