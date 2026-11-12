import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import {
  type SignupConsentReader,
  type SignupConsentReading,
  type signupConsentSchema,
  toSignupConsentReading,
} from '../consent-reader';
import { AUTHORIZED_SIGNUP_ENABLED_ENV } from '../flag';
import { authorizedSignupHandler } from '../handler';
import { runAuthorizedSignup } from '../run';
import { loadSignupIdentity, recordSignupOffer } from '../store';
import { echoOutcomeWriter } from '../test-models';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import {
  type MismatchReader,
  type MismatchReading,
  type signupMismatchReadSchema,
  toMismatchReading,
} from './mismatch-reader';
import { recordPlanNotice } from './prep';
import { type PlanReader, type PlanReading, toPlanReading } from './reader';
import { approveSignupPlan, parkSignupPlan } from './store';
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
    activityLabel: 'Preschool Swim',
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

function unrelatedConsent(): SignupConsentReader {
  return { read: vi.fn(async () => ({ verdict: 'unrelated' as const })) };
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

/** How each claimed plan turn on this offer was bound, as its reply audit row says. */
async function replyBindings(offerId: string) {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetId, offerId),
        eq(schema.auditLog.actionTaken, 'authorized_signup_step'),
      ),
    );
  return rows
    .map((row) => row.after as { step: string; boundBy?: string | null })
    .filter((after) => after.step === 'plan_reply')
    .map((after) => after.boundBy);
}

const APPROVE: PlanReading = {
  verdict: 'approve',
  choiceIds: ['sun-1000', 'sat-0900'],
  maxPriceCents: 10500,
  waiverAccepted: true,
  named: null,
};
const TAKE_BACK: PlanReading = { verdict: 'take_back', named: null };

