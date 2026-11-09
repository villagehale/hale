import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_REVOKE_PENDING_RETENTION_MS,
  GOOGLE_REVOKE_URL,
  type GoogleDisconnectPorts,
  disconnectGoogle,
  endGoogleForFamilyErasure,
} from '~/lib/integrations/google-disconnect';
import { saveConnection } from '~/lib/integrations/store';
import { encryptRevokePending, encryptTokens } from '~/lib/integrations/token-vault';
import { ERASURE_GOOGLE_PAGE_ROUTE } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { erasureGoogleLogLine, runDeletionSweep } from './delete';

/**
 * VIL-156 follow-up · erasing a family revokes its Google grants at Google first.
 *
 * The FK cascade deletes `integrations` rows, keys and pending tokens with them, and
 * deleting a key revokes nothing: the erased family's grant would stay live at Google.
 * Driven through runDeletionSweep's production wiring; the only fake is the network
 * (global fetch), so the revoke goes through the real revoker.
 */

let db: TestDb;
const NOW = new Date('2026-11-04T15:00:00.000Z');
const PAST = new Date(NOW.getTime() - 60_000);
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Scheduled so long ago that the seven-day Google wait has run out. */
const PAST_GOOGLE_WAIT = new Date(NOW.getTime() - GOOGLE_REVOKE_PENDING_RETENTION_MS - MINUTE_MS);

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

let posted: string[];
let googleStatus: number;

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_ID', '');
  vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_SECRET', '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'test-client.apps.example');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'test-secret');
  posted = [];
  googleStatus = 200;
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url !== GOOGLE_REVOKE_URL) throw new Error(`unexpected fetch ${url}`);
    posted.push(new URLSearchParams(init?.body ?? '').get('token') ?? '');
    return { ok: googleStatus === 200, status: googleStatus, json: async () => ({}) };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.exec('truncate table families, users, rate_limits cascade');
});

