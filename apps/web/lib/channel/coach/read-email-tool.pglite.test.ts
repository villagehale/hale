import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import {
  type CoachEmailReaderDeps,
  READ_EMAIL_MAX_CHARS,
  coachEmailReader,
  productionCoachEmailReaderDeps,
} from './read-email-tool';

const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const BODY = 'We can set up a visit. Our director will reach out to arrange a time.';

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

async function seedCoParent(familyId: string): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${familyId}:co`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({ familyId, userId, role: 'co_parent' });
  return userId;
}

async function connectGmail(familyId: string, userId: string): Promise<string> {
  const id = await seedIntegration(db.database, familyId, userId, 'gmail');
  await db.exec(`update integrations set scopes = array['${READ_SCOPE}'] where id = '${id}'`);
  return id;
}

async function alert(
  familyId: string,
  parentUserId: string,
  gmailMessageId: string,
  snippet: string | null,
): Promise<string> {
  return threadProactiveMessage(db.database, {
    familyId,
    parentUserId,
    body: 'Hale wrote this alert.',
    source: { kind: 'gmail', eventId: null, gmailMessageId, snippet },
  });
}

function reader(fetchBody: CoachEmailReaderDeps['fetchBody']) {
  const fetched: string[] = [];
  const deps: CoachEmailReaderDeps = {
    ...productionCoachEmailReaderDeps(db.database),
    // The token vault and Google are the boundary; the rows and the SQL are real.
    accessToken: async () => 'token-1',
    fetchBody: async (id, token) => {
      fetched.push(`${id}:${token}`);
      return fetchBody(id, token);
    },
  };
  return { reader: coachEmailReader(deps), fetched };
}

describe('read_email · production reader', () => {
  it('reads the body of an email an alert in this conversation named', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId } = await seedFamily(db.database);
    await connectGmail(familyId, parentUserId);
    const conversationId = await alert(familyId, parentUserId, 'gm-1', 'Happy Thanksgiving');
    const { reader: r, fetched } = reader(async () => BODY);

    await expect(r.connected(familyId, parentUserId)).resolves.toBe(true);
    await expect(
      r.read({ familyId, parentUserId, conversationId, gmailMessageId: 'gm-1' }),
    ).resolves.toEqual({ read: true, body: BODY, truncated: false });
    expect(fetched).toEqual(['gm-1:token-1']);
  });

  it('refuses an id this conversation never carried, even one alerted to the other parent', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId } = await seedFamily(db.database);
    const coParent = await seedCoParent(familyId);
    await connectGmail(familyId, parentUserId);
    const mine = await alert(familyId, parentUserId, 'gm-mine', 'snippet');
    await alert(familyId, coParent, 'gm-theirs', 'snippet');
    const { reader: r, fetched } = reader(async () => BODY);

    await expect(
      r.read({ familyId, parentUserId, conversationId: mine, gmailMessageId: 'gm-theirs' }),
    ).resolves.toEqual({ read: false, reason: 'not_alerted' });
    await expect(
      r.read({ familyId, parentUserId, conversationId: mine, gmailMessageId: 'gm-never' }),
    ).resolves.toEqual({ read: false, reason: 'not_alerted' });
    expect(fetched).toEqual([]);
  });

  it("refuses a 13+ child's email before any Google call", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId } = await seedFamily(db.database);
    await connectGmail(familyId, parentUserId);
    const conversationId = await alert(familyId, parentUserId, 'gm-teen', null);
    const { reader: r, fetched } = reader(async () => BODY);

    await expect(
      r.read({ familyId, parentUserId, conversationId, gmailMessageId: 'gm-teen' }),
    ).resolves.toEqual({ read: false, reason: 'private' });
    expect(fetched).toEqual([]);
  });

  it("never reads the co-parent's mailbox: only their Gmail is connected", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId } = await seedFamily(db.database);
    const coParent = await seedCoParent(familyId);
    await connectGmail(familyId, coParent);
    const conversationId = await alert(familyId, parentUserId, 'gm-1', 'snippet');
    const { reader: r, fetched } = reader(async () => BODY);

    await expect(r.connected(familyId, parentUserId)).resolves.toBe(false);
    await expect(r.connected(familyId, coParent)).resolves.toBe(true);
    await expect(
      r.read({ familyId, parentUserId, conversationId, gmailMessageId: 'gm-1' }),
    ).resolves.toEqual({ read: false, reason: 'not_connected' });
    expect(fetched).toEqual([]);
  });

  it('a connection without the read scope is not connected', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await seedIntegration(db.database, familyId, parentUserId, 'gmail');
    const { reader: r } = reader(async () => BODY);

    await expect(r.connected(familyId, parentUserId)).resolves.toBe(false);
  });

  it('names a Google failure and bounds a long body', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { familyId, parentUserId } = await seedFamily(db.database);
    await connectGmail(familyId, parentUserId);
    const conversationId = await alert(familyId, parentUserId, 'gm-1', 'snippet');

    const failing = reader(async () => {
      throw new Error('gmail messages.get 503');
    });
    await expect(
      failing.reader.read({ familyId, parentUserId, conversationId, gmailMessageId: 'gm-1' }),
    ).resolves.toEqual({ read: false, reason: 'google_error' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('gm-1');

    const long = 'x'.repeat(READ_EMAIL_MAX_CHARS + 10);
    const longReader = reader(async () => long);
    const read = await longReader.reader.read({
      familyId,
      parentUserId,
      conversationId,
      gmailMessageId: 'gm-1',
    });
    expect(read).toEqual({
      read: true,
      body: long.slice(0, READ_EMAIL_MAX_CHARS),
      truncated: true,
    });
  });
});
