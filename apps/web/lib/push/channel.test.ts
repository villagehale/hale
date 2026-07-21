import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExpoPushChannel } from './channel';
import type { ExpoPushClient } from './expo-client';

// The Expo push Channel is the seam VIL-213 consumes: send(userId, message) → typed
// result, never throwing for an expected outcome. We fake the db (token select + the
// dead-token delete) and the Expo client — no real DB, no network. Rule #1: the token
// value is a device address; no test asserts it reaching a log.
const USER_ID = '22222222-2222-4222-8222-222222222222';

interface Capture {
  deleted: unknown[];
}
let capture: Capture;

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

function fakeClient(send: ExpoPushClient['send']): ExpoPushClient {
  return { send };
}

const MSG = { title: 'A gentle nudge', body: 'Nadia has a check-up tomorrow' };

beforeEach(() => {
  capture = { deleted: [] };
  vi.stubEnv('PUSH_SEND_ENABLED', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createExpoPushChannel().send', () => {
  it('is disabled (no send) when the flag is off', async () => {
    vi.stubEnv('PUSH_SEND_ENABLED', '');
    const send = vi.fn(async () => []);
    const channel = createExpoPushChannel({
      database: fakeDb([{ id: 't1', expoPushToken: 'ExponentPushToken[a]' }], capture) as never,
      client: fakeClient(send),
    });

    expect(await channel.send(USER_ID, MSG)).toEqual({ status: 'disabled' });
    expect(send).not.toHaveBeenCalled();
  });

  it('reports no_address (no HTTP) when the user has no registered device', async () => {
    const send = vi.fn(async () => []);
    const channel = createExpoPushChannel({
      database: fakeDb([], capture) as never,
      client: fakeClient(send),
    });

    expect(await channel.send(USER_ID, MSG)).toEqual({ status: 'no_address' });
    expect(send).not.toHaveBeenCalled();
  });

  it('delivers one message per token and reports the count', async () => {
    const send = vi.fn(async () => [{ status: 'ok' as const }, { status: 'ok' as const }]);
    const channel = createExpoPushChannel({
      database: fakeDb(
        [
          { id: 't1', expoPushToken: 'ExponentPushToken[a]' },
          { id: 't2', expoPushToken: 'ExponentPushToken[b]' },
        ],
        capture,
      ) as never,
      client: fakeClient(send),
    });

    expect(await channel.send(USER_ID, MSG)).toEqual({
      status: 'delivered',
      delivered: 2,
      pruned: 0,
    });
    const messages = send.mock.calls[0]?.[0] as Array<{ to: string }>;
    expect(messages.map((m) => m.to)).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[b]']);
  });

  it('prunes a DeviceNotRegistered token and reports it', async () => {
    const send = vi.fn(async () => [
      { status: 'ok' as const },
      { status: 'error' as const, details: { error: 'DeviceNotRegistered' } },
    ]);
    const channel = createExpoPushChannel({
      database: fakeDb(
        [
          { id: 't1', expoPushToken: 'ExponentPushToken[live]' },
          { id: 't2', expoPushToken: 'ExponentPushToken[dead]' },
        ],
        capture,
      ) as never,
      client: fakeClient(send),
    });

    expect(await channel.send(USER_ID, MSG)).toEqual({
      status: 'delivered',
      delivered: 1,
      pruned: 1,
    });
    expect(capture.deleted).toHaveLength(1);
  });

  it('returns a typed transport error (not a throw) when the provider send fails', async () => {
    const send = vi.fn(async () => {
      throw new Error('Expo push send failed (503)');
    });
    const channel = createExpoPushChannel({
      database: fakeDb([{ id: 't1', expoPushToken: 'ExponentPushToken[a]' }], capture) as never,
      client: fakeClient(send),
    });

    const result = await channel.send(USER_ID, MSG);
    expect(result).toEqual({
      status: 'error',
      error: { kind: 'transport', message: 'Expo push send failed (503)' },
    });
    // Nothing pruned when the batch never reached the provider.
    expect(capture.deleted).toEqual([]);
  });
});
