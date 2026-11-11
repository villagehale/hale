import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { AUTHORIZED_SIGNUP_ENABLED_ENV } from '../flag';
import { recordSignupOffer } from '../store';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import {
  PRE_OPEN_LEAD_MS,
  type PlanPrepKind,
  plannedOfferDueForPrep,
  preOpenDueAt,
  runDueSignupPlanPrep,
} from './prep';
import { approveSignupPlan } from './store';

const NOW = new Date('2026-11-30T20:00:00.000Z');
const OPENS = new Date('2026-12-01T12:00:00.000Z');
const URL = 'https://haltonhills.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage';
const SESSIONS = [
  {
    id: 'sat-0900',
    label: 'Preschool Swim Sat 9:00',
    startsAt: '2027-01-09T14:00:00.000Z',
    endsAt: '2027-01-09T14:45:00.000Z',
    full: false,
    priceCents: 9800,
  },
];

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, 'true');
  vi.stubEnv(AUTHORIZED_SIGNUP_ENABLED_ENV, 'on');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function planned() {
  const seeded = await seedFamily(db.database);
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
  const offer = await recordSignupOffer(db.database, {
    familyId: seeded.familyId,
    childId,
    parentUserId: seeded.parentUserId,
    activityKey: 'swim-preschool',
    registrationUrl: URL,
    sessions: SESSIONS,
    approvedPriceCents: null,
    planOpensAt: OPENS,
    now: NOW,
  });
  if (!offer.ok) throw new Error(offer.reason);
  const approved = await approveSignupPlan(db.database, {
    offerId: offer.id,
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    messageId: 'msg-prep',
    choiceIds: ['sat-0900'],
    maxPriceCents: 10000,
    opensAt: OPENS,
    waiverAccepted: true,
    now: NOW,
  });
  expect(approved).toEqual({ ok: true });
  return { ...seeded, childId, offerId: offer.id };
}

function fakes() {
  const kinds: PlanPrepKind[] = [];
  const bodies: string[] = [];
  return {
    kinds,
    bodies,
    deps: {
      writer: {
        write: async (facts: { kind: PlanPrepKind }) => {
          kinds.push(facts.kind);
          return `text for ${facts.kind}`;
        },
      },
      deliver: async (input: { kind: PlanPrepKind; body: string }) => {
        bodies.push(input.body);
        return true;
      },
    },
  };
}

describe('plan prep before the open', () => {
  it('schedules the login ask, account prep with a link, then the 30-minute reminder', async () => {
    const family = await planned();
    const row = await db.database
      .select()
      .from(schema.authorizedSignupOffers)
      .then((rows) => rows.find((r) => r.id === family.offerId));
    expect(row?.status).toBe('planned');
    expect(plannedOfferDueForPrep({ status: 'planned', planOpensAt: OPENS }, NOW)).toBe(true);
    expect(PRE_OPEN_LEAD_MS).toBe(30 * 60_000);
    expect(preOpenDueAt(OPENS).toISOString()).toBe('2026-12-01T11:30:00.000Z');

    const first = fakes();
    const login = await runDueSignupPlanPrep(db.database, { now: NOW }, first.deps);
    expect(login.notices).toEqual([{ offerId: family.offerId, kind: 'login_ask', sent: true }]);
    expect(first.bodies[0]).toMatch(/https:\/\/app\.villagehale\.com\/l\/[0-9A-Za-z]{10}/);
    expect(first.bodies[0]).toContain('text for login_ask');

    const second = fakes();
    const account = await runDueSignupPlanPrep(db.database, { now: NOW }, second.deps);
    expect(account.notices).toEqual([
      { offerId: family.offerId, kind: 'account_prep', sent: true },
    ]);
    expect(second.bodies[0]).toMatch(/https:\/\/app\.villagehale\.com\/l\/[0-9A-Za-z]{10}/);
    expect(second.bodies[0]).toContain('text for account_prep');

    const tooSoon = fakes();
    const waiting = await runDueSignupPlanPrep(db.database, { now: NOW }, tooSoon.deps);
    expect(waiting.notices).toEqual([]);

    const reminderAt = preOpenDueAt(OPENS);
    const third = fakes();
    const reminder = await runDueSignupPlanPrep(db.database, { now: reminderAt }, third.deps);
    expect(reminder.notices).toEqual([{ offerId: family.offerId, kind: 'pre_open', sent: true }]);
    expect(third.bodies[0]).toBe('text for pre_open');
    expect(third.bodies[0]).not.toMatch(/https:\/\//);

    const kinds = await db.database
      .select({ kind: schema.providerLoginNotices.kind })
      .from(schema.providerLoginNotices)
      .where(eq(schema.providerLoginNotices.offerId, family.offerId));
    expect(kinds.map((k) => k.kind).sort()).toEqual(['account_prep', 'login_ask', 'pre_open']);
  });

  it('does not send when the model writes nothing', async () => {
    const family = await planned();
    const result = await runDueSignupPlanPrep(
      db.database,
      { now: NOW },
      {
        writer: { write: async () => null },
        deliver: async () => true,
      },
    );
    expect(result.notices).toEqual([{ offerId: family.offerId, kind: 'login_ask', sent: false }]);
    const notices = await db.database
      .select()
      .from(schema.providerLoginNotices)
      .where(eq(schema.providerLoginNotices.offerId, family.offerId));
    expect(notices).toEqual([]);
  });
});
