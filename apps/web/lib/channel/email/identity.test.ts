import { schema } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { type FakeDb, makeFakeDb } from '~/lib/channel/intake/fakes';
import { resolveEmailSender } from './identity';

/**
 * The fake Drizzle handle deliberately does NOT evaluate `where` clauses — it hands
 * back the whole table. That is exactly the point here: every filter the lookup relies
 * on has to be re-applied in code as defense in depth, the same way
 * `resolveVerifiedChannelByPhone` re-checks its own hash. A test that only exercised the
 * SQL would prove nothing about the case where the query is wrong.
 */

const FAMILY = '00000000-0000-4000-8000-00000000fa11';
const OTHER_FAMILY = '00000000-0000-4000-8000-00000000fa12';
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

type FamilyRole = typeof schema.familyMembers.$inferInsert.role;
type Member = { familyId: string; userId: string; role: FamilyRole };

function seed(
  fake: FakeDb,
  users: Array<{ id: string; email: string | null }>,
  members: Member[],
): void {
  for (const user of users) fake.db.insert(schema.users).values(user);
  for (const member of members) fake.db.insert(schema.familyMembers).values(member);
}

function parentIn(familyId: string, userId: string): Member {
  return { familyId, userId, role: 'primary_parent' };
}

describe('resolveEmailSender', () => {
  it('resolves an address that belongs to a parent in exactly one family', async () => {
    const fake = makeFakeDb();
    seed(fake, [{ id: USER, email: 'sam@example.com' }], [parentIn(FAMILY, USER)]);

    await expect(resolveEmailSender(fake.db, 'sam@example.com')).resolves.toEqual({
      userId: USER,
      familyId: FAMILY,
      role: 'primary_parent',
    });
  });

  it('matches the stored address case-insensitively', async () => {
    const fake = makeFakeDb();
    seed(fake, [{ id: USER, email: 'Sam.Rivera@Example.com' }], [parentIn(FAMILY, USER)]);

    await expect(resolveEmailSender(fake.db, 'sam.rivera@example.com')).resolves.toEqual({
      userId: USER,
      familyId: FAMILY,
      role: 'primary_parent',
    });
  });

  it('resolves a co-parent and reports their role', async () => {
    const fake = makeFakeDb();
    seed(
      fake,
      [{ id: USER, email: 'sam@example.com' }],
      [{ familyId: FAMILY, userId: USER, role: 'co_parent' }],
    );

    await expect(resolveEmailSender(fake.db, 'sam@example.com')).resolves.toEqual({
      userId: USER,
      familyId: FAMILY,
      role: 'co_parent',
    });
  });

  it('resolves a caregiver and reports their role rather than hiding them', async () => {
    const fake = makeFakeDb();
    seed(
      fake,
      [{ id: USER, email: 'sitter@example.com' }],
      [{ familyId: FAMILY, userId: USER, role: 'nanny' }],
    );

    await expect(resolveEmailSender(fake.db, 'sitter@example.com')).resolves.toEqual({
      userId: USER,
      familyId: FAMILY,
      role: 'nanny',
    });
  });

  it('returns null for an address with no account', async () => {
    const fake = makeFakeDb();
    seed(fake, [{ id: USER, email: 'sam@example.com' }], [parentIn(FAMILY, USER)]);

    await expect(resolveEmailSender(fake.db, 'stranger@example.com')).resolves.toBeNull();
  });

  /**
   * `users.email` is NULLABLE — an SMS-provisioned parent has no address at all. A
   * lookup that let a null match an empty-ish input would resolve a stranger onto a
   * real family, which is the worst outcome this module has.
   */
  it('never matches a user whose address is null', async () => {
    const fake = makeFakeDb();
    seed(fake, [{ id: USER, email: null }], [parentIn(FAMILY, USER)]);

    for (const probe of ['', '   ', 'null', 'undefined']) {
      await expect(resolveEmailSender(fake.db, probe)).resolves.toBeNull();
    }
  });

  it('returns null for an empty address rather than resolving the first row', async () => {
    const fake = makeFakeDb();
    seed(fake, [{ id: USER, email: 'sam@example.com' }], [parentIn(FAMILY, USER)]);

    await expect(resolveEmailSender(fake.db, '')).resolves.toBeNull();
  });

  it('returns null when the account exists but belongs to no family', async () => {
    const fake = makeFakeDb();
    seed(fake, [{ id: USER, email: 'sam@example.com' }], []);

    await expect(resolveEmailSender(fake.db, 'sam@example.com')).resolves.toBeNull();
  });

  /**
   * A user in two families is genuinely ambiguous: nothing in an inbound email says
   * which household they meant. Guessing would file one family's message in another
   * family's ledger, so this fails closed and the caller treats it as unroutable.
   */
  it('refuses to guess when the sender belongs to more than one family', async () => {
    const fake = makeFakeDb();
    seed(
      fake,
      [{ id: USER, email: 'sam@example.com' }],
      [parentIn(FAMILY, USER), parentIn(OTHER_FAMILY, USER)],
    );

    await expect(resolveEmailSender(fake.db, 'sam@example.com')).resolves.toBeNull();
  });

  /**
   * The membership rows of OTHER users are in the same table the fake hands back
   * wholesale. Resolving against one of them would attach this sender to a household
   * they have nothing to do with.
   */
  it('ignores the memberships of other users when the query does not filter', async () => {
    const fake = makeFakeDb();
    seed(
      fake,
      [
        { id: USER, email: 'sam@example.com' },
        { id: OTHER_USER, email: 'other@example.com' },
      ],
      [parentIn(OTHER_FAMILY, OTHER_USER), parentIn(FAMILY, USER)],
    );

    await expect(resolveEmailSender(fake.db, 'sam@example.com')).resolves.toEqual({
      userId: USER,
      familyId: FAMILY,
      role: 'primary_parent',
    });
  });

  it('ignores another account that is not the address we asked about', async () => {
    const fake = makeFakeDb();
    seed(
      fake,
      [
        { id: OTHER_USER, email: 'other@example.com' },
        { id: USER, email: 'sam@example.com' },
      ],
      [parentIn(FAMILY, USER)],
    );

    await expect(resolveEmailSender(fake.db, 'other@example.com')).resolves.toBeNull();
  });
});
