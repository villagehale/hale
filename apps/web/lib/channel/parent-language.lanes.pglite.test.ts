import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFollowUpRecipient } from '~/lib/channel/activity/sweep';
import { emailAlertPorts } from '~/lib/cron/connector-sync';
import { defaultReminderRunDeps } from '~/lib/loop/reminders/run';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * VIL-572 · each proactive lane's PRODUCTION reader returns the one stored language.
 * The lanes' own suites inject the language, so a reader that drifted back to the family's
 * language, the wrong user, or a constant would pass them all. The family is French and
 * each parent has set another language, so every wrong source gives a different answer.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function family(parentLanguage: string | null): Promise<SeededFamily> {
  const seeded = await seedFamily(db.database);
  await db.database
    .update(schema.families)
    .set({ primaryLanguage: 'fr' })
    .where(eq(schema.families.id, seeded.familyId));
  await setLanguage(seeded.parentUserId, parentLanguage);
  return seeded;
}

async function setLanguage(userId: string, language: string | null) {
  await db.database
    .update(schema.users)
    .set({ proactiveLanguage: language })
    .where(eq(schema.users.id, userId));
}

async function coParent(familyId: string, language: string): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `co-${familyId}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('co-parent insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  await setLanguage(user.id, language);
  return user.id;
}

async function promiseMessage({ familyId, parentUserId }: SeededFamily): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      status: 'sent',
      sentAt: new Date(),
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('channel_messages insert returned no row');
  return row.id;
}

describe('activity follow-ups: resolveFollowUpRecipient', () => {
  it("writes in the parent's stored language, not the family's", async () => {
    const seeded = await family('zh');
    const recipient = await resolveFollowUpRecipient(db.database, await promiseMessage(seeded));
    expect(recipient?.language).toBe('zh');
  });

  it("falls back to the family's language when the parent has set none", async () => {
    const seeded = await family(null);
    const recipient = await resolveFollowUpRecipient(db.database, await promiseMessage(seeded));
    expect(recipient?.language).toBe('fr');
  });
});

describe('reminders: defaultReminderRunDeps().loadLanguage', () => {
  it('reads the recipient’s own language, so two parents can differ', async () => {
    const seeded = await family('zh');
    const other = await coParent(seeded.familyId, 'es');
    const { loadLanguage } = defaultReminderRunDeps();
    expect(await loadLanguage(db.database, seeded.familyId, seeded.parentUserId)).toBe('zh');
    expect(await loadLanguage(db.database, seeded.familyId, other)).toBe('es');
  });
});

describe('email alerts: emailAlertPorts().parentLanguage', () => {
  it("reads the parent's stored language, then the family's", async () => {
    const seeded = await family('zh');
    const unset = await family(null);
    expect(
      await emailAlertPorts(db.database, seeded.familyId, 'ya29.test').parentLanguage(
        seeded.parentUserId,
        new Date(),
      ),
    ).toBe('zh');
    expect(
      await emailAlertPorts(db.database, unset.familyId, 'ya29.test').parentLanguage(
        unset.parentUserId,
        new Date(),
      ),
    ).toBe('fr');
  });
});
