import { schema } from '@hale/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EmailType } from '~/lib/cron/email-compliance';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { resolveSendableEmail } from './sendable';
import { UNSUBSCRIBABLE_STREAMS } from './streams';

/**
 * MAY WE ANSWER THIS PARENT BY EMAIL — the send-time consent check, against a real
 * Postgres because it is a question about rows.
 *
 * The distinction under test is the whole design: a parent who muted ONE stream has
 * made a preference about Hale's own messages and is still owed an answer when they
 * write; a parent who has opted out of ALL of them has said the email spelling of STOP,
 * and gets the same silence a stopped number gets. Getting this backwards in either
 * direction is a real failure — one ignores a parent who asked a question, the other
 * emails someone who asked us not to.
 */

describe('resolveSendableEmail', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  // ONE Postgres for the file, a fresh family per test. Opt-outs are keyed by user, so
  // separate families cannot see each other's rows — and booting a database six times
  // to prove that would cost five seconds to learn nothing.
  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    ({ familyId, parentUserId } = await seedFamily(db.database));
  });

  afterAll(async () => {
    await db.close();
  });

  const address = () => `${familyId}@example.test`;

  async function optOut(...streams: EmailType[]): Promise<void> {
    for (const emailType of streams) {
      await db.database.insert(schema.emailOptOuts).values({ userId: parentUserId, emailType });
    }
  }

  it('answers a parent who has asked for nothing to stop', async () => {
    expect(await resolveSendableEmail(db.database, parentUserId)).toBe(address());
  });

  it('still answers a parent who muted one stream', async () => {
    await optOut('weekly_plan');

    expect(await resolveSendableEmail(db.database, parentUserId)).toBe(address());
  });

  it('still answers a parent who muted all but one', async () => {
    await optOut(...UNSUBSCRIBABLE_STREAMS.slice(1));

    expect(await resolveSendableEmail(db.database, parentUserId)).toBe(address());
  });

  it('goes silent once every stream is off — the email spelling of STOP', async () => {
    await optOut(...UNSUBSCRIBABLE_STREAMS);

    expect(await resolveSendableEmail(db.database, parentUserId)).toBeNull();
  });

  it('has nowhere to send when the account holds no address', async () => {
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: null, name: 'Texting Parent' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('no user');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: user.id, role: 'co_parent' });

    expect(await resolveSendableEmail(db.database, user.id)).toBeNull();
  });

  it('never answers one parent at another parent address', async () => {
    const other = await seedFamily(db.database, 'Other Family');

    expect(await resolveSendableEmail(db.database, other.parentUserId)).toBe(
      `${other.familyId}@example.test`,
    );
    expect(await resolveSendableEmail(db.database, parentUserId)).toBe(address());
  });
});
