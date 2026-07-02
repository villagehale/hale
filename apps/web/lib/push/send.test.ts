import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendPushToUser } from './send';
import type { ExpoPushClient } from './expo-client';

// sendPushToUser fans a notification out to a user's registered devices via the
// injected Expo client, gated by PUSH_SEND_ENABLED. We fake the db (token select +
// the delete of a de-registered token) and the Expo client — no real DB, no
// network. Rule #1: the token value is a device address; nothing here asserts it
// reaching a log.
const USER_ID = '22222222-2222-4222-8222-222222222222';

interface Capture {
  deleted: unknown[];
}
let capture: Capture;

/** Fake db: the token select returns `tokens`; a delete().where() is captured so
 * the DeviceNotRegistered cleanup is observable. */
function fakeDb(tokens: Array<{ id: string; expoPushToken: string }>, cap: Capture): unknown {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table !== schema.pushTokens) throw new Error('unexpected select');
        return { where: async () => tokens };
      },
    }),
    delete: (table: unknown) => ({
      where: async (predicate: unknown) => {
        if (table === schema.pushTokens) cap.deleted.push(predicate);
      },
    }),
  };
}

function fakeExpoClient(
  tickets: Array<{ status: 'ok' | 'error'; details?: { error?: string } }>,
): { client: ExpoPushClient; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => tickets);
  return { client: { send }, send };
}

const MSG = { title: 'A gentle nudge', body: 'Nadia has a check-up tomorrow' };

beforeEach(() => {
  capture = { deleted: [] };
  vi.stubEnv('PUSH_SEND_ENABLED', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sendPushToUser', () => {
  it('makes NO send when the flag is off (default posture)', async () => {
    vi.stubEnv('PUSH_SEND_ENABLED', '');
    const db = fakeDb([{ id: 't1', expoPushToken: 'ExponentPushToken[a]' }], capture);
    const { client, send } = fakeExpoClient([{ status: 'ok' }]);

    const result = await sendPushToUser(USER_ID, MSG, db as never, { client });

    expect(result).toEqual({ status: 'disabled' });
    expect(send).not.toHaveBeenCalled();
  });

  it('makes NO HTTP call when the user has no registered tokens', async () => {
    const db = fakeDb([], capture);
    const { client, send } = fakeExpoClient([]);

    const result = await sendPushToUser(USER_ID, MSG, db as never, { client });

    expect(result).toEqual({ status: 'no_tokens' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one message per token to the Expo client', async () => {
    const db = fakeDb(
      [
        { id: 't1', expoPushToken: 'ExponentPushToken[a]' },
        { id: 't2', expoPushToken: 'ExponentPushToken[b]' },
      ],
      capture,
    );
    const { client, send } = fakeExpoClient([{ status: 'ok' }, { status: 'ok' }]);

    const result = await sendPushToUser(USER_ID, MSG, db as never, { client });

    expect(result).toEqual({ status: 'sent', delivered: 2, pruned: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const messages = send.mock.calls[0]?.[0] as Array<{ to: string; title: string; body: string }>;
    expect(messages.map((m) => m.to)).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[b]']);
    expect(messages[0]).toMatchObject({ title: MSG.title, body: MSG.body });
    expect(capture.deleted).toEqual([]);
  });

  it('prunes a token whose ticket is DeviceNotRegistered', async () => {
    const db = fakeDb(
      [
        { id: 't1', expoPushToken: 'ExponentPushToken[live]' },
        { id: 't2', expoPushToken: 'ExponentPushToken[dead]' },
      ],
      capture,
    );
    const { client } = fakeExpoClient([
      { status: 'ok' },
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ]);

    const result = await sendPushToUser(USER_ID, MSG, db as never, { client });

    expect(result).toEqual({ status: 'sent', delivered: 1, pruned: 1 });
    // The dead device's row is deleted so we stop addressing it.
    expect(capture.deleted).toHaveLength(1);
  });
});
