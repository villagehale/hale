import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import {
  type BrowserUsePlanInput,
  type BrowserUsePlanResult,
  PlanEngineThrew,
  type PlanPayingToken,
  type PlanResumeToken,
} from '../browser-use/plan-engine';
import { storeProviderSession } from '../browser-use/vault';
import { recordSignupOffer } from '../store';
import type { PlanNoticePart } from './bubbles';
import {
  PLAN_OPS_STOP_ENABLED_ENV,
  REGISTRATION_PLAN_AT_OPEN_ENABLED_ENV,
  REGISTRATION_PLAN_RUN_ENABLED_ENV,
} from './flag';
import type { PlanPrepFacts } from './prep';
import {
  type PlanOutcomeNotice,
  type PlanRunDetail,
  type PlanSignupRunner,
  runDueSignupPlans,
} from './run';
import {
  approveSignupPlan,
  cancelSignupPlan,
  countRunningPlans,
  loadConversablePlans,
  planOpsStopped,
  planTakenBack,
  requestStopForRunningPlans,
  runPlanStop,
  savePlanResume,
} from './store';

const scriptDb = vi.hoisted(() => ({ current: null as unknown, realDriver: false }));
vi.mock('@hale/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: (options: Parameters<typeof actual.createDb>[0]) =>
      scriptDb.realDriver ? actual.createDb(options) : scriptDb.current,
  };
});

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

/** A run that stopped at checkout and left its browser open for the parent. */
const UNPAID: BrowserUsePlanResult = {
  outcome: 'needs_human',
  detail: 'no_saved_card',
  choiceIndex: 0,
  liveViewUrl: 'https://live.example-browser.test/session-1',
  checkoutUrl: null,
  holdExpiresAt: new Date(NOW.getTime() + 10 * 60_000),
  cartTotalCents: 9800,
  confirmationNumber: null,
  opensAt: null,
  amountChargedCents: null,
  runId: 'run-1',
  sessionId: 'bu-session-1',
  costUsd: '0.0400',
  sessionCostUsd: null,
  browserId: 'browser-1',
  charged: 'nothing',
};
/** The engine already closed this one's browser and read its cost. */
const CLOSED: BrowserUsePlanResult = {
  ...UNPAID,
  liveViewUrl: null,
  holdExpiresAt: null,
  sessionCostUsd: '0.050000',
};
const OPEN_BROWSER: PlanResumeToken = {
  phase: 'signup',
  runId: 'run-1',
  sessionId: 'bu-session-1',
  browserId: 'browser-1',
};
const RELEASED_COST = '0.120000';
/** A sweep-level detail on an engine result: the ending is judged the same on either path. */
const atDetail = (detail: PlanRunDetail): BrowserUsePlanResult => ({
  ...CLOSED,
  detail: detail as BrowserUsePlanResult['detail'],
});
const SITE_CHOICES = [
  {
    id: 'nov-21',
    label: 'Nov 21',
    starts_at: '2026-11-21',
    price_cents: 12000,
    waitlist: false,
    billing_note: 'billed December',
    provider_email: 'rec@example.test',
  },
];

