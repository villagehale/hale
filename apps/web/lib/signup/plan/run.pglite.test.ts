import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import type {
  BrowserUsePlanInput,
  BrowserUsePlanResult,
  PlanResumeToken,
} from '../browser-use/plan-engine';
import { storeProviderSession } from '../browser-use/vault';
import { isOneSubmittingViolation, recordSignupOffer } from '../store';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import {
  PLAN_JOIN_LEAD_MS,
  PLAN_LEASE_MS,
  PLAN_MAX_LATE_MS,
  type PlanOutcomeNotice,
  type PlanRunDeps,
  runDueSignupPlans,
} from './run';
import { approveSignupPlan, cancelSignupPlan, claimDuePlan, savePlanResume } from './store';

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
let phoneSeq = 0;

/** The parent's live channel: enrolled, verified, not revoked. */
async function enrolParent(familyId: string, userId: string) {
  phoneSeq += 1;
  const phone = `+1202555${String(100 + phoneSeq).padStart(4, '0')}`;
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
  });
  return phone;
}

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
  const phone = await enrolParent(seeded.familyId, seeded.parentUserId);
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
  return { ...seeded, phone, offerId: offer.id };
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
      if (!(await input.stillAuthorized())) {
        return {
          ...result,
          outcome: 'cancelled' as const,
          detail: 'authorization_lapsed' as const,
          confirmationNumber: null,
          amountChargedCents: null,
        };
      }
      await input.onStep({
        step: 'payment',
        outcome: result.outcome,
        detail: result.detail,
        amountChargedCents: result.amountChargedCents,
        confirmed: result.confirmationNumber !== null,
      });
      return result;
    }),
    release: vi.fn(async (_resume: PlanResumeToken) => null),
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

describe("the plan runs only on its own parent's consent", () => {
  it('a consent row written by another parent does not carry the plan: consent_missing', async () => {
    const family = await plannedFamily();
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: `co-${family.familyId}@example.test`, name: 'Co Parent' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('no co-parent');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: family.familyId, userId: user.id, role: 'co_parent' });
    await db.database
      .update(schema.authorizedSignupConsents)
      .set({ parentUserId: user.id })
      .where(eq(schema.authorizedSignupConsents.familyId, family.familyId));
    const { runner, inputs } = engineLike(PAID);
    const result = await runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'consent_missing',
    });
    expect(inputs.map((i) => i.correlationId)).not.toContain(family.offerId);

    // Positive control: the same plan on its own parent's consent runs.
    const own = await plannedFamily();
    const armed = await runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps);
    expect(armed.plans.find((p) => p.offerId === own.offerId)?.outcome).toBe('completed');
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
      release: vi.fn(async () => null),
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

