import { type Database, schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { type ExpoPushClient, createExpoPushClient } from './expo-client';

/**
 * The delivery-channel seam. A `Channel` takes a composed, address-free message plus
 * the recipient (internal users.id) and delivers it to that user's live addresses on
 * this channel, returning a typed result — never throwing for an expected outcome
 * (no address, provider transport failure). This is the shape VIL-213 (A2) implements
 * per leg: push now; email/SMS later reuse the same `send(userId, message) → result`
 * contract so channel selection can treat every leg uniformly.
 *
 * Privacy (rule #1): the message carries only the caller's teen-safe title/body/data;
 * the address (the Expo token) is a device pointer, never logged. `sendPushToUser`
 * (lib/push/send) is the backward-compatible facade over the Expo implementation for
 * the existing crons; new consumers take the channel directly.
 */

export interface ChannelMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** A transport failure reaching the provider (network / non-2xx) — the send never
 * left, so the caller may retry or fall back to another channel. */
export interface ChannelTransportError {
  kind: 'transport';
  message: string;
}

export type ChannelDelivery =
  /** The channel is gated off (PUSH_SEND_ENABLED unset) — nothing addressed. */
  | { status: 'disabled' }
  /** The user has no live address on this channel (no registered device). */
  | { status: 'no_address' }
  /** Handed to the provider: `delivered` accepted, `pruned` dead addresses removed. */
  | { status: 'delivered'; delivered: number; pruned: number }
  /** The provider transport failed; nothing was delivered. */
  | { status: 'error'; error: ChannelTransportError };

export interface Channel {
  send(userId: string, message: ChannelMessage): Promise<ChannelDelivery>;
}

export interface ExpoChannelDeps {
  database: Database;
  client: ExpoPushClient;
}

function pushSendEnabled(): boolean {
  return process.env.PUSH_SEND_ENABLED === 'true';
}

export function defaultExpoChannelDeps(database: Database): ExpoChannelDeps {
  return { database, client: createExpoPushClient() };
}

/**
 * The Expo push implementation of the channel. Looks up the user's registered tokens,
 * hands one message per token to the injected Expo client, prunes any token that comes
 * back DeviceNotRegistered (a dead device — uninstalled / logged out), and reports the
 * typed outcome. Gated by PUSH_SEND_ENABLED (off by default) so nothing addresses a
 * real device until the flag is flipped on purpose.
 */
export function createExpoPushChannel(deps: ExpoChannelDeps): Channel {
  return {
    async send(userId, message) {
      if (!pushSendEnabled()) {
        return { status: 'disabled' };
      }

      const tokens = await deps.database
        .select({ id: schema.pushTokens.id, expoPushToken: schema.pushTokens.expoPushToken })
        .from(schema.pushTokens)
        .where(eq(schema.pushTokens.userId, userId));

      if (tokens.length === 0) {
        return { status: 'no_address' };
      }

      let tickets: Awaited<ReturnType<ExpoPushClient['send']>>;
      try {
        tickets = await deps.client.send(
          tokens.map((t) => ({
            to: t.expoPushToken,
            title: message.title,
            body: message.body,
            ...(message.data ? { data: message.data } : {}),
          })),
        );
      } catch (e) {
        return { status: 'error', error: { kind: 'transport', message: (e as Error).message } };
      }

      const deadTokenIds = tokens
        .filter((_, i) => tickets[i]?.details?.error === 'DeviceNotRegistered')
        .map((t) => t.id);

      if (deadTokenIds.length > 0) {
        await deps.database.delete(schema.pushTokens).where(inArray(schema.pushTokens.id, deadTokenIds));
      }

      const delivered = tickets.filter((t) => t.status === 'ok').length;
      return { status: 'delivered', delivered, pruned: deadTokenIds.length };
    },
  };
}