let db: TestDb;
let messageSeq = 0;
let phoneSeq = 0;
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
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
});
afterEach(() => {
  process.argv = realArgv;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

/** A plan the next sweep claims and runs: an enrolled parent, a consent and a city login. */
async function dueFamily() {
  const seeded = await seedFamily(db.database);
  phoneSeq += 1;
  const phone = `+1202555${String(100 + phoneSeq).padStart(4, '0')}`;
  await db.database.insert(schema.parentChannels).values({
    userId: seeded.parentUserId,
    familyId: seeded.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
  });
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
  messageSeq += 1;
  const approved = await approveSignupPlan(db.database, {
    offerId: offer.id,
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    messageId: `msg-plan-${messageSeq}`,
    choiceIds: ['sat-0900'],
    maxPriceCents: 10000,
    opensAt: OPENS,
    waiverAccepted: true,
    now: new Date(NOW.getTime() - 20 * 60 * 60_000),
  });
  if (!approved.ok) throw new Error(approved.reason);
  const stored = await storeProviderSession(db.database, {
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    providerHost: AUTO_HOST,
    storageState: { cookies: [{ name: 'SID', value: 'c', domain: `.${AUTO_HOST}` }] },
    capturedAt: new Date(NOW.getTime() - 60 * 60_000),
  });
  if (!stored.ok) throw new Error('the city login was not stored');
  return { offerId: offer.id, familyId: seeded.familyId, parentUserId: seeded.parentUserId };
}

/** A run that ends as `ending`. `during` is what lands on the plan while the run is going. */
function runEndingAt(ending: BrowserUsePlanResult, during: () => Promise<unknown>) {
  return {
    run: vi.fn(async (input: BrowserUsePlanInput) => {
      await input.onCheckpoint(QUEUED);
      await during();
      return ending;
    }),
    release: vi.fn(async (_resume: PlanResumeToken) => RELEASED_COST),
    settlePayment: vi.fn(async (): Promise<BrowserUsePlanResult> => {
      throw new Error('no payment under way');
    }),
  };
}

const opsStop = () => requestStopForRunningPlans(db.database, { now: NOW });
const nothingLands = async () => undefined;

/** Every #ops page the sweep posts. */
function opsPages() {
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.test/ops-fixture');
  const paged: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
    paged.push(JSON.parse(init?.body ?? '{}').text);
    return new Response('ok', { status: 200 });
  });
  return paged;
}
const stopPage = (offerId: string) =>
  `Hale: ops page. site registration_stop_unverified. ref ${offerId}.`;

/** Sweep wiring that records every text a plan's end would send. */
function hearing(runner: PlanSignupRunner) {
  const notices: PlanOutcomeNotice[] = [];
  const asks: PlanNoticePart[] = [];
  return {
    notices,
    asks,
    deps: {
      runner,
      autoHosts: [AUTO_HOST],
      notifyParent: async (notice: PlanOutcomeNotice) => {
        notices.push(notice);
        return 'sent' as const;
      },
      prep: {
        writer: {
          write: async (facts: PlanPrepFacts) => ({
            bubbles: [`ask for ${facts.kind}`],
            card: facts.loginCard ? { title: 'New link', description: 'Swim' } : null,
          }),
        },
        deliver: async (input: { parts: readonly PlanNoticePart[] }) => {
          asks.push(...input.parts);
          return 'sent' as const;
        },
      },
    },
  };
}

const firstBody = (parts: readonly PlanNoticePart[]) => {
  const first = parts[0];
  return first?.type === 'link' ? first.url : first?.body;
};

