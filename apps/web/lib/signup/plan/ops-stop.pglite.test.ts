import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import type {
  BrowserUsePlanResult,
  PlanPayingToken,
  PlanResumeToken,
} from '../browser-use/plan-engine';
import { recordSignupOffer } from '../store';
import { REGISTRATION_PLAN_AT_OPEN_ENABLED_ENV, REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import { type PlanOutcomeNotice, runDueSignupPlans } from './run';
import { planTakenBack, requestStopForRunningPlans, savePlanResume } from './store';

const scriptDb = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@hale/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hale/db')>()),
  createDb: () => scriptDb.current,
}));

const NOW = new Date('2026-12-01T11:58:00.000Z');
const OPENS = new Date('2026-12-01T12:00:00.000Z');
const NEXT_SWEEP = new Date(NOW.getTime() + 60_000);
const AUTO_HOST = 'register.example-rec.test';
const AUTO_URL = `https://${AUTO_HOST}/Clients/BookMe4LandingPages/CoursesLandingPage`;
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

const UNSTARTED: PlanResumeToken = {
  phase: 'signup',
  runId: null,
  sessionId: null,
  browserId: null,
};
const QUEUED: PlanResumeToken = {
  phase: 'signup',
  runId: 'run-queue',
  sessionId: 'bu-session-queue',
  browserId: null,
};
const PAYING: PlanPayingToken = {
  phase: 'paying',
  runId: 'pay-run-1',
  sessionId: 'bu-session-pay',
  browserId: 'browser-pay',
  choiceIndex: 1,
  cartTotalCents: 9800,
  holdExpiresAt: null,
  costUsd: '0.0400',
};
const PAID: BrowserUsePlanResult = {
  outcome: 'completed',
  detail: 'none',
  choiceIndex: 1,
  liveViewUrl: null,
  checkoutUrl: null,
  holdExpiresAt: null,
  cartTotalCents: 9800,
  confirmationNumber: 'R-55120',
  opensAt: null,
  amountChargedCents: 9800,
  runId: 'pay-run-1',
  sessionId: 'bu-session-pay',
  costUsd: '0.0500',
  sessionCostUsd: '0.090000',
  browserId: 'browser-pay',
  charged: { cents: 9800 },
};

let db: TestDb;
let messageSeq = 0;
const realArgv = process.argv;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.database.delete(schema.authorizedSignupOffers);
  vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, 'true');
});
afterEach(() => {
  process.argv = realArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

const offers = schema.authorizedSignupOffers;

async function pendingOffer() {
  const seeded = await seedFamily(db.database);
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
  const offer = await recordSignupOffer(db.database, {
    familyId: seeded.familyId,
    childId,
    parentUserId: seeded.parentUserId,
    activityKey: 'swim-preschool',
    registrationUrl: AUTO_URL,
    sessions: SESSIONS,
    approvedPriceCents: null,
    now: new Date(NOW.getTime() - 24 * 60 * 60_000),
  });
  if (!offer.ok) throw new Error(offer.reason);
  return { offerId: offer.id, familyId: seeded.familyId };
}

async function plannedOffer() {
  const plan = await pendingOffer();
  messageSeq += 1;
  await db.database
    .update(offers)
    .set({
      status: 'planned',
      planChoiceIds: ['sat-0900'],
      planMaxPriceCents: 10000,
      planOpensAt: OPENS,
      planWaiverAccepted: true,
      planApprovedAt: new Date(NOW.getTime() - 20 * 60 * 60_000),
      authorizingMessageId: `msg-plan-${messageSeq}`,
    })
    .where(eq(offers.id, plan.offerId));
  return plan;
}

/** A plan an earlier sweep claimed and let go: the next sweep picks it up. */
async function runningPlan(resume: PlanResumeToken) {
  const plan = await plannedOffer();
  await db.database
    .update(offers)
    .set({ status: 'submitting', planResume: resume, planLeaseUntil: null })
    .where(eq(offers.id, plan.offerId));
  return plan;
}

async function offerRow(offerId: string) {
  const [row] = await db.database.select().from(offers).where(eq(offers.id, offerId));
  if (!row) throw new Error('offer not found');
  return row;
}

async function stopRows(offerId: string) {
  return db.database
    .select({
      familyId: schema.auditLog.familyId,
      actor: schema.auditLog.actor,
      actionTaken: schema.auditLog.actionTaken,
      targetTable: schema.auditLog.targetTable,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetId, offerId),
        sql`${schema.auditLog.after}->>'step' = 'plan_ops_stop'`,
      ),
    );
}

function sweepDeps(settled: BrowserUsePlanResult = PAID) {
  const notices: PlanOutcomeNotice[] = [];
  const runner = {
    run: vi.fn(async (): Promise<BrowserUsePlanResult> => {
      throw new Error('a stopped plan never starts a run');
    }),
    release: vi.fn(async (_resume: PlanResumeToken) => null),
    settlePayment: vi.fn(async () => settled),
  };
  return {
    runner,
    notices,
    deps: {
      runner,
      autoHosts: [AUTO_HOST],
      notifyParent: async (notice: PlanOutcomeNotice) => {
        notices.push(notice);
        return 'sent' as const;
      },
    },
  };
}

/** Runs the real script on the test database. Stderr also carries SDK warnings at import. */
async function runScript(database: unknown) {
  scriptDb.current = database;
  vi.stubEnv('DATABASE_URL', 'postgres://unused.invalid/none');
  process.argv = ['node', 'stop-signup-plans.ts'];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const streams = [
    ['log', stdout],
    ['info', stdout],
    ['warn', stderr],
    ['error', stderr],
  ] as const;
  for (const [method, into] of streams) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      into.push(args.map(String).join(' '));
    });
  }
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  await import('../../../scripts/stop-signup-plans');
  return { stdout, stderr, exit };
}

