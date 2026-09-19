import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorDisconnectHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext, HandlerVerdict } from '~/lib/channel/router/route';
import { saveConnection } from '~/lib/integrations/store';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * DISCONNECT BY TEXT, against the real DDL — the one deterministic turn in the product
 * that DELETES something.
 *
 * pglite rather than fakes, because every question worth asking here is SQL. Whose row
 * moved (the revoke predicate is a triple, and a fake answers "one row" to any of
 * them). Whether a SECOND disconnect finds anything left to do — which is not a
 * question about the handler at all but about what the UPDATE matches once the tokens
 * are gone. And whether exactly one immutable audit row exists afterwards (rule #6),
 * which is only countable against a real table.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };
let coParentUserId: string;

const NOW = new Date('2026-09-18T14:00:00.000Z');
const TOKENS = { accessToken: 'ya29.secret-access', refreshToken: '1//secret-refresh' };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  family = await seedFamily(db.database);
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `co-${randomUUID()}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!co) throw new Error('co-parent insert returned no row');
  coParentUserId = co.id;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: family.familyId, userId: coParentUserId, role: 'co_parent' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function connect(userId: string, provider: 'gcal' | 'gmail' = 'gcal'): Promise<void> {
  await saveConnection(db.database, {
    familyId: family.familyId,
    userId,
    provider,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    tokens: TOKENS,
  });
}

function turn(body: string): HandlerContext {
  return {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    conversationId: randomUUID(),
    body,
    send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' as const }),
    now: NOW,
    resolved: null,
    openQuestions: async () => [],
    inboundChannelMessageId: randomUUID(),
  };
}

function text(body: string): Promise<HandlerVerdict> {
  return connectorDisconnectHandler().handle(db.database, turn(body));
}

async function rowFor(userId: string, provider: 'gcal' | 'gmail' = 'gcal') {
  const [row] = await db.database
    .select({
      status: schema.integrations.status,
      enc: schema.integrations.oauthTokensEncrypted,
    })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, family.familyId),
        eq(schema.integrations.userId, userId),
        eq(schema.integrations.provider, provider),
      ),
    );
  return row;
}

async function revokeRows() {
  return db.database
    .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, family.familyId),
        eq(schema.auditLog.actionTaken, 'integration_revoked'),
      ),
    );
}

describe('disconnect by text, end to end', () => {
  it('purges the keys, answers with the removal URL, and leaves one audit row', async () => {
    await connect(family.parentUserId);

    const verdict = await text('disconnect my calendar');

    expect(verdict).toMatchObject({ claimed: true, outcome: 'revoked' });
    expect(verdict.claimed && verdict.reply).toContain('myaccount.google.com/permissions');
    expect(await rowFor(family.parentUserId)).toEqual({ status: 'revoked', enc: null });

    const rows = await revokeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe(family.parentUserId);
    expect(rows[0]?.after).toMatchObject({
      provider: 'gcal',
      via: 'sms',
      custody: {
        holder: 'hale',
        store: 'integrations.oauth_tokens_encrypted',
        envelope: 'aes-256-gcm',
        key: 'APP_ENCRYPTION_KEY',
        region: 'unnamed',
      },
    });
    // Rule #1: the row that describes the vault carries nothing that was in it.
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain('secret-access');
    expect(serialized).not.toContain('secret-refresh');
  });

  /**
   * THE CO-PARENT'S GRANT IS NOT THEIRS TO END. The revoke predicate is
   * (family, user, provider), and this is the assertion that keeps the middle term:
   * widen it and the co-parent's calendar dies on the other parent's text.
   */
  it('touches only the texting parent - the co-parent keeps the same provider', async () => {
    await connect(family.parentUserId);
    await connect(coParentUserId);

    await text('disconnect my google calendar');

    expect(await rowFor(family.parentUserId)).toEqual({ status: 'revoked', enc: null });
    const co = await rowFor(coParentUserId);
    expect(co?.status).toBe('active');
    expect(co?.enc).not.toBeNull();
    const rows = await revokeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe(family.parentUserId);
  });

  it('ends only the provider named - Gmail survives a calendar disconnect', async () => {
    await connect(family.parentUserId, 'gcal');
    await connect(family.parentUserId, 'gmail');

    await text('disconnect my calendar');

    expect((await rowFor(family.parentUserId, 'gmail'))?.status).toBe('active');
  });

  /**
   * SAID TWICE, DONE ONCE. The second text finds nothing of theirs holding keys, so it
   * says so — and writes NO second audit row. Rule #6's trail is a record of acts, and
   * a disconnect that disconnected nothing is not one.
   */
  it('answers the second disconnect honestly and writes no second audit row', async () => {
    await connect(family.parentUserId);
    await text('disconnect my calendar');

    const again = await text('disconnect my calendar');

    expect(again).toMatchObject({ claimed: true, outcome: 'not_connected' });
    expect(again.claimed && again.reply).toContain('nothing to disconnect');
    expect(await revokeRows()).toHaveLength(1);
  });

  it('never claims a disconnect for a parent who never connected anything', async () => {
    const verdict = await text('disconnect gmail');

    expect(verdict).toMatchObject({ claimed: true, outcome: 'not_connected' });
    expect(await revokeRows()).toHaveLength(0);
  });

  it('answers a French instruction in French', async () => {
    await connect(family.parentUserId);

    const verdict = await text('deconnectez mon agenda svp');

    expect(verdict).toMatchObject({ claimed: true, outcome: 'revoked' });
    expect(verdict.claimed && verdict.reply).toContain('Google Agenda est déconnecté');
  });

  /**
   * A KNOWN LIMIT, pinned rather than left to be discovered by a French parent.
   *
   * The reply language is read from THIS inbound (channel/language.ts) and from nothing
   * stored — `families.primary_language` has no writer, so reading it would be reading a
   * column nobody fills. That detector needs two distinct French markers before it will
   * say 'fr', and a disconnect instruction is short: "arrete de synchroniser mon
   * calendrier" is unmistakably French to a human and reads as English to the detector,
   * so the act is right and the words are the English twin. The fix belongs in
   * language.ts, where it would change every deterministic reply at once, and not in
   * this handler - a second language source for one surface is how two of them drift.
   */
  it('still ACTS on a French instruction the shared detector reads as English', async () => {
    await connect(family.parentUserId);

    const verdict = await text('arrete de synchroniser mon calendrier');

    expect(verdict).toMatchObject({ claimed: true, outcome: 'revoked' });
    expect(await rowFor(family.parentUserId)).toEqual({ status: 'revoked', enc: null });
    expect(verdict.claimed && verdict.reply).toContain('Google Calendar is disconnected');
  });

  /** A command, not an answer: it consults no open question and reads no bare word, so
   * a YES pending elsewhere in the thread can never land here. */
  it.each(['yes', 'no', 'oui', 'done', 'stop the swim reminders'])(
    'declines %j and leaves the connection alone',
    async (body) => {
      await connect(family.parentUserId);

      expect(await text(body)).toEqual({ claimed: false });
      expect((await rowFor(family.parentUserId))?.status).toBe('active');
    },
  );
});
