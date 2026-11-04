import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  GOOGLE_REVOKE_RETRY_BUDGET_MS,
  type GoogleDisconnectPorts,
  type GoogleRevokeResult,
  disconnectGoogle,
  retryPendingGoogleRevocations,
} from './google-disconnect';
import type { FetchLike } from './google-oauth';
import { loadPushWatch, savePushWatch } from './google-push-store';
import type { GoogleJsonClient } from './google-push-watch';
import {
  markConnectionError,
  saveConnection,
  saveConnectionCursor,
  saveConnectionTokensById,
} from './store';
import { type OAuthTokens, decryptTokens } from './token-vault';

/**
 * VIL-156 · a disconnect really ends Hale's Google access, against the real DDL.
 *
 * Google revokes per project: one revoke ends every scope Hale holds on that account.
 * So the primitive ends every Google connector of the parent, revokes each refresh token
 * at Google, stops each push watch first, and keeps one token only until Google answers.
 * Fakes sit only at the ports: the revoke endpoint, Google's JSON API and the token
 * endpoint a push stop refreshes through.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;
let coParentUserId: string;

const NOW = new Date('2026-11-04T15:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const CAL = { accessToken: 'ya29.cal', refreshToken: '1//cal-r' };
const MAIL = { accessToken: 'ya29.mail', refreshToken: '1//mail-r' };
const CO = { accessToken: 'ya29.co', refreshToken: '1//co-r' };
const CAL_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const MAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_ID', '');
  vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_SECRET', '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client.apps.example');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-secret');
  const family = await seedFamily(db.database);
  familyId = family.familyId;
  parentUserId = family.parentUserId;
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `co-${randomUUID()}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!co) throw new Error('co-parent insert returned no row');
  coParentUserId = co.id;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: coParentUserId, role: 'co_parent' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // The retry reads every family's pending rows, so no test may leave one behind.
  await db.exec('truncate table families, users cascade');
});

type Call = { kind: 'refresh' | 'stop' | 'revoke'; detail: string };

function scriptedPorts(
  answer: (token: string) => GoogleRevokeResult,
  opts: { env?: Record<string, string>; now?: Date; log?: Call[] } = {},
): GoogleDisconnectPorts & { revoked: string[]; log: Call[] } {
  const log = opts.log ?? [];
  const revoked: string[] = [];
  const google: GoogleJsonClient = {
    async request({ url }) {
      log.push({ kind: 'stop', detail: url });
      return { ok: true, status: 204, json: async () => ({}) };
    },
  };
  const tokenFetch: FetchLike = async (url) => {
    log.push({ kind: 'refresh', detail: url });
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.fresh' }) };
  };
  return {
    revoker: {
      async revoke(token) {
        revoked.push(token);
        log.push({ kind: 'revoke', detail: token });
        return answer(token);
      },
    },
    google,
    tokenFetch,
    env: opts.env ?? {},
    now: () => opts.now ?? NOW,
    revoked,
    log,
  };
}

const OK = (): GoogleRevokeResult => ({ outcome: 'revoked' });
const DOWN = (): GoogleRevokeResult => ({ outcome: 'unavailable', status: 503 });

async function connect(
  userId: string,
  provider: 'gcal' | 'gmail',
  tokens: OAuthTokens,
): Promise<string> {
  await saveConnection(db.database, {
    familyId,
    userId,
    provider,
    scopes: provider === 'gcal' ? CAL_SCOPES : MAIL_SCOPES,
    tokens,
  });
  const row = await rowFor(userId, provider);
  if (!row) throw new Error('connection was not saved');
  return row.id;
}

async function rowFor(userId: string, provider: 'gcal' | 'gmail') {
  const [row] = await db.database
    .select({
      id: schema.integrations.id,
      status: schema.integrations.status,
      enc: schema.integrations.oauthTokensEncrypted,
      pending: schema.integrations.googleRevokePendingEncrypted,
      since: schema.integrations.googleRevokePendingSince,
      lastErrorCode: schema.integrations.lastErrorCode,
    })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        eq(schema.integrations.userId, userId),
        eq(schema.integrations.provider, provider),
      ),
    );
  return row;
}

async function audits(verb: string) {
  return db.database
    .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, verb)));
}

function disconnect(
  userId: string,
  named: 'gcal' | 'gmail',
  ports: GoogleDisconnectPorts,
  via: 'settings' | 'sms' = 'settings',
) {
  return disconnectGoogle(db.database, { familyId, userId, via, named }, ports);
}

describe('disconnectGoogle: one disconnect ends every Google connector of the parent', () => {
  it('ends gcal and gmail, revokes each refresh token at Google, and leaves the co-parent alone', async () => {
    await connect(parentUserId, 'gcal', CAL);
    await connect(parentUserId, 'gmail', MAIL);
    await connect(coParentUserId, 'gcal', CO);
    const ports = scriptedPorts(OK);

    const result = await disconnect(parentUserId, 'gcal', ports);

    expect(result).toEqual({
      status: 'disconnected',
      providers: ['gcal', 'gmail'],
      google: 'revoked',
    });
    expect(new Set(ports.revoked)).toEqual(new Set(['1//cal-r', '1//mail-r']));
    expect(ports.revoked).toHaveLength(2);
    expect(ports.revoked).toContain('1//cal-r');
    expect(ports.revoked).not.toContain('1//co-r');
    expect(ports.revoked).not.toContain('ya29.cal');
    for (const provider of ['gcal', 'gmail'] as const) {
      expect(await rowFor(parentUserId, provider)).toMatchObject({
        status: 'revoked',
        enc: null,
        pending: null,
        since: null,
      });
    }
    const co = await rowFor(coParentUserId, 'gcal');
    expect(co?.status).toBe('active');
    expect(co?.enc).not.toBeNull();

    const ended = await audits('integration_revoked');
    expect(ended).toHaveLength(2);
    for (const row of ended) {
      expect(row.actor).toBe(parentUserId);
      expect(row.after).toMatchObject({ named: 'gcal', via: 'settings' });
    }
    const settled = await audits('integration_google_grant_revoked');
    expect(settled).toHaveLength(2);
    for (const row of settled) expect(row.actor).toBe('system');

    const everything = JSON.stringify(
      await db.database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.familyId, familyId)),
    );
    expect(everything).toContain('integration_revoked');
    expect(everything).not.toContain('cal-r');
    expect(everything).not.toContain('mail-r');
  });

  it('keeps one token in pending when Google is down, then the retry finishes the revoke', async () => {
    await connect(parentUserId, 'gcal', CAL);
    await connect(parentUserId, 'gmail', MAIL);

    const result = await disconnect(parentUserId, 'gcal', scriptedPorts(DOWN));

    expect(result).toEqual({
      status: 'disconnected',
      providers: ['gcal', 'gmail'],
      google: 'pending_retry',
    });
    const cal = await rowFor(parentUserId, 'gcal');
    expect(cal?.enc).toBeNull();
    expect(cal?.pending).not.toBeNull();
    expect(cal?.pending).not.toContain('cal-r');
    expect(cal?.since).toEqual(NOW);
    // Only the refresh token is kept: revoking it ends the grant, and the access token
    // is dropped at once.
    expect(JSON.parse(decryptString(cal?.pending as string))).toEqual({
      kind: 'refresh',
      token: '1//cal-r',
    });
    expect(await audits('integration_google_grant_revoked')).toHaveLength(0);

    const retry = await retryPendingGoogleRevocations(db.database, scriptedPorts(OK));

    expect(retry).toMatchObject({ attempted: 2, revoked: 2, pending: 0 });
    expect((await rowFor(parentUserId, 'gcal'))?.pending).toBeNull();
    expect((await rowFor(parentUserId, 'gmail'))?.pending).toBeNull();
    expect(await audits('integration_google_grant_revoked')).toHaveLength(2);
  });
});

describe('each unconfirmed outcome keeps its own name', () => {
  it('invalid_token on a refresh token: the grant is already gone, counted as done', async () => {
    await connect(parentUserId, 'gcal', CAL);

    const result = await disconnect(
      parentUserId,
      'gcal',
      scriptedPorts(() => ({ outcome: 'invalid_token' })),
    );

    expect(result).toMatchObject({ google: 'revoked' });
    const [row] = await audits('integration_google_grant_revoked');
    expect(row?.after).toMatchObject({ provider: 'gcal', outcome: 'already_invalid' });
    expect(await audits('integration_google_grant_revoke_failed')).toHaveLength(0);
  });

  it('invalid_token on an access token proves nothing: access_expired, not confirmed', async () => {
    await connect(parentUserId, 'gcal', { accessToken: 'ya29.only' });
    const ports = scriptedPorts(() => ({ outcome: 'invalid_token' }));

    const result = await disconnect(parentUserId, 'gcal', ports);

    expect(ports.revoked).toEqual(['ya29.only']);
    expect(result).toMatchObject({ google: 'not_confirmed' });
    const [row] = await audits('integration_google_grant_revoke_failed');
    expect(row?.after).toMatchObject({ provider: 'gcal', outcome: 'access_expired' });
    expect(await audits('integration_google_grant_revoked')).toHaveLength(0);
  });

  it('another 4xx is refused: permanent, pending cleared, not confirmed', async () => {
    await connect(parentUserId, 'gcal', CAL);

    const result = await disconnect(
      parentUserId,
      'gcal',
      scriptedPorts(() => ({ outcome: 'refused', status: 400 })),
    );

    expect(result).toMatchObject({ google: 'not_confirmed' });
    expect((await rowFor(parentUserId, 'gcal'))?.pending).toBeNull();
    const [row] = await audits('integration_google_grant_revoke_failed');
    expect(row?.after).toMatchObject({ provider: 'gcal', outcome: 'refused', status: 400 });
  });

  it('a row with no usable token string is ended, never POSTs, and is not confirmed', async () => {
    const id = await connect(parentUserId, 'gcal', CAL);
    await db.database
      .update(schema.integrations)
      .set({ oauthTokensEncrypted: encryptString('{}') })
      .where(eq(schema.integrations.id, id));
    const ports = scriptedPorts(OK);

    const result = await disconnect(parentUserId, 'gcal', ports);

    expect(result).toEqual({
      status: 'disconnected',
      providers: ['gcal'],
      google: 'not_confirmed',
    });
    expect(ports.revoked).toEqual([]);
    expect(await rowFor(parentUserId, 'gcal')).toMatchObject({ status: 'revoked', enc: null });
    const [row] = await audits('integration_google_grant_revoke_failed');
    expect(row?.after).toMatchObject({ provider: 'gcal', outcome: 'no_token' });
  });

  it('a revoke still transient past the retention window is abandoned; a younger one waits', async () => {
    const start = NOW;
    await connect(parentUserId, 'gcal', CAL);
    await connect(coParentUserId, 'gcal', CO);
    await disconnect(parentUserId, 'gcal', scriptedPorts(DOWN, { now: start }));
    await disconnect(
      coParentUserId,
      'gcal',
      scriptedPorts(DOWN, { now: new Date(start.getTime() + 2 * DAY_MS) }),
    );

    const retry = await retryPendingGoogleRevocations(
      db.database,
      scriptedPorts(DOWN, { now: new Date(start.getTime() + 8 * DAY_MS) }),
    );

    expect(retry).toMatchObject({ attempted: 2, abandoned: 1, pending: 1 });
    expect((await rowFor(parentUserId, 'gcal'))?.pending).toBeNull();
    expect((await rowFor(coParentUserId, 'gcal'))?.pending).not.toBeNull();
    const failed = await audits('integration_google_grant_revoke_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.after).toMatchObject({ outcome: 'abandoned' });
  });
});

describe('push watches stop before the grant is revoked', () => {
  it('stops both channels while the token still works, then revokes, and drops the watch rows', async () => {
    const calId = await connect(parentUserId, 'gcal', CAL);
    const mailId = await connect(parentUserId, 'gmail', MAIL);
    const expiration = new Date(NOW.getTime() + DAY_MS);
    await savePushWatch(db.database, calId, {
      provider: 'gcal',
      channelId: 'channel-cal',
      resourceId: 'resource-cal',
      tokenHash: 'hash-cal',
      mailboxKey: null,
      topicName: null,
      expiration,
    });
    await savePushWatch(db.database, mailId, {
      provider: 'gmail',
      channelId: null,
      resourceId: null,
      tokenHash: null,
      mailboxKey: 'mailbox-key',
      topicName: 'projects/example/topics/gmail',
      expiration,
    });
    const ports = scriptedPorts(OK, { env: { GOOGLE_PUSH_SYNC_ENABLED: 'true' } });

    await disconnect(parentUserId, 'gmail', ports);

    const order = ports.log.filter((call) => call.kind !== 'refresh');
    expect(order.map((call) => call.kind)).toEqual(['stop', 'stop', 'revoke', 'revoke']);
    const stops = order.filter((call) => call.kind === 'stop').map((call) => call.detail);
    expect(stops.some((url) => url.includes('calendar/v3/channels/stop'))).toBe(true);
    expect(stops.some((url) => url.includes('gmail/v1/users/me/stop'))).toBe(true);
    expect(ports.log.filter((call) => call.kind === 'refresh')).toHaveLength(2);
    expect(await loadPushWatch(db.database, calId)).toBeNull();
    expect(await loadPushWatch(db.database, mailId)).toBeNull();
  });

  it('with the push flag off, calls no stop and still revokes both', async () => {
    await connect(parentUserId, 'gcal', CAL);
    await connect(parentUserId, 'gmail', MAIL);
    const ports = scriptedPorts(OK);

    await disconnect(parentUserId, 'gcal', ports);

    expect(ports.log.filter((call) => call.kind === 'stop')).toHaveLength(0);
    expect(ports.log.filter((call) => call.kind === 'revoke')).toHaveLength(2);
  });
});

describe('only the named connector decides whether anything ends', () => {
  it('a Calendar-only parent naming Gmail ends nothing', async () => {
    await connect(parentUserId, 'gcal', CAL);
    const ports = scriptedPorts(OK);

    expect(await disconnect(parentUserId, 'gmail', ports)).toEqual({ status: 'not_connected' });

    expect(ports.revoked).toEqual([]);
    expect(await audits('integration_revoked')).toHaveLength(0);
    const cal = await rowFor(parentUserId, 'gcal');
    expect(cal?.status).toBe('active');
    expect(cal?.enc).not.toBeNull();
  });

  it('said twice, done once', async () => {
    await connect(parentUserId, 'gcal', CAL);
    await disconnect(parentUserId, 'gcal', scriptedPorts(OK));

    expect(await disconnect(parentUserId, 'gcal', scriptedPorts(OK))).toEqual({
      status: 'not_connected',
    });
    expect(await audits('integration_revoked')).toHaveLength(1);
  });
});

describe('a running sync cannot revive an ended row', () => {
  it('the three writers leave an ended row ended, and still work on a live one', async () => {
    const ended = await connect(parentUserId, 'gcal', CAL);
    const live = await connect(coParentUserId, 'gcal', CO);
    await disconnect(parentUserId, 'gcal', scriptedPorts(OK));
    const before = await rowFor(parentUserId, 'gcal');

    await saveConnectionTokensById(db.database, ended, { accessToken: 'ya29.new' });
    expect((await rowFor(parentUserId, 'gcal'))?.enc).toBeNull();
    await saveConnectionCursor(db.database, ended, { x: 1 });
    expect((await rowFor(parentUserId, 'gcal'))?.status).toBe('revoked');
    await markConnectionError(db.database, ended, 'token_refresh_failed');
    const after = await rowFor(parentUserId, 'gcal');
    expect(after?.status).toBe('revoked');
    expect(after?.lastErrorCode).toBe(before?.lastErrorCode);

    // Positive control: the same three calls take effect on a row that holds keys.
    await saveConnectionTokensById(db.database, live, { accessToken: 'ya29.new' });
    const refreshed = await rowFor(coParentUserId, 'gcal');
    expect(decryptTokens(refreshed?.enc as string).accessToken).toBe('ya29.new');
    await markConnectionError(db.database, live, 'token_refresh_failed');
    expect((await rowFor(coParentUserId, 'gcal'))?.status).toBe('error');
    await saveConnectionCursor(db.database, live, { x: 1 });
    expect((await rowFor(coParentUserId, 'gcal'))?.status).toBe('active');
  });
});

describe('reconnecting clears a pending revoke', () => {
  it("clears every pending row of that parent, and leaves the co-parent's", async () => {
    await connect(parentUserId, 'gcal', CAL);
    await connect(parentUserId, 'gmail', MAIL);
    await connect(coParentUserId, 'gcal', CO);
    await disconnect(parentUserId, 'gcal', scriptedPorts(DOWN));
    await disconnect(coParentUserId, 'gcal', scriptedPorts(DOWN));
    expect((await rowFor(parentUserId, 'gmail'))?.pending).not.toBeNull();

    await connect(parentUserId, 'gcal', { accessToken: 'ya29.again', refreshToken: '1//again' });

    for (const provider of ['gcal', 'gmail'] as const) {
      expect(await rowFor(parentUserId, provider)).toMatchObject({ pending: null, since: null });
    }
    expect((await rowFor(coParentUserId, 'gcal'))?.pending).not.toBeNull();
    const ports = scriptedPorts(OK);
    expect(await retryPendingGoogleRevocations(db.database, ports)).toMatchObject({
      attempted: 1,
      revoked: 1,
    });
    expect(ports.revoked).toEqual(['1//co-r']);
  });
});

describe('the cron retry reaches every pending row during a long outage', () => {
  it('stops at its time budget and starts the next run with the rows it did not reach', async () => {
    const third = { accessToken: 'ya29.third', refreshToken: '1//third-r' };
    const [thirdParent] = await db.database
      .insert(schema.users)
      .values({ email: `third-${randomUUID()}@example.test`, name: 'Third Parent' })
      .returning({ id: schema.users.id });
    if (!thirdParent) throw new Error('third parent insert returned no row');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: thirdParent.id, role: 'co_parent' });
    await connect(parentUserId, 'gcal', CAL);
    await connect(coParentUserId, 'gcal', CO);
    await connect(thirdParent.id, 'gcal', third);
    await disconnect(parentUserId, 'gcal', scriptedPorts(DOWN, { now: NOW }));
    await disconnect(
      coParentUserId,
      'gcal',
      scriptedPorts(DOWN, { now: new Date(NOW.getTime() + 1000) }),
    );
    await disconnect(
      thirdParent.id,
      'gcal',
      scriptedPorts(DOWN, { now: new Date(NOW.getTime() + 2000) }),
    );

    // Google hangs: each attempt costs more than half the budget, so one run reaches two.
    let clock = NOW.getTime() + DAY_MS;
    const hanging = (): GoogleDisconnectPorts & { revoked: string[] } => {
      const ports = scriptedPorts(() => {
        clock += GOOGLE_REVOKE_RETRY_BUDGET_MS / 2 + 1;
        return { outcome: 'unavailable', status: null };
      });
      return { ...ports, now: () => new Date(clock) };
    };

    const first = hanging();
    expect(await retryPendingGoogleRevocations(db.database, first)).toMatchObject({
      attempted: 2,
      pending: 2,
    });
    expect(first.revoked).toEqual(['1//cal-r', '1//co-r']);

    const second = hanging();
    await retryPendingGoogleRevocations(db.database, second);
    expect(second.revoked[0]).toBe('1//third-r');
  });
});

describe("Google's answer and its audit row land together", () => {
  it('keeps the token pending when the audit row cannot be written, and records it on the retry', async () => {
    await connect(parentUserId, 'gcal', CAL);
    await db.exec(`
      create or replace function fail_grant_audit() returns trigger as $$
      begin raise exception 'audit write refused'; end; $$ language plpgsql;
      create trigger fail_grant_audit before insert on audit_log for each row
        when (new.action_taken = 'integration_google_grant_revoked')
        execute function fail_grant_audit();
    `);
    try {
      const result = await disconnect(parentUserId, 'gcal', scriptedPorts(OK));
      expect(result).toMatchObject({ google: 'pending_retry' });
      expect((await rowFor(parentUserId, 'gcal'))?.pending).not.toBeNull();
    } finally {
      await db.exec(
        'drop trigger fail_grant_audit on audit_log; drop function fail_grant_audit();',
      );
    }

    expect(await retryPendingGoogleRevocations(db.database, scriptedPorts(OK))).toMatchObject({
      attempted: 1,
      revoked: 1,
    });
    expect((await rowFor(parentUserId, 'gcal'))?.pending).toBeNull();
    expect(await audits('integration_google_grant_revoked')).toHaveLength(1);
  });
});
