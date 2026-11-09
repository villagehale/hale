import { schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  coachEmailReader,
  productionCoachEmailReaderDeps,
} from '~/lib/channel/coach/read-email-tool';
import { createConversation } from '~/lib/coach/conversation';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { scrubEmailAlertSnippets } from './email-alert-snippet-scrub';
import { CONNECTOR_SCOPES } from './google-oauth';

/**
 * VIL-619 · the one-time scrub of sender words that alerts stored before the private flag.
 * Written and tested here; it runs against prod only with Barton's OK.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.exec('truncate table families, users cascade');
});

const SENDER_WORDS = 'Happy Thanksgiving, we can set up a visit';

async function seed() {
  const { familyId, parentUserId } = await seedFamily(db.database);
  const conversationId = await createConversation(familyId, db.database);
  const row = (source: schema.StoredMessageSource | null, deletedAt: Date | null = null) =>
    db.database
      .insert(schema.messages)
      .values({ conversationId, role: 'assistant', content: 'Hale wrote this.', source, deletedAt })
      .returning({ id: schema.messages.id })
      .then((rows) => rows[0]?.id as string);
  const ids = {
    text: await row({
      kind: 'gmail',
      eventId: 'e-1',
      gmailMessageId: 'gm-text',
      snippet: SENDER_WORDS,
    }),
    teen: await row({ kind: 'gmail', eventId: null, gmailMessageId: 'gm-teen', snippet: null }),
    removed: await row(
      { kind: 'gmail', eventId: null, gmailMessageId: 'gm-gone', snippet: SENDER_WORDS },
      new Date('2026-11-01T00:00:00.000Z'),
    ),
    current: await row({ kind: 'gmail', eventId: null, gmailMessageId: 'gm-new', private: false }),
    readReply: await row({ kind: 'read_email' }),
    plain: await row(null),
  };
  return { familyId, parentUserId, conversationId, ids };
}

async function sources(ids: string[]) {
  const rows = await db.database
    .select({ id: schema.messages.id, source: schema.messages.source })
    .from(schema.messages)
    .where(inArray(schema.messages.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.source]));
}

describe('scrubEmailAlertSnippets', () => {
  it('a dry run counts the rows and changes nothing', async () => {
    const { ids } = await seed();
    const before = await sources(Object.values(ids));

    await expect(scrubEmailAlertSnippets(db.database, { apply: false })).resolves.toEqual({
      rows: 3,
      private: 1,
      families: 1,
      applied: false,
    });
    expect(await sources(Object.values(ids))).toEqual(before);
  });

  it('removes the snippet from every alert row, keeps the private meaning, and audits counts', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId, conversationId, ids } = await seed();

    await expect(scrubEmailAlertSnippets(db.database, { apply: true })).resolves.toEqual({
      rows: 3,
      private: 1,
      families: 1,
      applied: true,
    });

    const after = await sources(Object.values(ids));
    expect(after).toEqual({
      [ids.text]: { kind: 'gmail', eventId: 'e-1', gmailMessageId: 'gm-text', private: false },
      [ids.teen]: { kind: 'gmail', eventId: null, gmailMessageId: 'gm-teen', private: true },
      [ids.removed]: { kind: 'gmail', eventId: null, gmailMessageId: 'gm-gone', private: false },
      [ids.current]: { kind: 'gmail', eventId: null, gmailMessageId: 'gm-new', private: false },
      [ids.readReply]: { kind: 'read_email' },
      [ids.plain]: null,
    });
    const everything = JSON.stringify(await db.database.select().from(schema.messages));
    expect(everything).not.toContain(SENDER_WORDS);
    expect(everything).not.toContain('snippet');

    const audits = await db.database
      .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'email_alert_snippets_scrubbed'));
    expect(audits).toEqual([{ actor: 'system', after: { rows: 3 } }]);
    expect(JSON.stringify(audits)).not.toContain(SENDER_WORDS);

    // The private meaning survives the rewrite: the 13+ child's email is still refused,
    // and the one that was readable still reads.
    const integrationId = await seedIntegration(db.database, familyId, parentUserId, 'gmail');
    await db.database
      .update(schema.integrations)
      .set({ scopes: [...CONNECTOR_SCOPES.gmail] })
      .where(eq(schema.integrations.id, integrationId));
    const reader = coachEmailReader({
      ...productionCoachEmailReaderDeps(db.database),
      accessToken: async () => 'token-1',
      fetchBody: async () => 'the email body',
    });
    const read = (gmailMessageId: string) =>
      reader.read({ familyId, parentUserId, conversationId, gmailMessageId });
    await expect(read('gm-teen')).resolves.toEqual({ read: false, reason: 'private' });
    await expect(read('gm-text')).resolves.toEqual({
      read: true,
      body: 'the email body',
      truncated: false,
    });

    await expect(scrubEmailAlertSnippets(db.database, { apply: true })).resolves.toEqual({
      rows: 0,
      private: 0,
      families: 0,
      applied: true,
    });
  });
});
