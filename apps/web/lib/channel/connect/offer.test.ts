import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorLinkHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext } from '~/lib/channel/router/route';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { offerConnectorLink } from './offer';

/**
 * The connector handoff's mint — a verified parent's "connect my calendar" becomes a
 * single-use sign-in link, an audit row, and one locked reply. Over REAL Postgres so
 * the enrollment gate, the token write and the audit write are the deployed SQL.
 *
 * Rule #11: every way this can decline to hand over a link is a NAMED outcome —
 * `not_enrolled`, `mint_failed` — never a silent fall-through.
 */

const NOW = new Date('2026-08-31T15:00:00.000Z');
const PHONE = '+14165550188';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

describe('offerConnectorLink', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  beforeEach(async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    db = await createTestDb();
    const seeded = await seedFamily(db.database);
    familyId = seeded.familyId;
    parentUserId = seeded.parentUserId;
    await db.database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  it('mints a link for a verified parent, with the audit row beside it (rule #6)', async () => {
    const outcome = await offerConnectorLink(db.database, {
      familyId,
      parentUserId,
      provider: 'gcal',
      now: NOW,
    });

    if (outcome.status !== 'minted') throw new Error(`expected minted, got ${outcome.status}`);
    expect(outcome.url).toMatch(/^https:\/\/app\.villagehale\.com\/connect\?t=[A-Za-z0-9_-]+$/);

    const tokens = await db.database.select().from(schema.channelSigninTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.userId).toBe(parentUserId);
    // The URL carries the raw token; the row holds only its digest.
    expect(outcome.url).not.toContain(tokens[0]?.tokenHash);

    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'connector_link_minted'));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.familyId).toBe(familyId);
    expect(audits[0]?.actor).toBe(parentUserId);
    expect(audits[0]?.after).toEqual({ provider: 'gcal' });
    // Never the token, never the number (rule #1).
    expect(JSON.stringify(audits[0])).not.toContain(PHONE);
  });

  it('names not_enrolled when the channel is gone, and mints nothing', async () => {
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: NOW })
      .where(eq(schema.parentChannels.userId, parentUserId));

    const outcome = await offerConnectorLink(db.database, {
      familyId,
      parentUserId,
      provider: 'gcal',
      now: NOW,
    });
    expect(outcome).toEqual({ status: 'not_enrolled' });
    expect(await db.database.select().from(schema.channelSigninTokens)).toHaveLength(0);
    expect(await db.database.select().from(schema.auditLog)).toHaveLength(0);
  });

  it('names not_enrolled for a non-parent role', async () => {
    await db.database
      .update(schema.familyMembers)
      .set({ role: 'extended' })
      .where(eq(schema.familyMembers.userId, parentUserId));

    const outcome = await offerConnectorLink(db.database, {
      familyId,
      parentUserId,
      provider: 'gmail',
      now: NOW,
    });
    expect(outcome).toEqual({ status: 'not_enrolled' });
  });

  it('names mint_failed when the write cannot land', async () => {
    await db.exec('DROP TABLE channel_signin_tokens');

    const outcome = await offerConnectorLink(db.database, {
      familyId,
      parentUserId,
      provider: 'gcal',
      now: NOW,
    });
    expect(outcome.status).toBe('mint_failed');
  });
});

describe('connectorLinkHandler', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  beforeEach(async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    db = await createTestDb();
    const seeded = await seedFamily(db.database);
    familyId = seeded.familyId;
    parentUserId = seeded.parentUserId;
    await db.database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  function turn(body: string): HandlerContext {
    return {
      familyId,
      parentUserId,
      conversationId: 'conv-1',
      body,
      phoneE164: PHONE,
      now: NOW,
      resolved: null,
      openQuestions: async () => [],
    };
  }

  it('claims the founder\'s exact ask and replies with the link', async () => {
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn('I want you to connect my Google Calendar'),
    );

    if (!verdict.claimed) throw new Error('expected the handler to claim');
    expect(verdict.outcome).toBe('sent');
    expect(verdict.reply).toContain('https://app.villagehale.com/connect?t=');
    expect(verdict.reply).toContain('Google Calendar');
    expect(verdict.reply).toContain('Good for 15 minutes.');
  });

  it('answers a French ask with the French twin', async () => {
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn('Connecte mon Google Agenda svp'),
    );
    if (!verdict.claimed) throw new Error('expected the handler to claim');
    expect(verdict.reply).toContain('Google Agenda');
    expect(verdict.reply).toContain('Bon pour 15 minutes.');
  });

  it('does NOT mint for a question about the calendar\'s contents', async () => {
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn("what's on my calendar this week"),
    );
    expect(verdict.claimed).toBe(false);
    // The must-not-mint half: no token, no audit row, nothing to leak.
    expect(await db.database.select().from(schema.channelSigninTokens)).toHaveLength(0);
    expect(await db.database.select().from(schema.auditLog)).toHaveLength(0);
  });

  it('answers a mint failure honestly rather than deferring the turn (mint_failed named)', async () => {
    await db.exec('DROP TABLE channel_signin_tokens');
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn('connect my google calendar'),
    );
    if (!verdict.claimed) throw new Error('expected the handler to claim');
    expect(verdict.outcome).toBe('mint_failed');
    expect(verdict.reply).toContain('nothing was changed');
  });
});