describe("a plan runs only while the parent's yes still stands", () => {
  const lapses: [string, (family: Awaited<ReturnType<typeof plannedFamily>>) => Promise<void>][] = [
    [
      'the parent opted out (the live channel row is revoked)',
      async (family) => {
        await db.database
          .update(schema.parentChannels)
          .set({ revokedAt: NOW })
          .where(eq(schema.parentChannels.userId, family.parentUserId));
      },
    ],
    [
      'the parent left the family',
      async (family) => {
        await db.database
          .delete(schema.familyMembers)
          .where(
            and(
              eq(schema.familyMembers.familyId, family.familyId),
              eq(schema.familyMembers.userId, family.parentUserId),
            ),
          );
      },
    ],
    [
      'the family is scheduled for erasure',
      async (family) => {
        await db.database
          .update(schema.families)
          .set({ scheduledDeletionAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000) })
          .where(eq(schema.families.id, family.familyId));
      },
    ],
    [
      'a text the parent sent may be a stop nobody has read yet',
      async (family) => {
        await db.database.insert(schema.optOutHeldMessages).values({
          providerMessageId: `held-${family.offerId}`,
          phoneHash: phoneBlindIndex(family.phone),
          heldAt: NOW,
          nextReadAt: NOW,
        });
      },
    ],
  ];

  it.each(lapses)(
    'ends with a named outcome and opens no browser when %s',
    async (_name, lapse) => {
      const family = await plannedFamily();
      await lapse(family);
      const { runner, inputs } = engineLike(PAID);
      const { deps: d, notices } = deps(runner);
      const result = await runDueSignupPlans(db.database, { now: NOW }, d);

      expect(result.plans.find((p) => p.offerId === family.offerId)).toEqual({
        offerId: family.offerId,
        outcome: 'cancelled',
        detail: 'authorization_lapsed',
        notice: 'withheld',
      });
      expect(inputs.some((i) => i.correlationId === family.offerId)).toBe(false);
      expect(notices.some((n) => n.offerId === family.offerId)).toBe(false);
      expect((await offerRow(family.offerId))?.status).toBe('handed_back');
      const audit = await steps(family.offerId);
      expect(audit.map((s) => s.step)).toEqual(['plan_approved', 'plan_started', 'plan_finished']);
      // One code for every lapse: a co-parent's export never says which (a stop is one adult's).
      expect(audit.at(-1)).toMatchObject({ detail: 'authorization_lapsed', notice: 'withheld' });
    },
  );

  it('re-checks just before paying: an opt-out during the run leaves the card unused', async () => {
    const family = await plannedFamily();
    const { runner: inner } = engineLike(PAID);
    const runner = {
      run: vi.fn(async (input: BrowserUsePlanInput) => {
        expect(await input.stillAuthorized()).toBe(true);
        if (input.correlationId === family.offerId) {
          await db.database
            .update(schema.parentChannels)
            .set({ revokedAt: NOW })
            .where(eq(schema.parentChannels.userId, family.parentUserId));
        }
        return inner.run(input);
      }),
      release: inner.release,
    };
    const { deps: d, notices } = deps(runner);
    const result = await runDueSignupPlans(db.database, { now: NOW }, d);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
      notice: 'withheld',
    });
    expect((await steps(family.offerId)).map((s) => s.step)).not.toContain('plan_payment');
    expect(notices.some((n) => n.offerId === family.offerId)).toBe(false);
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
  });
});

const MIN = 60_000;
const QUEUED: PlanResumeToken = {
  phase: 'signup',
  runId: 'run-queue',
  sessionId: 'bu-session-queue',
  browserId: null,
};

/**
 * A town queue longer than one sweep for `offerId`: the run is created (and its resume
 * token written) on the first sweep, then checkpoints `sweeps` times before it finishes
 * the way `engineLike` does. Every other plan finishes at once.
 */
function queueing(offerId: string, sweeps: number) {
  const { runner: finish } = engineLike(PAID);
  const resumes: (PlanResumeToken | null)[] = [];
  let left = sweeps;
  const runner = {
    run: vi.fn(async (input: BrowserUsePlanInput) => {
      if (input.correlationId !== offerId) return finish.run(input);
      resumes.push(input.resume);
      if (!input.resume) await input.onCheckpoint(QUEUED);
      if (left > 0) {
        left -= 1;
        return {
          outcome: 'checkpointed' as const,
          resume: { ...QUEUED, browserId: 'browser-queue' },
        };
      }
      return finish.run(input);
    }),
    release: vi.fn(async (_resume: PlanResumeToken) => '0.120000'),
  };
  return { runner, resumes };
}

async function secondPlan(
  family: Awaited<ReturnType<typeof plannedFamily>>,
  opensAt: Date,
): Promise<string> {
  const childId = await seedChild(db.database, family.familyId, 'Bo', 50, undefined, NOW);
  const offer = await recordSignupOffer(db.database, {
    familyId: family.familyId,
    childId,
    parentUserId: family.parentUserId,
    activityKey: 'gym-preschool',
    registrationUrl: AUTO_URL,
    sessions: SESSIONS,
    approvedPriceCents: null,
    now: NOW,
  });
  if (!offer.ok) throw new Error(offer.reason);
  messageSeq += 1;
  expect(
    await approveSignupPlan(db.database, {
      offerId: offer.id,
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      messageId: `msg-plan-${messageSeq}`,
      choiceIds: ['sun-1000'],
      maxPriceCents: 10000,
      opensAt,
      waiverAccepted: false,
      now: new Date(NOW.getTime() - 60 * MIN),
    }),
  ).toEqual({ ok: true });
  return offer.id;
}

const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);

