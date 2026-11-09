import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import type { BrowserUsePlanInput, BrowserUsePlanResult } from '../browser-use/plan-engine';
import { storeProviderSession } from '../browser-use/vault';
import { recordSignupOffer } from '../store';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import { type PlanOutcomeNotice, type PlanRunDeps, runDueSignupPlans } from './run';
import { approveSignupPlan } from './store';

// Invented hosts and details only. The Browser Use engine is its own tested unit
// (plan-engine.test.ts); here a stand-in runner reports steps the way it does.
const NOW = new Date('2026-12-01T11:58:00.000Z');
const OPENS = new Date('2026-12-01T12:00:00.000Z');
const AUTO_HOST = 'register.example-rec.test';
const AUTO_URL = `https://${AUTO_HOST}/Clients/BookMe4LandingPages/CoursesLandingPage`;
const ASSISTED_URL = 'https://anc.ca.apm.activecommunities.com/exampleville/activity/detail/1';
const SESSIONS = [
  {
    id: 'sat-0900',
    label: 'Preschool Swim Sat 9:00',
    startsAt: '2027-01-09T14:00:00.000Z',
    endsAt: '2027-01-09T14:45:00.000Z',
    full: false,
    priceCents: 9800,
  },
  {
    id: 'sun-1000',
    label: 'Preschool Swim Sun 10:00',
    startsAt: '2027-01-10T15:00:00.000Z',
    endsAt: '2027-01-10T15:45:00.000Z',
    full: false,
    priceCents: 9800,
  },
];

let db: TestDb;
let messageSeq = 0;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.database.update(schema.authorizedSignupOffers).set({ browserUseCostUsd: null });
  vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, 'true');
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function plannedFamily(
  options: { url?: string; maxPriceCents?: number; opensAt?: Date; session?: boolean } = {},
) {
  const seeded = await seedFamily(db.database);
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
  const url = options.url ?? AUTO_URL;
  const offer = await recordSignupOffer(db.database, {
    familyId: seeded.familyId,
    childId,
    parentUserId: seeded.parentUserId,
    activityKey: 'swim-preschool',
    registrationUrl: url,
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
    choiceIds: ['sat-0900', 'sun-1000'],
    maxPriceCents: options.maxPriceCents ?? 10000,
    opensAt: options.opensAt ?? OPENS,
    waiverAccepted: true,
    now: new Date(NOW.getTime() - 20 * 60 * 60_000),
  });
  expect(approved).toEqual({ ok: true });
  if (options.session !== false) {
    const stored = await storeProviderSession(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      providerHost: new URL(url).hostname,
      storageState: { cookies: [{ name: 'SID', value: 'c', domain: `.${new URL(url).hostname}` }] },
      capturedAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    expect(stored.ok).toBe(true);
  }
  return { ...seeded, offerId: offer.id };
}

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
  runId: 'run-1',
  sessionId: 'bu-session-1',
  costUsd: '0.0500',
  sessionCostUsd: '0.090000',
  browserId: 'browser-1',
};

/** Reports steps and asks the cap the way the engine does, then returns `result`. */
function engineLike(result: BrowserUsePlanResult, cartTotalCents = 9800) {
  const inputs: BrowserUsePlanInput[] = [];
  const caps: { ok: boolean }[] = [];
  const runner = {
    run: vi.fn(async (input: BrowserUsePlanInput) => {
      inputs.push(input);
      await input.onStep({ step: 'checkout', choiceIndex: 1, cartTotalCents });
      const cap = await input.checkSpendingCap(cartTotalCents);
      caps.push(cap);
      await input.onStep({ step: 'spending_cap', amountCents: cartTotalCents, ok: cap.ok });
      if (!cap.ok)
        return { ...result, outcome: 'needs_human' as const, detail: 'spending_cap' as const };
      await input.onStep({
        step: 'payment',
        outcome: result.outcome,
        detail: result.detail,
        amountChargedCents: result.amountChargedCents,
        confirmed: result.confirmationNumber !== null,
      });
      return result;
    }),
  };
  return { runner, inputs, caps };
}

