import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { loadPendingOffer, recordSignupOffer } from './store';

// Invented hosts and programs only.
const NOW = new Date('2026-11-20T15:00:00.000Z');
const GYM_URL = 'https://gym.example-rec.test/register/tots';
const KICKERS_URL = 'https://kickers.example-sport.test/register/sat';
const SAME_HOST_URL = 'https://gym.example-rec.test/register/swim';
const SESSION = {
  id: 'sat-1015',
  label: 'Sat 10:15',
  startsAt: '2027-01-09T15:15:00.000Z',
  endsAt: '2027-01-09T16:00:00.000Z',
  full: false,
  priceCents: 12000,
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function family() {
  const seeded = await seedFamily(db.database);
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
  return { ...seeded, childId };
}

function record(
  f: { familyId: string; parentUserId: string; childId: string },
  url: string,
  activityLabel: string,
  minutesAfter: number,
) {
  return recordSignupOffer(db.database, {
    familyId: f.familyId,
    childId: f.childId,
    parentUserId: f.parentUserId,
    activityKey: `act-${minutesAfter}`,
    activityLabel,
    registrationUrl: url,
    sessions: [SESSION],
    approvedPriceCents: null,
    now: new Date(NOW.getTime() + minutesAfter * 60_000),
  });
}

async function statusOf(id: string) {
  const [row] = await db.database
    .select({
      status: schema.authorizedSignupOffers.status,
      label: schema.authorizedSignupOffers.activityLabel,
    })
    .from(schema.authorizedSignupOffers)
    .where(eq(schema.authorizedSignupOffers.id, id));
  return row;
}

async function supersededAudits(id: string) {
  const rows = await db.database
    .select({ after: schema.auditLog.after, actor: schema.auditLog.actor })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetId, id),
        eq(schema.auditLog.actionTaken, 'authorized_signup_step'),
      ),
    );
  return rows.filter((row) => (row.after as { step?: string }).step === 'offer_superseded');
}

describe('one live signup ask per family', () => {
  it('a new ask closes the pending ask for another program, audits it, and names it', async () => {
    const f = await family();
    const gym = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!gym.ok) throw new Error(gym.reason);
    expect(gym.closed).toEqual([]);

    const kickers = await record(f, KICKERS_URL, 'Little Kickers', 5);
    if (!kickers.ok) throw new Error(kickers.reason);

    expect(await statusOf(gym.id)).toEqual({ status: 'handed_back', label: 'Gymnastics Tots' });
    expect(await statusOf(kickers.id)).toEqual({ status: 'pending', label: 'Little Kickers' });
    expect(kickers.closed).toEqual([
      {
        offerId: gym.id,
        activityLabel: 'Gymnastics Tots',
        providerHost: 'gym.example-rec.test',
        sessionLabels: ['Sat 10:15'],
      },
    ]);
    const audits = await supersededAudits(gym.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe(f.parentUserId);
    expect(audits[0]?.after).toEqual({
      step: 'offer_superseded',
      host: 'gym.example-rec.test',
      supersededBy: kickers.id,
    });
  });

  it('a new ask on the same host replaces the old one instead of being refused', async () => {
    const f = await family();
    const first = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!first.ok) throw new Error(first.reason);
    const second = await record(f, SAME_HOST_URL, 'Preschool Swim', 5);
    expect(second.ok).toBe(true);
    expect((await statusOf(first.id))?.status).toBe('handed_back');
  });

  it('an approved plan is not an ask: a new ask leaves it planned and closes nothing', async () => {
    const f = await family();
    const planned = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!planned.ok) throw new Error(planned.reason);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'planned' })
      .where(eq(schema.authorizedSignupOffers.id, planned.id));

    const next = await record(f, KICKERS_URL, 'Little Kickers', 5);
    if (!next.ok) throw new Error(next.reason);
    expect(next.closed).toEqual([]);
    expect((await statusOf(planned.id))?.status).toBe('planned');
    expect(await supersededAudits(planned.id)).toEqual([]);
  });

  it("closes only this family's asks", async () => {
    const mine = await family();
    const theirs = await family();
    const other = await record(theirs, GYM_URL, 'Gymnastics Tots', 0);
    if (!other.ok) throw new Error(other.reason);
    const own = await record(mine, KICKERS_URL, 'Little Kickers', 5);
    if (!own.ok) throw new Error(own.reason);
    expect(own.closed).toEqual([]);
    expect((await statusOf(other.id))?.status).toBe('pending');
  });
});

describe('loadPendingOffer', () => {
  it('binds the newest pending ask when older rows are still pending', async () => {
    const f = await family();
    // Rows written before one-live-ask: two pending asks on different hosts.
    const rows = await db.database
      .insert(schema.authorizedSignupOffers)
      .values(
        [
          { url: KICKERS_URL, host: 'kickers.example-sport.test', minutes: 5 },
          { url: GYM_URL, host: 'gym.example-rec.test', minutes: 0 },
        ].map((row) => ({
          familyId: f.familyId,
          childId: f.childId,
          parentUserId: f.parentUserId,
          activityKey: `legacy-${row.minutes}`,
          registrationUrl: row.url,
          providerHost: row.host,
          sessions: [SESSION],
          status: 'pending',
          createdAt: new Date(NOW.getTime() + row.minutes * 60_000),
          updatedAt: new Date(NOW.getTime() + row.minutes * 60_000),
        })),
      )
      .returning({
        id: schema.authorizedSignupOffers.id,
        url: schema.authorizedSignupOffers.registrationUrl,
      });
    const newest = rows.find((row) => row.url === KICKERS_URL);

    expect((await loadPendingOffer(db.database, f.familyId))?.id).toBe(newest?.id);
  });
});