describe('an ops stop of every running plan', () => {
  it('takes back a plan in signup, and no payment can start after it', async () => {
    const plan = await runningPlan(QUEUED);
    const startsPayment = { ...PAYING, runId: null };
    expect(await planTakenBack(db.database, plan)).toBe(false);

    expect(await requestStopForRunningPlans(db.database, { now: NOW })).toEqual({
      signup: 1,
      paying: 0,
    });

    expect(await planTakenBack(db.database, plan)).toBe(true);
    expect(
      await savePlanResume(db.database, { ...plan, resume: startsPayment, letGo: false }),
    ).toBe(false);
    expect((await offerRow(plan.offerId)).planResume).toEqual(QUEUED);

    const notStopped = await runningPlan(QUEUED);
    expect(
      await savePlanResume(db.database, { ...notStopped, resume: startsPayment, letGo: false }),
    ).toBe(true);
  });

  it('the next sweep lets a stopped run go and texts nobody', async () => {
    const plan = await runningPlan(QUEUED);
    await requestStopForRunningPlans(db.database, { now: NOW });
    const { runner, notices, deps } = sweepDeps();

    const result = await runDueSignupPlans(db.database, { now: NEXT_SWEEP }, deps);

    expect(result.plans).toEqual([
      {
        offerId: plan.offerId,
        outcome: 'cancelled',
        detail: 'authorization_lapsed',
        notice: 'withheld',
      },
    ]);
    expect(runner.release).toHaveBeenCalledWith(QUEUED);
    expect(runner.run).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect((await offerRow(plan.offerId)).status).toBe('handed_back');
  });

  it('marks a plan in paying, and the sweep still reads the payment and tells the parent', async () => {
    const plan = await runningPlan(PAYING);

    expect(await requestStopForRunningPlans(db.database, { now: NOW })).toEqual({
      signup: 0,
      paying: 1,
    });
    expect((await offerRow(plan.offerId)).planCancelRequestedAt).toEqual(NOW);

    const { runner, notices, deps } = sweepDeps();
    const result = await runDueSignupPlans(db.database, { now: NEXT_SWEEP }, deps);

    expect(runner.settlePayment).toHaveBeenCalledTimes(1);
    expect(runner.release).not.toHaveBeenCalled();
    expect(result.plans).toEqual([
      { offerId: plan.offerId, outcome: 'completed', detail: 'none', notice: 'sent' },
    ]);
    expect(notices.map((n) => [n.offerId, n.outcome, n.amountChargedCents])).toEqual([
      [plan.offerId, 'completed', 9800],
    ]);
    expect((await offerRow(plan.offerId)).status).toBe('completed');
  });

  it('leaves planned, terminal and one-shot signup rows untouched', async () => {
    const pending = await pendingOffer();
    const planned = await plannedOffer();
    const completed = await plannedOffer();
    const handedBack = await plannedOffer();
    const oneShot = await pendingOffer();
    await db.database
      .update(offers)
      .set({ status: 'completed' })
      .where(eq(offers.id, completed.offerId));
    await db.database
      .update(offers)
      .set({ status: 'handed_back' })
      .where(eq(offers.id, handedBack.offerId));
    await db.database
      .update(offers)
      .set({ status: 'submitting' })
      .where(eq(offers.id, oneShot.offerId));
    const untouched = [pending, planned, completed, handedBack, oneShot];
    const before = await Promise.all(untouched.map((row) => offerRow(row.offerId)));
    const running = await runningPlan(QUEUED);

    expect(await requestStopForRunningPlans(db.database, { now: NOW })).toEqual({
      signup: 1,
      paying: 0,
    });

    expect(await Promise.all(untouched.map((row) => offerRow(row.offerId)))).toEqual(before);
    for (const row of untouched) expect(await stopRows(row.offerId)).toEqual([]);
    expect((await offerRow(running.offerId)).planCancelRequestedAt).toEqual(NOW);
  });

  it('a second stop keeps the first time and writes no second audit row', async () => {
    const signup = await runningPlan(QUEUED);
    const paying = await runningPlan(PAYING);
    await requestStopForRunningPlans(db.database, { now: NOW });

    expect(await requestStopForRunningPlans(db.database, { now: NEXT_SWEEP })).toEqual({
      signup: 0,
      paying: 0,
    });

    expect((await offerRow(signup.offerId)).planCancelRequestedAt).toEqual(NOW);
    expect(await stopRows(signup.offerId)).toEqual([
      {
        familyId: signup.familyId,
        actor: 'system',
        actionTaken: 'authorized_signup_step',
        targetTable: 'authorized_signup_offers',
        after: { step: 'plan_ops_stop', phase: 'signup' },
      },
    ]);
    expect(await stopRows(paying.offerId)).toEqual([
      {
        familyId: paying.familyId,
        actor: 'system',
        actionTaken: 'authorized_signup_step',
        targetTable: 'authorized_signup_offers',
        after: { step: 'plan_ops_stop', phase: 'paying' },
      },
    ]);
  });

  it('keeps the time of a take-back the parent already made', async () => {
    const plan = await runningPlan(QUEUED);
    await db.database
      .update(offers)
      .set({ planCancelRequestedAt: OPENS })
      .where(eq(offers.id, plan.offerId));

    expect(await requestStopForRunningPlans(db.database, { now: NOW })).toEqual({
      signup: 0,
      paying: 0,
    });

    expect((await offerRow(plan.offerId)).planCancelRequestedAt).toEqual(OPENS);
    expect(await stopRows(plan.offerId)).toEqual([]);
  });

  it('with the run flag off the stop still lands, but no sweep lets the run go', async () => {
    vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, '');
    const plan = await runningPlan(QUEUED);

    expect(await requestStopForRunningPlans(db.database, { now: NOW })).toEqual({
      signup: 1,
      paying: 0,
    });

    const { runner, deps } = sweepDeps();
    expect(await runDueSignupPlans(db.database, { now: NEXT_SWEEP }, deps)).toEqual({
      skipped: 'flag_off',
      plans: [],
    });
    expect(runner.release).not.toHaveBeenCalled();
    const row = await offerRow(plan.offerId);
    expect(row.status).toBe('submitting');
    expect(row.planCancelRequestedAt).toEqual(NOW);
  });

  it('a stopped plan a sweep puts back before its open never runs at the open', async () => {
    vi.stubEnv(REGISTRATION_PLAN_AT_OPEN_ENABLED_ENV, 'true');
    const plan = await runningPlan(UNSTARTED);
    await requestStopForRunningPlans(db.database, { now: NOW });
    const { runner, notices, deps } = sweepDeps();

    await runDueSignupPlans(db.database, { now: NEXT_SWEEP }, deps);
    const returned = await offerRow(plan.offerId);
    expect(returned.status).toBe('planned');
    expect(returned.planCancelRequestedAt).toEqual(NOW);

    const atOpen = await runDueSignupPlans(
      db.database,
      { now: new Date(OPENS.getTime() + 60_000) },
      deps,
    );

    expect(atOpen.plans).toEqual([
      {
        offerId: plan.offerId,
        outcome: 'cancelled',
        detail: 'authorization_lapsed',
        notice: 'withheld',
      },
    ]);
    expect(runner.run).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect((await offerRow(plan.offerId)).status).toBe('handed_back');
  });
});

