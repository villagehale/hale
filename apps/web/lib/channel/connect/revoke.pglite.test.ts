import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorDisconnectHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext, HandlerVerdict } from '~/lib/channel/router/route';
import {
  type SaidLineInput,
  type SaidLineWriter,
  acceptSaidLine,
} from '~/lib/channel/voice/said-line';
import type {
  GoogleDisconnectPorts,
  GoogleRevokeResult,
} from '~/lib/integrations/google-disconnect';
import { saveConnection } from '~/lib/integrations/store';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { DisconnectReader, DisconnectReading } from './disconnect-read';

/**
 * DISCONNECT BY TEXT, against the real DDL — the one deterministic turn in the product
 * that DELETES something.
 *
 * pglite rather than fakes, because every question worth asking here is SQL. Whose row
 * moved (the predicate is a pair plus the named connector, and a fake answers "one row"
 * to any of them). Whether a SECOND disconnect finds anything left to do. And whether the
 * immutable audit rows exist afterwards (rule #6), which is only countable against a real
 * table. Fakes sit only at the ports: the reader, the writer and Google.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };
let coParentUserId: string;

const NOW = new Date('2026-09-18T14:00:00.000Z');
const TOKENS = { accessToken: 'ya29.secret-access', refreshToken: '1//secret-refresh' };

/** The facts the reply must carry, as the brief states them (VIL-156 §5). */
const REVOKED_FACT = "Google has removed Hale's access to their Google account";
const NOT_CONFIRMED_FACT =
  "Hale deleted its keys, but Google did not confirm that it removed Hale's access, and Hale cannot ask again; their Google account settings show whether Hale is still listed";

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
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function connect(
  userId: string,
  provider: 'gcal' | 'gmail' | 'gdrive' = 'gcal',
  scopes: string[] = ['https://www.googleapis.com/auth/calendar.readonly'],
): Promise<void> {
  await saveConnection(db.database, {
    familyId: family.familyId,
    userId,
    provider,
    scopes,
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

interface Harness {
  writes: SaidLineInput[];
  revoked: string[];
  reads: string[];
  log: { error: ReturnType<typeof vi.fn> };
  text(body: string): Promise<HandlerVerdict>;
}

function harness(
  opts: {
    reading?: DisconnectReading | null;
    google?: GoogleRevokeResult;
    writerFails?: boolean;
  } = {},
): Harness {
  const writes: SaidLineInput[] = [];
  const revoked: string[] = [];
  const reads: string[] = [];
  const log = { error: vi.fn() };
  const writer: SaidLineWriter = {
    async write(input) {
      writes.push(input);
      return opts.writerFails ? null : acceptSaidLine('ok', input);
    },
  };
  const reader: DisconnectReader = {
    async read({ text }) {
      reads.push(text);
      return opts.reading === undefined ? 'disconnect' : opts.reading;
    },
  };
  const ports: GoogleDisconnectPorts = {
    revoker: {
      async revoke(token) {
        revoked.push(token);
        return opts.google ?? { outcome: 'revoked' };
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
  const handler = connectorDisconnectHandler(log, writer, ports, reader);
  return {
    writes,
    revoked,
    reads,
    log,
    text: (body) => handler.handle(db.database, turn(body)),
  };
}

async function rowFor(userId: string, provider: 'gcal' | 'gmail' | 'gdrive' = 'gcal') {
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

async function auditRows(verb: string) {
  return db.database
    .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.familyId, family.familyId), eq(schema.auditLog.actionTaken, verb)),
    );
}

describe('disconnect by text, end to end', () => {
  it('ends the keys, revokes at Google, and asks the writer for one reply from facts', async () => {
    await connect(family.parentUserId);
    const h = harness();

    const verdict = await h.text('disconnect my calendar');

    expect(verdict).toEqual({ claimed: true, outcome: 'revoked', reply: 'ok' });
    expect(await rowFor(family.parentUserId)).toEqual({ status: 'revoked', enc: null });
    expect(h.revoked).toEqual(['1//secret-refresh']);

    expect(h.writes).toHaveLength(1);
    const input = h.writes[0] as SaidLineInput;
    expect(input.purpose).toBe('connector_revoke');
    expect(input.parentWords).toBe('disconnect my calendar');
    expect(input.mustConvey).toEqual(['bothOff', 'googleAccess']);
    expect(input.facts.googleAccess).toBe(REVOKED_FACT);
    expect(input.facts.reconnect).toBeTruthy();
    expect(input).not.toHaveProperty('links');
    const serialized = JSON.stringify(input);
    expect(serialized).toContain('bothOff');
    expect(serialized).not.toContain('myaccount.google.com');
    expect(serialized).not.toContain('/connect?t=');
    expect(serialized).not.toContain('secret-refresh');

    const rows = await auditRows('integration_revoked');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe(family.parentUserId);
    expect(rows[0]?.after).toMatchObject({
      provider: 'gcal',
      via: 'sms',
      named: 'gcal',
      custody: {
        holder: 'hale',
        store: 'integrations.oauth_tokens_encrypted',
        envelope: 'aes-256-gcm',
        key: 'APP_ENCRYPTION_KEY',
        region: 'unnamed',
      },
      pending: { store: 'integrations.google_revoke_pending_encrypted' },
    });
    // Rule #1: the row that describes the vault carries nothing that was in it.
    expect(JSON.stringify(rows)).not.toContain('secret-access');
    expect(JSON.stringify(rows)).not.toContain('secret-refresh');

    // Nothing is minted on a disconnect: the way back is to ask.
    expect(await auditRows('connector_link_minted')).toHaveLength(0);
    const signins = await db.database
      .select({ id: schema.channelSigninTokens.id })
      .from(schema.channelSigninTokens)
      .where(eq(schema.channelSigninTokens.userId, family.parentUserId));
    expect(signins).toHaveLength(0);
  });

  /**
   * THE CO-PARENT'S GRANT IS NOT THEIRS TO END. The predicate keeps the user term:
   * widen it and the co-parent's calendar dies on the other parent's text.
   */
  it('touches only the texting parent - the co-parent keeps the same provider', async () => {
    await connect(family.parentUserId);
    await connect(coParentUserId);

    await harness().text('disconnect my google calendar');

    expect(await rowFor(family.parentUserId)).toEqual({ status: 'revoked', enc: null });
    const co = await rowFor(coParentUserId);
    expect(co?.status).toBe('active');
    expect(co?.enc).not.toBeNull();
    const rows = await auditRows('integration_revoked');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe(family.parentUserId);
  });

  /**
   * Google revokes per project, not per connector: ending the calendar's grant ends the
   * Gmail one too, so Hale ends both rather than leave a Gmail row holding dead keys.
   */
  it('a calendar disconnect ends Gmail too', async () => {
    await connect(family.parentUserId, 'gcal');
    await connect(family.parentUserId, 'gmail');
    await connect(coParentUserId, 'gcal');

    await harness().text('disconnect my calendar');

    expect(await rowFor(family.parentUserId, 'gmail')).toEqual({ status: 'revoked', enc: null });
    // Positive control: the co-parent's own grant is not this parent's to end.
    const co = await rowFor(coParentUserId, 'gcal');
    expect(co?.status).toBe('active');
    expect(co?.enc).not.toBeNull();
  });

  it('still revokes an existing Drive row by text, though Drive can no longer be connected', async () => {
    await connect(family.parentUserId, 'gdrive', [
      'https://www.googleapis.com/auth/drive.readonly',
    ]);

    const verdict = await harness().text('disconnect google drive');

    expect(verdict).toMatchObject({ claimed: true, outcome: 'revoked' });
    expect(await rowFor(family.parentUserId, 'gdrive')).toEqual({ status: 'revoked', enc: null });
  });

  it('tells the parent Google did not confirm when Google refused the revoke', async () => {
    await connect(family.parentUserId);
    const h = harness({ google: { outcome: 'refused', status: 400 } });

    await h.text('disconnect my calendar');

    expect(h.writes[0]?.facts.googleAccess).toBe(NOT_CONFIRMED_FACT);
  });

  /**
   * SAID TWICE, DONE ONCE. The second text finds nothing of theirs holding keys, so it
   * says so — and writes NO second audit row.
   */
  it('answers the second disconnect honestly and writes no second audit row', async () => {
    await connect(family.parentUserId);
    await harness().text('disconnect my calendar');
    const h = harness();

    const again = await h.text('disconnect my calendar');

    expect(again).toMatchObject({ claimed: true, outcome: 'not_connected' });
    expect(h.writes[0]?.facts.outcome).toContain('nothing changed');
    expect(h.revoked).toEqual([]);
    expect(await auditRows('integration_revoked')).toHaveLength(1);
  });

  it('never claims a disconnect for a parent who never connected anything', async () => {
    const verdict = await harness().text('disconnect gmail');

    expect(verdict).toMatchObject({ claimed: true, outcome: 'not_connected' });
    expect(await auditRows('integration_revoked')).toHaveLength(0);
  });

  it("hands the writer the family's language", async () => {
    await db.database
      .update(schema.families)
      .set({ primaryLanguage: 'fr' })
      .where(eq(schema.families.id, family.familyId));
    await connect(family.parentUserId);
    const h = harness();

    await h.text('deconnectez mon agenda svp');

    expect(h.writes[0]?.language).toBe('fr');
  });
});

describe('the model reads the text before anything ends', () => {
  it('a question about disconnecting goes to the coach and ends nothing', async () => {
    await connect(family.parentUserId, 'gcal');
    await connect(family.parentUserId, 'gmail');
    const h = harness({ reading: 'question' });

    expect(await h.text('how do I disconnect my calendar?')).toEqual({ claimed: false });

    expect(h.reads).toEqual(['how do I disconnect my calendar?']);
    expect(h.revoked).toEqual([]);
    expect(h.writes).toEqual([]);
    expect((await rowFor(family.parentUserId, 'gcal'))?.status).toBe('active');
    expect((await rowFor(family.parentUserId, 'gmail'))?.status).toBe('active');
  });

  it('a failed read ends nothing and sends nothing, and says so in the log', async () => {
    await connect(family.parentUserId);
    const h = harness({ reading: null });

    expect(await h.text('disconnect my calendar')).toEqual({
      claimed: true,
      outcome: 'disconnect_unread',
      reply: null,
    });

    expect((await rowFor(family.parentUserId))?.status).toBe('active');
    expect(h.revoked).toEqual([]);
    expect(h.log.error).toHaveBeenCalled();
  });

  it('a reply the writer cannot write sends nothing, and the disconnect stands', async () => {
    await connect(family.parentUserId);
    const h = harness({ writerFails: true });

    expect(await h.text('disconnect my calendar')).toEqual({
      claimed: true,
      outcome: 'reply_unwritten',
      reply: null,
    });

    expect(await rowFor(family.parentUserId)).toEqual({ status: 'revoked', enc: null });
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ disconnect: 'revoked' }),
      expect.any(String),
    );
  });

  /** A command, not an answer: it consults no open question and reads no bare word, so
   * a YES pending elsewhere in the thread can never land here. */
  it.each(['yes', 'no', 'oui', 'done', 'stop the swim reminders'])(
    'declines %j without a read and leaves the connection alone',
    async (body) => {
      await connect(family.parentUserId);
      const h = harness();

      expect(await h.text(body)).toEqual({ claimed: false });
      expect(h.reads).toEqual([]);
      expect((await rowFor(family.parentUserId))?.status).toBe('active');
    },
  );
});
