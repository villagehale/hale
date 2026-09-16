import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startCaregiverInvite, startCoParentInvite } from '~/lib/channel/caregiver/invites';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';

/**
 * VIL-355 · the co-parent scope question through the router's REAL reader.
 *
 * Every other test of the bare-YES arbitration injects the source — `async () => null`
 * in open-questions.test.ts, a static list in route.test.ts — so blinding the
 * production `coParentAssent` source in wiring.ts failed nothing: the gate would have
 * been arbitrating over a question the router never saw. This file reads the way
 * production does, against real Postgres, and is the one pin on that wiring.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165551234';
const PARTNER_PHONE = '+16475550199';
const NOW = new Date('2026-09-15T12:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:household-reader', name: 'Ana' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  return { familyId, parentUserId };
}

function openQuestions(seeded: { familyId: string; parentUserId: string }) {
  return defaultOpenQuestionReader().open(db.database, { ...seeded, now: NOW });
}

describe('the co-parent scope question, through the production reader', () => {
  it('lists the pending assent as solicited, asked at the moment the parent asked', async () => {
    const seeded = await seedFamily();
    await startCoParentInvite(db.database, {
      familyId: seeded.familyId,
      invitedByUserId: seeded.parentUserId,
      inviterPhoneE164: PARENT_PHONE,
      inviterName: 'Ana',
      parsed: { ok: true, name: 'Sam', phoneE164: PARTNER_PHONE, role: 'co_parent' },
      language: 'en',
      now: NOW,
    });

    const questions = await openQuestions(seeded);
    expect(
      questions.map((q) => ({ kind: q.kind, askedAt: q.askedAt, solicited: q.solicited })),
    ).toEqual([{ kind: 'co_parent_assent', askedAt: NOW, solicited: true }]);
  });

  /** The role filter's negative control: a CAREGIVER ask awaiting the same parent's yes
   * is answered by the caregiver lane before a router turn exists, so listing it would
   * make every bare affirmative in the household ambiguous. */
  it('lists nothing for a caregiver ask awaiting the same parent', async () => {
    const seeded = await seedFamily();
    await startCaregiverInvite(db.database, {
      familyId: seeded.familyId,
      invitedByUserId: seeded.parentUserId,
      inviterPhoneE164: PARENT_PHONE,
      parsed: { ok: true, name: 'Sam', phoneE164: PARTNER_PHONE, role: 'nanny' },
      now: NOW,
    });

    expect(await openQuestions(seeded)).toEqual([]);
  });
});
