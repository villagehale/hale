import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailBlindIndex } from '~/lib/crypto/blind-index';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { GOOGLE_PUSH_SYNC_ENABLED_ENV } from './google-push-flag';
import { type GooglePushHandleDeps, handleGooglePushNotification } from './google-push-handle';
import {
  GOOGLE_PUSH_DEBOUNCE_MS,
  claimPushDebounce,
  loadCalendarChannel,
  loadGmailIntegrations,
  loadPushWatch,
  releasePushDebounce,
  savePushWatch,
  takePushPending,
} from './google-push-store';
import { hashChannelToken, verifyPubSubPushToken } from './google-push-verify';
import {
  GMAIL_WATCH_MAX_MS,
  type GoogleJsonClient,
  ensureGooglePushWatch,
} from './google-push-watch';

const KEY = Buffer.alloc(32, 7).toString('base64');
const TOKEN = 'channel-secret';
const NOW = new Date('2026-10-01T12:00:00.000Z');
const TOPIC = 'projects/hale-test/topics/gmail-push';
const AUDIENCE = 'https://app.villagehale.com/api/webhooks/gmail';
const SERVICE_ACCOUNT = 'push@hale-test.iam.gserviceaccount.com';
const ON = { [GOOGLE_PUSH_SYNC_ENABLED_ENV]: 'true' };

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

