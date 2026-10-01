import { describe, expect, it } from 'vitest';
import { GOOGLE_PUSH_SYNC_ENABLED_ENV } from './google-push-flag';
import { type GooglePushHandleDeps, handleGooglePushNotification } from './google-push-handle';
import { hashChannelToken } from './google-push-verify';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const TOKEN = 'channel-secret';
const ON = { [GOOGLE_PUSH_SYNC_ENABLED_ENV]: 'true' };

function headerBag(values: Record<string, string> = {}): { get(name: string): string | null } {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

function deps(over: Partial<GooglePushHandleDeps> = {}): GooglePushHandleDeps {
  return {
    loadCalendarChannel: async () => ({
      integrationId: '11111111-1111-4111-8111-111111111111',
      channelId: 'chan-1',
      resourceId: 'res-1',
      tokenHash: hashChannelToken(TOKEN),
    }),
    loadGmailIntegrations: async () => ['22222222-2222-4222-8222-222222222222'],
    claimPushDebounce: async () => 'run',
    takePushPending: async () => false,
    releasePushDebounce: async () => undefined,
    syncIntegration: async () => undefined,
    verifyPubSubToken: async () => ({ status: 'verified' }),
    mailboxKey: (email) => `key:${email.toLowerCase()}`,
    ...over,
  };
}

describe('handleGooglePushNotification', () => {
  it('flag off syncs nothing and does not look the channel up', async () => {
    let looked = false;
    const synced: string[] = [];
    const result = await handleGooglePushNotification({
      provider: 'gcal',
      headers: headerBag({
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': TOKEN,
        'x-goog-resource-id': 'res-1',
      }),
      rawBody: '',
      now: NOW,
      env: { [GOOGLE_PUSH_SYNC_ENABLED_ENV]: 'false' },
      deps: deps({
        loadCalendarChannel: async () => {
          looked = true;
          return null;
        },
        syncIntegration: async (id) => {
          synced.push(id);
        },
      }),
    });
    expect(result).toEqual({ status: 200, body: { skipped: 'flag_off' } });
    expect(looked).toBe(false);
    expect(synced).toEqual([]);
  });

  it('a verified calendar push syncs that integration and nothing else', async () => {
    const synced: string[] = [];
    const result = await handleGooglePushNotification({
      provider: 'gcal',
      headers: headerBag({
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': TOKEN,
        'x-goog-resource-id': 'res-1',
        'x-goog-resource-state': 'exists',
      }),
      rawBody: '',
      now: NOW,
      env: ON,
      deps: deps({
        syncIntegration: async (id) => {
          synced.push(id);
        },
      }),
    });
    expect(result.body.status).toBe('synced');
    expect(synced).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('a wrong channel token is 401 and does not sync', async () => {
    const synced: string[] = [];
    const result = await handleGooglePushNotification({
      provider: 'gcal',
      headers: headerBag({
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': 'nope',
        'x-goog-resource-id': 'res-1',
      }),
      rawBody: '',
      now: NOW,
      env: ON,
      deps: deps({
        syncIntegration: async (id) => {
          synced.push(id);
        },
      }),
    });
    expect(result.status).toBe(401);
    expect(synced).toEqual([]);
  });

  it('coalesces a second push inside the debounce window', async () => {
    let claims = 0;
    const synced: string[] = [];
    const shared = deps({
      claimPushDebounce: async () => {
        claims += 1;
        return claims === 1 ? 'run' : 'coalesce';
      },
      syncIntegration: async (id) => {
        synced.push(id);
      },
    });
    const headers = headerBag({
      'x-goog-channel-id': 'chan-1',
      'x-goog-channel-token': TOKEN,
      'x-goog-resource-id': 'res-1',
    });
    const first = await handleGooglePushNotification({
      provider: 'gcal',
      headers,
      rawBody: '',
      now: NOW,
      env: ON,
      deps: shared,
    });
    const second = await handleGooglePushNotification({
      provider: 'gcal',
      headers,
      rawBody: '',
      now: NOW,
      env: ON,
      deps: shared,
    });
    expect(first.body.status).toBe('synced');
    expect(second.body.skipped).toBe('debounced');
    expect(synced).toHaveLength(1);
  });

  it('runs one trailing sync when a push arrives during the in-flight one', async () => {
    let pending = false;
    const synced: string[] = [];
    const result = await handleGooglePushNotification({
      provider: 'gcal',
      headers: headerBag({
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': TOKEN,
        'x-goog-resource-id': 'res-1',
      }),
      rawBody: '',
      now: NOW,
      env: ON,
      deps: deps({
        takePushPending: async () => {
          if (!pending) return false;
          pending = false;
          return true;
        },
        syncIntegration: async (id) => {
          synced.push(id);
          if (synced.length === 1) pending = true;
        },
      }),
    });
    expect(result.body.status).toBe('synced');
    expect(synced).toHaveLength(2);
  });

  it('decodes a Gmail notice and syncs by mailbox, without handing historyId to the sync', async () => {
    const synced: string[] = [];
    const data = Buffer.from(
      JSON.stringify({ emailAddress: 'parent@example.com', historyId: '8888' }),
    ).toString('base64');
    const result = await handleGooglePushNotification({
      provider: 'gmail',
      headers: headerBag({ authorization: 'Bearer good-token' }),
      rawBody: JSON.stringify({ message: { data } }),
      now: NOW,
      env: ON,
      deps: deps({
        syncIntegration: async (id) => {
          synced.push(id);
        },
      }),
    });
    expect(result.body.status).toBe('synced');
    expect(synced).toEqual(['22222222-2222-4222-8222-222222222222']);
  });

  it('a bad Pub/Sub token does not sync', async () => {
    const synced: string[] = [];
    const result = await handleGooglePushNotification({
      provider: 'gmail',
      headers: headerBag({ authorization: 'Bearer bad' }),
      rawBody: '{}',
      now: NOW,
      env: ON,
      deps: deps({
        verifyPubSubToken: async () => ({ status: 'invalid', reason: 'jwt_invalid' }),
        syncIntegration: async (id) => {
          synced.push(id);
        },
      }),
    });
    expect(result.status).toBe(401);
    expect(synced).toEqual([]);
  });
});
