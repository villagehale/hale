import type { Channel as PushChannel } from '~/lib/push/channel';
import type { Channel } from '../types';

/**
 * The push leg of the channel seam (VIL-213 · A2). A thin adapter over the existing
 * Expo push channel (lib/push/channel) — it owns token lookup, per-token delivery,
 * dead-token pruning, and the PUSH_SEND_ENABLED gate; this only translates its
 * ChannelDelivery into the seam's ChannelSendOutcome so the dispatch treats every
 * leg uniformly. The underlying channel is injected (wiring builds it from the db;
 * tests pass a fake), so this file never touches Expo or the database directly.
 *
 * Privacy (rule #1): only the caller's teen-safe title/body/data cross into the push
 * channel; the Expo token is a device address that stays inside the underlying channel.
 */

export interface ExpoPushChannelAdapterDeps {
  /** The constructed Expo push channel (createExpoPushChannel) being wrapped. */
  push: PushChannel;
}

export function createExpoPushChannelAdapter(deps: ExpoPushChannelAdapterDeps): Channel {
  return {
    kind: 'push',
    async send({ userId, rendered }) {
      if (rendered.kind !== 'push') {
        throw new Error(`expo push adapter received ${rendered.kind} content`);
      }

      const delivery = await deps.push.send(userId, {
        title: rendered.title,
        body: rendered.body,
        ...(rendered.data ? { data: rendered.data } : {}),
      });

      switch (delivery.status) {
        // A multi-token send has no single provider id — the ledger records the send,
        // not a per-device receipt.
        case 'delivered':
          return { status: 'sent', providerMessageId: null };
        case 'no_address':
          return { status: 'skipped', reason: 'no_address' };
        case 'disabled':
          return { status: 'skipped', reason: 'disabled' };
        case 'error':
          return { status: 'error', transient: true, code: 'expo_push', message: delivery.error.message };
      }
    },
  };
}