describe('the day-before plan conversation', () => {
  it("stores the parent's ranked yes as the plan and replies with the model's text", async () => {
    const f = await family();
    const { planReader, planWriter, written } = fakes(APPROVE);
    const input = turn(f, 'yes, Sunday first, Saturday if not, up to $105, tick the waiver');
    const result = await runAuthorizedSignup(db.database, input, { planReader, planWriter });

    expect(result).toEqual({
      claimed: true,
      outcome: 'plan_approved',
      reply: 'reply for approved',
      deliverOnThread: true,
      afterSend: expect.any(Function),
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

  it('asks once for the real date of birth when Hale only has a derived one', async () => {
    const f = await family();
    await db.database
      .update(schema.children)
      .set({ dobPrecision: 'derived' })
      .where(eq(schema.children.id, f.childId));
    const identity = await loadSignupIdentity(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      now: NOW,
    });
    expect(identity?.childDob).toBeNull();

    const { planReader, planWriter, written } = fakes(APPROVE);
    const first = await runAuthorizedSignup(db.database, turn(f), { planReader, planWriter });
    expect(first?.outcome).toBe('plan_clarify');
    expect(written[0]?.moment).toBe('clarify');
    expect(written[0]?.question).toMatch(/date of birth/i);
    expect((await offer(f.offerId)).status).toBe('pending');
    expect(await auditSteps(f.offerId)).toContain('plan_ask_dob');

    const second = await runAuthorizedSignup(db.database, turn(f), { planReader, planWriter });
    expect(second?.outcome).toBe('plan_approved');
    expect((await offer(f.offerId)).status).toBe('planned');
  });

  it("a co-parent's yes never reaches the plan Hale offered the other parent", async () => {
    const f = await family();
    const coParentUserId = await seedCoParent(f.familyId);
    const { planReader, planWriter, written } = fakes(APPROVE);
    const result = await runAuthorizedSignup(
      db.database,
      turn({ ...f, parentUserId: coParentUserId }),
      {
        planReader,
        planWriter,
      },
    );

    expect(result).toEqual({
      claimed: false,
      outcome: 'not_claimed',
      reply: null,
      deliverOnThread: false,
    });
    expect(planReader.read).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect((await offer(f.offerId)).status).toBe('pending');
    const consents = await db.database
      .select()
      .from(schema.authorizedSignupConsents)
      .where(eq(schema.authorizedSignupConsents.familyId, f.familyId));
    expect(consents).toEqual([]);

    // Positive control: the parent the plan was offered to can still approve it.
    const own = await runAuthorizedSignup(db.database, turn(f), { planReader, planWriter });
    expect(own?.outcome).toBe('plan_approved');
    expect((await offer(f.offerId)).status).toBe('planned');
  });

  it('the waiver is ticked only when Hale asked about it: the parent saying so is not enough', async () => {
    const text = 'yes, Sunday first, Saturday if not, up to $105, tick the waiver';
    // The model's answer is stipulated; the bindings and what Hale asked are the real ones.
    const planReader: PlanReader = {
      read: vi.fn(async (read) =>
        toPlanReading(
          {
            reason: 'r',
            said: 'yes, Sunday first, Saturday if not',
            named: null,
            verdict: 'approve',
            choiceIds: ['sun-1000', 'sat-0900'],
            maxPriceCents: 10500,
            waiverSaid: 'tick the waiver',
            waiverAccepted: true,
            question: null,
          },
          read.offer,
          read.text,
        ),
      ),
    };
    const { planWriter } = fakes(null);
    const unasked = await family();
    const result = await runAuthorizedSignup(db.database, turn(unasked, text), {
      planReader,
      planWriter,
    });
    expect(result.outcome).toBe('plan_approved');
    expect((await offer(unasked.offerId)).planWaiverAccepted).toBe(false);

    // Positive control: once a text of Hale's asked about the waiver, their words tick it.
    const asked = await family();
    await recordPlanNotice(db.database, {
      familyId: asked.familyId,
      offerId: asked.offerId,
      providerHost: 'register.example-rec.test',
      kind: 'ask_waiver',
      now: NOW,
    });
    await runAuthorizedSignup(db.database, turn(asked, text), { planReader, planWriter });
    expect((await offer(asked.offerId)).planWaiverAccepted).toBe(true);
  });

  it("with the lane off, the plan lane reads nothing: the offer is the ordinary sign-up's", async () => {
    vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, '');
    const f = await family();
    const { planReader, planWriter } = fakes(APPROVE);
    const consentReader = unrelatedConsent();
    const result = await runAuthorizedSignup(db.database, turn(f), {
      planReader,
      planWriter,
      consentReader,
    });
    expect(result.claimed).toBe(false);
    expect(planReader.read).not.toHaveBeenCalled();
    expect(consentReader.read).toHaveBeenCalledTimes(1);
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('an offer with no open time is not a plan: the ordinary sign-up reads it', async () => {
    const f = await family({ opensAt: null });
    const { planReader, planWriter } = fakes(APPROVE);
    const consentReader = unrelatedConsent();
    await runAuthorizedSignup(db.database, turn(f), { planReader, planWriter, consentReader });
    expect(planReader.read).not.toHaveBeenCalled();
    expect(consentReader.read).toHaveBeenCalledTimes(1);
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
    const { planReader, planWriter, written } = fakes(TAKE_BACK);
    const result = await runAuthorizedSignup(db.database, turn(f, 'actually never mind'), {
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
      const { planReader, planWriter, written } = fakes(TAKE_BACK);
      const result = await runAuthorizedSignup(db.database, later, { planReader, planWriter });

      expect(vi.mocked(planReader.read).mock.calls[0]?.[0].offer).toMatchObject({
        status: 'planned',
        plan: { choiceIds: ['sat-0900'], maxPriceCents: 9800, waiverAccepted: false },
      });
      const row = await offer(f.offerId);
      expect(row.status).toBe('submitting');
      expect(row.planCancelRequestedAt).not.toBeNull();
      if (recorded === 'paying') {
        // Already paying: no "cancelled" reply. The sweep reports what the payment did.
        expect(result).toEqual({
          claimed: false,
          outcome: 'plan_cancel_paying',
          reply: null,
          deliverOnThread: false,
        });
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
      const again = fakes(TAKE_BACK);
      expect(await runAuthorizedSignup(db.database, later, again)).toMatchObject({
        claimed: false,
        outcome: 'not_claimed',
      });
      expect(again.planReader.read).not.toHaveBeenCalled();
    },
  );

  it('a no to the offered plan closes the offer', async () => {
    const f = await family();
    const { planReader, planWriter } = fakes(TAKE_BACK);
    const result = await runAuthorizedSignup(db.database, turn(f, "no thanks, I'll do it"), {
      planReader,
      planWriter,
    });
    expect(result?.outcome).toBe('plan_declined');
    expect((await offer(f.offerId)).status).toBe('handed_back');
  });

  it("a co-parent's take-back never reaches the plan the other parent set", async () => {
    const f = await family();
    expect(
      await approveSignupPlan(db.database, {
        offerId: f.offerId,
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        messageId: 'msg-approve-own',
        choiceIds: ['sat-0900'],
        maxPriceCents: 9800,
        opensAt: OPENS,
        waiverAccepted: false,
        now: new Date(NOW.getTime() - 30 * 60_000),
      }),
    ).toEqual({ ok: true });
    const coParentUserId = await seedCoParent(f.familyId);
    const { planReader, planWriter, written } = fakes({ verdict: 'take_back', named: 'tokens' });
    const result = await runAuthorizedSignup(
      db.database,
      turn({ ...f, parentUserId: coParentUserId }, 'cancel the swim one'),
      { planReader, planWriter },
    );

    expect(result).toEqual({
      claimed: false,
      outcome: 'not_claimed',
      reply: null,
      deliverOnThread: false,
    });
    expect(planReader.read).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect((await offer(f.offerId)).status).toBe('planned');
    expect(await auditSteps(f.offerId)).toEqual(['plan_approved']);

    // Positive control: the parent who set it takes it back.
    const own = await runAuthorizedSignup(db.database, turn(f, 'cancel the swim one'), {
      planReader,
      planWriter,
    });
    expect(own.outcome).toBe('plan_cancelled');
    expect((await offer(f.offerId)).status).toBe('handed_back');
  });

  it("a co-parent's no never reaches the ask Hale made the other parent", async () => {
    const f = await family();
    const coParentUserId = await seedCoParent(f.familyId);
    const { planReader, planWriter } = fakes(TAKE_BACK);
    const result = await runAuthorizedSignup(
      db.database,
      turn({ ...f, parentUserId: coParentUserId }, 'no thanks'),
      { planReader, planWriter },
    );
    expect(result).toMatchObject({ claimed: false, outcome: 'not_claimed' });
    expect(planReader.read).not.toHaveBeenCalled();
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('a group seat that may not authorize a sign-up cannot take a plan back', async () => {
    const f = await family();
    const { planReader, planWriter, written } = fakes(TAKE_BACK);
    const declineSeat = vi.fn(async () => true);
    const result = await runAuthorizedSignup(db.database, turn(f, 'cancel it'), {
      planReader,
      planWriter,
      declineSeat,
    });
    expect(result).toEqual({
      claimed: true,
      outcome: 'group_member_not_authorized',
      reply: null,
      deliverOnThread: false,
    });
    expect(declineSeat).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
    expect((await offer(f.offerId)).status).toBe('pending');

    // Positive control: a seat that may authorize takes it back.
    const allowed = await runAuthorizedSignup(db.database, turn(f, 'cancel it'), {
      planReader,
      planWriter,
      declineSeat: async () => false,
    });
    expect(allowed.outcome).toBe('plan_declined');
    expect((await offer(f.offerId)).status).toBe('handed_back');
  });

  it('a hedge asks the model question back and changes nothing', async () => {
    const f = await family();
    const { planReader, planWriter, written } = fakes({
      verdict: 'unclear',
      question: 'Which day first?',
      named: null,
    });
    const result = await runAuthorizedSignup(db.database, turn(f), { planReader, planWriter });
    expect(result?.outcome).toBe('plan_clarify');
    expect(written[0]?.question).toBe('Which day first?');
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('a yes the store refuses is said back with the registration link after the text', async () => {
    const f = await family();
    const { planReader, planWriter, written } = fakes({ ...APPROVE, maxPriceCents: 900_000 });
    const result = await runAuthorizedSignup(db.database, turn(f), { planReader, planWriter });
    expect(result?.outcome).toBe('plan_refused');
    expect(written[0]?.refusal).toBe('max_price');
    expect(result?.reply).toBe(`reply for refused\n${URL}`);
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('a reply the model could not write sends nothing and says so', async () => {
    const f = await family();
    const { planReader } = fakes({ verdict: 'unclear', question: 'Which day?', named: null });
    const result = await runAuthorizedSignup(db.database, turn(f), {
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

  it('the reader is told which program and host the plan is for', async () => {
    const f = await family();
    const { planReader, planWriter } = fakes({ verdict: 'unrelated' });
    await runAuthorizedSignup(db.database, turn(f, 'what time is pickup friday'), {
      planReader,
      planWriter,
    });
    expect(vi.mocked(planReader.read).mock.calls[0]?.[0].offer).toMatchObject({
      activity: 'Preschool Swim',
      host: 'register.example-rec.test',
    });
  });
});

describe('which ask a message answers', () => {
  const KICKERS_URL = 'https://kickers.example-sport.test/register/sat';
  const KICKERS_OPENS = new Date('2026-12-08T12:00:00.000Z');

  /** A pending ask for another program, newer than the swim offer, opening after it. */
  async function kickersAsk(f: { familyId: string; parentUserId: string; childId: string }) {
    const recorded = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'kickers-sat',
      activityLabel: 'Little Kickers',
      registrationUrl: KICKERS_URL,
      sessions: SESSIONS,
      approvedPriceCents: null,
      planOpensAt: KICKERS_OPENS,
      now: new Date(NOW.getTime() - 10 * 60_000),
    });
    if (!recorded.ok) throw new Error(recorded.reason);
    return recorded.id;
  }

  async function approveSwim(f: { familyId: string; parentUserId: string; offerId: string }) {
    expect(
      await approveSignupPlan(db.database, {
        offerId: f.offerId,
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        messageId: `msg-approve-${f.offerId}`,
        choiceIds: ['sat-0900'],
        maxPriceCents: 9800,
        opensAt: OPENS,
        waiverAccepted: false,
        now: new Date(NOW.getTime() - 30 * 60_000),
      }),
    ).toEqual({ ok: true });
  }

  /** Stands in for the model: one stipulated reading per program. */
  function readerBy(readings: Record<string, PlanReading | null>): PlanReader {
    return {
      read: vi.fn(async ({ offer: read }) => readings[read.activity ?? ''] ?? null),
    };
  }

  function readOrder(reader: PlanReader) {
    return vi.mocked(reader.read).mock.calls.map((call) => call[0].offer.activity);
  }

  it('a yes answers the newest ask, not the one that opens first', async () => {
    const f = await family();
    const kickersId = await kickersAsk(f);
    const { planReader, planWriter } = fakes(APPROVE);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
    });

    expect(result?.outcome).toBe('plan_approved');
    expect(vi.mocked(planReader.read).mock.calls[0]?.[0].offer).toMatchObject({
      activity: 'Little Kickers',
      host: 'kickers.example-sport.test',
    });
    expect((await offer(kickersId)).status).toBe('planned');
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('a take-back naming the older plan reads past the newest ask and lands on that plan', async () => {
    const f = await family();
    await approveSwim(f);
    const kickersId = await kickersAsk(f);
    const planReader = readerBy({
      'Little Kickers': { verdict: 'unrelated' },
      'Preschool Swim': { verdict: 'take_back', named: 'tokens' },
    });
    const { planWriter } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'cancel the swim one'), {
      planReader,
      planWriter,
    });

    expect(result?.outcome).toBe('plan_cancelled');
    expect(readOrder(planReader)).toEqual(['Little Kickers', 'Preschool Swim']);
    expect((await offer(f.offerId)).status).toBe('handed_back');
    expect((await offer(kickersId)).status).toBe('pending');
  });

  it('a take-back that does not name the older plan stops there, unclaimed', async () => {
    const f = await family();
    await approveSwim(f);
    const kickersId = await kickersAsk(f);
    const planReader = readerBy({
      'Little Kickers': { verdict: 'unrelated' },
      'Preschool Swim': { verdict: 'take_back', named: null },
    });
    const { planWriter, written } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'cancel'), {
      planReader,
      planWriter,
    });

    expect(result).toEqual({
      claimed: false,
      outcome: 'plan_unnamed',
      reply: null,
      deliverOnThread: false,
    });
    expect(written).toEqual([]);
    expect((await offer(f.offerId)).status).toBe('planned');
    expect((await offer(kickersId)).status).toBe('pending');
  });

  it('a bare stop reaches the newest ask, not an older plan whose run is going', async () => {
    const f = await family();
    await approveSwim(f);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({
        status: 'submitting',
        planResume: { phase: 'signup', runId: 'run-q', sessionId: null, browserId: null },
        planLeaseUntil: null,
      })
      .where(eq(schema.authorizedSignupOffers.id, f.offerId));
    const kickersId = await kickersAsk(f);
    const later = { now: new Date(OPENS.getTime() + 5 * 60_000) };
    const { planReader, planWriter } = fakes(TAKE_BACK);
    const result = await runAuthorizedSignup(
      db.database,
      { ...turn(f, 'stop'), ...later },
      { planReader, planWriter },
    );

    expect(result?.outcome).toBe('plan_declined');
    expect(readOrder(planReader)).toEqual(['Little Kickers']);
    expect((await offer(kickersId)).status).toBe('handed_back');
    expect((await offer(f.offerId)).planCancelRequestedAt).toBeNull();

    // A stop that names the running plan reaches it.
    const named = readerBy({ 'Preschool Swim': { verdict: 'take_back', named: 'tokens' } });
    const stopped = await runAuthorizedSignup(
      db.database,
      { ...turn(f, 'stop the swim registration'), ...later },
      { planReader: named, planWriter },
    );
    expect(stopped?.outcome).toBe('plan_cancelled');
    expect((await offer(f.offerId)).planCancelRequestedAt).not.toBeNull();
  });

  it('a yes that names an older ask approves that ask', async () => {
    const f = await family();
    const kickersId = await kickersAsk(f);
    const planReader = readerBy({
      'Little Kickers': { verdict: 'unrelated' },
      'Preschool Swim': { ...APPROVE, named: 'tokens' },
    });
    const { planWriter } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes to the swim one'), {
      planReader,
      planWriter,
    });

    expect(result?.outcome).toBe('plan_approved');
    expect((await offer(f.offerId)).status).toBe('planned');
    expect((await offer(kickersId)).status).toBe('pending');
  });

  it('a yes the reader put on an older ask without naming it stops, unclaimed', async () => {
    const f = await family();
    const kickersId = await kickersAsk(f);
    const planReader = readerBy({
      'Little Kickers': { verdict: 'unrelated' },
      'Preschool Swim': APPROVE,
    });
    const { planWriter } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'ok'), {
      planReader,
      planWriter,
    });

    expect(result).toMatchObject({ claimed: false, outcome: 'plan_unnamed' });
    expect((await offer(f.offerId)).status).toBe('pending');
    expect((await offer(kickersId)).status).toBe('pending');
  });

  it('a bare yes binds the newest ask still waiting, past a newer approved plan', async () => {
    const f = await family();
    const kickersId = await kickersAsk(f);
    await approveSignupPlan(db.database, {
      offerId: kickersId,
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      messageId: 'msg-approve-kickers',
      choiceIds: ['sat-0900'],
      maxPriceCents: 9800,
      opensAt: KICKERS_OPENS,
      waiverAccepted: false,
      now: new Date(NOW.getTime() - 5 * 60_000),
    });
    const planReader = readerBy({
      'Little Kickers': { verdict: 'unrelated' },
      'Preschool Swim': APPROVE,
    });
    const { planWriter } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
    });

    expect(readOrder(planReader)).toEqual(['Little Kickers', 'Preschool Swim']);
    expect(result?.outcome).toBe('plan_approved');
    expect((await offer(f.offerId)).status).toBe('planned');

    // Hale's receipt for the swim plan is its last word to them: a bare stop next takes the
    // swim plan back, not the Kickers plan approved before it.
    await result.afterSend?.('out-swim-planned');
    const stop: PlanReader = {
      read: vi.fn(async (read) =>
        toPlanReading(
          {
            reason: 'r',
            said: 'no stop',
            named: null,
            verdict: 'take_back',
            choiceIds: [],
            maxPriceCents: null,
            waiverSaid: null,
            waiverAccepted: false,
            question: null,
          },
          read.offer,
          read.text,
        ),
      ),
    };
    const stopped = await runAuthorizedSignup(db.database, turn(f, 'no stop'), {
      planReader: stop,
      planWriter,
    });
    expect(stopped.outcome).toBe('plan_cancelled');
    expect(readOrder(stop)).toEqual(['Preschool Swim']);
    expect((await offer(f.offerId)).status).toBe('handed_back');
    expect((await offer(kickersId)).status).toBe('planned');
  });

  it('a reading that fails stops the turn: no later plan is read, and nothing moves', async () => {
    const consentReader: SignupConsentReader = {
      read: vi.fn(async () => ({ verdict: 'consent' as const, sessionId: 'sat-0900' })),
    };
    const f = await family();
    const kickersId = await kickersAsk(f);
    const planReader = readerBy({ 'Little Kickers': null, 'Preschool Swim': APPROVE });
    const { planWriter, written } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
      consentReader,
    });

    expect(result).toEqual({
      claimed: false,
      outcome: 'plan_unread',
      reply: null,
      deliverOnThread: false,
    });
    expect(readOrder(planReader)).toEqual(['Little Kickers']);
    expect(consentReader.read).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect((await offer(f.offerId)).status).toBe('pending');
    expect((await offer(kickersId)).status).toBe('pending');
  });

  it("a co-parent's newer plan ask never captures this parent's bare yes", async () => {
    const f = await family(); // the swim plan, asked of this parent an hour ago
    const coParentUserId = await seedCoParent(f.familyId);
    const kickersId = await kickersAsk({ ...f, parentUserId: coParentUserId });
    const { planReader, planWriter, written } = fakes(APPROVE);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
    });

    expect(readOrder(planReader)).toEqual(['Preschool Swim']);
    expect(result.outcome).toBe('plan_approved');
    expect(written.map((facts) => facts.refusal)).toEqual([null]);
    expect((await offer(f.offerId)).status).toBe('planned');
    expect((await offer(kickersId)).status).toBe('pending');

    // The co-parent's own yes reaches only the ask Hale made them.
    const theirs = fakes({ verdict: 'unrelated' });
    await runAuthorizedSignup(db.database, turn({ ...f, parentUserId: coParentUserId }, 'yes'), {
      planReader: theirs.planReader,
      planWriter: theirs.planWriter,
    });
    expect(readOrder(theirs.planReader)).toEqual(['Little Kickers']);
  });

  it("a co-parent's newer one-shot ask never makes this parent's bare yes need a name", async () => {
    const f = await family();
    const coParentUserId = await seedCoParent(f.familyId);
    const gym = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: coParentUserId,
      activityKey: 'gym-tots',
      activityLabel: 'Gym Tots',
      registrationUrl: 'https://gym.example-play.test/register',
      sessions: SESSIONS,
      approvedPriceCents: null,
      planOpensAt: null,
      now: new Date(NOW.getTime() - 10 * 60_000),
    });
    if (!gym.ok) throw new Error(gym.reason);
    const consentReader: SignupConsentReader = {
      read: vi.fn(async () => ({ verdict: 'consent' as const, sessionId: 'sat-0900' })),
    };
    const { planReader, planWriter } = fakes(APPROVE);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
      consentReader,
    });

    expect(consentReader.read).not.toHaveBeenCalled();
    expect(result.outcome).toBe('plan_approved');
    expect((await offer(f.offerId)).status).toBe('planned');
    expect((await offer(gym.id)).status).toBe('pending');
  });

  it('the reply audit says how the plan was bound: the newest ask, or the words that named it', async () => {
    const older = await family();
    await kickersAsk(older);
    const planReader = readerBy({
      'Little Kickers': { verdict: 'unrelated' },
      'Preschool Swim': { ...APPROVE, named: 'tokens' },
    });
    const { planWriter } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(older, 'yes to the swim one'), {
      planReader,
      planWriter,
    });
    expect(result.outcome).toBe('plan_approved');
    expect(await replyBindings(older.offerId)).toEqual(['tokens']);

    const f = await family();
    const kickersId = await kickersAsk(f);
    const newest = fakes({ ...APPROVE, named: 'tokens' });
    await runAuthorizedSignup(db.database, turn(f, 'yes to kickers'), {
      planReader: newest.planReader,
      planWriter: newest.planWriter,
    });
    expect(await replyBindings(kickersId)).toEqual(['newest']);
  });

  it('a bare cancel, happy or yes never moves an older plan, whatever the model quoted as its name', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const swimmers = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'little-swimmers',
      activityLabel: '儿童游泳课',
      registrationUrl: 'https://app.amilia.com/store/en/example-club/shop/programs/1',
      sessions: SESSIONS,
      approvedPriceCents: null,
      planOpensAt: OPENS,
      now: new Date(NOW.getTime() - 30 * 60_000),
    });
    if (!swimmers.ok) throw new Error(swimmers.reason);
    const kickersId = await kickersAsk(f);
    const turns: { body: string; named: string; yes: boolean }[] = [
      { body: 'cancel', named: 'cancel', yes: false },
      { body: 'happy', named: 'happy', yes: true },
      { body: 'yes', named: 'yes', yes: true },
      { body: '游泳那个取消吧', named: '游泳', yes: false },
    ];
    for (const { body, named, yes } of turns) {
      // The model's worst answer is stipulated: its verdict on the older plan, with the
      // parent's words as the plan's name. The bindings are the real ones.
      const planReader: PlanReader = {
        read: vi.fn(async (read) =>
          read.offer.activity === 'Little Kickers'
            ? { verdict: 'unrelated' as const }
            : toPlanReading(
                {
                  reason: 'r',
                  said: body,
                  named,
                  verdict: yes ? 'approve' : 'take_back',
                  choiceIds: yes ? ['sat-0900'] : [],
                  maxPriceCents: yes ? 9800 : null,
                  waiverSaid: null,
                  waiverAccepted: false,
                  question: null,
                },
                read.offer,
                read.text,
              ),
        ),
      };
      const { planWriter, written } = fakes(null);
      const result = await runAuthorizedSignup(db.database, turn(f, body), {
        planReader,
        planWriter,
      });
      expect(readOrder(planReader)).toEqual(['Little Kickers', '儿童游泳课']);
      expect(result).toEqual({
        claimed: false,
        outcome: 'plan_unnamed',
        reply: null,
        deliverOnThread: false,
      });
      expect(written).toEqual([]);
    }
    for (const id of [kickersId, swimmers.id, f.offerId]) {
      expect((await offer(id)).status).toBe('pending');
    }
    expect(await replyBindings(swimmers.id)).toEqual([]);

    // Positive control: the parent writing its whole name, set off on its own, reaches it.
    const named: PlanReader = {
      read: vi.fn(async (read) =>
        read.offer.activity === 'Little Kickers'
          ? { verdict: 'unrelated' as const }
          : toPlanReading(
              {
                reason: 'r',
                said: '取消吧',
                named: '儿童游泳课',
                verdict: 'take_back',
                choiceIds: [],
                maxPriceCents: null,
                waiverSaid: null,
                waiverAccepted: false,
                question: null,
              },
              read.offer,
              read.text,
            ),
      ),
    };
    const { planWriter } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, '儿童游泳课，取消吧'), {
      planReader: named,
      planWriter,
    });
    expect(result.outcome).toBe('plan_declined');
    expect((await offer(swimmers.id)).status).toBe('handed_back');
    expect(await replyBindings(swimmers.id)).toEqual(['tokens']);
  });

  it('an older plan never asks back on words that do not name it: a question to it would hand the next bare yes to the newest', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const kickersId = await kickersAsk(f);
    const raw = (over: Partial<Parameters<typeof toPlanReading>[0]>) => ({
      reason: 'r',
      said: null,
      named: null,
      verdict: 'unrelated' as const,
      choiceIds: [],
      maxPriceCents: null,
      waiverSaid: null,
      waiverAccepted: false,
      question: null,
      ...over,
    });
    // The model's readings are stipulated, one per program; the bindings are the real ones.
    const readerOf = (
      swim: Parameters<typeof toPlanReading>[0],
      kickers: Parameters<typeof toPlanReading>[0],
    ): PlanReader => ({
      read: vi.fn(async (read) =>
        toPlanReading(
          read.offer.activity === 'Little Kickers' ? kickers : swim,
          read.offer,
          read.text,
        ),
      ),
    });
    const question = 'Do you want the Sunday 10:00 swim session instead?';
    const { planWriter, written } = fakes(null);

    const later = readerOf(
      raw({ verdict: 'unclear', named: 'the later one', question }),
      raw({ verdict: 'unrelated' }),
    );
    const asked = await runAuthorizedSignup(db.database, turn(f, 'can we do the later one?'), {
      planReader: later,
      planWriter,
    });
    expect(readOrder(later)).toEqual(['Little Kickers', 'Preschool Swim']);
    expect(asked).toEqual({
      claimed: false,
      outcome: 'not_claimed',
      reply: null,
      deliverOnThread: false,
    });

    // The parent's bare yes next answers the only ask Hale put to them: the newest.
    const yes = { said: 'yes', choiceIds: ['sat-0900'], maxPriceCents: 9800 };
    const bare = readerOf(raw({ verdict: 'approve', ...yes }), raw({ verdict: 'approve', ...yes }));
    const approved = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader: bare,
      planWriter,
    });
    expect(approved.outcome).toBe('plan_approved');
    expect(written.map((facts) => facts.moment)).toEqual(['approved']);
    expect(await replyBindings(f.offerId)).toEqual([]);
    expect(await replyBindings(kickersId)).toEqual(['newest']);
    expect((await offer(f.offerId)).status).toBe('pending');

    // Positive control: words that name the older plan may be asked back.
    const named = readerOf(
      raw({ verdict: 'unclear', named: 'the later swim one', question }),
      raw({ verdict: 'unrelated' }),
    );
    const clarified = await runAuthorizedSignup(
      db.database,
      turn(f, 'can we do the later swim one?'),
      { planReader: named, planWriter },
    );
    expect(clarified.outcome).toBe('plan_clarify');
    expect(written.at(-1)?.question).toBe(question);
    expect(await replyBindings(f.offerId)).toEqual(['tokens']);
  });

  it('a named older plan that asks back is the ask a bare yes after it answers', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const kickersId = await kickersAsk(f); // ten minutes ago
    const raw = (over: Partial<Parameters<typeof toPlanReading>[0]>) => ({
      reason: 'r',
      said: null,
      named: null,
      verdict: 'unrelated' as const,
      choiceIds: [],
      maxPriceCents: null,
      waiverSaid: null,
      waiverAccepted: false,
      question: null,
      ...over,
    });
    // The model's raw answers are stipulated, one per program; the readers are the real ones.
    const readerOf = (
      swim: Parameters<typeof toPlanReading>[0],
      kickers: Parameters<typeof toPlanReading>[0],
    ): PlanReader => ({
      read: vi.fn(async (read) =>
        toPlanReading(
          read.offer.activity === 'Little Kickers' ? kickers : swim,
          read.offer,
          read.text,
        ),
      ),
    });
    const question = 'Do you want the Sunday 10:00 swim session instead?';
    const { planWriter, written } = fakes(null);

    const asked = await runAuthorizedSignup(db.database, turn(f, 'can we do the later swim one?'), {
      planReader: readerOf(
        raw({ verdict: 'unclear', named: 'the later swim one', question }),
        raw({ verdict: 'unrelated' }),
      ),
      planWriter,
    });
    expect(asked.outcome).toBe('plan_clarify');
    expect(written.at(-1)?.question).toBe(question);
    // Asked only once the question went out: the router sends it, then calls afterSend.
    expect((await offer(f.offerId)).lastAskedAt).toBeNull();
    await asked.afterSend?.('out-swim-question');
    expect((await offer(f.offerId)).lastAskedAt?.toISOString()).toBe(NOW.toISOString());

    // The model's worst answer: both asks read the bare yes as a go-ahead.
    const yes = { said: 'yes', choiceIds: ['sun-1000'], maxPriceCents: 9800 };
    const bare = readerOf(raw({ verdict: 'approve', ...yes }), raw({ verdict: 'approve', ...yes }));
    const approved = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader: bare,
      planWriter,
    });
    expect(approved.outcome).toBe('plan_approved');
    expect(readOrder(bare)).toEqual(['Preschool Swim']);
    const swim = await offer(f.offerId);
    expect(swim.status).toBe('planned');
    expect(swim.planChoiceIds).toEqual(['sun-1000']);
    expect((await offer(kickersId)).status).toBe('pending');
    expect(await replyBindings(f.offerId)).toEqual(['tokens', 'newest']);
    expect(await replyBindings(kickersId)).toEqual([]);
  });

  it('a message about none of them leaves the pending ask to no one but the coach', async () => {
    const consentReader: SignupConsentReader = {
      read: vi.fn(async () => ({ verdict: 'consent' as const, sessionId: 'sat-0900' })),
    };
    const f = await family();
    await kickersAsk(f);
    const { planReader, planWriter } = fakes({ verdict: 'unrelated' });
    const result = await runAuthorizedSignup(db.database, turn(f, 'what time is pickup'), {
      planReader,
      planWriter,
      consentReader,
    });
    expect(result.claimed).toBe(false);
    expect(planReader.read).toHaveBeenCalledTimes(2);
    expect(consentReader.read).not.toHaveBeenCalled();
  });
});