function headers(values: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

function storeDeps(
  synced: string[],
  verify: GooglePushHandleDeps['verifyPubSubToken'],
): GooglePushHandleDeps {
  return {
    loadCalendarChannel: (channelId) => loadCalendarChannel(db.database, channelId),
    loadGmailIntegrations: (mailboxKey) => loadGmailIntegrations(db.database, mailboxKey),
    claimPushDebounce: (integrationId, now) => claimPushDebounce(db.database, integrationId, now),
    takePushPending: (integrationId, now) => takePushPending(db.database, integrationId, now),
    releasePushDebounce: (integrationId, now) =>
      releasePushDebounce(db.database, integrationId, now),
    syncIntegration: async (integrationId) => {
      synced.push(integrationId);
    },
    verifyPubSubToken: verify,
    mailboxKey: (email) => emailBlindIndex(email.toLowerCase()),
  };
}

describe('google push subscriptions', () => {
  let familyId: string;
  let parentUserId: string;
  let integrationId: string;

  beforeEach(async () => {
    const family = await seedFamily(db.database);
    familyId = family.familyId;
    parentUserId = family.parentUserId;
    integrationId = await seedIntegration(db.database, familyId, parentUserId, 'gcal');
  });

  it('verifies a stored channel token and refuses a forged one', async () => {
    await savePushWatch(db.database, integrationId, {
      provider: 'gcal',
      channelId: 'chan-1',
      resourceId: 'res-1',
      tokenHash: hashChannelToken(TOKEN),
      mailboxKey: null,
      topicName: null,
      expiration: new Date(NOW.getTime() + 86_400_000),
    });
    const synced: string[] = [];
    const deps = storeDeps(synced, async () => ({ status: 'verified' }));
    const ok = await handleGooglePushNotification({
      provider: 'gcal',
      headers: headers({
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': TOKEN,
        'x-goog-resource-id': 'res-1',
      }),
      rawBody: '',
      now: NOW,
      env: ON,
      deps,
    });
    const forged = await handleGooglePushNotification({
      provider: 'gcal',
      headers: headers({
        'x-goog-channel-id': 'chan-1',
        'x-goog-channel-token': 'forged',
        'x-goog-resource-id': 'res-1',
      }),
      rawBody: '',
      now: new Date(NOW.getTime() + GOOGLE_PUSH_DEBOUNCE_MS + 1),
      env: ON,
      deps,
    });
    expect(ok.body.status).toBe('synced');
    expect(forged.status).toBe(401);
    expect(synced).toEqual([integrationId]);
  });

  it('debounces a burst for one integration and runs again after the window', async () => {
    await savePushWatch(db.database, integrationId, {
      provider: 'gcal',
      channelId: 'chan-2',
      resourceId: 'res-2',
      tokenHash: hashChannelToken(TOKEN),
      mailboxKey: null,
      topicName: null,
      expiration: new Date(NOW.getTime() + 86_400_000),
    });
    const synced: string[] = [];
    const deps = storeDeps(synced, async () => ({ status: 'verified' }));
    const push = (now: Date) =>
      handleGooglePushNotification({
        provider: 'gcal',
        headers: headers({
          'x-goog-channel-id': 'chan-2',
          'x-goog-channel-token': TOKEN,
          'x-goog-resource-id': 'res-2',
        }),
        rawBody: '',
        now,
        env: ON,
        deps,
      });
    expect((await push(NOW)).body.status).toBe('synced');
    expect((await push(new Date(NOW.getTime() + 1000))).body.skipped).toBe('debounced');
    expect((await push(new Date(NOW.getTime() + GOOGLE_PUSH_DEBOUNCE_MS + 1))).body.status).toBe(
      'synced',
    );
    expect(synced).toEqual([integrationId, integrationId]);
  });

  it('flag off does not sync and does not move the debounce window', async () => {
    await savePushWatch(db.database, integrationId, {
      provider: 'gcal',
      channelId: 'chan-3',
      resourceId: 'res-3',
      tokenHash: hashChannelToken(TOKEN),
      mailboxKey: null,
      topicName: null,
      expiration: new Date(NOW.getTime() + 86_400_000),
    });
    const synced: string[] = [];
    const result = await handleGooglePushNotification({
      provider: 'gcal',
      headers: headers({
        'x-goog-channel-id': 'chan-3',
        'x-goog-channel-token': TOKEN,
        'x-goog-resource-id': 'res-3',
      }),
      rawBody: '',
      now: NOW,
      env: {},
      deps: storeDeps(synced, async () => ({ status: 'verified' })),
    });
    expect(result.body.skipped).toBe('flag_off');
    expect(synced).toEqual([]);
    const row = await loadPushWatch(db.database, integrationId);
    expect(row?.channelId).toBe('chan-3');
    const stored = await db.database
      .select({ debounceUntil: schema.googlePushSubscriptions.debounceUntil })
      .from(schema.googlePushSubscriptions)
      .where(eq(schema.googlePushSubscriptions.integrationId, integrationId));
    expect(stored[0]?.debounceUntil).toBeNull();
  });

  it('renews a Gmail watch before the 7-day expiry without writing historyId onto the cursor', async () => {
    const gmailId = await seedIntegration(db.database, familyId, parentUserId, 'gmail');
    const mailbox = `parent-${gmailId}@example.com`;
    await db.database
      .update(schema.integrations)
      .set({ providerMetadata: { historyId: '100' } })
      .where(eq(schema.integrations.id, gmailId));
    await savePushWatch(db.database, gmailId, {
      provider: 'gmail',
      channelId: null,
      resourceId: null,
      tokenHash: null,
      mailboxKey: emailBlindIndex(mailbox),
      topicName: TOPIC,
      expiration: new Date(NOW.getTime() + 60 * 60 * 1000),
    });
    const calls: string[] = [];
    const google: GoogleJsonClient = {
      async request({ url }) {
        calls.push(url);
        if (url.includes('/profile')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ emailAddress: mailbox, historyId: '100' }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            historyId: '99999',
            expiration: String(NOW.getTime() + GMAIL_WATCH_MAX_MS),
          }),
        };
      },
    };
    const result = await ensureGooglePushWatch({
      integrationId: gmailId,
      provider: 'gmail',
      accessToken: 'ya29',
      now: NOW,
      env: ON,
      deps: {
        loadWatch: (id) => loadPushWatch(db.database, id),
        saveWatch: (id, watch) => savePushWatch(db.database, id, watch),
        google,
        newChannelId: () => 'unused',
        newToken: () => 'unused',
        mailboxKey: (email) => emailBlindIndex(email),
        calendarAddress: 'https://app.villagehale.com/api/webhooks/gcal',
        topicName: TOPIC,
      },
    });
    expect(result.outcome).toBe('renewed');
    expect(calls.some((url) => url.endsWith('/watch'))).toBe(true);
    const [integration] = await db.database
      .select({ providerMetadata: schema.integrations.providerMetadata })
      .from(schema.integrations)
      .where(eq(schema.integrations.id, gmailId));
    expect(integration?.providerMetadata).toEqual({ historyId: '100' });
    const watch = await loadPushWatch(db.database, gmailId);
    expect(watch?.expiration?.getTime()).toBe(NOW.getTime() + GMAIL_WATCH_MAX_MS);
  });

  it('flag off renewal does not call Google and leaves the row', async () => {
    await savePushWatch(db.database, integrationId, {
      provider: 'gcal',
      channelId: 'chan-4',
      resourceId: 'res-4',
      tokenHash: hashChannelToken(TOKEN),
      mailboxKey: null,
      topicName: null,
      expiration: new Date(NOW.getTime() + 60 * 60 * 1000),
    });
    const google: GoogleJsonClient = {
      async request() {
        throw new Error('google must not be called');
      },
    };
    const result = await ensureGooglePushWatch({
      integrationId,
      provider: 'gcal',
      accessToken: 'ya29',
      now: NOW,
      env: {},
      deps: {
        loadWatch: () => {
          throw new Error('store must not be read');
        },
        saveWatch: async () => {
          throw new Error('store must not be written');
        },
        google,
        newChannelId: () => 'x',
        newToken: () => 'y',
        mailboxKey: () => 'z',
        calendarAddress: 'https://app.villagehale.com/api/webhooks/gcal',
        topicName: TOPIC,
      },
    });
    expect(result.outcome).toBe('flag_off');
    const watch = await loadPushWatch(db.database, integrationId);
    expect(watch?.channelId).toBe('chan-4');
  });

  it('a verified Gmail Pub/Sub push syncs the mailbox and ignores the notice historyId', async () => {
    const gmailId = await seedIntegration(db.database, familyId, parentUserId, 'gmail');
    const mailbox = `parent-${gmailId}@example.com`;
    await db.database
      .update(schema.integrations)
      .set({ providerMetadata: { historyId: '100' } })
      .where(eq(schema.integrations.id, gmailId));
    await savePushWatch(db.database, gmailId, {
      provider: 'gmail',
      channelId: null,
      resourceId: null,
      tokenHash: null,
      mailboxKey: emailBlindIndex(mailbox),
      topicName: TOPIC,
      expiration: new Date(NOW.getTime() + GMAIL_WATCH_MAX_MS),
    });
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'k';
    jwk.alg = 'RS256';
    const jwks = createLocalJWKSet({ keys: [jwk] });
    const token = await new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer('https://accounts.google.com')
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const data = Buffer.from(
      JSON.stringify({ emailAddress: mailbox, historyId: '99999' }),
    ).toString('base64');
    const synced: string[] = [];
    const result = await handleGooglePushNotification({
      provider: 'gmail',
      headers: headers({ authorization: `Bearer ${token}` }),
      rawBody: JSON.stringify({ message: { data } }),
      now: NOW,
      env: ON,
      deps: storeDeps(synced, (presented) =>
        verifyPubSubPushToken(presented, {
          audience: AUDIENCE,
          serviceAccount: SERVICE_ACCOUNT,
          jwks,
        }),
      ),
    });
    expect(result.body.status).toBe('synced');
    expect(synced).toEqual([gmailId]);
    const [integration] = await db.database
      .select({ providerMetadata: schema.integrations.providerMetadata })
      .from(schema.integrations)
      .where(eq(schema.integrations.id, gmailId));
    expect(integration?.providerMetadata).toEqual({ historyId: '100' });
  });
});
