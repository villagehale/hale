import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunConnectorSyncDeps, runConnectorSync } from '~/lib/cron/connector-sync';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  type GoogleDisconnectPorts,
  type GoogleRevokeResult,
  disconnectGoogle,
  endGoogleForFamilyErasure,
  retryPendingGoogleRevocations,
  settleSupersededGoogleRevoke,
} from './google-disconnect';
import {
  listActiveConnectorConnections,
  markConnectionError,
  otherParentHoldsGoogleAccount,
  saveConnection,
  saveConnectionCursor,
  saveConnectionTokensById,
} from './store';
import { type GoogleFetch, syncConnection } from './sync';
import { decryptTokens, encryptTokens } from './token-vault';

/**
 * VIL-156 · both cross-household Google decisions are keyed on the Google account the
 * callback read, and that key survives every sync.
 *
 * The key once lived in provider_metadata, which a calendar sync replaces with
 * `{ syncToken }`: after the first sync the key was gone, so an erasure revoked another
 * household's live grant on the same account, and a reconnect of that account never
 * cancelled the waiting revoke that then ended the fresh grant. Driven through the REAL
 * sweep and its REAL cursor writer; the fakes sit at Google's HTTP (calendar list and
 * revoke) and at the sweep's alert/mirror ports, which this suite does not exercise.
 */

let db: TestDb;
const NOW = new Date('2026-11-04T15:00:00.000Z');
const ACCOUNT = 'blind-index-of-one-google-account';

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.exec('truncate table families, users, rate_limits cascade');
});

function scriptedPorts(answer: () => GoogleRevokeResult) {
  const revoked: string[] = [];
  const ports: GoogleDisconnectPorts = {
    revoker: {
      async revoke(token) {
        revoked.push(token);
        return answer();
      },
    },
    google: {
      async request() {
        throw new Error('push is off in this suite');
      },
    },
    tokenFetch: async () => {
      throw new Error('push is off in this suite');
    },
    env: {},
    now: () => NOW,
  };
  return { ports, revoked };
}
const OK = (): GoogleRevokeResult => ({ outcome: 'revoked' });
const DOWN = (): GoogleRevokeResult => ({ outcome: 'unavailable', status: 503 });

/** One household, its parent, and (when asked) a second adult seated in it. */
async function household(name: string) {
  const family = await seedFamily(db.database, name);
  return { familyId: family.familyId, userId: family.parentUserId };
}

/** As the callback saves a connect whose Google identity it read. */
async function connect(familyId: string, userId: string, refreshToken: string, key?: string) {
  return saveConnection(db.database, {
    familyId,
    userId,
    provider: 'gcal',
    scopes: [],
    tokens: { accessToken: `ya29.${refreshToken}`, refreshToken },
    ...(key ? { googleAccountKey: key } : {}),
  });
}

/** A row written before the key had its own column: the key is unknown. */
async function legacyRow(familyId: string, userId: string, refreshToken: string) {
  await db.database.insert(schema.integrations).values({
    familyId,
    userId,
    provider: 'gcal',
    oauthTokensEncrypted: encryptTokens({ accessToken: `ya29.${refreshToken}`, refreshToken }),
    providerMetadata: { syncToken: 'an-old-cursor' },
    status: 'active',
  });
}

const calendar: GoogleFetch = async (url) => {
  if (!url.includes('calendar/v3/calendars/primary/events')) {
    throw new Error(`unexpected google fetch ${url}`);
  }
  return { ok: true, status: 200, json: async () => ({ items: [], nextSyncToken: 'sync-1' }) };
};

/** The production sweep over every live row, with the production cursor writer. */
async function runCalendarSync() {
  const deps: RunConnectorSyncDeps = {
    listConnections: () => listActiveConnectorConnections(db.database),
    decryptTokens,
    loadChildNames: async () => [],
    buildDeps: () => ({
      googleFetch: calendar,
      enqueue: async () => {},
      saveCursor: (id, meta) => saveConnectionCursor(db.database, id, meta),
      markError: (id, code) => markConnectionError(db.database, id, code),
      refreshTokens: async () => {
        throw new Error('no refresh in this suite');
      },
      saveTokens: (id, tokens) => saveConnectionTokensById(db.database, id, tokens),
      alertGmailEnvelopes: async (batch) =>
        batch.envelopes.map(() => ({ alert: 'dark' as const, booking: null, going: null })),
      alertCalendarChanges: async (batch) => ({
        changes: batch.changes.map(() => 'dark' as const),
        reoffers: [],
      }),
      detectTravelBookings: async (batch) => batch.envelopes.map(() => 'dark' as const),
      mirrorCalendarWindow: async () => ({
        mirrored: 0,
        updated: 0,
        removed: 0,
        alreadyKnown: 0,
        skipped: 0,
        notKid: 0,
        unjudged: 0,
        unjudgedNoJudge: 0,
        held: false,
      }),
    }),
    syncOne: (connection, deps, childNames) => syncConnection(connection, { ...deps, childNames }),
  };
  return runConnectorSync(deps);
}

