import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { productionChannelCoachPorts } from '~/lib/channel/coach/runtime';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { householdGroupFact, loadHouseholdGroupFact } from './household-group';
import { type FirstTouchGiven, createSession, saveSession } from './session';

/**
 * VIL-566 — a yes to the co-parent group is the wish; the family's Linq group is the
 * claim. They are read from two stores, so a yes with no group reads `pending`, and
 * only a claimed group reads `claimed`. Against the real DDL and the real session
 * encryption: the wish lives inside the encrypted session blob.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-11-03T15:00:00.000Z');

let db: TestDb;
let seq = 0;

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
  await db.exec('truncate table sms_intake_sessions, families cascade');
});

function given(coparentGroup: boolean | null): FirstTouchGiven {
  return {
    parentName: null,
    activityPick: null,
    connectCalendar: null,
    connectGmail: null,
    parentRole: null,
    nameDeclined: false,
    kidsNamesDeclined: false,
    calendarLater: false,
    gmailLater: false,
    scheduleDone: true,
    scheduled: [],
    coparentGroup,
    coparentGroupMode: null,
  };
}

async function family(): Promise<string> {
  const [row] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Group test', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  return row?.id as string;
}

async function answered(
  familyId: string,
  coparentGroup: boolean | null,
  at: Date,
  closed = true,
): Promise<void> {
  seq += 1;
  const session = await createSession(db.database, {
    phoneE164: `+1555555${String(100 + seq).padStart(4, '0')}`,
    state: 'awaiting_ladder',
    sourceCode: null,
  });
  await saveSession(
    db.database,
    session,
    {
      familyId,
      firstTouch: {
        language: null,
        place: null,
        locationRequest: null,
        given: given(coparentGroup),
      },
      ...(closed ? { state: 'complete' as const, closedAt: at } : {}),
    },
    at,
  );
}

async function claim(familyId: string): Promise<void> {
  await db.database
    .update(schema.families)
    .set({ linqGroupChatId: `chat-${familyId}` })
    .where(eq(schema.families.id, familyId));
}

describe('loadHouseholdGroupFact', () => {
  it('a yes with no group is pending, and the same yes after the claim is claimed', async () => {
    const familyId = await family();
    await answered(familyId, true, NOW);
    expect(await loadHouseholdGroupFact(db.database, familyId)).toBe('pending');

    await claim(familyId);
    expect(await loadHouseholdGroupFact(db.database, familyId)).toBe('claimed');
  });

  it('carries no fact when they never said yes, even with a group claimed', async () => {
    const noAnswer = await family();
    await answered(noAnswer, null, NOW);
    expect(await loadHouseholdGroupFact(db.database, noAnswer)).toBeNull();

    const declined = await family();
    await answered(declined, false, NOW);
    await claim(declined);
    expect(await loadHouseholdGroupFact(db.database, declined)).toBeNull();
  });

  it('reads the newest answer, and only this family', async () => {
    const changed = await family();
    await answered(changed, true, new Date(NOW.getTime() - 86_400_000));
    await answered(changed, false, NOW, false);
    expect(await loadHouseholdGroupFact(db.database, changed)).toBeNull();

    const other = await family();
    await answered(other, true, NOW);
    const quiet = await family();
    expect(await loadHouseholdGroupFact(db.database, quiet)).toBeNull();
    expect(await loadHouseholdGroupFact(db.database, other)).toBe('pending');
  });
});

describe('the coach context', () => {
  const ask = (familyId: string) =>
    productionChannelCoachPorts(db.database).loadContext({
      familyId,
      question: 'are we all set?',
      intent: null,
      focusedChildId: null,
      transcript: [],
      sourceNote: null,
    });

  it('carries pending after a yes with no group, and nothing for a family that never said yes', async () => {
    const yes = await family();
    await answered(yes, true, NOW);
    expect((await ask(yes)).householdGroup).toBe('pending');

    const never = await family();
    expect(await ask(never)).not.toHaveProperty('householdGroup');
  });
});

describe('householdGroupFact', () => {
  it('names the open ask unclaimed, a stored yes pending, and a group claimed', () => {
    expect(householdGroupFact({ wanted: null, claimed: false, asking: true })).toBe('unclaimed');
    expect(householdGroupFact({ wanted: null, claimed: true, asking: true })).toBe('claimed');
    expect(householdGroupFact({ wanted: true, claimed: false, asking: false })).toBe('pending');
    expect(householdGroupFact({ wanted: true, claimed: true, asking: false })).toBe('claimed');
    expect(householdGroupFact({ wanted: false, claimed: false, asking: false })).toBeNull();
    expect(householdGroupFact({ wanted: null, claimed: true, asking: false })).toBeNull();
  });
});