describe('a queue longer than one sweep', () => {
  it('keeps the place in line: the plan checkpoints, and the next sweep finishes the same run', async () => {
    const family = await plannedFamily();
    const { runner, resumes } = queueing(family.offerId, 1);
    const { deps: d, notices } = deps(runner);

    const first = await runDueSignupPlans(db.database, { now: NOW }, d);
    expect(first.plans.find((p) => p.offerId === family.offerId)).toEqual({
      offerId: family.offerId,
      outcome: 'checkpointed',
      phase: 'signup',
    });
    const held = await offerRow(family.offerId);
    expect(held?.status).toBe('submitting');
    expect(held?.planResume).toEqual({ ...QUEUED, browserId: 'browser-queue' });
    expect(held?.planLeaseUntil).toBeNull();
    expect(notices.some((n) => n.offerId === family.offerId)).toBe(false);
    expect(runner.release).not.toHaveBeenCalled();

    const second = await runDueSignupPlans(db.database, { now: at(11) }, d);
    expect(second.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'completed',
      notice: 'sent',
    });
    expect(resumes).toEqual([null, { ...QUEUED, browserId: 'browser-queue' }]);
    expect((await offerRow(family.offerId))?.status).toBe('completed');
    expect(notices.filter((n) => n.offerId === family.offerId)).toHaveLength(1);
    expect((await steps(family.offerId)).map((s) => s.step)).toEqual([
      'plan_approved',
      'plan_started',
      'plan_checkpointed',
      'plan_resumed',
      'plan_checkout',
      'plan_spending_cap',
      'plan_payment',
      'plan_finished',
    ]);

    // A finished plan is never picked up again.
    await runDueSignupPlans(db.database, { now: at(22) }, d);
    expect(resumes).toHaveLength(2);
  });

  it('one family, two children: the second waits its turn and nothing is submitted twice', async () => {
    const family = await plannedFamily();
    const later = await secondPlan(family, new Date(OPENS.getTime() + MIN));
    const { runner, resumes } = queueing(family.offerId, 1);
    const ran = (offerId: string) =>
      runner.run.mock.calls.filter(([input]) => input.correlationId === offerId).length;
    const ours = (result: Awaited<ReturnType<typeof runDueSignupPlans>>) =>
      result.plans
        .filter((p) => p.offerId === family.offerId || p.offerId === later)
        .map((p) => [p.offerId === later ? 'second' : 'first', p.outcome]);

    expect(ours(await runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps))).toEqual([
      ['first', 'checkpointed'],
    ]);
    expect(ours(await runDueSignupPlans(db.database, { now: at(11) }, deps(runner).deps))).toEqual([
      ['first', 'completed'],
    ]);
    expect(ours(await runDueSignupPlans(db.database, { now: at(22) }, deps(runner).deps))).toEqual([
      ['second', 'completed'],
    ]);
    await runDueSignupPlans(db.database, { now: at(33) }, deps(runner).deps);

    expect(resumes).toHaveLength(2);
    expect(ran(family.offerId)).toBe(2);
    expect(ran(later)).toBe(1);
    const payments = async (offerId: string) =>
      (await steps(offerId)).filter((s) => s.step === 'plan_payment').length;
    expect([await payments(family.offerId), await payments(later)]).toEqual([1, 1]);
  });

  it('a sweep the platform killed lets go of the plan only once its lease has passed', async () => {
    // The earliest open is claimed first, so this one is claimed ahead of any other.
    const family = await plannedFamily({ opensAt: at(1) });
    // Claimed and its run created, then the sweep died before it could checkpoint.
    const claimed = await claimDuePlan(db.database, {
      now: NOW,
      leadMs: PLAN_JOIN_LEAD_MS,
      leaseMs: PLAN_LEASE_MS,
    });
    expect(claimed).toMatchObject({ offerId: family.offerId, resume: null });
    await savePlanResume(db.database, {
      offerId: family.offerId,
      familyId: family.familyId,
      resume: QUEUED,
      letGo: false,
    });
    const { runner, resumes } = queueing(family.offerId, 0);

    await runDueSignupPlans(db.database, { now: at(5) }, deps(runner).deps);
    expect(resumes).toEqual([]);
    expect((await offerRow(family.offerId))?.status).toBe('submitting');

    const late = new Date(NOW.getTime() + PLAN_LEASE_MS + MIN);
    const resumed = await runDueSignupPlans(db.database, { now: late }, deps(runner).deps);
    expect(resumed.plans.find((p) => p.offerId === family.offerId)?.outcome).toBe('completed');
    expect(resumes).toEqual([QUEUED]);
  });

  it('a queue still waiting past the opening window is let go, and the parent hears it', async () => {
    const family = await plannedFamily();
    const { runner } = queueing(family.offerId, 99);
    const { deps: d, notices } = deps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, d);
    expect((await offerRow(family.offerId))?.status).toBe('submitting');

    const past = new Date(OPENS.getTime() + PLAN_MAX_LATE_MS + MIN);
    const result = await runDueSignupPlans(db.database, { now: past }, d);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toEqual({
      offerId: family.offerId,
      outcome: 'not_open',
      detail: 'open_window_passed',
      notice: 'sent',
    });
    expect(runner.run.mock.calls.filter(([i]) => i.correlationId === family.offerId)).toHaveLength(
      1,
    );
    expect(runner.release).toHaveBeenCalledWith({ ...QUEUED, browserId: 'browser-queue' });
    const row = await offerRow(family.offerId);
    expect(row?.status).toBe('handed_back');
    expect(row?.browserUseCostUsd).toBe('0.120000');
    expect(notices.find((n) => n.offerId === family.offerId)).toMatchObject({
      outcome: 'not_open',
      detail: 'open_window_passed',
    });
    expect((await steps(family.offerId)).at(-1)).toMatchObject({
      step: 'plan_finished',
      detail: 'open_window_passed',
      notice: 'sent',
    });
  });

  it('a parent who opts out between sweeps: the run is let go and no one is texted', async () => {
    const family = await plannedFamily();
    const { runner } = queueing(family.offerId, 99);
    const { deps: d, notices } = deps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, d);
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: at(5) })
      .where(eq(schema.parentChannels.userId, family.parentUserId));

    const result = await runDueSignupPlans(db.database, { now: at(11) }, d);
    expect(result.plans.find((p) => p.offerId === family.offerId)).toEqual({
      offerId: family.offerId,
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
      notice: 'withheld',
    });
    expect(runner.release).toHaveBeenCalledTimes(1);
    expect(notices.some((n) => n.offerId === family.offerId)).toBe(false);
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
  });
});