async function finishedRow(offerId: string) {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetId, offerId),
        sql`${schema.auditLog.after}->>'step' = 'plan_finished'`,
      ),
    );
  expect(rows).toHaveLength(1);
  return rows[0]?.after as Record<string, unknown>;
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
async function runScript(
  database: unknown,
  options: { args?: string[]; realDriverUrl?: string } = {},
) {
  scriptDb.current = database;
  scriptDb.realDriver = options.realDriverUrl !== undefined;
  vi.stubEnv('DATABASE_URL', options.realDriverUrl ?? 'postgres://unused.invalid/none');
  process.argv = ['node', 'stop-signup-plans.ts', ...(options.args ?? [])];
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
  it('is honoured by a deployment with the flag unset, because only --apply writes one', async () => {
    expect(process.env[PLAN_OPS_STOP_ENABLED_ENV]).toBeUndefined();
    const plan = await runningPlan(QUEUED);
    expect(await planOpsStopped(db.database, plan)).toBe(false);

    await requestStopForRunningPlans(db.database, { now: NOW });

    expect(await planOpsStopped(db.database, plan)).toBe(true);
  });

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

  it('a run let go with its answer unread tells the parent Hale cannot say what it did', async () => {
    const paged = opsPages();
    const plan = await runningPlan(QUEUED);
    await requestStopForRunningPlans(db.database, { now: NOW });
    const { runner, notices, deps } = sweepDeps();

    const result = await runDueSignupPlans(db.database, { now: NEXT_SWEEP }, deps);

    expect(result.plans).toEqual([
      { offerId: plan.offerId, outcome: 'needs_human', detail: 'unconfirmed', notice: 'sent' },
    ]);
    expect(runner.release).toHaveBeenCalledWith(QUEUED);
    expect(runner.run).not.toHaveBeenCalled();
    expect(notices.map((n) => [n.offerId, n.outcome, n.detail, n.charged, n.liveViewUrl])).toEqual([
      [plan.offerId, 'needs_human', 'unconfirmed', 'unknown', null],
    ]);
    expect(paged).toEqual([stopPage(plan.offerId)]);
    expect((await offerRow(plan.offerId)).status).toBe('handed_back');
    expect(await finishedRow(plan.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'unconfirmed',
      charged: 'unknown',
      notice: 'sent',
      stoppedFrom: { outcome: 'cancelled', detail: 'authorization_lapsed' },
    });
  });

  it("a parent's own take-back of a queued run stays silent, with no page", async () => {
    const paged = opsPages();
    const plan = await runningPlan(QUEUED);
    await db.database
      .update(offers)
      .set({ planCancelRequestedAt: NOW })
      .where(eq(offers.id, plan.offerId));
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
    expect(notices).toEqual([]);
    expect(paged).toEqual([]);
    expect(await finishedRow(plan.offerId)).not.toHaveProperty('stoppedFrom');
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

  it('also covers a plan the parent already took back, and keeps their time', async () => {
    const plan = await runningPlan(QUEUED);
    await db.database
      .update(offers)
      .set({ planCancelRequestedAt: OPENS })
      .where(eq(offers.id, plan.offerId));

    expect(await requestStopForRunningPlans(db.database, { now: NOW })).toEqual({
      signup: 1,
      paying: 0,
    });

    expect((await offerRow(plan.offerId)).planCancelRequestedAt).toEqual(OPENS);
    expect(await stopRows(plan.offerId)).toHaveLength(1);
    expect(await requestStopForRunningPlans(db.database, { now: NEXT_SWEEP })).toEqual({
      signup: 0,
      paying: 0,
    });
    expect(await stopRows(plan.offerId)).toHaveLength(1);
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

  it('a stopped plan before its open is let go, never put back to planned', async () => {
    vi.stubEnv(REGISTRATION_PLAN_AT_OPEN_ENABLED_ENV, 'true');
    const plan = await runningPlan(UNSTARTED);
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
    expect((await offerRow(plan.offerId)).status).toBe('handed_back');
    expect(
      await loadConversablePlans(db.database, { familyId: plan.familyId, now: NEXT_SWEEP }),
    ).toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
    expect(notices).toEqual([]);

    const notStopped = await runningPlan(UNSTARTED);
    await runDueSignupPlans(db.database, { now: NEXT_SWEEP }, deps);
    expect((await offerRow(notStopped.offerId)).status).toBe('planned');
  });
});

describe('a stop that lands while the run is going', () => {
  const STOPPED_SUMMARY = {
    outcome: 'cancelled',
    detail: 'authorization_lapsed',
    notice: 'withheld',
  };

  it.each<[string, BrowserUsePlanResult]>([
    ['no saved card', UNPAID],
    ['a security code', { ...UNPAID, detail: 'security_code' }],
    ['a price change', { ...UNPAID, detail: 'price_change' }],
    ['the spending cap', { ...UNPAID, detail: 'spending_cap' }],
    ['the payment switch off', { ...UNPAID, detail: 'payment_off' }],
    ['a total not read at review', { ...UNPAID, detail: 'total_unread' }],
    ['a currency not read at review', { ...UNPAID, detail: 'currency_unknown' }],
    ['a choice it could not read', { ...CLOSED, detail: 'choice_unreadable' }],
    ['a cart with no live view', { ...CLOSED, outcome: 'error', detail: 'no_live_view' }],
    ['a login wall', { ...UNPAID, outcome: 'needs_login', detail: 'login_wall' }],
    ['a verification code', { ...UNPAID, detail: 'verification_code' }],
    ['a waiver', { ...UNPAID, detail: 'waiver' }],
    ['a medical question', { ...UNPAID, detail: 'medical' }],
    ['an unexpected field', { ...CLOSED, detail: 'unexpected_field' }],
    ['a captcha', { ...CLOSED, detail: 'captcha' }],
    ['a waiting room', { ...CLOSED, outcome: 'not_open', detail: 'waiting_room' }],
    ['a timed open', { ...CLOSED, outcome: 'not_open', detail: 'timed_open' }],
    ['a session it could not find', { ...CLOSED, detail: 'session_not_found' }],
    ['a page error', { ...CLOSED, outcome: 'error', detail: 'page_error' }],
    ['a form filled for the parent', { ...UNPAID, outcome: 'ready_for_parent', detail: 'none' }],
    ['sold out', { ...CLOSED, outcome: 'sold_out', detail: 'none' }],
    ['not open yet', { ...CLOSED, outcome: 'not_open', detail: 'none' }],
    ['a stop with no detail', { ...CLOSED, detail: 'none' }],
    ['a login with no detail', { ...CLOSED, outcome: 'needs_login', detail: 'none' }],
    ['no seed browser', { ...CLOSED, outcome: 'error', detail: 'browser_unavailable' }],
    ['no seeder', { ...CLOSED, outcome: 'error', detail: 'seed_unavailable' }],
    ['a failed seed', { ...CLOSED, outcome: 'error', detail: 'seed_failed' }],
    ['a refused URL', atDetail('url_refused')],
    ['a missed open', atDetail('missed_open')],
    ['a parent town', atDetail('parent_town')],
    ['choices gone', atDetail('choices_gone')],
    ['a missing detail', atDetail('missing_detail')],
    ['a missing consent', atDetail('consent_missing')],
    ['a wider consent', atDetail('consent_wider')],
    ['no city login', { ...atDetail('no_provider_session'), outcome: 'needs_login' }],
    ['the spend reserve', { ...atDetail('spend_reserve_reached'), outcome: 'error' }],
  ])('ending at %s, the parent hears nothing and the browser is let go', async (_name, ending) => {
    const paged = opsPages();
    const plan = await dueFamily();
    const runner = runEndingAt(ending, opsStop);
    const stopped = hearing(runner);

    const result = await runDueSignupPlans(db.database, { now: NOW }, stopped.deps);

    expect(result.plans).toEqual([{ offerId: plan.offerId, ...STOPPED_SUMMARY }]);
    expect(stopped.notices).toEqual([]);
    expect(stopped.asks).toEqual([]);
    const row = await offerRow(plan.offerId);
    expect(row.status).toBe('handed_back');
    expect(runner.release.mock.calls).toEqual(ending.liveViewUrl ? [[OPEN_BROWSER]] : []);
    expect(Number(row.browserUseCostUsd)).toBe(
      Number(ending.liveViewUrl ? RELEASED_COST : ending.sessionCostUsd),
    );
    expect(await finishedRow(plan.offerId)).toMatchObject({
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
      charged: 'nothing',
      notice: 'withheld',
      stoppedFrom: { outcome: ending.outcome, detail: ending.detail },
    });
    expect(paged).toEqual([]);

    const control = await dueFamily();
    const heard = hearing(runEndingAt(ending, nothingLands));
    await runDueSignupPlans(db.database, { now: NOW }, heard.deps);
    expect(heard.notices.map((n) => [n.offerId, n.outcome, n.detail, n.liveViewUrl])).toEqual([
      [control.offerId, ending.outcome, ending.detail, ending.liveViewUrl],
    ]);
  });

  it.each<[string, BrowserUsePlanResult]>([
    ['an agent that says it submitted', { ...CLOSED, outcome: 'error', detail: 'submit_boundary' }],
    ['payment details entered', { ...CLOSED, outcome: 'error', detail: 'payment_boundary' }],
    ['a waitlist', { ...CLOSED, outcome: 'waitlist', detail: 'none' }],
    ['a waitlist with a listed detail', { ...CLOSED, outcome: 'waitlist', detail: 'page_error' }],
    ['a failed run', { ...CLOSED, outcome: 'error', detail: 'run_failed' }],
    ['a cancelled run', { ...CLOSED, outcome: 'error', detail: 'run_cancelled' }],
    ['a run that timed out', { ...CLOSED, outcome: 'needs_human', detail: 'timeout' }],
    ['an answer it could not read', { ...CLOSED, outcome: 'error', detail: 'unreadable_output' }],
    ['an API error', { ...CLOSED, outcome: 'error', detail: 'api_error' }],
    ['an error with no detail', { ...CLOSED, outcome: 'error', detail: 'none' }],
    [
      'a detail added later',
      { ...atDetail('a_detail_added_later' as PlanRunDetail), outcome: 'error' },
    ],
  ])('ending at %s, the parent is told and #ops is paged once', async (_name, ending) => {
    const paged = opsPages();
    const plan = await dueFamily();
    const runner = runEndingAt(ending, opsStop);
    const stopped = hearing(runner);

    const result = await runDueSignupPlans(db.database, { now: NOW }, stopped.deps);

    expect(result.plans).toEqual([
      { offerId: plan.offerId, outcome: ending.outcome, detail: ending.detail, notice: 'sent' },
    ]);
    expect(stopped.notices.map((n) => [n.offerId, n.outcome, n.detail, n.charged])).toEqual([
      [plan.offerId, ending.outcome, ending.detail, 'unknown'],
    ]);
    expect(paged).toEqual([stopPage(plan.offerId)]);
    expect(await finishedRow(plan.offerId)).toMatchObject({
      outcome: ending.outcome,
      detail: ending.detail,
      charged: 'unknown',
      notice: 'sent',
      stoppedFrom: { outcome: ending.outcome, detail: ending.detail },
    });
  });

  it('ending at the check before payment, the parent hears nothing and #ops is not paged', async () => {
    const paged = opsPages();
    const plan = await dueFamily();
    const ending: BrowserUsePlanResult = {
      ...CLOSED,
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
    };
    const stopped = hearing(runEndingAt(ending, opsStop));

    const result = await runDueSignupPlans(db.database, { now: NOW }, stopped.deps);

    expect(result.plans).toEqual([{ offerId: plan.offerId, ...STOPPED_SUMMARY }]);
    expect(stopped.notices).toEqual([]);
    expect(paged).toEqual([]);
  });

  it.each([
    ['once a session started', 'run-1', 'bu-session-1'],
    ['naming no session, since the create call may have reached the provider', null, null],
  ])(
    'an engine that throws %s tells the parent and pages once',
    async (_name, runId, sessionId) => {
      const paged = opsPages();
      const plan = await dueFamily();
      const stopped = hearing({
        ...runEndingAt(UNPAID, nothingLands),
        run: async () => {
          await opsStop();
          throw new PlanEngineThrew(new TypeError('fetch failed'), {
            runId,
            sessionId,
            browserId: null,
            sessionCostUsd: null,
            reviewStarted: false,
          });
        },
      });

      const result = await runDueSignupPlans(db.database, { now: NOW }, stopped.deps);

      expect(result.plans).toEqual([
        { offerId: plan.offerId, outcome: 'error', detail: 'engine_threw', notice: 'sent' },
      ]);
      expect(stopped.notices.map((n) => [n.offerId, n.detail])).toEqual([
        [plan.offerId, 'engine_threw'],
      ]);
      expect(paged).toEqual([stopPage(plan.offerId)]);
    },
  );

  it.each<[string, BrowserUsePlanResult, string]>([
    [
      'options that do not match',
      { ...CLOSED, outcome: 'options_mismatch', detail: 'none', siteChoices: SITE_CHOICES },
      'ask for options_mismatch',
    ],
    [
      'a rejected password',
      {
        ...UNPAID,
        outcome: 'needs_login',
        detail: 'password_rejected',
        passwordRejectionMessage: 'Password must include a number',
        passwordRule: '8 characters and a number',
      },
      'ask for password_rejected',
    ],
  ])('ending at %s, nothing is asked and the plan is not parked', async (_name, ending, ask) => {
    const plan = await dueFamily();
    const runner = runEndingAt(ending, opsStop);
    const stopped = hearing(runner);

    const result = await runDueSignupPlans(db.database, { now: NOW }, stopped.deps);

    expect(result.plans).toEqual([{ offerId: plan.offerId, ...STOPPED_SUMMARY }]);
    expect(stopped.asks).toEqual([]);
    expect(stopped.notices).toEqual([]);
    const row = await offerRow(plan.offerId);
    expect(row.status).toBe('handed_back');
    expect(row.planAvailability).toBeNull();
    expect(runner.release.mock.calls).toEqual(ending.liveViewUrl ? [[OPEN_BROWSER]] : []);
    expect(await loadConversablePlans(db.database, { familyId: plan.familyId, now: NOW })).toEqual(
      [],
    );
    expect((await countRunningPlans(db.database)).running).toEqual({ signup: 0, paying: 0 });

    const control = await dueFamily();
    const heard = hearing(runEndingAt(ending, nothingLands));
    await runDueSignupPlans(db.database, { now: NOW }, heard.deps);
    expect(firstBody(heard.asks)).toBe(ask);
    expect((await offerRow(control.offerId)).status).toBe('planned');
  });

  it('a review that may have placed the order still reaches the parent', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.test/ops-fixture');
    const paged: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
      paged.push(JSON.parse(init?.body ?? '{}').text);
      return new Response('ok', { status: 200 });
    });
    const plan = await dueFamily();
    const runner = runEndingAt(
      { ...UNPAID, detail: 'review_placed_order', charged: 'unknown' },
      opsStop,
    );
    const stopped = hearing(runner);

    await runDueSignupPlans(db.database, { now: NOW }, stopped.deps);

    expect(stopped.notices.map((n) => [n.offerId, n.detail, n.charged, n.liveViewUrl])).toEqual([
      [plan.offerId, 'review_placed_order', 'unknown', UNPAID.liveViewUrl],
    ]);
    expect(runner.release).not.toHaveBeenCalled();
    expect(paged).toEqual([
      `Hale: ops page. site registration_review_placed_order. ref ${plan.offerId}.`,
    ]);
  });

  it('a plan past its paying checkpoint is counted under paying and its parent is told', async () => {
    const plan = await dueFamily();
    let stopped: Awaited<ReturnType<typeof opsStop>> | null = null;
    const heard = hearing({
      ...runEndingAt(PAID, nothingLands),
      run: async (input: BrowserUsePlanInput) => {
        expect(await input.onCheckpoint({ ...PAYING, runId: null })).toBe(true);
        stopped = await opsStop();
        return PAID;
      },
    });

    await runDueSignupPlans(db.database, { now: NOW }, heard.deps);

    expect(stopped).toEqual({ signup: 0, paying: 1 });
    expect(heard.notices.map((n) => [n.offerId, n.outcome, n.amountChargedCents])).toEqual([
      [plan.offerId, 'completed', 9800],
    ]);
    expect((await offerRow(plan.offerId)).status).toBe('completed');
  });

  it('a decline read from a payment already under way still reaches the parent', async () => {
    const plan = await runningPlan(PAYING);
    await opsStop();
    const paged = opsPages();
    const { notices, deps } = sweepDeps({
      ...PAID,
      outcome: 'payment_not_approved',
      detail: 'card_declined',
      confirmationNumber: null,
      amountChargedCents: null,
      charged: 'nothing',
    });

    await runDueSignupPlans(db.database, { now: NEXT_SWEEP }, deps);

    expect(notices.map((n) => [n.offerId, n.outcome, n.detail, n.charged])).toEqual([
      [plan.offerId, 'payment_not_approved', 'card_declined', 'nothing'],
    ]);
    expect(paged).not.toContain(stopPage(plan.offerId));
  });

  it("a parent's own take-back during a run still hears how the run ended", async () => {
    const plan = await dueFamily();
    const runner = runEndingAt(UNPAID, () =>
      cancelSignupPlan(db.database, {
        offerId: plan.offerId,
        familyId: plan.familyId,
        actor: plan.parentUserId,
        now: NOW,
      }),
    );
    const parent = hearing(runner);

    await runDueSignupPlans(db.database, { now: NOW }, parent.deps);

    expect(parent.notices.map((n) => [n.offerId, n.detail, n.liveViewUrl])).toEqual([
      [plan.offerId, 'no_saved_card', UNPAID.liveViewUrl],
    ]);
    expect(runner.release).not.toHaveBeenCalled();
  });

  it('a plan the parent took back before the stop also ends without a text', async () => {
    const plan = await dueFamily();
    const stopped = hearing(
      runEndingAt(UNPAID, async () => {
        await cancelSignupPlan(db.database, {
          offerId: plan.offerId,
          familyId: plan.familyId,
          actor: plan.parentUserId,
          now: NOW,
        });
        await opsStop();
      }),
    );

    const result = await runDueSignupPlans(db.database, { now: NOW }, stopped.deps);

    expect(result.plans).toEqual([{ offerId: plan.offerId, ...STOPPED_SUMMARY }]);
    expect(stopped.notices).toEqual([]);
  });
});