async function rowOf(familyId: string) {
  const [row] = await db.database
    .select({
      status: schema.integrations.status,
      enc: schema.integrations.oauthTokensEncrypted,
      pending: schema.integrations.googleRevokePendingEncrypted,
      meta: schema.integrations.providerMetadata,
      key: schema.integrations.googleAccountKey,
    })
    .from(schema.integrations)
    .where(and(eq(schema.integrations.familyId, familyId)));
  if (!row) throw new Error('no integrations row');
  return row;
}

describe('a calendar sync keeps the Google account key', () => {
  it('erasure after a sync: the same account live in another household (another Hale user) is never revoked', async () => {
    const erased = await household('Erased');
    const other = await household('Other');
    await connect(erased.familyId, erased.userId, '1//erased', ACCOUNT);
    await connect(other.familyId, other.userId, '1//other', ACCOUNT);

    expect((await runCalendarSync()).connections).toBe(2);
    // The sync really replaced the cursor metadata, and the key is still on the row.
    expect(await rowOf(erased.familyId)).toMatchObject({
      meta: { syncToken: 'sync-1' },
      key: ACCOUNT,
    });

    const { ports, revoked } = scriptedPorts(OK);
    const settled = await endGoogleForFamilyErasure(db.database, erased.familyId, ports);

    expect(settled.map((row) => row.google)).toEqual(['grant_kept_other_household']);
    expect(revoked).toEqual([]);
    expect(await rowOf(other.familyId)).toMatchObject({
      status: 'active',
      enc: expect.any(String),
    });
  });

  it('positive control: a different account in the other household is revoked at Google', async () => {
    const erased = await household('Erased');
    const other = await household('Other');
    await connect(erased.familyId, erased.userId, '1//erased', ACCOUNT);
    await connect(other.familyId, other.userId, '1//other', 'another-google-account');
    await runCalendarSync();

    const { ports, revoked } = scriptedPorts(OK);
    const settled = await endGoogleForFamilyErasure(db.database, erased.familyId, ports);

    expect(settled.map((row) => row.google)).toEqual(['revoked']);
    expect(revoked).toEqual(['1//erased']);
  });

  it('an ENDED row of the same account in another household holds no grant: the erasure revokes', async () => {
    const erased = await household('Erased');
    const other = await household('Other');
    await connect(erased.familyId, erased.userId, '1//erased', ACCOUNT);
    await connect(other.familyId, other.userId, '1//other', ACCOUNT);
    await disconnectGoogle(
      db.database,
      { familyId: other.familyId, userId: other.userId, via: 'settings', named: 'gcal' },
      scriptedPorts(OK).ports,
    );
    expect(await rowOf(other.familyId)).toMatchObject({ enc: null, pending: null, key: ACCOUNT });

    const { ports, revoked } = scriptedPorts(OK);
    const settled = await endGoogleForFamilyErasure(db.database, erased.familyId, ports);

    expect(settled.map((row) => row.google)).toEqual(['revoked']);
    expect(revoked).toEqual(['1//erased']);
  });

  it('reconnect after a sync: the same account connected again cancels the waiting revoke, so the retry never ends the fresh grant', async () => {
    const first = await household('First');
    const second = await household('Second');
    await connect(first.familyId, first.userId, '1//first', ACCOUNT);
    await runCalendarSync();
    await disconnectGoogle(
      db.database,
      { familyId: first.familyId, userId: first.userId, via: 'settings', named: 'gcal' },
      scriptedPorts(DOWN).ports,
    );
    expect((await rowOf(first.familyId)).pending).not.toBeNull();

    // Another Hale user, the same Google account: only the key can tell.
    await connect(second.familyId, second.userId, '1//second', ACCOUNT);

    expect((await rowOf(first.familyId)).pending).toBeNull();
    const { ports, revoked } = scriptedPorts(OK);
    expect(await retryPendingGoogleRevocations(db.database, ports)).toMatchObject({
      attempted: 0,
    });
    expect(revoked).toEqual([]);
  });

  it('positive control: a different account connected after the sync leaves the revoke waiting, and the retry ends it', async () => {
    const first = await household('First');
    const second = await household('Second');
    await connect(first.familyId, first.userId, '1//first', ACCOUNT);
    await runCalendarSync();
    await disconnectGoogle(
      db.database,
      { familyId: first.familyId, userId: first.userId, via: 'settings', named: 'gcal' },
      scriptedPorts(DOWN).ports,
    );

    await connect(second.familyId, second.userId, '1//second', 'another-google-account');

    const { ports, revoked } = scriptedPorts(OK);
    expect(await retryPendingGoogleRevocations(db.database, ports)).toMatchObject({
      attempted: 1,
      revoked: 1,
    });
    expect(revoked).toEqual(['1//first']);
  });
});