describe('the stop-signup-plans script', () => {
  it('by default prints counts only and writes nothing', async () => {
    const stopped = await runningPlan(PAYING);
    await requestStopForRunningPlans(db.database, { now: NOW });
    const signup = await runningPlan(QUEUED);
    const paying = await runningPlan(PAYING);
    const ids = [stopped, signup, paying];
    const before = await Promise.all(ids.map((row) => offerRow(row.offerId)));

    const { stdout, stderr, exit } = await runScript(db.database);

    expect(stdout).toEqual([
      '{"mode":"dry_run","wouldStop":{"signup":1,"paying":1},"stillRunning":{"signup":1,"paying":2}}',
    ]);
    expect(exit).toHaveBeenCalledWith(0);
    const printed = [...stdout, ...stderr].join('\n');
    for (const row of ids) {
      expect(printed).not.toContain(row.offerId);
      expect(printed).not.toContain(row.familyId);
    }
    expect(printed).not.toContain(AUTO_HOST);
    expect(await Promise.all(ids.map((row) => offerRow(row.offerId)))).toEqual(before);
    expect(await stopRows(signup.offerId)).toEqual([]);
    expect(await stopRows(paying.offerId)).toEqual([]);
  });

  it('on a database failure prints the error code and never what the error carries', async () => {
    const familyId = '11111111-1111-4111-8111-111111111111';
    const failing = {
      select: () => {
        throw Object.assign(new Error(`Key (family_id)=(${familyId}) is not present`), {
          code: '23503',
        });
      },
    };

    const { stdout, stderr, exit } = await runScript(failing);

    expect(stdout).toEqual([]);
    expect(stderr.at(-1)).toBe('{"mode":"dry_run","failed":"23503"}');
    expect(stderr.join('\n')).not.toContain(familyId);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