describe('a plan ask and a one-shot ask, both live', () => {
  const GYM_URL = 'https://gym.example-play.test/register';
  const GYM_SESSION = {
    id: 'gym-sat',
    label: 'Gym Tots Sat 10:00',
    startsAt: '2027-01-09T15:00:00.000Z',
    endsAt: '2027-01-09T15:45:00.000Z',
    full: false,
    priceCents: null,
  };

  /** A one-shot ask (no open time) for another program, recorded `minutesAgo` before now. */
  async function gymAsk(
    f: { familyId: string; parentUserId: string; childId: string },
    minutesAgo: number,
  ) {
    const recorded = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'gym-tots',
      activityLabel: 'Gym Tots',
      registrationUrl: GYM_URL,
      sessions: [GYM_SESSION],
      approvedPriceCents: null,
      planOpensAt: null,
      now: new Date(NOW.getTime() - minutesAgo * 60_000),
    });
    if (!recorded.ok) throw new Error(recorded.reason);
    return recorded.id;
  }

  /** Both readers stand in for the model; `reads` is the order the walk asked them in. */
  function readers(plan: PlanReading | null, oneShot: SignupConsentReading | null) {
    const reads: string[] = [];
    const planReader: PlanReader = {
      read: vi.fn(async ({ offer: read }) => {
        reads.push(`plan:${read.activity}`);
        return plan;
      }),
    };
    const consentReader: SignupConsentReader = {
      read: vi.fn(async ({ offer: read }) => {
        reads.push(`one_shot:${read.activityKey}`);
        return oneShot;
      }),
    };
    return { reads, planReader, consentReader };
  }

  it('a bare yes to a newer one-shot ask goes to that ask, never to the older plan', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const gymId = await gymAsk(f, 10);
    const { reads, planReader, consentReader } = readers(APPROVE, {
      verdict: 'consent',
      sessionId: 'gym-sat',
    });
    const { planWriter } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
      consentReader,
      outcomeWriter: echoOutcomeWriter(),
      browser: null,
    });

    expect(reads).toEqual(['one_shot:gym-tots']);
    expect(result).toMatchObject({ claimed: true, outcome: 'browser_unavailable' });
    expect((await offer(gymId)).status).toBe('handed_back');
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it("a one-shot ask stays answerable while a newer plan ask waits: the plan's unrelated passes it on", async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const gymId = await gymAsk(f, 90);
    const { reads, planReader, consentReader } = readers(
      { verdict: 'unrelated' },
      { verdict: 'consent', sessionId: 'gym-sat' },
    );
    const { planWriter } = fakes(null);
    const result = await runAuthorizedSignup(
      db.database,
      turn(f, 'yes, sign her up for Gym Tots'),
      {
        planReader,
        planWriter,
        consentReader,
        outcomeWriter: echoOutcomeWriter(),
        browser: null,
      },
    );

    expect(reads).toEqual(['plan:Preschool Swim', 'one_shot:gym-tots']);
    expect(result).toMatchObject({ claimed: true, outcome: 'browser_unavailable' });
    expect((await offer(gymId)).status).toBe('handed_back');
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it("a plan ask stays answerable while a newer one-shot ask waits: the one-shot's unrelated passes it on", async () => {
    const f = await family();
    const gymId = await gymAsk(f, 10);
    const { reads, planReader, consentReader } = readers(
      { ...APPROVE, named: 'tokens' },
      { verdict: 'unrelated' },
    );
    const { planWriter } = fakes(null);
    const result = await runAuthorizedSignup(
      db.database,
      turn(f, 'yes to the swim one, Sunday then Saturday, up to $105'),
      { planReader, planWriter, consentReader },
    );

    expect(reads).toEqual(['one_shot:gym-tots', 'plan:Preschool Swim']);
    expect(result.outcome).toBe('plan_approved');
    expect((await offer(f.offerId)).status).toBe('planned');
    expect((await offer(gymId)).status).toBe('pending');
  });

  it('an older one-shot ask never asks back on words that do not name it', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const gymId = await gymAsk(f, 90);
    const { reads, planReader, consentReader } = readers(
      { verdict: 'unrelated' },
      { verdict: 'unclear', question: 'Which Gym Tots session do you mean?' },
    );
    const { planWriter } = fakes(null);
    const deps = {
      planReader,
      planWriter,
      consentReader,
      outcomeWriter: echoOutcomeWriter(),
      browser: null,
    };
    const result = await runAuthorizedSignup(
      db.database,
      turn(f, 'can we do the later one?'),
      deps,
    );

    expect(reads).toEqual(['plan:Preschool Swim', 'one_shot:gym-tots']);
    expect(result).toEqual({
      claimed: false,
      outcome: 'not_claimed',
      reply: null,
      deliverOnThread: false,
    });
    expect((await offer(gymId)).status).toBe('pending');

    // Positive control: words that carry its name may be asked back.
    const named = await runAuthorizedSignup(
      db.database,
      turn(f, 'can we do the later Gym Tots one?'),
      deps,
    );
    expect(named).toMatchObject({ claimed: true, outcome: 'clarify' });
    expect((await offer(gymId)).status).toBe('pending');
  });

  it('a bare cancel never names an older ask by a fragment of its site', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const older = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'toddler-gym',
      activityLabel: 'Toddler Gym',
      registrationUrl:
        'https://anc.ca.apm.activecommunities.com/examplecity/activity/search/detail/1',
      sessions: [GYM_SESSION],
      approvedPriceCents: null,
      planOpensAt: null,
      now: new Date(NOW.getTime() - 90 * 60_000),
    });
    if (!older.ok) throw new Error(older.reason);
    const { reads, planReader, consentReader } = readers(
      { verdict: 'unrelated' },
      { verdict: 'decline' },
    );
    const { planWriter } = fakes(null);
    const deps = {
      planReader,
      planWriter,
      consentReader,
      outcomeWriter: echoOutcomeWriter(),
      browser: null,
    };
    const result = await runAuthorizedSignup(db.database, turn(f, 'cancel'), deps);

    expect(reads).toEqual(['plan:Preschool Swim', 'one_shot:toddler-gym']);
    expect(result).toEqual({
      claimed: false,
      outcome: 'signup_unnamed',
      reply: null,
      deliverOnThread: false,
    });
    expect((await offer(older.id)).status).toBe('pending');

    // Positive control: words that carry its name reach it.
    const named = await runAuthorizedSignup(db.database, turn(f, 'cancel the toddler one'), deps);
    expect(named.claimed).toBe(true);
    expect((await offer(older.id)).status).toBe('handed_back');
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('a yes the one-shot reader put on an older ask whose name the parent never wrote stops, unclaimed', async () => {
    const f = await family();
    const gymId = await gymAsk(f, 90);
    const { reads, planReader, consentReader } = readers(
      { verdict: 'unrelated' },
      { verdict: 'consent', sessionId: 'gym-sat' },
    );
    const { planWriter } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes please'), {
      planReader,
      planWriter,
      consentReader,
      outcomeWriter: echoOutcomeWriter(),
      browser: null,
    });

    expect(reads).toEqual(['plan:Preschool Swim', 'one_shot:gym-tots']);
    expect(result).toEqual({
      claimed: false,
      outcome: 'signup_unnamed',
      reply: null,
      deliverOnThread: false,
    });
    expect((await offer(gymId)).status).toBe('pending');
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('a bare cancel, happy or yes never moves an older one-shot ask on a shared platform', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const older = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'little-swimmers',
      activityLabel: '儿童游泳课',
      registrationUrl: 'https://app.amilia.com/store/en/example-club/shop/programs/1',
      sessions: [GYM_SESSION],
      approvedPriceCents: null,
      planOpensAt: null,
      now: new Date(NOW.getTime() - 90 * 60_000),
    });
    if (!older.ok) throw new Error(older.reason);
    const readings: [string, SignupConsentReading][] = [
      ['cancel', { verdict: 'decline' }],
      ['happy', { verdict: 'consent', sessionId: 'gym-sat' }],
      ['yes', { verdict: 'consent', sessionId: 'gym-sat' }],
      ['游泳那个取消吧', { verdict: 'decline' }],
    ];
    for (const [body, reading] of readings) {
      const { reads, planReader, consentReader } = readers({ verdict: 'unrelated' }, reading);
      const { planWriter } = fakes(null);
      const result = await runAuthorizedSignup(db.database, turn(f, body), {
        planReader,
        planWriter,
        consentReader,
        outcomeWriter: echoOutcomeWriter(),
        browser: null,
      });
      expect(reads).toEqual(['plan:Preschool Swim', 'one_shot:little-swimmers']);
      expect(result).toMatchObject({ claimed: false, outcome: 'signup_unnamed' });
    }
    expect((await offer(older.id)).status).toBe('pending');
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it('a named older one-shot ask that asks back is the ask a bare no after it hands back', async () => {
    const seeded = await seedFamily(db.database);
    const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
    const oneShot = async (key: string, label: string, url: string, minutesAgo: number) => {
      const recorded = await recordSignupOffer(db.database, {
        familyId: seeded.familyId,
        childId,
        parentUserId: seeded.parentUserId,
        activityKey: key,
        activityLabel: label,
        registrationUrl: url,
        sessions: [GYM_SESSION],
        approvedPriceCents: null,
        planOpensAt: null,
        now: new Date(NOW.getTime() - minutesAgo * 60_000),
      });
      if (!recorded.ok) throw new Error(recorded.reason);
      return recorded.id;
    };
    const gymnasticsId = await oneShot('toddler-gymnastics', 'Toddler Gymnastics', GYM_URL, 90);
    const kickersId = await oneShot(
      'kickers-sat',
      'Little Kickers',
      'https://kickers.example-sport.test/register/sat',
      10,
    );
    // The model's raw answers are stipulated, one per program; the reader's checks are real.
    const consentOf = (
      gymnastics: z.infer<typeof signupConsentSchema>,
      kickers: z.infer<typeof signupConsentSchema>,
    ): SignupConsentReader => ({
      read: vi.fn(async ({ offer: read }) =>
        toSignupConsentReading(read.activityKey === 'kickers-sat' ? kickers : gymnastics, read),
      ),
    });
    // The production handler, as the router calls it: send the reply, then afterSend.
    const handle = (body: string, consentReader: SignupConsentReader) => {
      seq += 1;
      return authorizedSignupHandler({ consentReader, outcomeWriter: echoOutcomeWriter() }).handle(
        db.database,
        {
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          conversationId: 'conv-asked',
          body,
          now: NOW,
          send: async () => {
            throw new Error('handler must not send a 1:1 itself');
          },
          resolved: null,
          openQuestions: async () => [],
          inboundChannelMessageId: `msg-${seq}`,
        },
      );
    };
    const none = { sessionId: null, question: null };

    const asked = await handle(
      'is the gymnastics one on Saturdays?',
      consentOf(
        { verdict: 'unclear', sessionId: null, question: 'Do you want the Saturday class?' },
        { verdict: 'unrelated', ...none },
      ),
    );
    expect(asked).toMatchObject({ claimed: true, outcome: 'clarify' });
    if (!asked.claimed) return;
    expect(asked.reply).not.toBeNull();
    await asked.afterSend?.('out-gymnastics-question');

    // The model's worst answer: both asks read the bare no as a no.
    const declined = await handle(
      'no, forget it',
      consentOf({ verdict: 'decline', ...none }, { verdict: 'decline', ...none }),
    );
    expect(declined).toMatchObject({ claimed: true, outcome: 'declined' });
    expect((await offer(gymnasticsId)).status).toBe('handed_back');
    expect((await offer(kickersId)).status).toBe('pending');
  });
});