describe('a row that holds live keys holds no other grant’s waiting revoke', () => {
  async function trail(familyId: string, verb: string) {
    return db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, verb)));
  }

  async function disconnectHome(
    home: { familyId: string; userId: string },
    answer: () => GoogleRevokeResult,
  ) {
    return disconnectGoogle(
      db.database,
      { familyId: home.familyId, userId: home.userId, via: 'settings', named: 'gcal' },
      scriptedPorts(answer).ports,
    );
  }

  it('another account connected on the same row: the earlier revoke is asked of Google right after the connect, never dropped', async () => {
    const home = await household('Home');
    await connect(home.familyId, home.userId, '1//account-a', 'account-a');
    await disconnectHome(home, DOWN);

    const { superseded } = await connect(home.familyId, home.userId, '1//account-b', 'account-b');

    // The row is account B's now, under B's key.
    expect(await rowOf(home.familyId)).toMatchObject({
      status: 'active',
      pending: null,
      key: 'account-b',
    });
    expect(superseded).toMatchObject({ familyId: home.familyId, provider: 'gcal' });
    if (!superseded) throw new Error('the connect took no revoke from the row');
    const { ports, revoked } = scriptedPorts(OK);
    expect(await settleSupersededGoogleRevoke(db.database, superseded, ports)).toBe('revoked');
    expect(revoked).toEqual(['1//account-a']);
    expect(await trail(home.familyId, 'integration_google_grant_revoked')).toEqual([
      { after: { provider: 'gcal', outcome: 'revoked' } },
    ]);
    expect(await trail(home.familyId, 'integration_google_grant_revoke_failed')).toEqual([]);
    // Not a cancel: account A was not connected again.
    expect(await trail(home.familyId, 'integration_google_revoke_cancelled')).toEqual([]);

    // B's own disconnect later revokes B, and only B.
    await disconnectHome(home, DOWN);
    const retry = scriptedPorts(OK);
    expect(await retryPendingGoogleRevocations(db.database, retry.ports)).toMatchObject({
      attempted: 1,
      revoked: 1,
    });
    expect(retry.revoked).toEqual(['1//account-b']);
  });

  it('Google gives no answer at that moment: the earlier revoke is named superseded, since no slot is left to ask again from', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const home = await household('Home');
    await connect(home.familyId, home.userId, '1//account-a', 'account-a');
    await disconnectHome(home, DOWN);
    const { superseded } = await connect(home.familyId, home.userId, '1//account-b', 'account-b');

    if (!superseded) throw new Error('the connect took no revoke from the row');
    const { ports, revoked } = scriptedPorts(DOWN);
    expect(await settleSupersededGoogleRevoke(db.database, superseded, ports)).toBe('superseded');
    expect(revoked).toEqual(['1//account-a']);
    expect(await trail(home.familyId, 'integration_google_grant_revoke_failed')).toEqual([
      { after: { provider: 'gcal', outcome: 'superseded', status: 503 } },
    ]);
    expect(await trail(home.familyId, 'integration_google_grant_revoked')).toEqual([]);
  });

  it('positive control: the same account connected again is a cancel, and nothing is superseded', async () => {
    const home = await household('Home');
    await connect(home.familyId, home.userId, '1//account-a', 'account-a');
    await disconnectGoogle(
      db.database,
      { familyId: home.familyId, userId: home.userId, via: 'settings', named: 'gcal' },
      scriptedPorts(DOWN).ports,
    );

    const again = await connect(home.familyId, home.userId, '1//account-a-again', 'account-a');

    expect(again.superseded).toBeNull();
    expect(await rowOf(home.familyId)).toMatchObject({ status: 'active', pending: null });
    expect(await trail(home.familyId, 'integration_google_revoke_cancelled')).toHaveLength(1);
    expect(await trail(home.familyId, 'integration_google_grant_revoke_failed')).toEqual([]);
  });
});

