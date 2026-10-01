import { describe, expect, it } from 'vitest';
import { GOOGLE_PUSH_SYNC_ENABLED_ENV } from './google-push-flag';
import {
  CALENDAR_WATCH_TTL_MS,
  type EnsureWatchDeps,
  GMAIL_WATCH_MAX_MS,
  GOOGLE_PUSH_RENEW_BEFORE_MS,
  type GoogleJsonClient,
  type SavedPushWatch,
  ensureGooglePushWatch,
  pushWatchDue,
} from './google-push-watch';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const TOPIC = 'projects/hale-test/topics/gmail-push';

function scripted(routes: Array<{ match: string; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const google: GoogleJsonClient = {
    async request({ url, body }) {
      calls.push({ url, body });
      const route = routes.find((candidate) => url.includes(candidate.match));
      if (!route) throw new Error(`no route for ${url}`);
      const status = route.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => route.body };
    },
  };
  return { google, calls };
}

function deps(over: Partial<EnsureWatchDeps> = {}): EnsureWatchDeps {
  return {
    loadWatch: async () => null,
    saveWatch: async () => undefined,
    google: scripted([]).google,
    newChannelId: () => 'chan-new',
    newToken: () => 'token-new',
    mailboxKey: (email) => `key:${email}`,
    calendarAddress: 'https://app.villagehale.com/api/webhooks/gcal',
    topicName: TOPIC,
    ...over,
  };
}

describe('pushWatchDue', () => {
  it('renews inside a day of expiry, including a Gmail watch at its 7-day cap', () => {
    expect(pushWatchDue(null, NOW)).toBe(true);
    const fresh = new Date(NOW.getTime() + GMAIL_WATCH_MAX_MS);
    expect(pushWatchDue(fresh, NOW)).toBe(false);
    const insideWindow = new Date(NOW.getTime() + GOOGLE_PUSH_RENEW_BEFORE_MS - 1);
    expect(pushWatchDue(insideWindow, NOW)).toBe(true);
    // Opened for 7 days, checked 6 days and an hour later: 23 hours left.
    const opened = new Date('2026-10-01T12:00:00.000Z');
    const later = new Date(opened.getTime() + 6 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
    const expires = new Date(opened.getTime() + GMAIL_WATCH_MAX_MS);
    expect(expires.getTime() - later.getTime()).toBeLessThan(GOOGLE_PUSH_RENEW_BEFORE_MS);
    expect(pushWatchDue(expires, later)).toBe(true);
  });
});

describe('ensureGooglePushWatch', () => {
  const on = { [GOOGLE_PUSH_SYNC_ENABLED_ENV]: 'true' };

  it('flag off calls neither Google nor the store', async () => {
    const { google, calls } = scripted([]);
    let loaded = false;
    const result = await ensureGooglePushWatch({
      integrationId: 'i1',
      provider: 'gmail',
      accessToken: 'ya29',
      now: NOW,
      env: {},
      deps: deps({
        google,
        loadWatch: async () => {
          loaded = true;
          return null;
        },
      }),
    });
    expect(result.outcome).toBe('flag_off');
    expect(calls).toEqual([]);
    expect(loaded).toBe(false);
  });

  it('leaves a fresh channel alone', async () => {
    const { google, calls } = scripted([]);
    const result = await ensureGooglePushWatch({
      integrationId: 'i1',
      provider: 'gcal',
      accessToken: 'ya29',
      now: NOW,
      env: on,
      deps: deps({
        google,
        loadWatch: async () => ({
          provider: 'gcal',
          expiration: new Date(NOW.getTime() + CALENDAR_WATCH_TTL_MS),
          channelId: 'chan-old',
          resourceId: 'res-old',
        }),
      }),
    });
    expect(result.outcome).toBe('not_due');
    expect(calls).toEqual([]);
  });

  it('renews an expiring calendar channel and stops the previous one', async () => {
    const { google, calls } = scripted([
      {
        match: 'events/watch',
        body: { resourceId: 'res-new', expiration: String(NOW.getTime() + CALENDAR_WATCH_TTL_MS) },
      },
      { match: 'channels/stop', body: {} },
    ]);
    const saved: SavedPushWatch[] = [];
    const result = await ensureGooglePushWatch({
      integrationId: 'i1',
      provider: 'gcal',
      accessToken: 'ya29',
      now: NOW,
      env: on,
      deps: deps({
        google,
        loadWatch: async () => ({
          provider: 'gcal',
          expiration: new Date(NOW.getTime() + 60 * 60 * 1000),
          channelId: 'chan-old',
          resourceId: 'res-old',
        }),
        saveWatch: async (_id, watch) => {
          saved.push(watch);
        },
      }),
    });
    expect(result.outcome).toBe('renewed');
    expect(saved[0]?.channelId).toBe('chan-new');
    expect(saved[0]?.resourceId).toBe('res-new');
    expect(saved[0]?.tokenHash).toBeTruthy();
    expect(calls.map((call) => call.url)).toEqual([
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch',
      'https://www.googleapis.com/calendar/v3/channels/stop',
    ]);
    expect(calls[1]?.body).toEqual({ id: 'chan-old', resourceId: 'res-old' });
    expect(calls[0]?.body).toMatchObject({
      id: 'chan-new',
      type: 'web_hook',
      address: 'https://app.villagehale.com/api/webhooks/gcal',
      token: 'token-new',
    });
  });

  it('opens a Gmail watch on the Pub/Sub topic and does not keep the response historyId', async () => {
    const { google, calls } = scripted([
      { match: '/profile', body: { emailAddress: 'Parent@Example.com', historyId: '1' } },
      {
        match: '/watch',
        body: { historyId: '99999', expiration: String(NOW.getTime() + GMAIL_WATCH_MAX_MS) },
      },
    ]);
    const saved: SavedPushWatch[] = [];
    const result = await ensureGooglePushWatch({
      integrationId: 'i1',
      provider: 'gmail',
      accessToken: 'ya29',
      now: NOW,
      env: on,
      deps: deps({
        google,
        saveWatch: async (_id, watch) => {
          saved.push(watch);
        },
      }),
    });
    expect(result.outcome).toBe('opened');
    expect(calls[1]?.body).toEqual({ topicName: TOPIC });
    expect(saved[0]).toMatchObject({
      provider: 'gmail',
      mailboxKey: 'key:parent@example.com',
      topicName: TOPIC,
    });
    expect(JSON.stringify(saved[0])).not.toContain('99999');
  });

  it('names a missing Pub/Sub topic and does not call watch', async () => {
    const { google, calls } = scripted([]);
    const result = await ensureGooglePushWatch({
      integrationId: 'i1',
      provider: 'gmail',
      accessToken: 'ya29',
      now: NOW,
      env: on,
      deps: deps({ google, topicName: null }),
    });
    expect(result.outcome).toBe('topic_not_configured');
    expect(calls).toEqual([]);
  });
});
