import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import type { BrowserUsePlanInput, BrowserUsePlanResult } from '../browser-use/plan-engine';
import { storeProviderSession } from '../browser-use/vault';
import { isOneSubmittingViolation, recordSignupOffer } from '../store';
import { REGISTRATION_ASSISTED_RUN_ENABLED_ENV, REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import { type PlanOutcomeNotice, type PlanRunDeps, runDueSignupPlans } from './run';
import { approveSignupPlan, cancelSignupPlan } from './store';

// Invented hosts and details only. The Browser Use engine is its own tested unit
// (plan-engine.test.ts); here a stand-in runner reports steps the way it does.
const NOW = new Date('2026-12-01T11:58:00.000Z');
const OPENS = new Date('2026-12-01T12:00:00.000Z');
const AUTO_HOST = 'register.example-rec.test';
const AUTO_URL = `https://${AUTO_HOST}/Clients/BookMe4LandingPages/CoursesLandingPage`;
const ASSISTED_URL = 'https://anc.ca.apm.activecommunities.com/exampleville/activity/detail/1';
const LIVE = 'https://live.browser-use.com/s/fixture-live-view-token';
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
    expect(input).toMatchObject({ mode: 'auto', maxPriceCents: 10000, waiverAccepted: true });
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

  it('hands an ActiveNet town back to the parent without a browser while the assisted switch is off', async () => {
    const family = await plannedFamily({ url: ASSISTED_URL });
    const { runner, inputs } = engineLike(PAID);
    const { deps: d, notices } = deps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, d);

    expect(inputs.some((i) => i.correlationId === family.offerId)).toBe(false);
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
    expect(notices.find((n) => n.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'parent_town',
    });
    expect((await steps(family.offerId)).map((s) => s.step)).toEqual([
      'plan_approved',
      'plan_started',
      'plan_finished',
    ]);
  });

  it('on an ActiveNet town with the assisted switch on, fills and hands the parent the live browser: no cap, no payment', async () => {
    vi.stubEnv(REGISTRATION_ASSISTED_RUN_ENABLED_ENV, 'true');
    const family = await plannedFamily({ url: ASSISTED_URL });
    const { runner, inputs, caps } = engineLike(PAID);
    runner.run.mockImplementationOnce(async (input: BrowserUsePlanInput) => {
      inputs.push(input);
      await input.onStep({ step: 'ready', choiceIndex: 0, feeCents: 9800 });
      return {
        ...PAID,
        outcome: 'ready_for_parent',
        detail: 'none',
        choiceIndex: 0,
        liveViewUrl: LIVE,
        holdExpiresAt: new Date(NOW.getTime() + 15 * 60_000),
        confirmationNumber: null,
        amountChargedCents: null,
        sessionCostUsd: null,
      };
    });
    const { deps: d, notices } = deps(runner);
    const result = await runDueSignupPlans(db.database, { now: NOW }, d);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toEqual({
      offerId: family.offerId,
      outcome: 'ready_for_parent',
      detail: 'none',
      notice: 'sent',
    });
    expect(inputs.find((i) => i.correlationId === family.offerId)?.mode).toBe('assisted');
    expect(caps).toEqual([]);
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
    expect(notices.find((n) => n.offerId === family.offerId)).toMatchObject({
      outcome: 'ready_for_parent',
      liveViewUrl: LIVE,
      choiceIndex: 0,
      amountChargedCents: null,
    });
    const audit = await steps(family.offerId);
    expect(audit.map((s) => s.step)).toEqual([
      'plan_approved',
      'plan_started',
      'plan_ready',
      'plan_finished',
    ]);
    expect(audit[1]).toMatchObject({ mode: 'assisted' });
    expect(JSON.stringify(audit)).not.toContain('fixture-live-view-token');
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