describe('a row whose key is unknown falls back to the Hale user, for both decisions', () => {
  it('erasure: a legacy row whose owner holds a live grant in another household ends locally only', async () => {
    const erased = await household('Erased');
    const other = await seedFamily(db.database, 'Other');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: other.familyId, userId: erased.userId, role: 'co_parent' });
    await legacyRow(erased.familyId, erased.userId, '1//legacy');
    await connect(other.familyId, erased.userId, '1//there', ACCOUNT);

    const { ports, revoked } = scriptedPorts(OK);
    const settled = await endGoogleForFamilyErasure(db.database, erased.familyId, ports);

    expect(settled.map((row) => row.google)).toEqual(['grant_kept_other_household']);
    expect(revoked).toEqual([]);
  });

  it('positive control: a legacy row whose owner holds nothing elsewhere is revoked', async () => {
    const erased = await household('Erased');
    const other = await household('Other');
    await legacyRow(erased.familyId, erased.userId, '1//legacy');
    await connect(other.familyId, other.userId, '1//there', ACCOUNT);

    const { ports, revoked } = scriptedPorts(OK);
    const settled = await endGoogleForFamilyErasure(db.database, erased.familyId, ports);

    expect(settled.map((row) => row.google)).toEqual(['revoked']);
    expect(revoked).toEqual(['1//legacy']);
  });

  it("reconnect: a connect whose account Hale could not read cancels its own user's waiting revoke, and no one else's", async () => {
    const first = await household('First');
    const stranger = await household('Stranger');
    await connect(first.familyId, first.userId, '1//first', ACCOUNT);
    await connect(stranger.familyId, stranger.userId, '1//stranger', ACCOUNT);
    for (const { familyId, userId } of [first, stranger]) {
      await disconnectGoogle(
        db.database,
        { familyId, userId, via: 'settings', named: 'gcal' },
        scriptedPorts(DOWN).ports,
      );
    }

    await connect(first.familyId, first.userId, '1//again');

    expect((await rowOf(first.familyId)).pending).toBeNull();
    // Positive control: the same account under another Hale user is not this user's to
    // cancel without a key, so that revoke still runs.
    expect((await rowOf(stranger.familyId)).pending).not.toBeNull();
  });

  it("reconnect: a legacy pending revoke is cancelled by its owner's connect, and not by another user's", async () => {
    const first = await household('First');
    const stranger = await household('Stranger');
    await legacyRow(first.familyId, first.userId, '1//legacy');
    await legacyRow(stranger.familyId, stranger.userId, '1//stranger');
    for (const { familyId, userId } of [first, stranger]) {
      await disconnectGoogle(
        db.database,
        { familyId, userId, via: 'settings', named: 'gcal' },
        scriptedPorts(DOWN).ports,
      );
    }
    const second = await seedFamily(db.database, 'Second');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: second.familyId, userId: first.userId, role: 'co_parent' });

    await connect(second.familyId, first.userId, '1//again', ACCOUNT);

    expect((await rowOf(first.familyId)).pending).toBeNull();
    // Positive control: another user's unknown-account revoke still runs.
    expect((await rowOf(stranger.familyId)).pending).not.toBeNull();
    const { ports, revoked } = scriptedPorts(OK);
    await retryPendingGoogleRevocations(db.database, ports);
    expect(revoked).toEqual(['1//stranger']);
  });
});

describe('the own-link check reads the stored account key', () => {
  async function coParentIn(familyId: string) {
    const [co] = await db.database
      .insert(schema.users)
      .values({ email: `co-${randomUUID()}@example.test`, name: 'Co Parent' })
      .returning({ id: schema.users.id });
    if (!co) throw new Error('co-parent insert returned no row');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: co.id, role: 'co_parent' });
    return co.id;
  }

  it("the co-parent's row in the same family under the same key: held", async () => {
    const home = await household('Home');
    const coParent = await coParentIn(home.familyId);
    await connect(home.familyId, coParent, '1//co', ACCOUNT);

    expect(
      await otherParentHoldsGoogleAccount(db.database, {
        familyId: home.familyId,
        userId: home.userId,
        accountKey: ACCOUNT,
      }),
    ).toBe(true);
  });

  it("controls: another family's row, and the parent's own row, are not held", async () => {
    const home = await household('Home');
    const elsewhere = await household('Elsewhere');
    await connect(elsewhere.familyId, elsewhere.userId, '1//elsewhere', ACCOUNT);
    await connect(home.familyId, home.userId, '1//own', ACCOUNT);

    expect(
      await otherParentHoldsGoogleAccount(db.database, {
        familyId: home.familyId,
        userId: home.userId,
        accountKey: ACCOUNT,
      }),
    ).toBe(false);
  });
});
