import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
/**
 * Delivery receipts, the only thing that turns "we called the API" into "it reached
 * the phone". Linq posts one receipt per status transition, keyed by the provider
 * message id the send returned, and `channel_messages.provider_message_id` is indexed
 * for exactly this lookup.
 *
 * Receipts are NOT ordered. Each transition arrives as its own event, so
 * `sent` and `delivered` can arrive in either order, and a retry can redeliver an old
 * one at any time. Applying whatever arrives last would let a stale `sent` un-deliver a
 * delivered message. So the write is MONOTONIC: each target status names the states it
 * is allowed to overwrite, and the guard rides in the UPDATE's own WHERE — one
 * statement, no read-modify-write, so concurrent callbacks cannot race each other.
 */

type ChannelMessageStatus = (typeof schema.channelMessageStatusEnum.enumValues)[number];

/** The ledger state a provider status string means, or null when it means nothing we
 * record (inbound-only values, and anything a provider adds later — we refuse to guess). */
export function mapDeliveryStatus(raw: string): ChannelMessageStatus | null {
  switch (raw.trim().toLowerCase()) {
    case 'accepted':
    case 'scheduled':
    case 'queued':
    case 'sending':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'undelivered':
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

/**
 * The states `next` may overwrite. Empty means "never write" — a `queued` callback
 * arriving after the row already exists carries no new information.
 *
 * `failed` is the deliberate exception to strict forward-only progress: it may
 * overwrite `delivered`, because a carrier that reports an optimistic delivery and then
 * an `undelivered` is telling us the message did NOT arrive, and a parent silently not
 * receiving a reminder is exactly what this ledger exists to surface.
 *
 * No suppression state is ever overwritable: those rows record a message Hale CHOSE not
 * to send (consent, quiet hours, cap), they never reached a provider, and no provider
 * callback can legitimately name one.
 */
export function overwritableFrom(next: ChannelMessageStatus): ChannelMessageStatus[] {
  switch (next) {
    case 'sent':
      return ['queued'];
    case 'delivered':
      return ['queued', 'sent'];
    case 'failed':
      return ['queued', 'sent', 'delivered'];
    default:
      return [];
  }
}

export type StatusApplyResult = 'updated' | 'ignored' | 'unknown_message';

/**
 * Apply one delivery receipt to the ledger. `ignored` covers both an unmappable status
 * and a callback that lost the monotonic guard; `unknown_message` means no row carries
 * that provider id (a send from another environment sharing the number, or a callback
 * for a message this deployment never wrote).
 */
export async function applyDeliveryStatus(
  database: Database,
  input: { providerMessageId: string; rawStatus: string; errorCode: string | null },
): Promise<StatusApplyResult> {
  const next = mapDeliveryStatus(input.rawStatus);
  if (!next) return 'ignored';

  const from = overwritableFrom(next);
  if (from.length === 0) return 'ignored';

  const updated = await database
    .update(schema.channelMessages)
    .set({ status: next, errorCode: input.errorCode })
    .where(
      and(
        eq(schema.channelMessages.providerMessageId, input.providerMessageId),
        inArray(schema.channelMessages.status, from),
      ),
    )
    .returning({ id: schema.channelMessages.id });

  if (updated.length > 0) return 'updated';

  // Nothing moved. Either the row is already past this state (the common, correct case
  // for an out-of-order callback) or there is no such row at all — worth telling apart,
  // because a persistent `unknown_message` means the callback URL is pointed at the
  // wrong deployment.
  const existing = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.providerMessageId, input.providerMessageId))
    .limit(1);
  return existing.length > 0 ? 'ignored' : 'unknown_message';
}

