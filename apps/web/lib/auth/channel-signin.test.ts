import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  CHANNEL_SIGNIN_TTL_MS,
  consumeChannelSigninToken,
  mintChannelSigninToken,
} from './channel-signin';

/**
 * The phone-channel sign-in token — magic_link_tokens' lifecycle keyed on user_id,
 * because an SMS-onboarded parent has no email for a magic link to reach and redeeming
 * one would fork a second, empty account (the resolver-keyed-on-unwritten-field shape).
 *
 * Over REAL Postgres because everything that matters here is SQL: the atomic
 * conditional burn that makes it single-use, the expiry read, and the
 * invalidate-prior-on-mint UPDATE.
 */

const NOW = new Date('2026-08-31T15:00:00.000Z');
const SMS_IDENTITY = 'sms:feedfacefeedface';

describe('channel sign-in tokens', () => {
  let db: TestDb;
  let userId: string;
  let familyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const seeded = await seedFamily(db.database);
    userId = seeded.parentUserId;
    familyId = seeded.familyId;
    await db.database
      .update(schema.users)
      .set({ externalAuthId: SMS_IDENTITY })
      .where(eq(schema.users.id, userId));
  });

  afterEach(async () => {
    await db.close();
  });

  it('stores only the hash, with a 15-minute expiry', async () => {
    const minted = await mintChannelSigninToken(db.database, { userId, now: NOW });

    const rows = await db.database.select().from(schema.channelSigninTokens);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('no token row');
    expect(row.userId).toBe(userId);
    expect(row.tokenHash).not.toContain(minted.token);
    expect(row.tokenHash).toHaveLength(64); // sha256 hex — never the token itself
    expect(row.consumedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + CHANNEL_SIGNIN_TTL_MS);
    expect(CHANNEL_SIGNIN_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('invalidates the prior unconsumed token on a fresh mint', async () => {
    const first = await mintChannelSigninToken(db.database, { userId, now: NOW });
    await mintChannelSigninToken(db.database, {
      userId,
      now: new Date(NOW.getTime() + 1000),
    });

    const stale = await consumeChannelSigninToken(first.token, db.database, {
      now: new Date(NOW.getTime() + 2000),
    });
    expect(stale.ok).toBe(false);
  });

  it('redeems once and only once, resolving the identity the account already has', async () => {
    const minted = await mintChannelSigninToken(db.database, { userId, now: NOW });
    const later = new Date(NOW.getTime() + 60_000);

    const first = await consumeChannelSigninToken(minted.token, db.database, { now: later });
    expect(first).toEqual({ ok: true, identity: { id: SMS_IDENTITY, email: null } });

    // The replay: the conditional burn already matched nothing.
    const replay = await consumeChannelSigninToken(minted.token, db.database, { now: later });
    expect(replay.ok).toBe(false);

    const [row] = await db.database.select().from(schema.channelSigninTokens);
    expect(row?.consumedAt).not.toBeNull();
  });

  it('writes the redemption audit row (rule #6) — ids only, never the token', async () => {
    const minted = await mintChannelSigninToken(db.database, { userId, now: NOW });
    await consumeChannelSigninToken(minted.token, db.database, {
      now: new Date(NOW.getTime() + 1000),
    });

    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'connector_link_signed_in'));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.familyId).toBe(familyId);
    expect(audits[0]?.actor).toBe(userId);
    expect(JSON.stringify(audits[0])).not.toContain(minted.token);
  });

  it('refuses an expired token', async () => {
    const minted = await mintChannelSigninToken(db.database, { userId, now: NOW });
    const past = new Date(NOW.getTime() + CHANNEL_SIGNIN_TTL_MS + 1);

    expect((await consumeChannelSigninToken(minted.token, db.database, { now: past })).ok).toBe(
      false,
    );
    // Positive control for the expiry read: one millisecond inside the window works.
    const fresh = await mintChannelSigninToken(db.database, { userId, now: NOW });
    const inside = new Date(NOW.getTime() + CHANNEL_SIGNIN_TTL_MS - 1);
    expect((await consumeChannelSigninToken(fresh.token, db.database, { now: inside })).ok).toBe(
      true,
    );
  });

  it('refuses garbage and over-long probes without a table read', async () => {
    expect((await consumeChannelSigninToken('', db.database)).ok).toBe(false);
    expect((await consumeChannelSigninToken('x'.repeat(65), db.database)).ok).toBe(false);
  });

  it('refuses a token whose account has no identity to sign in as', async () => {
    await db.database
      .update(schema.users)
      .set({ externalAuthId: null })
      .where(eq(schema.users.id, userId));
    const minted = await mintChannelSigninToken(db.database, { userId, now: NOW });

    const result = await consumeChannelSigninToken(minted.token, db.database, {
      now: new Date(NOW.getTime() + 1000),
    });
    expect(result.ok).toBe(false);
  });
});