function deps(runner: PlanRunDeps['runner']) {
  const notices: PlanOutcomeNotice[] = [];
  const value: PlanRunDeps = {
    runner,
    autoHosts: [AUTO_HOST],
    notifyParent: async (notice) => {
      notices.push(notice);
      return 'sent';
    },
  };
  return { deps: value, notices };
}

async function offerRow(offerId: string) {
  const [row] = await db.database
    .select()
    .from(schema.authorizedSignupOffers)
    .where(eq(schema.authorizedSignupOffers.id, offerId));
  return row;
}

async function steps(offerId: string) {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetId, offerId),
        eq(schema.auditLog.actionTaken, 'authorized_signup_step'),
      ),
    )
    .orderBy(schema.auditLog.occurredAt);
  return rows.map((row) => row.after as Record<string, unknown>);
}

describe('approving a day-before plan', () => {
  it('writes the consent from the approving message, then plans the offer', async () => {
    const family = await plannedFamily();
    const row = await offerRow(family.offerId);
    expect(row).toMatchObject({
      status: 'planned',
      planChoiceIds: ['sat-0900', 'sun-1000'],
      planMaxPriceCents: 10000,
      planWaiverAccepted: true,
    });
    expect(row?.planOpensAt?.toISOString()).toBe(OPENS.toISOString());
    const [consent] = await db.database
      .select()
      .from(schema.authorizedSignupConsents)
      .where(eq(schema.authorizedSignupConsents.familyId, family.familyId));
    expect(consent).toMatchObject({ providerHost: AUTO_HOST, activityKey: 'swim-preschool' });
    expect(consent?.fieldsAllowed).toContain('session');
    expect((await steps(family.offerId)).map((s) => s.step)).toEqual(['plan_approved']);
  });

  it.each([
    ['a session the offer does not have', { choiceIds: ['sat-0900', 'mon-0700'] }, 'choices'],
    ['the same session twice', { choiceIds: ['sat-0900', 'sat-0900'] }, 'choices'],
    ['no choices', { choiceIds: [] }, 'choices'],
    ['a maximum above the 500-dollar ceiling', { maxPriceCents: 50001 }, 'max_price'],
    ['an open time already past', { opensAt: new Date('2026-11-01T12:00:00.000Z') }, 'opens_at'],
  ])('refuses %s and leaves the offer pending', async (_name, change, reason) => {
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
      now: NOW,
    });
    if (!offer.ok) throw new Error(offer.reason);
    const result = await approveSignupPlan(db.database, {
      offerId: offer.id,
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      messageId: 'msg-refused',
      choiceIds: ['sat-0900'],
      maxPriceCents: 10000,
      opensAt: OPENS,
      waiverAccepted: false,
      now: NOW,
      ...change,
    });
    expect(result).toEqual({ ok: false, reason });
    expect((await offerRow(offer.id))?.status).toBe('pending');
  });
});

