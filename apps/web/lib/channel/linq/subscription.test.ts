import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TURN_DEADLINE_MS } from '~/lib/channel/config';
import {
  LINQ_SUBSCRIBED_EVENTS,
  LINQ_UNSUBSCRIBED_ACCOUNT_EVENTS,
  LINQ_WEBHOOK_CATALOG,
  linqWebhookStatus,
  subscribedEventsFromPayload,
  subscriptionIncludesPollVotes,
} from './subscription';
import { SEND_TIMEOUT_MS } from './transport';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

describe('Linq webhook subscription (VIL-400)', () => {
  it('subscribes to 66 of the 75 catalog events, including both poll votes', () => {
    expect(LINQ_WEBHOOK_CATALOG).toHaveLength(75);
    expect(LINQ_SUBSCRIBED_EVENTS).toHaveLength(66);
    expect(LINQ_UNSUBSCRIBED_ACCOUNT_EVENTS).toHaveLength(9);
    expect(new Set([...LINQ_SUBSCRIBED_EVENTS, ...LINQ_UNSUBSCRIBED_ACCOUNT_EVENTS]).size).toBe(75);
    expect(subscriptionIncludesPollVotes(LINQ_SUBSCRIBED_EVENTS)).toBe(true);
    expect(subscriptionIncludesPollVotes(LINQ_UNSUBSCRIBED_ACCOUNT_EVENTS)).toBe(false);
  });

  it('fails the health check when either poll vote is missing', () => {
    const events = LINQ_SUBSCRIBED_EVENTS.filter((event) => event !== 'poll.vote.removed');
    expect(subscriptionIncludesPollVotes(events)).toBe(false);
    expect(
      linqWebhookStatus({
        status: 'ok',
        payload: { subscriptions: [{ subscribed_events: events }] },
      }),
    ).toBe('missing_poll_vote');
    expect(
      linqWebhookStatus({
        status: 'ok',
        payload: { data: [{ events: [...LINQ_SUBSCRIBED_EVENTS] }] },
      }),
    ).toBe('ok');
    expect(linqWebhookStatus({ status: 'unconfigured' })).toBe('unconfigured');
    expect(linqWebhookStatus({ status: 'unreachable' })).toBe('unreachable');
  });

  it('reads subscribed_events off the shapes Linq returns', () => {
    expect(
      subscribedEventsFromPayload({
        webhook_subscriptions: [{ event_types: ['poll.vote.added', 'poll.vote.removed'] }],
      }),
    ).toEqual(['poll.vote.added', 'poll.vote.removed']);
  });

  it('lists every subscribed event in .env.example', () => {
    const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
    for (const event of LINQ_SUBSCRIBED_EVENTS) {
      expect(example, event).toContain(event);
    }
  });

  it('bounds a Linq send inside the turn deadline', () => {
    expect(SEND_TIMEOUT_MS).toBe(8_000);
    expect(SEND_TIMEOUT_MS).toBeLessThan(TURN_DEADLINE_MS);
  });
});
