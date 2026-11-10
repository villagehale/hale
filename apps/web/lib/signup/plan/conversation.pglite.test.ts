import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import type { SignupConsentReader } from '../consent-reader';
import { AUTHORIZED_SIGNUP_ENABLED_ENV } from '../flag';
import { runAuthorizedSignup } from '../run';
import { recordSignupOffer } from '../store';
import { runPlanTurn } from './conversation';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import type { PlanReader, PlanReading } from './reader';
import { approveSignupPlan } from './store';
import type { PlanReplyFacts, PlanReplyWriter } from './writer';

// Invented hosts and details only. The read and the reply are model calls with their own
// recorded evals (signup-plan-read, signup-plan-reply); here each is a stipulated answer,
// and what is tested is what the database and the reply do with it.
const NOW = new Date('2026-11-30T20:00:00.000Z');
const OPENS = new Date('2026-12-01T12:00:00.000Z');
const URL = 'https://register.example-rec.test/Clients/BookMe4LandingPages/CoursesLandingPage';
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
let seq = 0;

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

async function family(options: { opensAt?: Date | null } = {}) {
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
    planOpensAt: options.opensAt === undefined ? OPENS : options.opensAt,
    now: new Date(NOW.getTime() - 60 * 60_000),
  });
  if (!offer.ok) throw new Error(offer.reason);
  return { ...seeded, childId, offerId: offer.id };
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

function turn(f: { familyId: string; parentUserId: string }, body = 'parent words') {
  seq += 1;
  return {
    familyId: f.familyId,
    parentUserId: f.parentUserId,
    body,
    inboundChannelMessageId: `msg-${seq}`,
    existingThread: true,
    now: NOW,
  };
}

function fakes(reading: PlanReading | null) {
  const written: PlanReplyFacts[] = [];
  const planReader: PlanReader = { read: vi.fn(async () => reading) };
  const planWriter: PlanReplyWriter = {
    write: vi.fn(async (facts: PlanReplyFacts) => {
      written.push(facts);
      return `reply for ${facts.moment}`;
    }),
  };
  return { planReader, planWriter, written };
}

async function offer(offerId: string) {
  const [row] = await db.database
    .select()
    .from(schema.authorizedSignupOffers)
    .where(eq(schema.authorizedSignupOffers.id, offerId));
  if (!row) throw new Error('no offer');
  return row;
}

async function auditSteps(offerId: string) {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetId, offerId),
        eq(schema.auditLog.actionTaken, 'authorized_signup_step'),
      ),
    );
  return rows.map((row) => (row.after as { step: string; moment?: string }).step);
}

const APPROVE: PlanReading = {
  verdict: 'approve',
  choiceIds: ['sun-1000', 'sat-0900'],
  maxPriceCents: 10500,
  waiverAccepted: true,
};