describe('cancelling a planned registration', () => {
  it('moves the plan out of planned with one audit row, so the open never runs it', async () => {
    const family = await plannedFamily();
    expect(
      await cancelSignupPlan(db.database, {
        offerId: family.offerId,
        familyId: family.familyId,
        actor: family.parentUserId,
        now: NOW,
      }),
    ).toBe('cancelled');
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
    const audit = await steps(family.offerId);
    expect(audit.map((s) => s.step)).toEqual(['plan_approved', 'plan_cancelled']);

    const { runner, inputs } = engineLike(PAID);
    const swept = await runDueSignupPlans(db.database, { now: NOW }, deps(runner).deps);
    expect(swept.plans.some((p) => p.offerId === family.offerId)).toBe(false);
    expect(inputs.some((i) => i.correlationId === family.offerId)).toBe(false);

    // A second cancel finds nothing planned and writes nothing.
    expect(
      await cancelSignupPlan(db.database, {
        offerId: family.offerId,
        familyId: family.familyId,
        actor: family.parentUserId,
        now: NOW,
      }),
    ).toBe('not_planned');
    expect(await steps(family.offerId)).toHaveLength(2);
  });

  it("refuses another family's offer", async () => {
    const family = await plannedFamily();
    const other = await seedFamily(db.database);
    expect(
      await cancelSignupPlan(db.database, {
        offerId: family.offerId,
        familyId: other.familyId,
        actor: other.parentUserId,
        now: NOW,
      }),
    ).toBe('not_planned');
    expect((await offerRow(family.offerId))?.status).toBe('planned');
  });
});

describe('one registration per family, held by the database', () => {
  it('rejects a second submitting offer for the same family, whoever writes it', async () => {
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
    const toSubmitting = (id: string) =>
      db.database
        .update(schema.authorizedSignupOffers)
        .set({ status: 'submitting' })
        .where(eq(schema.authorizedSignupOffers.id, id));
    await toSubmitting(family.offerId);
    const error = await toSubmitting(second.id).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).not.toBeNull();
    expect(isOneSubmittingViolation(error)).toBe(true);
    // Positive control: another family's offer is free to submit, and an unrelated error
    // is not read as the one-per-family guard.
    const other = await plannedFamily();
    await expect(toSubmitting(other.offerId)).resolves.toBeDefined();
    expect(isOneSubmittingViolation(new Error('connection reset'))).toBe(false);
  });
});
