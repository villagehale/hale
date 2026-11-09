import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { friendVoiceContext, nameAskVoiceInput } from '~/lib/channel/intake/friend-voice';
import { type FirstTouchGiven, createSession, saveSession } from '~/lib/channel/intake/session';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { nameAskChecklist } from './name-reply';

/**
 * The reply to the open name ask is written from the family's real onboarding
 * state, read from the session the onboarding turn reads. A parent who already
 * connected or declined Gmail is never asked for it again here.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');
const NOW = new Date('2026-11-08T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table sms_intake_sessions, family_members, families, users cascade');
});

let phoneSeq = 0;

async function onboarding(
  owner: { familyId: string; parentUserId: string },
  given: Partial<FirstTouchGiven>,
): Promise<void> {
  phoneSeq += 1;
  const session = await createSession(db.database, {
    phoneE164: `+1555555010${phoneSeq}`,
    state: 'awaiting_details',
    sourceCode: null,
  });
  await saveSession(
    db.database,
    session,
    {
      familyId: owner.familyId,
      userId: owner.parentUserId,
      collected: {
        ...session.collected,
        children: [{ name: 'Kid', ageMonths: 30, agePrecision: 'months' }],
      },
      firstTouch: {
        language: 'en',
        place: {
          kind: 'city',
          areaCoarse: 'Springfield',
          postalCode: null,
          municipality: null,
          city: 'Springfield',
        },
        locationRequest: null,
        given: {
          parentName: null,
          activityPick: null,
          connectCalendar: null,
          connectGmail: null,
          ...given,
        },
      },
    },
    NOW,
  );
}

async function modelFacts(owner: { familyId: string; parentUserId: string }) {
  const stored = await nameAskChecklist(db.database, owner);
  return friendVoiceContext(nameAskVoiceInput('undo', 'en', stored)) as {
    known: Record<string, boolean | null> | null;
    missing: string[] | null;
    answering: string | null;
    next: string | null;
  };
}

describe('the name-ask reply reads the family onboarding state', () => {
  it('asks for Gmail next only while Gmail is still unanswered (positive control)', async () => {
    const owner = await seedFamily(db.database, 'Household A');
    await onboarding(owner, {});
    const facts = await modelFacts(owner);
    expect(facts).toMatchObject({ answering: 'name', next: 'gmail' });
    expect(facts.known).toMatchObject({ postal: true, kids: true, ages: true, gmail: false });
  });

  it('a family with Gmail connected: the facts say so, and Gmail is not next', async () => {
    const owner = await seedFamily(db.database, 'Household B');
    await onboarding(owner, { connectGmail: true });
    const facts = await modelFacts(owner);
    expect(facts.known?.gmail).toBe(true);
    expect(facts.missing).not.toContain('gmail');
    expect(facts).toMatchObject({ answering: 'name', next: 'calendar' });
  });

  it('a family that declined Gmail gets no Gmail item', async () => {
    const owner = await seedFamily(db.database, 'Household C');
    await onboarding(owner, { connectGmail: false, connectCalendar: false });
    const facts = await modelFacts(owner);
    expect(facts.missing).not.toContain('gmail');
    expect(facts.missing).not.toContain('calendar');
    expect(facts.next).not.toBe('gmail');
  });

  it("passes unknown, not false, when the session is the other parent's or there is none", async () => {
    const owner = await seedFamily(db.database, 'Household D');
    const [coparent] = await db.database
      .insert(schema.users)
      .values({ name: null })
      .returning({ id: schema.users.id });
    if (!coparent) throw new Error('seed returned no row');
    await onboarding(owner, {});
    const lone = await seedFamily(db.database, 'Household E');

    for (const reader of [{ familyId: owner.familyId, parentUserId: coparent.id }, lone]) {
      const facts = await modelFacts(reader);
      expect(facts.known).toEqual({
        postal: null,
        kids: null,
        ages: null,
        name: false,
        gmail: null,
        calendar: null,
        schedule: null,
        coparent: null,
      });
      expect(facts).toMatchObject({ missing: ['name'], answering: 'name', next: null });
    }
  });
});