describe('the day-before plan conversation', () => {
  it("stores the parent's ranked yes as the plan and replies with the model's text", async () => {
    const f = await family();
    const { planReader, planWriter, written } = fakes(APPROVE);
    const input = turn(f, 'yes, Sunday first, Saturday if not, up to $105, tick the waiver');
    const result = await runPlanTurn(db.database, input, { planReader, planWriter });

    expect(result).toEqual({
      claimed: true,
      outcome: 'plan_approved',
      reply: 'reply for approved',
      deliverOnThread: true,
    });
    const row = await offer(f.offerId);
    expect(row.status).toBe('planned');
    expect(row.planChoiceIds).toEqual(['sun-1000', 'sat-0900']);
    expect(row.planMaxPriceCents).toBe(10500);
    expect(row.planWaiverAccepted).toBe(true);
    expect(row.planOpensAt?.toISOString()).toBe(OPENS.toISOString());
    expect(row.authorizingMessageId).toBe(input.inboundChannelMessageId);
    const [consent] = await db.database
      .select()
      .from(schema.authorizedSignupConsents)
      .where(eq(schema.authorizedSignupConsents.familyId, f.familyId));
    expect(consent?.messageId).toBe(input.inboundChannelMessageId);
    // The reply restates the parent's order, not the offer's.
    expect(written[0]?.sessions.map((s) => s.label)).toEqual([
      'Preschool Swim Sun 10:00',
      'Preschool Swim Sat 9:00',
    ]);
    expect(written[0]?.maxPriceCents).toBe(10500);
    expect(await auditSteps(f.offerId)).toEqual(['plan_approved', 'plan_reply']);
  });

  it("a co-parent's yes cannot approve the plan Hale offered the other parent", async () => {
    const f = await family();
    const coParentUserId = await seedCoParent(f.familyId);
    const { planReader, planWriter, written } = fakes(APPROVE);
    const result = await runPlanTurn(db.database, turn({ ...f, parentUserId: coParentUserId }), {
      planReader,
      planWriter,
    });

    expect(result?.outcome).toBe('plan_refused');
    expect(written[0]?.refusal).toBe('not_offer_parent');
    expect(result?.reply).toBe(`reply for refused\n${URL}`);
    expect((await offer(f.offerId)).status).toBe('pending');
    const consents = await db.database
      .select()
      .from(schema.authorizedSignupConsents)
      .where(eq(schema.authorizedSignupConsents.familyId, f.familyId));
    expect(consents).toEqual([]);

    // Positive control: the parent the plan was offered to can still approve it.
    const own = await runPlanTurn(db.database, turn(f), { planReader, planWriter });
    expect(own?.outcome).toBe('plan_approved');
    expect((await offer(f.offerId)).status).toBe('planned');
  });

  it('with the lane off, owns nothing and reads nothing', async () => {
    vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, '');
    const f = await family();
    const { planReader, planWriter } = fakes(APPROVE);
    expect(await runPlanTurn(db.database, turn(f), { planReader, planWriter })).toBeNull();
    expect(planReader.read).not.toHaveBeenCalled();
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('an offer with no open time is not a plan: the ordinary sign-up reads it', async () => {
    const f = await family({ opensAt: null });
    const { planReader, planWriter } = fakes(APPROVE);
    expect(await runPlanTurn(db.database, turn(f), { planReader, planWriter })).toBeNull();
    expect(planReader.read).not.toHaveBeenCalled();
  });

  it('a take-back of an approved plan cancels it before the open', async () => {
    const f = await family();
    const approved = await approveSignupPlan(db.database, {
      offerId: f.offerId,
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      messageId: 'msg-approve',
      choiceIds: ['sat-0900'],
      maxPriceCents: 9800,
      opensAt: OPENS,
      waiverAccepted: false,
      now: new Date(NOW.getTime() - 30 * 60_000),
    });
    expect(approved).toEqual({ ok: true });
    const { planReader, planWriter, written } = fakes({ verdict: 'take_back' });
    const result = await runPlanTurn(db.database, turn(f, 'actually never mind'), {
      planReader,
      planWriter,
    });
    expect(result?.outcome).toBe('plan_cancelled');
    expect(result?.reply).toBe('reply for cancelled');
    expect((await offer(f.offerId)).status).toBe('handed_back');
    // The reader saw the plan the parent is taking back.
    expect(vi.mocked(planReader.read).mock.calls[0]?.[0].offer).toMatchObject({
      status: 'planned',
      plan: { choiceIds: ['sat-0900'], maxPriceCents: 9800, waiverAccepted: false },
    });
    expect(written[0]?.moment).toBe('cancelled');
    expect(await auditSteps(f.offerId)).toEqual(['plan_approved', 'plan_cancelled', 'plan_reply']);
  });

  it.each([
    [
      'its queue',
      { phase: 'signup', runId: 'run-q', sessionId: null, browserId: null },
      'cancel_requested',
    ],
    [
      'its payment',
      {
        phase: 'paying',
        runId: 'pay-run-1',
        sessionId: 'bu-session-pay',
        browserId: null,
        choiceIndex: 0,
        cartTotalCents: 9800,
        holdExpiresAt: null,
        costUsd: null,
      },
      'paying',
    ],
  ] as const)(
    'a take-back while the run is in %s is recorded on the offer for the next sweep',
    async (_name, resume, recorded) => {
      const f = await family();
      expect(
        await approveSignupPlan(db.database, {
          offerId: f.offerId,
          familyId: f.familyId,
          parentUserId: f.parentUserId,
          messageId: `msg-approve-${resume.phase}`,
          choiceIds: ['sat-0900'],
          maxPriceCents: 9800,
          opensAt: OPENS,
          waiverAccepted: false,
          now: new Date(NOW.getTime() - 30 * 60_000),
        }),
      ).toEqual({ ok: true });
      // Past the open, checkpointed between sweeps.
      await db.database
        .update(schema.authorizedSignupOffers)
        .set({ status: 'submitting', planResume: resume, planLeaseUntil: null })
        .where(eq(schema.authorizedSignupOffers.id, f.offerId));
      const later = {
        ...turn(f, 'stop, I will do it myself'),
        now: new Date(OPENS.getTime() + 20 * 60_000),
      };
      const { planReader, planWriter, written } = fakes({ verdict: 'take_back' });
      const result = await runPlanTurn(db.database, later, { planReader, planWriter });

      expect(vi.mocked(planReader.read).mock.calls[0]?.[0].offer).toMatchObject({
        status: 'planned',
        plan: { choiceIds: ['sat-0900'], maxPriceCents: 9800, waiverAccepted: false },
      });
      const row = await offer(f.offerId);
      expect(row.status).toBe('submitting');
      expect(row.planCancelRequestedAt).not.toBeNull();
      if (recorded === 'paying') {
        // Already paying: no "cancelled" reply. The sweep reports what the payment did.
        expect(result).toBeNull();
        expect(written).toEqual([]);
        expect(await auditSteps(f.offerId)).toEqual(['plan_approved', 'plan_cancel_requested']);
      } else {
        expect(result?.outcome).toBe('plan_cancelled');
        expect(written[0]?.moment).toBe('cancelled');
        expect(await auditSteps(f.offerId)).toEqual([
          'plan_approved',
          'plan_cancel_requested',
          'plan_reply',
        ]);
      }
      // Taken back: the plan lane no longer owns this family's turns.
      const again = fakes({ verdict: 'take_back' });
      expect(await runPlanTurn(db.database, later, again)).toBeNull();
      expect(again.planReader.read).not.toHaveBeenCalled();
    },
  );

  it('a no to the offered plan closes the offer', async () => {
    const f = await family();
    const { planReader, planWriter } = fakes({ verdict: 'take_back' });
    const result = await runPlanTurn(db.database, turn(f, "no thanks, I'll do it"), {
      planReader,
      planWriter,
    });
    expect(result?.outcome).toBe('plan_declined');
    expect((await offer(f.offerId)).status).toBe('handed_back');
  });

  it('a hedge asks the model question back and changes nothing', async () => {
    const f = await family();
    const { planReader, planWriter, written } = fakes({
      verdict: 'unclear',
      question: 'Which day first?',
    });
    const result = await runPlanTurn(db.database, turn(f), { planReader, planWriter });
    expect(result?.outcome).toBe('plan_clarify');
    expect(written[0]?.question).toBe('Which day first?');
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('a yes the store refuses is said back with the registration link after the text', async () => {
    const f = await family();
    const { planReader, planWriter, written } = fakes({ ...APPROVE, maxPriceCents: 900_000 });
    const result = await runPlanTurn(db.database, turn(f), { planReader, planWriter });
    expect(result?.outcome).toBe('plan_refused');
    expect(written[0]?.refusal).toBe('max_price');
    expect(result?.reply).toBe(`reply for refused\n${URL}`);
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('a reply the model could not write sends nothing and says so', async () => {
    const f = await family();
    const { planReader } = fakes({ verdict: 'unclear', question: 'Which day?' });
    const result = await runPlanTurn(db.database, turn(f), {
      planReader,
      planWriter: { write: async () => null },
    });
    expect(result).toMatchObject({ claimed: true, reply: null, unsent: 'reply_unwritten' });
  });

  it('the one-shot sign-up never reads a pending plan offer, even when the plan read is unrelated', async () => {
    const consentReader: SignupConsentReader = {
      read: vi.fn(async () => ({ verdict: 'consent' as const, sessionId: 'sat-0900' })),
    };
    const plan = await family();
    const { planReader, planWriter } = fakes({ verdict: 'unrelated' });
    const result = await runAuthorizedSignup(db.database, turn(plan), {
      planReader,
      planWriter,
      consentReader,
    });
    expect(result.claimed).toBe(false);
    expect(consentReader.read).not.toHaveBeenCalled();
    expect((await offer(plan.offerId)).status).toBe('pending');

    // Positive control: an offer with no open time still goes to the consent read.
    const ordinary = await family({ opensAt: null });
    await runAuthorizedSignup(db.database, turn(ordinary), {
      planReader,
      planWriter,
      consentReader,
      browser: null,
    });
    expect(consentReader.read).toHaveBeenCalledTimes(1);
  });
});