describe('the stop-signup-plans script', () => {
  beforeEach(() => {
    vi.stubEnv(PLAN_OPS_STOP_ENABLED_ENV, 'true');
  });

  it('with apply, marks every running plan once and reports the counts', async () => {
    const signup = await runningPlan(QUEUED);
    const paying = await runningPlan(PAYING);
    const planned = await plannedOffer();

    expect(await runPlanStop(db.database, { apply: true, now: NOW })).toEqual({
      mode: 'apply',
      stopped: { signup: 1, paying: 1 },
      stillRunning: { signup: 1, paying: 1 },
    });

    for (const row of [signup, paying]) {
      expect((await offerRow(row.offerId)).planCancelRequestedAt).toEqual(NOW);
      expect(await stopRows(row.offerId)).toHaveLength(1);
    }
    expect((await offerRow(planned.offerId)).planCancelRequestedAt).toBeNull();
    expect(await stopRows(planned.offerId)).toEqual([]);

    expect(await runPlanStop(db.database, { apply: true, now: NEXT_SWEEP })).toEqual({
      mode: 'apply',
      stopped: { signup: 0, paying: 0 },
      stillRunning: { signup: 1, paying: 1 },
    });
    expect((await offerRow(signup.offerId)).planCancelRequestedAt).toEqual(NOW);
  });

  it('without apply, reports what it would stop and writes nothing', async () => {
    const signup = await runningPlan(QUEUED);
    const before = await offerRow(signup.offerId);

    expect(await runPlanStop(db.database, { apply: false, now: NOW })).toEqual({
      mode: 'dry_run',
      wouldStop: { signup: 1, paying: 0 },
      stillRunning: { signup: 1, paying: 0 },
    });

    expect(await offerRow(signup.offerId)).toEqual(before);
    expect(await stopRows(signup.offerId)).toEqual([]);
  });

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

  it('on a malformed DATABASE_URL prints the error code and no part of the URL', async () => {
    const user = 'fake_user';
    const password = 'pa#ss-FAKE';
    const host = 'db.example.invalid';
    const url = `postgres://${user}:${password}@${host}:6543/postgres`;
    const { createDb } = await vi.importActual<typeof import('@hale/db')>('@hale/db');
    expect(() => createDb({ connectionString: url })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_URL', input: url }),
    );

    const { stdout, stderr, exit } = await runScript(null, { realDriverUrl: url });

    expect(stdout).toEqual([]);
    expect(stderr.at(-1)).toBe('{"mode":"dry_run","failed":"ERR_INVALID_URL"}');
    const printed = stderr.join('\n');
    for (const part of [user, password, host]) expect(printed).not.toContain(part);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('with --apply and the flag off, refuses, names the flag and writes nothing', async () => {
    vi.stubEnv(PLAN_OPS_STOP_ENABLED_ENV, 'TRUE');
    const plan = await runningPlan(QUEUED);
    const before = await offerRow(plan.offerId);

    const { stdout, stderr, exit } = await runScript(db.database, { args: ['--apply'] });

    expect(stdout).toEqual([]);
    expect(stderr.at(-1)).toBe('{"mode":"apply","refused":"PLAN_OPS_STOP_ENABLED"}');
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).not.toHaveBeenCalledWith(0);
    expect(await offerRow(plan.offerId)).toEqual(before);
    expect(await stopRows(plan.offerId)).toEqual([]);
  });

  it('the dry run works with the flag off', async () => {
    vi.stubEnv(PLAN_OPS_STOP_ENABLED_ENV, '');
    await runningPlan(QUEUED);

    const { stdout, exit } = await runScript(db.database);

    expect(stdout).toEqual([
      '{"mode":"dry_run","wouldStop":{"signup":1,"paying":0},"stillRunning":{"signup":1,"paying":0}}',
    ]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('with --apply, marks the running plan and writes its one audit row', async () => {
    const plan = await runningPlan(QUEUED);
    const startedAt = Date.now();

    const { stdout, exit } = await runScript(db.database, { args: ['--apply'] });

    expect(stdout).toEqual([
      '{"mode":"apply","stopped":{"signup":1,"paying":0},"stillRunning":{"signup":1,"paying":0}}',
    ]);
    expect(exit).toHaveBeenCalledWith(0);
    const stampedAt = (await offerRow(plan.offerId)).planCancelRequestedAt?.getTime();
    expect(stampedAt).toBeGreaterThanOrEqual(startedAt);
    expect(stampedAt).toBeLessThanOrEqual(Date.now());
    expect(await stopRows(plan.offerId)).toEqual([
      {
        familyId: plan.familyId,
        actor: 'system',
        actionTaken: 'authorized_signup_step',
        targetTable: 'authorized_signup_offers',
        after: { step: 'plan_ops_stop', phase: 'signup' },
      },
    ]);
  });
});
