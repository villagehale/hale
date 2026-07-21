import type { Database } from '@hale/db';
import { db as defaultDb } from '~/lib/db';
import { type ChannelMessage, createExpoPushChannel } from './channel';
import { type ExpoPushClient, createExpoPushClient } from './expo-client';

/**
 * Fan a single notification out to every device a user has registered. A thin,
 * backward-compatible facade over the Expo push `Channel` (lib/push/channel): the
 * crons and notifyFamily callers keep this exact signature and result shape while the
 * channel is the reusable seam VIL-213 (A2) consumes for uniform channel selection.
 *
 * Gated by PUSH_SEND_ENABLED (off by default). A dead device (DeviceNotRegistered)
 * has its token pruned by the channel. A provider transport failure is re-thrown here
 * (the prior behavior these callers relied on); the channel itself returns it typed.
 * Privacy (rule #1): the token is a device address, never logged; the caller owns the
 * copy being teen-safe (never a child's raw content).
 */

/** @deprecated Prefer `ChannelMessage` from lib/push/channel — kept as the callers' name. */
export type PushMessage = ChannelMessage;

export interface PushSendDeps {
  client: ExpoPushClient;
}

export type PushSendResult =
  | { status: 'disabled' }
  | { status: 'no_tokens' }
  | { status: 'sent'; delivered: number; pruned: number };

export function defaultPushSendDeps(): PushSendDeps {
  return { client: createExpoPushClient() };
}

export async function sendPushToUser(
  userId: string,
  message: PushMessage,
  database: Database = defaultDb(),
  deps: PushSendDeps = defaultPushSendDeps(),
): Promise<PushSendResult> {
  const channel = createExpoPushChannel({ database, client: deps.client });
  const delivery = await channel.send(userId, message);
  switch (delivery.status) {
    case 'disabled':
      return { status: 'disabled' };
    case 'no_address':
      console.info('push send: no tokens for user (0 devices)');
      return { status: 'no_tokens' };
    case 'delivered':
      return { status: 'sent', delivered: delivery.delivered, pruned: delivery.pruned };
    case 'error':
      // The prior facade let a provider transport failure propagate as a throw; keep
      // that for the existing callers (the channel exposes it typed for new consumers).
      throw new Error(delivery.error.message);
  }
}