async function household(name: string) {
  const family = await seedFamily(db.database, name);
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `co-${randomUUID()}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!co) throw new Error('co-parent insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: family.familyId, userId: co.id, role: 'co_parent' });
  return { familyId: family.familyId, parentUserId: family.parentUserId, coParentUserId: co.id };
}

async function connect(
  familyId: string,
  userId: string,
  provider: 'gcal' | 'gmail',
  refreshToken: string,
  googleAccountKey?: string,
) {
  await saveConnection(db.database, {
    familyId,
    userId,
    provider,
    scopes: [],
    tokens: { accessToken: `ya29.${refreshToken}`, refreshToken },
    ...(googleAccountKey ? { googleAccountKey } : {}),
  });
}

const googleDown: GoogleDisconnectPorts = {
  revoker: { revoke: async () => ({ outcome: 'unavailable', status: 503 }) },
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

async function failErasureEndFor(familyId: string): Promise<() => Promise<unknown>> {
  await db.exec(`
    create or replace function fail_erasure_end() returns trigger as $$
    begin
      if new.action_taken = 'integration_ended_for_erasure'
        and new.family_id = '${familyId}' then
        raise exception 'erasure end refused';
      end if;
      return new;
    end $$ language plpgsql;
    create trigger fail_erasure_end before insert on audit_log
      for each row execute function fail_erasure_end();
  `);
  return () =>
    db.exec('drop trigger fail_erasure_end on audit_log; drop function fail_erasure_end();');
}

async function scheduleAt(familyId: string, at: Date): Promise<void> {
  await db.database
    .update(schema.families)
    .set({ scheduledDeletionAt: at })
    .where(eq(schema.families.id, familyId));
}

async function familyStands(familyId: string): Promise<boolean> {
  const rows = await db.database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return rows.length === 1;
}

/** Stands in for the Slack post only; the owed claims it would page are real rows. */
function recordingPager() {
  let calls = 0;
  return {
    calls: () => calls,
    page: async () => {
      calls += 1;
      return { posted: 1, deduped: 0, failed: 0 };
    },
  };
}

async function erasureClaims() {
  return db.database
    .select({ identifier: schema.rateLimits.identifier, count: schema.rateLimits.count })
    .from(schema.rateLimits)
    .where(eq(schema.rateLimits.route, ERASURE_GOOGLE_PAGE_ROUTE));
}

describe('the erasure promise wins after a bounded wait for Google', () => {
  it('a family whose Google end throws every run is erased once past the wait, named and paged', async () => {
    const failing = await household('Failing');
    await connect(failing.familyId, failing.parentUserId, 'gcal', '1//failing-cal');
    await scheduleAt(failing.familyId, PAST_GOOGLE_WAIT);
    const drop = await failErasureEndFor(failing.familyId);
    try {
      const pager = recordingPager();
      const summary = await runDeletionSweep(db.database, NOW, async () => {}, pager.page);

      expect(await familyStands(failing.familyId)).toBe(false);
      expect(summary).toMatchObject({
        erased: 1,
        googleEndFailed: 0,
        googleRevokePending: 0,
        pastGoogleWait: { unconfirmed: 0, endFailed: 1 },
      });
      expect(summary.google).toEqual([
        { integrationId: expect.any(String), provider: 'gcal', google: 'google_end_failed' },
      ]);
      expect(pager.calls()).toBe(1);
      expect(await erasureClaims()).toEqual([
        { identifier: expect.stringMatching(/^[0-9a-f-]{36}:0:1$/), count: 0 },
      ]);
    } finally {
      await drop();
    }
  });

  it('positive control: inside the wait the same family is kept, and nobody is paged', async () => {
    const failing = await household('Failing');
    await connect(failing.familyId, failing.parentUserId, 'gcal', '1//failing-cal');
    await scheduleAt(failing.familyId, new Date(NOW.getTime() - 6 * DAY_MS));
    const drop = await failErasureEndFor(failing.familyId);
    try {
      const pager = recordingPager();
      const summary = await runDeletionSweep(db.database, NOW, async () => {}, pager.page);

      expect(await familyStands(failing.familyId)).toBe(true);
      expect(summary).toMatchObject({
        erased: 0,
        googleEndFailed: 1,
        pastGoogleWait: { unconfirmed: 0, endFailed: 0 },
      });
      expect(pager.calls()).toBe(0);
      expect(await erasureClaims()).toEqual([]);
    } finally {
      await drop();
    }
  });

  it('the google-end-failed log names the error only, never the family being erased', async () => {
    const failing = await household('Failing');
    await connect(failing.familyId, failing.parentUserId, 'gcal', '1//failing-cal');
    await scheduleAt(failing.familyId, new Date(NOW.getTime() - 6 * DAY_MS));
    const drop = await failErasureEndFor(failing.familyId);
    try {
      const errors = vi.mocked(console.error);
      await runDeletionSweep(db.database, NOW, async () => {}, recordingPager().page);

      const lines = errors.mock.calls.filter(
        ([, message]) => message === 'deletion sweep: google end failed',
      );
      // Positive control: the end did fail, and the line says what kind of error.
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[0]).toEqual({ error: expect.stringMatching(/\w+/) });
      expect(JSON.stringify(lines[0])).not.toContain(failing.familyId);
    } finally {
      await drop();
    }
  });

  it('the per-row erasure log line carries codes only, never the row', async () => {
    const erased = await household('Erased');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal', 'account-p');
    const [row] = await db.database
      .select({ id: schema.integrations.id })
      .from(schema.integrations)
      .where(eq(schema.integrations.familyId, erased.familyId));
    if (!row) throw new Error('no integrations row');
    const infos = vi.mocked(console.info);

    await endGoogleForFamilyErasure(db.database, erased.familyId);

    const lines = infos.mock.calls.filter(
      ([, message]) => message === 'google disconnect: family erasure',
    );
    // Positive control: the row was settled, and its line names how.
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[0]).toEqual({
      provider: 'gcal',
      push: expect.any(String),
      google: 'revoked',
    });
    expect(JSON.stringify(lines[0])).not.toContain(row.id);
  });

  it('a revoke Google still has not answered past the wait: erased, its token with it, named and paged', async () => {
    const erased = await household('Erased');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal');
    await scheduleAt(erased.familyId, PAST_GOOGLE_WAIT);
    googleStatus = 503;
    const pager = recordingPager();

    const summary = await runDeletionSweep(db.database, NOW, async () => {}, pager.page);

    expect(await familyStands(erased.familyId)).toBe(false);
    expect(summary).toMatchObject({
      erased: 1,
      googleRevokePending: 0,
      pastGoogleWait: { unconfirmed: 1, endFailed: 0 },
    });
    expect(summary.google).toEqual([
      expect.objectContaining({ provider: 'gcal', google: 'google_unconfirmed' }),
    ]);
    expect(pager.calls()).toBe(1);
    expect(await erasureClaims()).toEqual([
      { identifier: expect.stringMatching(/^[0-9a-f-]{36}:1:0$/), count: 0 },
    ]);
    // No pending token survives anywhere.
    const pendingLeft = await db.database
      .select({ id: schema.integrations.id })
      .from(schema.integrations)
      .where(eq(schema.integrations.familyId, erased.familyId));
    expect(pendingLeft).toEqual([]);
  });
});

describe('paging the erasure is its own leg', () => {
  it('a pager that throws is named, the sweep still returns, and the claim stays owed', async () => {
    const erased = await household('Erased');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal');
    await scheduleAt(erased.familyId, PAST_GOOGLE_WAIT);
    googleStatus = 503;

    const summary = await runDeletionSweep(
      db.database,
      NOW,
      async () => {},
      async () => {
        throw new Error('slack client exploded');
      },
    );

    expect(summary).toMatchObject({
      erased: 1,
      pastGoogleWait: { unconfirmed: 1, endFailed: 0, page: 'page_failed' },
    });
    expect(await erasureClaims()).toEqual([
      { identifier: expect.stringMatching(/^[0-9a-f-]{36}:1:0$/), count: 0 },
    ]);
  });

  it('the cron log line carries counts and outcome codes only, never an id', async () => {
    const erased = await household('Erased');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal');
    await connect(erased.familyId, erased.coParentUserId, 'gcal', '1//co-cal');
    await scheduleAt(erased.familyId, PAST_GOOGLE_WAIT);
    googleStatus = 503;
    const pager = recordingPager();

    const summary = await runDeletionSweep(db.database, NOW, async () => {}, pager.page);
    const line = erasureGoogleLogLine(summary);

    expect(line).toEqual({
      googleRevokePending: 0,
      googleEndFailed: 0,
      pastGoogleWait: { unconfirmed: 1, endFailed: 0, page: { posted: 1, deduped: 0, failed: 0 } },
      google: { google_unconfirmed: 2 },
    });
    const ids = [
      erased.familyId,
      erased.parentUserId,
      ...summary.google.map((row) => row.integrationId),
    ];
    // Positive control: the summary itself does carry the row ids the line leaves out.
    expect(summary.google).toHaveLength(2);
    for (const id of ids) expect(JSON.stringify(line)).not.toContain(id);
  });

  it('positive control: a sweep that touched no Google row has no line to log', async () => {
    const summary = await runDeletionSweep(db.database, NOW, async () => {});
    expect(erasureGoogleLogLine(summary)).toBeNull();
  });
});

describe('the erasure page is recorded with the deletion, so a later throw cannot lose it', () => {
  it('a family erased past the wait keeps its owed page when a later family purge throws', async () => {
    const erased = await household('Erased');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal');
    await scheduleAt(erased.familyId, PAST_GOOGLE_WAIT);
    const broken = await household('Broken');
    await db.database.insert(schema.chatAttachments).values({
      familyId: broken.familyId,
      storagePath: `chat/${broken.familyId}/photo.png`,
      mime: 'image/png',
      sizeBytes: 1,
      originalName: 'photo.png',
    });
    await scheduleAt(broken.familyId, PAST);
    googleStatus = 503;
    const pager = recordingPager();

    await expect(
      runDeletionSweep(
        db.database,
        NOW,
        async (path) => {
          if (path.startsWith(`chat/${broken.familyId}/`)) throw new Error('bucket down');
        },
        pager.page,
      ),
    ).rejects.toThrow('bucket down');

    expect(await familyStands(erased.familyId)).toBe(false);
    expect(await familyStands(broken.familyId)).toBe(true);
    expect(await erasureClaims()).toEqual([
      { identifier: expect.stringMatching(/^[0-9a-f-]{36}:1:0$/), count: 0 },
    ]);
  });
});

describe('the production pager records the page where the failure-page cron finds it', () => {
  it('an erasure past the wait leaves an owed counts-only claim when Slack is not configured', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', '');
    const erased = await household('Erased');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal');
    await scheduleAt(erased.familyId, PAST_GOOGLE_WAIT);
    googleStatus = 503;

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.pastGoogleWait).toEqual({
      unconfirmed: 1,
      endFailed: 0,
      page: { posted: 0, deduped: 0, failed: 1 },
    });
    const claims = await db.database
      .select({ identifier: schema.rateLimits.identifier, count: schema.rateLimits.count })
      .from(schema.rateLimits)
      .where(eq(schema.rateLimits.route, ERASURE_GOOGLE_PAGE_ROUTE));
    expect(claims).toEqual([
      { identifier: expect.stringMatching(/^[0-9a-f-]{36}:1:0$/), count: 0 },
    ]);
    expect(claims[0]?.identifier).not.toContain(erased.familyId);
  });
});

describe('erasing one household never revokes a Google account another household still uses', () => {
  /** The erased family, plus a second household its co-parent is also seated in. */
  async function twoHouseholds() {
    const erased = await household('Erased');
    const other = await seedFamily(db.database, 'Other');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: other.familyId, userId: erased.coParentUserId, role: 'co_parent' });
    return { erased, otherFamilyId: other.familyId };
  }

  async function otherRow(otherFamilyId: string) {
    const [there] = await db.database
      .select({
        status: schema.integrations.status,
        enc: schema.integrations.oauthTokensEncrypted,
      })
      .from(schema.integrations)
      .where(eq(schema.integrations.familyId, otherFamilyId));
    return there;
  }

  it('the same account live in another household: the row here ends locally only', async () => {
    const { erased, otherFamilyId } = await twoHouseholds();
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal', 'account-p');
    await connect(erased.familyId, erased.coParentUserId, 'gcal', '1//co-here', 'account-x');
    await connect(otherFamilyId, erased.coParentUserId, 'gcal', '1//co-there', 'account-x');
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    // Positive control: the parent with no other household is revoked at Google.
    expect(posted).toEqual(['1//erased-cal']);
    expect(summary.google.map((row) => row.google).sort()).toEqual([
      'grant_kept_other_household',
      'revoked',
    ]);
    expect(await otherRow(otherFamilyId)).toMatchObject({
      status: 'active',
      enc: expect.any(String),
    });
  });

  it('the same parent with a DIFFERENT account in the other household: this account is revoked at Google', async () => {
    const { erased, otherFamilyId } = await twoHouseholds();
    await connect(erased.familyId, erased.coParentUserId, 'gcal', '1//co-here', 'account-x');
    await connect(otherFamilyId, erased.coParentUserId, 'gcal', '1//co-there', 'account-y');
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted).toEqual(['1//co-here']);
    expect(summary.google.map((row) => row.google)).toEqual(['revoked']);
    expect(await otherRow(otherFamilyId)).toMatchObject({
      status: 'active',
      enc: expect.any(String),
    });
  });

  it('a row whose account Hale never read falls back to its owner: kept when they hold a grant elsewhere', async () => {
    const { erased, otherFamilyId } = await twoHouseholds();
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal');
    await connect(erased.familyId, erased.coParentUserId, 'gcal', '1//co-here');
    await connect(otherFamilyId, erased.coParentUserId, 'gcal', '1//co-there', 'account-x');
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    // Positive control: the unread row of the parent with no other household is revoked.
    expect(posted).toEqual(['1//erased-cal']);
    expect(summary.google.map((row) => row.google).sort()).toEqual([
      'grant_kept_other_household',
      'revoked',
    ]);
    expect(await otherRow(otherFamilyId)).toMatchObject({ status: 'active' });
  });

  it('an owned account that may be shared, a live row of another parent elsewhere having no key, ends locally only as ended_possibly_shared', async () => {
    const erased = await household('Erased');
    const other = await seedFamily(db.database, 'Other');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//owned-maybe', 'account-maybe');
    // A live grant whose key a sync overwrote: it may be the same Google account.
    await connect(other.familyId, other.parentUserId, 'gcal', '1//other-unkeyed');
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted).toEqual([]);
    expect(summary.google).toEqual([
      expect.objectContaining({ provider: 'gcal', google: 'ended_possibly_shared' }),
    ]);
    expect(await otherRow(other.familyId)).toMatchObject({
      status: 'active',
      enc: expect.any(String),
    });
  });

  it('control: an owned account where every live row elsewhere is keyed and different, an ENDED one unkeyed, is revoked at Google', async () => {
    const erased = await household('Erased');
    const other = await seedFamily(db.database, 'Other');
    const third = await seedFamily(db.database, 'Third');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//owned-alone', 'account-alone');
    await connect(other.familyId, other.parentUserId, 'gcal', '1//other-keyed', 'account-other');
    await db.database.insert(schema.integrations).values({
      familyId: third.familyId,
      userId: third.parentUserId,
      provider: 'gcal',
      status: 'revoked',
      oauthTokensEncrypted: null,
    });
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted).toEqual(['1//owned-alone']);
    expect(summary.google).toEqual([
      expect.objectContaining({ provider: 'gcal', google: 'revoked' }),
    ]);
  });

  it("the erased family's own trail row says only that the row ended locally; the reason stays in the return value", async () => {
    const { erased, otherFamilyId } = await twoHouseholds();
    await connect(erased.familyId, erased.coParentUserId, 'gcal', '1//co-here', 'account-x');
    await connect(otherFamilyId, erased.coParentUserId, 'gcal', '1//co-there', 'account-x');

    const settled = await endGoogleForFamilyErasure(db.database, erased.familyId);

    // Positive control: the reason is real, and it is named where #ops reads it.
    expect(settled.map((row) => row.google)).toEqual(['grant_kept_other_household']);
    const trail = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'integration_ended_for_erasure'));
    expect(trail).toHaveLength(1);
    expect(trail[0]?.after).toMatchObject({
      provider: 'gcal',
      pending: null,
      google: 'ended_locally',
    });
    expect(JSON.stringify(trail)).not.toContain('household');
  });
});

describe('a live Google row with no owner', () => {
  async function ownerlessRow(familyId: string, refreshToken: string, googleAccountKey?: string) {
    await db.database.insert(schema.integrations).values({
      familyId,
      userId: null,
      provider: 'gcal',
      status: 'active',
      oauthTokensEncrypted: encryptTokens({ accessToken: `ya29.${refreshToken}`, refreshToken }),
      ...(googleAccountKey ? { googleAccountKey } : {}),
    });
  }

  it('whose Google account is known and used nowhere else is revoked at Google', async () => {
    const erased = await household('Erased');
    await ownerlessRow(erased.familyId, '1//unowned-known', 'account-known');
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted).toEqual(['1//unowned-known']);
    expect(summary.google).toEqual([
      expect.objectContaining({ provider: 'gcal', google: 'revoked' }),
    ]);
  });

  it('whose Google account is live in another household ends locally only', async () => {
    const erased = await household('Erased');
    const other = await seedFamily(db.database, 'Other');
    await ownerlessRow(erased.familyId, '1//unowned-shared', 'account-shared');
    await connect(other.familyId, other.parentUserId, 'gcal', '1//other', 'account-shared');
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted).toEqual([]);
    expect(summary.google).toEqual([
      expect.objectContaining({ provider: 'gcal', google: 'grant_kept_other_household' }),
    ]);
    const [there] = await db.database
      .select({ status: schema.integrations.status, enc: schema.integrations.oauthTokensEncrypted })
      .from(schema.integrations)
      .where(eq(schema.integrations.familyId, other.familyId));
    expect(there).toMatchObject({ status: 'active', enc: expect.any(String) });
  });

  it('whose account may be shared, a live row elsewhere having no key, ends locally only as ended_possibly_shared', async () => {
    const erased = await household('Erased');
    const other = await seedFamily(db.database, 'Other');
    await ownerlessRow(erased.familyId, '1//unowned-maybe', 'account-maybe');
    // A live grant whose key a sync overwrote: it may be the same Google account.
    await connect(other.familyId, other.parentUserId, 'gcal', '1//other-unkeyed');
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted).toEqual([]);
    expect(summary.google).toEqual([
      expect.objectContaining({ provider: 'gcal', google: 'ended_possibly_shared' }),
    ]);
    const [there] = await db.database
      .select({ status: schema.integrations.status, enc: schema.integrations.oauthTokensEncrypted })
      .from(schema.integrations)
      .where(eq(schema.integrations.familyId, other.familyId));
    expect(there).toMatchObject({ status: 'active', enc: expect.any(String) });
  });

  it('control: every live row elsewhere keyed and different, an ENDED one unkeyed, is revoked at Google', async () => {
    const erased = await household('Erased');
    const other = await seedFamily(db.database, 'Other');
    const third = await seedFamily(db.database, 'Third');
    await ownerlessRow(erased.familyId, '1//unowned-alone', 'account-alone');
    await connect(other.familyId, other.parentUserId, 'gcal', '1//other-keyed', 'account-other');
    await db.database.insert(schema.integrations).values({
      familyId: third.familyId,
      userId: third.parentUserId,
      provider: 'gcal',
      status: 'revoked',
      oauthTokensEncrypted: null,
    });
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted).toEqual(['1//unowned-alone']);
    expect(summary.google).toEqual([
      expect.objectContaining({ provider: 'gcal', google: 'revoked' }),
    ]);
  });

  it('with no account key either is ended locally and named, never skipped', async () => {
    const erased = await household('Erased');
    await db.database.insert(schema.integrations).values({
      familyId: erased.familyId,
      userId: null,
      provider: 'gcal',
      status: 'active',
      oauthTokensEncrypted: encryptTokens({
        accessToken: 'ya29.unowned',
        refreshToken: '1//unowned',
      }),
    });
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(summary.google).toEqual([
      expect.objectContaining({ provider: 'gcal', google: 'ended_without_owner' }),
    ]);
    expect(posted).toEqual([]);
  });
});

describe('an ended Google row with no owner whose revoke still waits', () => {
  async function ownerlessPendingRow(familyId: string, token: string, googleAccountKey?: string) {
    await db.database.insert(schema.integrations).values({
      familyId,
      userId: null,
      provider: 'gcal',
      status: 'revoked',
      oauthTokensEncrypted: null,
      googleRevokePendingEncrypted: encryptRevokePending({ kind: 'refresh', token }),
      googleRevokePendingSince: PAST,
      ...(googleAccountKey ? { googleAccountKey } : {}),
    });
  }

  it('whose Google account is known and used nowhere else: the waiting token is revoked at Google', async () => {
    const erased = await household('Erased');
    await ownerlessPendingRow(erased.familyId, '1//unowned-pending', 'account-pending');
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted).toEqual(['1//unowned-pending']);
    expect(summary.google).toEqual([
      expect.objectContaining({ provider: 'gcal', google: 'revoked' }),
    ]);
  });

  it('control: with no account key either, it ends locally as ended_without_owner and nothing is posted', async () => {
    const erased = await household('Erased');
    await ownerlessPendingRow(erased.familyId, '1//unowned-pending-unkeyed');
    await scheduleAt(erased.familyId, PAST);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted).toEqual([]);
    expect(summary.google).toEqual([
      expect.objectContaining({ provider: 'gcal', google: 'ended_without_owner' }),
    ]);
  });
});

describe('runDeletionSweep revokes an erased family at Google before the cascade', () => {
  it('revokes every live grant and every pending one, then erases the family', async () => {
    const erased = await household('Erased');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal');
    await connect(erased.familyId, erased.parentUserId, 'gmail', '1//erased-mail');
    await connect(erased.familyId, erased.coParentUserId, 'gcal', '1//erased-co');
    // An earlier disconnect Google never answered: only the pending column holds it.
    await disconnectGoogle(
      db.database,
      { familyId: erased.familyId, userId: erased.coParentUserId, via: 'settings', named: 'gcal' },
      googleDown,
    );
    const kept = await household('Kept');
    await connect(kept.familyId, kept.parentUserId, 'gcal', '1//kept-cal');
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: PAST })
      .where(eq(schema.families.id, erased.familyId));

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(posted.sort()).toEqual(['1//erased-cal', '1//erased-co', '1//erased-mail']);
    // Each row's outcome is in the return, not only the counts.
    expect(summary.google.map((row) => [row.provider, row.google]).sort()).toEqual([
      ['gcal', 'revoked'],
      ['gcal', 'revoked'],
      ['gmail', 'revoked'],
    ]);
    expect(
      await db.database
        .select({ id: schema.families.id })
        .from(schema.families)
        .where(eq(schema.families.id, erased.familyId)),
    ).toEqual([]);
    // Positive control: the household not due keeps its live connection.
    const [live] = await db.database
      .select({
        status: schema.integrations.status,
        enc: schema.integrations.oauthTokensEncrypted,
      })
      .from(schema.integrations)
      .where(eq(schema.integrations.familyId, kept.familyId));
    expect(live?.status).toBe('active');
    expect(live?.enc).not.toBeNull();
  });

  it('waits for Google: a transient answer keeps the family until the revoke lands, and says so', async () => {
    const erased = await household('Erased');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal');
    await connect(erased.familyId, erased.parentUserId, 'gmail', '1//erased-mail');
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: PAST })
      .where(eq(schema.families.id, erased.familyId));
    googleStatus = 503;

    const waiting = await runDeletionSweep(db.database, NOW, async () => {});

    expect(waiting).toMatchObject({ erased: 0, googleRevokePending: 1 });
    const family = () =>
      db.database
        .select({ id: schema.families.id })
        .from(schema.families)
        .where(eq(schema.families.id, erased.familyId));
    expect(await family()).toHaveLength(1);
    // The family that stays has a trail of what ended, written by Hale (rule #6).
    const ended = await db.database
      .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'integration_ended_for_erasure'));
    expect(ended.map((row) => row.actor)).toEqual(['system', 'system']);
    expect(ended.map((row) => (row.after as { provider: string }).provider).sort()).toEqual([
      'gcal',
      'gmail',
    ]);

    googleStatus = 200;
    posted = [];
    const done = await runDeletionSweep(db.database, NOW, async () => {});

    expect(done).toMatchObject({ erased: 1, googleRevokePending: 0 });
    expect(posted.sort()).toEqual(['1//erased-cal', '1//erased-mail']);
    expect(await family()).toEqual([]);
  });

  it("one family's failed Google end keeps that family, named, and never holds the others", async () => {
    const failing = await household('Failing');
    await connect(failing.familyId, failing.parentUserId, 'gcal', '1//failing-cal');
    const erased = await household('Erased');
    await connect(erased.familyId, erased.parentUserId, 'gcal', '1//erased-cal');
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: PAST })
      .where(inArray(schema.families.id, [failing.familyId, erased.familyId]));
    // The local end's trail row cannot be written for one family only: its transaction
    // rolls back and the end throws, as a driver or constraint failure would.
    await db.exec(`
      create or replace function fail_erasure_end() returns trigger as $$
      begin
        if new.action_taken = 'integration_ended_for_erasure'
          and new.family_id = '${failing.familyId}' then
          raise exception 'erasure end refused';
        end if;
        return new;
      end $$ language plpgsql;
      create trigger fail_erasure_end before insert on audit_log
        for each row execute function fail_erasure_end();
    `);
    try {
      const summary = await runDeletionSweep(db.database, NOW, async () => {});

      expect(summary).toMatchObject({ erased: 1, googleRevokePending: 0, googleEndFailed: 1 });
      expect(posted).toEqual(['1//erased-cal']);
      const standing = await db.database
        .select({ id: schema.families.id })
        .from(schema.families)
        .where(inArray(schema.families.id, [failing.familyId, erased.familyId]));
      expect(standing).toEqual([{ id: failing.familyId }]);
      // The failing family's grant is untouched, live for the next sweep to end.
      const [row] = await db.database
        .select({ enc: schema.integrations.oauthTokensEncrypted })
        .from(schema.integrations)
        .where(eq(schema.integrations.familyId, failing.familyId));
      expect(row?.enc).not.toBeNull();
    } finally {
      await db.exec(
        'drop trigger fail_erasure_end on audit_log; drop function fail_erasure_end();',
      );
    }
  });

  it('positive control: a sweep with no family due posts nothing to Google', async () => {
    const kept = await household('Kept');
    await connect(kept.familyId, kept.parentUserId, 'gcal', '1//kept-cal');

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(0);
    expect(posted).toEqual([]);
  });
});