describe('when the site options do not match', () => {
  const CHOICES = [
    {
      id: 'nov-21',
      label: 'Nov 21',
      starts_at: '2026-11-21',
      price_cents: 12000,
      waitlist: false,
      billing_note: 'billed December',
      provider_email: 'rec@example.test',
    },
    {
      id: 'jan-wait',
      label: 'January waitlist',
      starts_at: '2027-01-09',
      price_cents: 9800,
      waitlist: true,
      billing_note: null,
      provider_email: 'rec@example.test',
    },
  ];

  async function mismatched() {
    const f = await family();
    await approveSignupPlan(db.database, {
      offerId: f.offerId,
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      messageId: 'msg-mismatch',
      choiceIds: ['sat-0900'],
      maxPriceCents: 10500,
      opensAt: OPENS,
      waiverAccepted: true,
      now: NOW,
    });
    await parkSignupPlan(db.database, {
      offerId: f.offerId,
      familyId: f.familyId,
      availability: { kind: 'options_mismatch', askedStart: 'January', choices: CHOICES },
      now: NOW,
    });
    return f;
  }

  it('parks a waitlist pick and does not invent an option', async () => {
    const f = await mismatched();
    const mismatchReader: MismatchReader = {
      read: vi.fn(async () => ({ verdict: 'waitlist' as const })),
    };
    const { planReader, planWriter } = fakes(APPROVE);
    const result = await runAuthorizedSignup(db.database, turn(f, 'join the waitlist'), {
      planReader,
      planWriter,
      mismatchReader,
    });
    expect(result?.outcome).toBe('plan_approved');
    expect(planReader.read).not.toHaveBeenCalled();
    expect((await offer(f.offerId)).planAvailability).toMatchObject({ kind: 'join_waitlist' });
  });

  it('parks the site option the parent named, never another', async () => {
    const f = await mismatched();
    const mismatchReader: MismatchReader = {
      read: vi.fn(async () => ({ verdict: 'option' as const, choiceId: 'nov-21' })),
    };
    const { planWriter } = fakes(APPROVE);
    await runAuthorizedSignup(db.database, turn(f, 'take Nov 21'), { planWriter, mismatchReader });
    expect((await offer(f.offerId)).planAvailability).toMatchObject({
      kind: 'take_option',
      choice: expect.objectContaining({ id: 'nov-21' }),
    });
  });

  it('a pick that cannot be read stops the turn and parks nothing', async () => {
    const f = await mismatched();
    const mismatchReader: MismatchReader = { read: vi.fn(async () => null) };
    const { planWriter, written } = fakes(APPROVE);
    const result = await runAuthorizedSignup(db.database, turn(f, 'the 21st'), {
      planWriter,
      mismatchReader,
    });
    expect(result).toMatchObject({ claimed: false, outcome: 'plan_unread' });
    expect(written).toEqual([]);
    expect((await offer(f.offerId)).planAvailability).toMatchObject({ kind: 'options_mismatch' });
  });

  it('emails the provider from Gmail only after they say yes', async () => {
    const f = await mismatched();
    const sendProviderEmail = vi.fn(async () => undefined);
    const mismatchReader: MismatchReader = {
      read: vi.fn(async () => ({ verdict: 'email' as const })),
    };
    const { planWriter } = fakes(APPROVE);
    await runAuthorizedSignup(db.database, turn(f, 'email them'), {
      planWriter,
      mismatchReader,
      sendProviderEmail,
    });
    expect(sendProviderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'rec@example.test',
        familyId: f.familyId,
        actorUserId: f.parentUserId,
      }),
    );
    expect((await offer(f.offerId)).planAvailability).toMatchObject({ kind: 'emailed' });
  });

  it("a co-parent's pick parks nothing and sends no email from anyone's Gmail", async () => {
    const f = await mismatched();
    const coParentUserId = await seedCoParent(f.familyId);
    const sendProviderEmail = vi.fn(async () => undefined);
    const mismatchReader: MismatchReader = {
      read: vi.fn(async () => ({ verdict: 'email' as const })),
    };
    const { planWriter, written } = fakes(APPROVE);
    const result = await runAuthorizedSignup(
      db.database,
      turn({ ...f, parentUserId: coParentUserId }, 'email them'),
      { planWriter, mismatchReader, sendProviderEmail },
    );

    expect(result).toMatchObject({ claimed: false, outcome: 'not_claimed' });
    expect(mismatchReader.read).not.toHaveBeenCalled();
    expect(sendProviderEmail).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect((await offer(f.offerId)).planAvailability).toMatchObject({ kind: 'options_mismatch' });
  });

  it('a group seat that may not authorize a sign-up parks nothing and emails no one', async () => {
    const f = await mismatched();
    const sendProviderEmail = vi.fn(async () => undefined);
    const { planWriter, written } = fakes(APPROVE);
    const picks = [
      { verdict: 'email' as const },
      { verdict: 'option' as const, choiceId: 'nov-21' },
      { verdict: 'waitlist' as const },
    ];
    for (const pick of picks) {
      const mismatchReader: MismatchReader = { read: vi.fn(async () => pick) };
      const result = await runAuthorizedSignup(db.database, turn(f, 'go with that'), {
        planWriter,
        mismatchReader,
        sendProviderEmail,
        declineSeat: async () => true,
      });
      expect(result).toEqual({
        claimed: true,
        outcome: 'group_member_not_authorized',
        reply: null,
        deliverOnThread: false,
      });
    }
    expect(sendProviderEmail).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect((await offer(f.offerId)).planAvailability).toMatchObject({ kind: 'options_mismatch' });
  });

  it('an older plan whose options did not match asks back, parks or emails only on words that name it', async () => {
    const f = await mismatched(); // the swim plan, asked an hour ago
    const kickers = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'kickers-sat',
      activityLabel: 'Little Kickers',
      registrationUrl: 'https://kickers.example-sport.test/register/sat',
      sessions: SESSIONS,
      approvedPriceCents: null,
      planOpensAt: new Date('2026-12-08T12:00:00.000Z'),
      now: new Date(NOW.getTime() - 10 * 60_000),
    });
    if (!kickers.ok) throw new Error(kickers.reason);
    const sendProviderEmail = vi.fn(async () => undefined);
    const { planReader, planWriter, written } = fakes({ verdict: 'unrelated' });
    const deps = (pick: MismatchReading) => ({
      planReader,
      planWriter,
      mismatchReader: { read: vi.fn(async () => pick) },
      sendProviderEmail,
    });

    const unclear = deps({ verdict: 'unclear', question: 'The Nov 21 start or the waitlist?' });
    const asked = await runAuthorizedSignup(db.database, turn(f, 'which is better?'), unclear);
    expect(unclear.mismatchReader.read).toHaveBeenCalledTimes(1);
    expect(asked).toEqual({
      claimed: false,
      outcome: 'not_claimed',
      reply: null,
      deliverOnThread: false,
    });
    const picks: MismatchReading[] = [
      { verdict: 'email' },
      { verdict: 'option', choiceId: 'nov-21' },
      { verdict: 'waitlist' },
    ];
    for (const pick of picks) {
      const result = await runAuthorizedSignup(db.database, turn(f, 'go with that'), deps(pick));
      expect(result).toEqual({
        claimed: false,
        outcome: 'plan_unnamed',
        reply: null,
        deliverOnThread: false,
      });
    }
    expect(sendProviderEmail).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect((await offer(f.offerId)).planAvailability).toMatchObject({ kind: 'options_mismatch' });
    expect((await offer(kickers.id)).status).toBe('pending');

    // Positive control: words that carry its name reach it.
    const named = await runAuthorizedSignup(
      db.database,
      turn(f, 'email the swim people'),
      deps({ verdict: 'email' }),
    );
    expect(named.outcome).toBe('plan_approved');
    expect(sendProviderEmail).toHaveBeenCalledTimes(1);
    expect((await offer(f.offerId)).planAvailability).toMatchObject({ kind: 'emailed' });
  });

  it('a named older plan whose options did not match asks back, and the bare yes after it is its pick', async () => {
    const f = await mismatched(); // the swim plan, asked an hour ago
    const kickers = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'kickers-sat',
      activityLabel: 'Little Kickers',
      registrationUrl: 'https://kickers.example-sport.test/register/sat',
      sessions: SESSIONS,
      approvedPriceCents: null,
      planOpensAt: new Date('2026-12-08T12:00:00.000Z'),
      now: new Date(NOW.getTime() - 10 * 60_000),
    });
    if (!kickers.ok) throw new Error(kickers.reason);
    // The model's raw answers are stipulated; the readers' checks are the real ones.
    const kickersReads = (verdict: 'approve' | 'unrelated'): PlanReader => ({
      read: vi.fn(async (read) =>
        toPlanReading(
          {
            reason: 'r',
            said: verdict === 'approve' ? 'yes' : null,
            named: null,
            verdict,
            choiceIds: verdict === 'approve' ? ['sat-0900'] : [],
            maxPriceCents: verdict === 'approve' ? 9800 : null,
            waiverSaid: null,
            waiverAccepted: false,
            question: null,
          },
          read.offer,
          read.text,
        ),
      ),
    });
    const swimReads = (raw: z.infer<typeof signupMismatchReadSchema>): MismatchReader => ({
      read: vi.fn(async (read) => toMismatchReading(raw, read.choices)),
    });
    const sendProviderEmail = vi.fn(async () => undefined);
    const { planWriter, written } = fakes(null);
    const question = 'Do you want the January waitlist instead?';

    const asked = await runAuthorizedSignup(
      db.database,
      turn(f, 'can the swim one wait for January?'),
      {
        planReader: kickersReads('unrelated'),
        planWriter,
        mismatchReader: swimReads({ reason: 'r', verdict: 'unclear', choiceId: null, question }),
        sendProviderEmail,
      },
    );
    expect(asked.outcome).toBe('plan_clarify');
    expect(written.at(-1)?.question).toBe(question);
    // The router sends the question, then hands the turn its outbound message.
    await asked.afterSend?.('out-swim-mismatch-question');

    // The model's worst answer: the newer ask reads the bare yes as its go-ahead.
    const planReader = kickersReads('approve');
    const picked = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
      mismatchReader: swimReads({
        reason: 'r',
        verdict: 'waitlist',
        choiceId: null,
        question: null,
      }),
      sendProviderEmail,
    });
    expect(picked.outcome).toBe('plan_approved');
    expect(planReader.read).not.toHaveBeenCalled();
    expect((await offer(f.offerId)).planAvailability).toMatchObject({ kind: 'join_waitlist' });
    expect((await offer(kickers.id)).status).toBe('pending');
    expect(sendProviderEmail).not.toHaveBeenCalled();
  });
});
