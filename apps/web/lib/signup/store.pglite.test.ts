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
  supersede?: readonly string[],
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
    supersede,
    now: new Date(NOW.getTime() + minutesAfter * 60_000),
  });
}

/** A second adult in the household with full parent scope. */
async function seedCoParent(familyId: string): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `co-${familyId}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('seedCoParent: users insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  return user.id;
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

describe('several signup asks at once', () => {
  it('a new ask for another program leaves the earlier ask open', async () => {
    const f = await family();
    const gym = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!gym.ok) throw new Error(gym.reason);
    const kickers = await record(f, KICKERS_URL, 'Little Kickers', 5);
    if (!kickers.ok) throw new Error(kickers.reason);

    expect(kickers.replaced).toEqual([]);
    expect(await statusOf(gym.id)).toEqual({ status: 'pending', label: 'Gymnastics Tots' });
    expect(await statusOf(kickers.id)).toEqual({ status: 'pending', label: 'Little Kickers' });
    expect(await supersededAudits(gym.id)).toEqual([]);
  });

  it('closes the earlier ask the parent replaced, audits it, and names it', async () => {
    const f = await family();
    const gym = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!gym.ok) throw new Error(gym.reason);
    const kickers = await record(f, KICKERS_URL, 'Little Kickers', 5, [gym.id]);
    if (!kickers.ok) throw new Error(kickers.reason);

    expect(await statusOf(gym.id)).toEqual({ status: 'handed_back', label: 'Gymnastics Tots' });
    expect(kickers.replaced).toEqual([
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

  it("never closes the co-parent's ask, even when it is named", async () => {
    const f = await family();
    const coParentUserId = await seedCoParent(f.familyId);
    const theirs = await record(
      { ...f, parentUserId: coParentUserId },
      GYM_URL,
      'Gymnastics Tots',
      0,
    );
    if (!theirs.ok) throw new Error(theirs.reason);
    const mine = await record(f, KICKERS_URL, 'Little Kickers', 5, [theirs.id]);
    if (!mine.ok) throw new Error(mine.reason);

    expect(mine.replaced).toEqual([]);
    expect((await statusOf(theirs.id))?.status).toBe('pending');
    expect(await supersededAudits(theirs.id)).toEqual([]);
  });

  it('a second ask on the same site is refused unless it replaces the open one', async () => {
    const f = await family();
    const first = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!first.ok) throw new Error(first.reason);

    expect(await record(f, SAME_HOST_URL, 'Preschool Swim', 5)).toEqual({
      ok: false,
      reason: 'offer_exists',
    });
    expect((await statusOf(first.id))?.status).toBe('pending');

    const replacing = await record(f, SAME_HOST_URL, 'Preschool Swim', 6, [first.id]);
    expect(replacing.ok).toBe(true);
    expect((await statusOf(first.id))?.status).toBe('handed_back');
  });

  it('an approved plan is not an ask: naming it closes nothing', async () => {
    const f = await family();
    const planned = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!planned.ok) throw new Error(planned.reason);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'planned' })
      .where(eq(schema.authorizedSignupOffers.id, planned.id));

    const next = await record(f, KICKERS_URL, 'Little Kickers', 5, [planned.id]);
    if (!next.ok) throw new Error(next.reason);
    expect(next.replaced).toEqual([]);
    expect((await statusOf(planned.id))?.status).toBe('planned');
    expect(await supersededAudits(planned.id)).toEqual([]);
  });

  it("never closes another family's ask", async () => {
    const mine = await family();
    const theirs = await family();
    const other = await record(theirs, GYM_URL, 'Gymnastics Tots', 0);
    if (!other.ok) throw new Error(other.reason);
    const own = await record(mine, KICKERS_URL, 'Little Kickers', 5, [other.id]);
    if (!own.ok) throw new Error(own.reason);
    expect(own.replaced).toEqual([]);
    expect((await statusOf(other.id))?.status).toBe('pending');
  });
});

describe('loadPendingOffer', () => {
  it('binds the newest pending ask when older rows are still pending', async () => {
    const f = await family();
    // Two pending asks on different hosts.
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
    const older = rows.find((row) => row.url === GYM_URL);

    expect((await loadPendingOffer(db.database, f.familyId))?.id).toBe(newest?.id);
    // A named ask is loaded as itself, so an older plan can still be approved.
    expect((await loadPendingOffer(db.database, f.familyId, older?.id))?.id).toBe(older?.id);
    const stranger = await family();
    expect(await loadPendingOffer(db.database, stranger.familyId, older?.id)).toBeNull();
  });
});