describe('carrying out plans at the open', () => {
  it('does nothing with the kill switch off: the plan stays planned', async () => {
    const family = await plannedFamily();
    vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, 'true\n');
    const { runner } = engineLike(PAID);
    expect(await runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps)).toEqual({
      skipped: 'flag_off',
      plans: [],
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect((await offerRow(family.offerId))?.status).toBe('planned');

    // Positive control: armed, the same plan runs.
    vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, 'true');
    const armed = await runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps);
    expect(armed.plans.map((p) => p.offerId)).toContain(family.offerId);
  });

  it('registers on an auto town, one audit row per step, and tells the parent', async () => {
    const family = await plannedFamily();
    const { runner, inputs, caps } = engineLike(PAID);
    const { deps: d, notices } = deps(runner);
    const result = await runDueSignupPlans(db.database, { now: NOW }, d);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toEqual({
      offerId: family.offerId,
      outcome: 'completed',
      detail: 'none',
      notice: 'sent',
    });
    const input = inputs.find((i) => i.correlationId === family.offerId);
    expect(input?.choices.map((c) => c.label)).toEqual([
      'Preschool Swim Sat 9:00',
      'Preschool Swim Sun 10:00',
    ]);
    expect(input).toMatchObject({ maxPriceCents: 10000, waiverAccepted: true });
    expect(caps).toEqual([{ ok: true, reason: expect.any(String) }]);
    expect((await offerRow(family.offerId))?.status).toBe('completed');
    expect((await offerRow(family.offerId))?.browserUseCostUsd).toBe('0.090000');

    const audit = await steps(family.offerId);
    expect(audit.map((s) => s.step)).toEqual([
      'plan_approved',
      'plan_started',
      'plan_checkout',
      'plan_spending_cap',
      'plan_payment',
      'plan_finished',
    ]);
    expect(audit.at(-1)).toMatchObject({ outcome: 'completed', confirmed: true, notice: 'sent' });
    const text = JSON.stringify(audit);
    expect(text).not.toContain('Ada');
    expect(text).not.toContain('R-55120');
    expect(text).not.toContain('example.test');
    expect(notices.find((n) => n.offerId === family.offerId)).toMatchObject({
      outcome: 'completed',
      confirmationNumber: 'R-55120',
      choiceIndex: 1,
    });
  });

  it('runs the spending cap at the plan maximum: a cart above it is never paid', async () => {
    const family = await plannedFamily({ maxPriceCents: 9000 });
    const { runner, caps } = engineLike(PAID, 9500);
    const result = await runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps);

    expect(caps).toEqual([{ ok: false, reason: expect.stringContaining('9000') }]);
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'spending_cap',
    });
    const audit = await steps(family.offerId);
    expect(audit.map((s) => s.step)).not.toContain('plan_payment');
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
  });

  it('waits for an open more than a few minutes away', async () => {
    const family = await plannedFamily({ opensAt: new Date(NOW.getTime() + 30 * 60_000) });
    const { runner } = engineLike(PAID);
    await runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps);
    expect((await offerRow(family.offerId))?.status).toBe('planned');
  });

  it('hands an assisted town back to the parent without opening a browser', async () => {
    const family = await plannedFamily({ url: ASSISTED_URL });
    const { runner, inputs } = engineLike(PAID);
    const { deps: d, notices } = deps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, d);

    expect(inputs.some((i) => i.correlationId === family.offerId)).toBe(false);
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
    expect(notices.find((n) => n.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'assisted_town',
    });
    expect((await steps(family.offerId)).map((s) => s.step)).toEqual([
      'plan_approved',
      'plan_started',
      'plan_finished',
    ]);
  });

  it('asks the parent to sign in again when no saved session is left', async () => {
    const family = await plannedFamily({ session: false });
    const { runner } = engineLike(PAID);
    const result = await runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps);
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_login',
      detail: 'no_provider_session',
    });
  });

  it('runs one registration per family at a time', async () => {
    const family = await plannedFamily();
    const childId = await seedChild(db.database, family.familyId, 'Bo', 50, undefined, NOW);
    const second = await recordSignupOffer(db.database, {
      familyId: family.familyId,
      childId,
      parentUserId: family.parentUserId,
      activityKey: 'gym-preschool',
      registrationUrl: AUTO_URL,
      sessions: SESSIONS,
      approvedPriceCents: null,
      now: NOW,
    });
    if (!second.ok) throw new Error(second.reason);
    expect(
      await approveSignupPlan(db.database, {
        offerId: second.id,
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        messageId: 'msg-plan-second',
        choiceIds: ['sun-1000'],
        maxPriceCents: 10000,
        opensAt: OPENS,
        waiverAccepted: false,
        now: new Date(NOW.getTime() - 60 * 60_000),
      }),
    ).toEqual({ ok: true });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = {
      run: vi.fn(async (input: BrowserUsePlanInput) => {
        if (input.correlationId === family.offerId || input.correlationId === second.id) await held;
        return PAID;
      }),
    };
    const first = runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps);
    // A second sweep while the first family's registration is running claims nothing of theirs.
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());
    const overlap = await runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps);
    const ours = [family.offerId, second.id];
    expect(overlap.plans.filter((p) => ours.includes(p.offerId))).toEqual([]);
    release();
    const done = await first;
    expect(done.plans.filter((p) => ours.includes(p.offerId))).toHaveLength(1);
    const statuses = [
      (await offerRow(family.offerId))?.status,
      (await offerRow(second.id))?.status,
    ];
    expect(statuses.sort()).toEqual(['completed', 'planned']);
  });
});
