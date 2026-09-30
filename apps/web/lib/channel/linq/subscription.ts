import { listLinqWebhookSubscriptions } from './transport';

/**
 * Linq's webhook catalog, from the authoritative list on
 * https://docs.linqapp.com/guides/webhooks/events/ (75 types, 2026-09).
 *
 * Hale subscribes to 66. The nine left off are account and team events:
 * they describe the Linq org, not a parent's chat, and a subscription that
 * included them would deliver credential-adjacent events to the inbound door.
 */
export const LINQ_WEBHOOK_CATALOG = [
  'message.sent',
  'message.received',
  'message.read',
  'message.delivered',
  'message.failed',
  'message.edited',
  'reaction.added',
  'reaction.removed',
  'poll.received',
  'poll.failed',
  'poll.sent',
  'poll.delivered',
  'poll.read',
  'poll.updated',
  'poll.vote.added',
  'poll.vote.removed',
  'poll.reaction.added',
  'participant.added',
  'participant.removed',
  'chat.created',
  'chat.group_name_updated',
  'chat.group_icon_updated',
  'chat.group_name_update_failed',
  'chat.group_icon_update_failed',
  'chat.background_updated',
  'chat.background_update_failed',
  'chat.typing_indicator.started',
  'chat.typing_indicator.stopped',
  'phone_number.status_updated',
  'phone_number.assigned',
  'phone_number.released',
  'contact_card.received',
  'call.initiated',
  'call.ringing',
  'call.answered',
  'call.ended',
  'call.failed',
  'call.declined',
  'call.no_answer',
  'location.sharing.started',
  'location.sharing.stopped',
  'payment.succeeded',
  'payment.canceled',
  'payment.expired',
  'payment.declined',
  'payment.authorized',
  'connection.created',
  'connection.revoked',
  'zero_day_retention.updated',
  'phone_number.forwarding_updated',
  'environment.line_moved',
  'contact_card.created',
  'contact_card.updated',
  'contact_card.deleted',
  'api_token.created',
  'api_token.renamed',
  'api_token.expiry_scheduled',
  'api_token.expired',
  'api_token.activated',
  'api_token.deleted',
  'environment.created',
  'environment.renamed',
  'environment.deleted',
  'webhook_subscription.created',
  'webhook_subscription.deleted',
  'webhook_subscription.target_url_changed',
  'webhook_subscription.enabled',
  'webhook_subscription.disabled',
  'webhook_subscription.events.updated',
  'webhook_subscription.phone_numbers.updated',
  'webhook_subscription.routing_headers_set',
  'webhook_subscription.routing_headers_cleared',
  'team_member.added',
  'team_member.signed_in',
  'team_member.signed_out',
] as const;

/** Account and team events. Not subscribed. */
export const LINQ_UNSUBSCRIBED_ACCOUNT_EVENTS = [
  'api_token.created',
  'api_token.renamed',
  'api_token.expiry_scheduled',
  'api_token.expired',
  'api_token.activated',
  'api_token.deleted',
  'team_member.added',
  'team_member.signed_in',
  'team_member.signed_out',
] as const;

const UNSUBSCRIBED = new Set<string>(LINQ_UNSUBSCRIBED_ACCOUNT_EVENTS);

/** The 66 events the inbound subscription is supposed to include. */
export const LINQ_SUBSCRIBED_EVENTS = LINQ_WEBHOOK_CATALOG.filter(
  (event) => !UNSUBSCRIBED.has(event),
);

export type LinqWebhookHealth = 'ok' | 'missing_poll_vote' | 'unconfigured' | 'unreachable';

/** Both poll-vote events. A subscription missing either one drops votes. */
export function subscriptionIncludesPollVotes(events: readonly string[]): boolean {
  return events.includes('poll.vote.added') && events.includes('poll.vote.removed');
}

/** Event names from a GET /webhook-subscriptions body. Tolerates the list
 * shapes Linq has shipped: a bare array, `{ data }`, `{ subscriptions }`. */
export function subscribedEventsFromPayload(payload: unknown): string[] {
  const rows = subscriptionRows(payload);
  const events: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const list = record.subscribed_events ?? record.events ?? record.event_types;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string') events.push(item);
    }
  }
  return events;
}

function subscriptionRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  for (const key of ['data', 'subscriptions', 'webhook_subscriptions', 'results']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  if (
    Array.isArray(record.subscribed_events) ||
    Array.isArray(record.events) ||
    Array.isArray(record.event_types)
  ) {
    return [payload];
  }
  return [];
}

export function linqWebhookStatus(
  listed:
    | { status: 'unconfigured' }
    | { status: 'unreachable' }
    | { status: 'ok'; payload: unknown },
): LinqWebhookHealth {
  if (listed.status !== 'ok') return listed.status;
  const events = subscribedEventsFromPayload(listed.payload);
  return subscriptionIncludesPollVotes(events) ? 'ok' : 'missing_poll_vote';
}

/** Fail-soft, same posture as the DB ping on /api/health. */
export async function linqWebhookHealth(): Promise<LinqWebhookHealth> {
  return linqWebhookStatus(await listLinqWebhookSubscriptions());
}
