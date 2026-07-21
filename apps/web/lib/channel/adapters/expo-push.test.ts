import { describe, expect, it } from 'vitest';
import type { Channel as PushChannel, ChannelDelivery, ChannelMessage } from '~/lib/push/channel';
import type { RenderedContent } from '../types';
import { createExpoPushChannelAdapter } from './expo-push';

// The push leg adapter (VIL-213 · A2): translate the underlying Expo channel's
// ChannelDelivery into the seam's ChannelSendOutcome. We fake the underlying channel
// — no db, no Expo — and assert each delivery status maps to the spec'd outcome.
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PUSH: Extract<RenderedContent, { kind: 'push' }> = {
  kind: 'push',
  title: 'A gentle nudge',
  body: 'A check-up is coming up',
  data: { deepLink: 'hale://loop' },
};

/** A fake push channel returning a scripted delivery + recording the message it got. */
function fakePush(delivery: ChannelDelivery): {
  push: PushChannel;
  calls: { userId: string; message: ChannelMessage }[];
} {
  const calls: { userId: string; message: ChannelMessage }[] = [];
  return {
    calls,
    push: {
      async send(userId, message) {
        calls.push({ userId, message });
        return delivery;
      },
    },
  };
}

describe('createExpoPushChannelAdapter().send', () => {
  it('maps delivered → sent with a null provider id (multi-token send has no single id)', async () => {
    const { push, calls } = fakePush({ status: 'delivered', delivered: 2, pruned: 0 });

    const outcome = await createExpoPushChannelAdapter({ push }).send({ userId: USER_ID, rendered: PUSH });

    expect(outcome).toEqual({ status: 'sent', providerMessageId: null });
    expect(calls).toEqual([
      { userId: USER_ID, message: { title: PUSH.title, body: PUSH.body, data: PUSH.data } },
    ]);
  });

  it('maps no_address → skipped/no_address', async () => {
    const { push } = fakePush({ status: 'no_address' });

    const outcome = await createExpoPushChannelAdapter({ push }).send({ userId: USER_ID, rendered: PUSH });

    expect(outcome).toEqual({ status: 'skipped', reason: 'no_address' });
  });

  it('maps disabled → skipped/disabled', async () => {
    const { push } = fakePush({ status: 'disabled' });

    const outcome = await createExpoPushChannelAdapter({ push }).send({ userId: USER_ID, rendered: PUSH });

    expect(outcome).toEqual({ status: 'skipped', reason: 'disabled' });
  });

  it('maps a transport error → transient error with the expo_push code', async () => {
    const { push } = fakePush({ status: 'error', error: { kind: 'transport', message: 'Expo 503' } });

    const outcome = await createExpoPushChannelAdapter({ push }).send({ userId: USER_ID, rendered: PUSH });

    expect(outcome).toEqual({ status: 'error', transient: true, code: 'expo_push', message: 'Expo 503' });
  });
});
