import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { PARENT_NAME_ASK_TEMPLATE_KEY } from './asked';
import {
  deliverParentCallNameLine,
  handleParentCallNameReply,
  holdGoogleGivenName,
  loadParentCallName,
} from './parent-call-name';

/**
 * The column and the WHERE are real here. The fake evaluates an update predicate
 * in JS; this proves `name IS NULL` and the other family's row are Postgres facts.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seed(label: string): Promise<{ familyId: string; userId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: label, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ name: null })
    .returning({ id: schema.users.id });
  if (!family || !user) throw new Error('seed returned no row');
  await db.database.insert(schema.familyMembers).values({
    familyId: family.id,
    userId: user.id,
    role: 'primary_parent',
  });
  return { familyId: family.id, userId: user.id };
}

describe('parent call name on postgres', () => {
  it('holds a given name without confirming it, refuses a phone, and yes does not touch the other family', async () => {
    const a = await seed('Household A');
    const b = await seed('Household B');
    await holdGoogleGivenName(db.database, {
      familyId: b.familyId,
      userId: b.userId,
      givenName: 'Other',
    });

    expect(
      await holdGoogleGivenName(db.database, {
        familyId: a.familyId,
        userId: a.userId,
        givenName: '+14165550100',
      }),
    ).toBe('refused');
    const [afterPhone] = await db.database
      .select({ name: schema.users.name, googleGivenName: schema.users.googleGivenName })
      .from(schema.users)
      .where(eq(schema.users.id, a.userId));
    expect(afterPhone).toEqual({ name: null, googleGivenName: null });

    expect(
      await holdGoogleGivenName(db.database, {
        familyId: a.familyId,
        userId: a.userId,
        givenName: 'Bea',
      }),
    ).toBe('held');
    const [held] = await db.database
      .select({ name: schema.users.name, googleGivenName: schema.users.googleGivenName })
      .from(schema.users)
      .where(eq(schema.users.id, a.userId));
    expect(held).toEqual({ name: null, googleGivenName: 'Bea' });

    await db.database.insert(schema.channelMessages).values({
      familyId: a.familyId,
      parentUserId: a.userId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      templateKey: 'parent_name_confirm',
      status: 'queued',
      sentAt: new Date('2026-09-22T15:00:00.000Z'),
    });
    const yes = await handleParentCallNameReply(
      db.database,
      { familyId: a.familyId, parentUserId: a.userId, body: 'yes' },
      {
        read: async () => ({
          reply: 'MODEL REPLY',
          parentName: null,
          nameConfirmed: true,
          parentRole: null,
        }),
      },
    );
    expect(yes.status).toBe('answered');

    const [confirmed] = await db.database
      .select({ name: schema.users.name, googleGivenName: schema.users.googleGivenName })
      .from(schema.users)
      .where(eq(schema.users.id, a.userId));
    const [untouched] = await db.database
      .select({ name: schema.users.name, googleGivenName: schema.users.googleGivenName })
      .from(schema.users)
      .where(eq(schema.users.id, b.userId));
    expect(confirmed).toEqual({ name: 'Bea', googleGivenName: null });
    expect(untouched).toEqual({ name: null, googleGivenName: 'Other' });
  });
});

describe('a name ask Linq may have taken', () => {
  const FLAG = 'LINQ_REFUSED_FOR_CERTAIN_ENABLED';
  const NOW = new Date('2026-10-08T22:00:00.000Z');

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function askRefusedWith(status: number) {
    const seeded = await seed(`Name ask ${status}`);
    await deliverParentCallNameLine(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.userId,
        to: '+15555550100',
        now: NOW,
        body: 'What should I call you?',
        templateKey: PARENT_NAME_ASK_TEMPLATE_KEY,
      },
      {
        transport: {
          send: async () => {
            throw new LinqSendError(`http_${status}`, status, true);
          },
        },
        threadMessage: async () => 'conv-1',
      },
    );
    return loadParentCallName(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
    });
  }

  it('flag on: a 409 counts as asked, so a later find does not ask again', async () => {
    vi.stubEnv(FLAG, 'true');
    expect((await askRefusedWith(409)).alreadyAsked).toBe(true);
  });

  it('flag on: a 422 proved a refusal, so the ask is still open', async () => {
    vi.stubEnv(FLAG, 'true');
    expect((await askRefusedWith(422)).alreadyAsked).toBe(false);
  });

  it('flag off: a 409 leaves the ask open, as main does', async () => {
    vi.stubEnv(FLAG, 'false');
    expect((await askRefusedWith(409)).alreadyAsked).toBe(false);
  });
});
