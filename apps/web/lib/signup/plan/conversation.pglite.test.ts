import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { PICK_ASK_BACK_QUESTION, PLAN_ASK_BACK_QUESTION, SIGNUP_ASK_BACK_QUESTION } from '../asks';
import {
  type SignupConsentReader,
  type SignupConsentReading,
  type signupConsentSchema,
  toSignupConsentReading,
} from '../consent-reader';
import { AUTHORIZED_SIGNUP_ENABLED_ENV } from '../flag';
import { authorizedSignupHandler } from '../handler';
import { runAuthorizedSignup } from '../run';
import {
  type SendStamp,
  askStamp,
  loadLastAskedOfferId,
  loadSignupIdentity,
  recordSignupOffer,
} from '../store';
import { echoOutcomeWriter } from '../test-models';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import {
  type MismatchReader,
  type MismatchReading,
  type signupMismatchReadSchema,
  toMismatchReading,
} from './mismatch-reader';
import { createPlanPrepDeliver } from './notice';
import { recordPlanNotice, runDueSignupPlanPrep } from './prep';
import { type PlanReader, type PlanReading, toPlanReading } from './reader';
import { approveSignupPlan, parkSignupPlan } from './store';
import type { PlanReplyFacts, PlanReplyWriter } from './writer';

// Invented hosts and details only. The read and the reply are model calls with their own
// recorded evals (signup-plan-read, signup-plan-reply); here each is a stipulated answer,
// and what is tested is what the database and the reply do with it.
const NOW = new Date('2026-11-30T20:00:00.000Z');
/** A later turn than one at NOW: Hale's question back goes out after the text it follows. */
const LATER = new Date(NOW.getTime() + 60_000);
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
  await texted(seeded.familyId, offer.id);
  return { ...seeded, childId, offerId: offer.id };
}

const setUpOffers = new Map<string, string[]>();

/**
 * The coach's reply carrying this offer went out, and the router stamped it as asked. Offers
 * a test sets up with an earlier `now` were texted earlier, so the family's set-up offers are
 * stamped again in the order they were made. Only before any turn: a stamp no set-up made
 * would be reordered, so it fails loudly instead.
 */
async function texted(familyId: string, offerId: string): Promise<void> {
  const ids = [...(setUpOffers.get(familyId) ?? []), offerId];
  setUpOffers.set(familyId, ids);
  const rows = await db.database
    .select({
      id: schema.authorizedSignupOffers.id,
      createdAt: schema.authorizedSignupOffers.createdAt,
      lastAskedSeq: schema.authorizedSignupOffers.lastAskedSeq,
    })
    .from(schema.authorizedSignupOffers)
    .where(eq(schema.authorizedSignupOffers.familyId, familyId));
  if (rows.some((row) => row.lastAskedSeq !== null && !ids.includes(row.id))) {
    throw new Error('texted: set offers up before any turn stamps one');
  }
  const ordered = rows
    .filter((row) => ids.includes(row.id))
    .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  for (const row of ordered) await stamped(familyId, row.id);
}

/** A text about this offer went to its parent, through the stamp every send site uses. */
async function stamped(familyId: string, offerId: string): Promise<void> {
  const [row] = await db.database
    .select({ parentUserId: schema.authorizedSignupOffers.parentUserId })
    .from(schema.authorizedSignupOffers)
    .where(eq(schema.authorizedSignupOffers.id, offerId));
  if (!row) throw new Error('stamped: no such offer');
  const keep = await askStamp(db.database, {
    familyId,
    parentUserId: row.parentUserId,
    offerIds: [offerId],
  })();
  expect(await keep()).toBe('stamped');
}

/** What the router does around a claimed reply's send: draws before it, keeps after it. */
async function replySent(result: { stamp?: SendStamp }): Promise<void> {
  const keep = await result.stamp?.();
  await keep?.();
}

/** The ask whose text reached the parent last, as the walk reads it. */
async function lastAsked(f: { familyId: string; parentUserId: string }) {
  return loadLastAskedOfferId(db.database, f);
}

let phones = 0;

/** A verified number for the parent, so the production prep deliver can text them. */
async function reachable(f: { familyId: string; parentUserId: string }) {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  phones += 1;
  const phone = `+1416555${String(2000 + phones).slice(-4)}`;
  await db.database.insert(schema.parentChannels).values({
    familyId: f.familyId,
    userId: f.parentUserId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(NOW.getTime() - 24 * 3_600_000),
  });
  return phone;
}

/**
 * The carrier under the production prep deliver: `sent` is what reached `to`, in order, and
 * `refuse` names the bodies it turns down.
 */
function prepTransport(to: string | null, refuse: (body: string) => boolean = () => false) {
  const sent: string[] = [];
  const transport: ChannelTransport = {
    async send(input) {
      if (refuse(input.body)) throw new LinqSendError('30003', 400, false);
      if (input.to === to) sent.push(input.body);
      return { providerMessageId: `prep-${input.to}-${sent.length}` };
    },
  };
  return { sent, transport };
}

const noNetwork: typeof fetch = async () => {
  throw new Error('conversation.pglite.test: this test makes no network calls');
};

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
      stamp: expect.any(Function),
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
    await texted(f.familyId, recorded.id);
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

  it('a take-back naming the older plan asks back about that plan; the bare take-back after it takes it back', async () => {
    const f = await family();
    await approveSwim(f);
    const kickersId = await kickersAsk(f);
    const planReader = readerBy({
      'Little Kickers': { verdict: 'unrelated' },
      'Preschool Swim': { verdict: 'take_back', named: 'tokens' },
    });
    const { planWriter, written } = fakes(null);
    const asked = await runAuthorizedSignup(db.database, turn(f, 'cancel the swim one'), {
      planReader,
      planWriter,
    });

    expect(asked.outcome).toBe('plan_clarify');
    expect(written.at(-1)).toMatchObject({ moment: 'clarify', question: PLAN_ASK_BACK_QUESTION });
    expect(readOrder(planReader)).toEqual(['Little Kickers', 'Preschool Swim']);
    expect((await offer(f.offerId)).status).toBe('planned');
    expect((await offer(f.offerId)).planCancelRequestedAt).toBeNull();
    expect((await offer(kickersId)).status).toBe('pending');
    await replySent(asked);

    // The model's worst answer: both asks read the bare no as a take-back.
    const bare = readerBy({
      'Little Kickers': TAKE_BACK,
      'Preschool Swim': TAKE_BACK,
    });
    const cancelled = await runAuthorizedSignup(db.database, turn(f, 'no'), {
      planReader: bare,
      planWriter,
    });
    expect(cancelled.outcome).toBe('plan_cancelled');
    expect(readOrder(bare)).toEqual(['Preschool Swim']);
    expect((await offer(f.offerId)).status).toBe('handed_back');
    expect((await offer(kickersId)).status).toBe('pending');
    expect(await replyBindings(f.offerId)).toEqual(['tokens', 'newest']);
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

    // A stop that names the running plan asks back about it; the bare stop after that
    // question reaches it.
    const named = readerBy({ 'Preschool Swim': { verdict: 'take_back', named: 'tokens' } });
    const asked = await runAuthorizedSignup(
      db.database,
      { ...turn(f, 'stop the swim registration'), ...later },
      { planReader: named, planWriter },
    );
    expect(asked.outcome).toBe('plan_clarify');
    expect((await offer(f.offerId)).planCancelRequestedAt).toBeNull();
    await replySent(asked);
    const stopped = await runAuthorizedSignup(
      db.database,
      { ...turn(f, 'stop'), ...later },
      { planReader: readerBy({ 'Preschool Swim': TAKE_BACK }), planWriter },
    );
    expect(stopped.outcome).toBe('plan_cancelled');
    expect((await offer(f.offerId)).planCancelRequestedAt).not.toBeNull();
  });

  it('a yes that names an older ask asks back about it, and the bare yes after that question approves it', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const kickersId = await kickersAsk(f); // ten minutes ago
    // The model's raw answers are stipulated, one per program; the readers' checks are real.
    const reads = (swim: 'approve' | 'unrelated', kickers: 'approve' | 'unrelated') => {
      const raw = (verdict: 'approve' | 'unrelated', named: string | null) => ({
        reason: 'r',
        said: verdict === 'approve' ? 'yes' : null,
        named: verdict === 'approve' ? named : null,
        verdict,
        choiceIds: verdict === 'approve' ? ['sun-1000'] : [],
        maxPriceCents: verdict === 'approve' ? 9800 : null,
        waiverSaid: null,
        waiverAccepted: false,
        question: null,
      });
      return {
        read: vi.fn(async (read: Parameters<PlanReader['read']>[0]) =>
          toPlanReading(
            read.offer.activity === 'Little Kickers'
              ? raw(kickers, null)
              : raw(swim, read.text === 'yes' ? null : 'the swim one'),
            read.offer,
            read.text,
          ),
        ),
      } satisfies PlanReader;
    };
    const { planWriter, written } = fakes(null);

    const named = reads('approve', 'unrelated');
    const asked = await runAuthorizedSignup(db.database, turn(f, 'yes to the swim one'), {
      planReader: named,
      planWriter,
    });
    expect(asked.outcome).toBe('plan_clarify');
    expect(readOrder(named)).toEqual(['Little Kickers', 'Preschool Swim']);
    expect(written.map((facts) => [facts.moment, facts.question])).toEqual([
      ['clarify', PLAN_ASK_BACK_QUESTION],
    ]);
    expect((await offer(f.offerId)).status).toBe('pending');
    expect(await replyBindings(f.offerId)).toEqual(['tokens']);
    // Not yet asked: the router sends the question, then stamps it.
    expect(await lastAsked(f)).toBe(kickersId);
    await replySent(asked);
    expect(await lastAsked(f)).toBe(f.offerId);

    // The model's worst answer: both asks read the bare yes as a go-ahead.
    const bare = reads('approve', 'approve');
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

  it('a bare yes past a newer approved plan binds nothing: the older ask waiting on one needs its name', async () => {
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
    const bare = readerBy({
      'Little Kickers': { verdict: 'unrelated' },
      'Preschool Swim': APPROVE,
    });
    const { planWriter, written } = fakes(null);
    const unnamed = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader: bare,
      planWriter,
    });

    expect(readOrder(bare)).toEqual(['Little Kickers', 'Preschool Swim']);
    expect(unnamed).toEqual({
      claimed: false,
      outcome: 'plan_unnamed',
      reply: null,
      deliverOnThread: false,
    });
    expect(written).toEqual([]);
    expect((await offer(f.offerId)).status).toBe('pending');

    // Positive control: a yes that names the swim plan asks back about it, and the bare yes
    // after that question approves it.
    const planReader = readerBy({
      'Little Kickers': { verdict: 'unrelated' },
      'Preschool Swim': { ...APPROVE, named: 'tokens' },
    });
    const asked = await runAuthorizedSignup(db.database, turn(f, 'yes to the swim one'), {
      planReader,
      planWriter,
    });
    expect(asked.outcome).toBe('plan_clarify');
    expect((await offer(f.offerId)).status).toBe('pending');
    await replySent(asked);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader: bare,
      planWriter,
    });
    expect(result.outcome).toBe('plan_approved');
    expect((await offer(f.offerId)).status).toBe('planned');

    // Hale's receipt for the swim plan is its last word to them: a bare stop next takes the
    // swim plan back, not the Kickers plan approved before it.
    await replySent(result);
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

  /** The model's go-ahead, stipulated for every plan; the reader's checks are the real ones. */
  function goAheadReader(named: string | null): PlanReader {
    return {
      read: vi.fn(async (read) =>
        toPlanReading(
          {
            reason: 'r',
            said: 'yes',
            named,
            verdict: 'approve',
            choiceIds: ['sun-1000'],
            maxPriceCents: 9800,
            waiverSaid: null,
            waiverAccepted: false,
            question: null,
          },
          read.offer,
          read.text,
        ),
      ),
    };
  }

  it('after the login ask for an approved plan, a bare yes never plans an older ask waiting on one', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    await approveSwim(f);
    const kickersId = await kickersAsk(f); // ten minutes ago, still waiting on a yes
    // The real prep sweep and its production deliver send the swim plan's login ask.
    const phone = await reachable(f);
    const prep = await runDueSignupPlanPrep(
      db.database,
      { now: NOW },
      {
        writer: { write: async (facts) => `text for ${facts.kind}` },
        deliver: createPlanPrepDeliver(db.database, {
          transport: prepTransport(phone).transport,
          fetch: noNetwork,
        }),
      },
    );
    expect(prep.notices).toContainEqual({ offerId: f.offerId, kind: 'login_ask', outcome: 'sent' });
    expect(await lastAsked(f)).toBe(f.offerId);

    const planReader = goAheadReader(null);
    const { planWriter, written } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
    });

    expect(readOrder(planReader)).toEqual(['Preschool Swim', 'Little Kickers']);
    expect(result).toEqual({
      claimed: false,
      outcome: 'plan_unnamed',
      reply: null,
      deliverOnThread: false,
    });
    expect(written).toEqual([]);
    expect((await offer(kickersId)).status).toBe('pending');
    expect(await replyBindings(kickersId)).toEqual([]);
    expect((await offer(f.offerId)).planChoiceIds).toEqual(['sat-0900']);

    // Positive control: a yes that names the Kickers ask asks back about it, and the bare
    // yes after that question plans it.
    const asked = await runAuthorizedSignup(
      db.database,
      { ...turn(f, 'yes to the kickers one'), now: LATER },
      { planReader: goAheadReader('the kickers one'), planWriter },
    );
    expect(asked.outcome).toBe('plan_clarify');
    expect((await offer(kickersId)).status).toBe('pending');
    await replySent(asked);
    const approved = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader: goAheadReader(null),
      planWriter,
    });
    expect(approved.outcome).toBe('plan_approved');
    expect((await offer(kickersId)).status).toBe('planned');
    expect(await replyBindings(kickersId)).toEqual(['tokens', 'newest']);
  });

  it('after a login ask whose link bubble failed, a bare yes never plans an older ask waiting on one', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    await approveSwim(f);
    const kickersId = await kickersAsk(f); // ten minutes ago, still waiting on a yes
    // The real prep sweep: the text about the swim plan reaches the parent, then the bubble
    // with its login link fails.
    const phone = await reachable(f);
    const { sent, transport } = prepTransport(phone, (body) => body.includes('/l/'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prep = await runDueSignupPlanPrep(
      db.database,
      { now: NOW },
      {
        writer: { write: async (facts) => `text for ${facts.kind}` },
        deliver: createPlanPrepDeliver(db.database, { transport, fetch: noNetwork }),
      },
    );
    warn.mockRestore();
    expect(sent).toEqual(['text for login_ask']);
    expect(prep.notices).toContainEqual({
      offerId: f.offerId,
      kind: 'login_ask',
      outcome: 'failed',
    });
    expect(await lastAsked(f)).toBe(f.offerId);

    // The model's worst answer: both asks read the bare yes as a go-ahead.
    const planReader = goAheadReader(null);
    const { planWriter, written } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
    });

    expect(readOrder(planReader)).toEqual(['Preschool Swim', 'Little Kickers']);
    expect(result).toEqual({
      claimed: false,
      outcome: 'plan_unnamed',
      reply: null,
      deliverOnThread: false,
    });
    expect(written).toEqual([]);
    expect((await offer(kickersId)).status).toBe('pending');
    expect(await replyBindings(kickersId)).toEqual([]);
  });

  it("after the receipt for a plan's finished run, a bare yes never plans an older ask waiting on one", async () => {
    const f = await family(); // the swim plan ask, an hour ago
    await approveSwim(f);
    const kickersId = await kickersAsk(f); // ten minutes ago, still waiting on a yes
    // The run registered swim and closed its offer. The after-run notice is then Hale's last
    // text about it: it stamps the offer as it marks its outbound row sent (notice.pglite).
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'completed' })
      .where(eq(schema.authorizedSignupOffers.id, f.offerId));
    await stamped(f.familyId, f.offerId);

    const planReader = goAheadReader(null);
    const { planWriter, written } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
    });

    expect(readOrder(planReader)).toEqual(['Little Kickers']);
    expect(result).toEqual({
      claimed: false,
      outcome: 'plan_unnamed',
      reply: null,
      deliverOnThread: false,
    });
    expect(written).toEqual([]);
    expect((await offer(kickersId)).status).toBe('pending');
    expect((await offer(f.offerId)).status).toBe('completed');

    // Positive control: a yes that names the Kickers ask asks back about it, and the bare
    // yes after that question plans it.
    const asked = await runAuthorizedSignup(
      db.database,
      { ...turn(f, 'yes to the kickers one'), now: LATER },
      { planReader: goAheadReader('the kickers one'), planWriter },
    );
    expect(asked.outcome).toBe('plan_clarify');
    expect((await offer(kickersId)).status).toBe('pending');
    await replySent(asked);
    const approved = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader: goAheadReader(null),
      planWriter,
    });
    expect(approved.outcome).toBe('plan_approved');
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
    await texted(f.familyId, gym.id);
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
    expect(result.outcome).toBe('plan_clarify');
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
    await texted(f.familyId, swimmers.id);
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

    // Positive control: the parent writing its whole name, set off on its own, names it, so
    // Hale asks back about it (and moves nothing until the parent answers that question).
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
    expect(result.outcome).toBe('plan_clarify');
    expect((await offer(swimmers.id)).status).toBe('pending');
    expect(await replyBindings(swimmers.id)).toEqual(['tokens']);
  });

  it('a page title stuffed with yes words never makes a bare yes bind its ask unless Hale asked about it last', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const stuffed = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'stuffed-title',
      // A page title chosen so that a bare yes names it: `please` is a whole word of it.
      activityLabel: 'Yes Please Okay Sure',
      registrationUrl: 'https://register.example-camp.test/yes',
      sessions: SESSIONS,
      approvedPriceCents: null,
      planOpensAt: OPENS,
      now: new Date(NOW.getTime() - 30 * 60_000),
    });
    if (!stuffed.ok) throw new Error(stuffed.reason);
    await texted(f.familyId, stuffed.id);
    const kickersId = await kickersAsk(f); // ten minutes ago: the ask Hale asked last
    await approveSignupPlan(db.database, {
      offerId: kickersId,
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      messageId: 'msg-approve-kickers-stuffed',
      choiceIds: ['sat-0900'],
      maxPriceCents: 9800,
      opensAt: KICKERS_OPENS,
      waiverAccepted: false,
      now: new Date(NOW.getTime() - 5 * 60_000),
    });
    // The model's worst answer, stipulated for every plan, quoting the bare yes as the name;
    // the reader's checks are the real ones (Kickers, already approved, reads it as unrelated).
    const stuffedReader = (): PlanReader => ({
      read: vi.fn(async (read) =>
        toPlanReading(
          {
            reason: 'r',
            said: 'yes please',
            named: 'yes please',
            verdict: 'approve',
            choiceIds: ['sat-0900'],
            maxPriceCents: 9800,
            waiverSaid: null,
            waiverAccepted: false,
            question: null,
          },
          read.offer,
          read.text,
        ),
      ),
    });
    const { planWriter, written } = fakes(null);

    // The bare yes names the stuffed ask, so Hale asks about it. Nothing is approved.
    for (const attempt of [1, 2]) {
      const asked = await runAuthorizedSignup(db.database, turn(f, 'yes please'), {
        planReader: stuffedReader(),
        planWriter,
      });
      expect(asked.outcome).toBe('plan_clarify');
      expect(written).toHaveLength(attempt);
      expect(written.at(-1)?.question).toBe(PLAN_ASK_BACK_QUESTION);
      expect((await offer(stuffed.id)).status).toBe('pending');
      // That question never went, so Kickers' text is still the last one.
      expect(await lastAsked(f)).toBe(kickersId);
    }
    expect((await offer(f.offerId)).status).toBe('pending');

    // Only once Hale's question about it went out does the bare yes after it bind it.
    const asked = await runAuthorizedSignup(db.database, turn(f, 'yes please'), {
      planReader: stuffedReader(),
      planWriter,
    });
    expect(asked.outcome).toBe('plan_clarify');
    await replySent(asked);
    const approved = await runAuthorizedSignup(db.database, turn(f, 'yes please'), {
      planReader: stuffedReader(),
      planWriter,
    });
    expect(approved.outcome).toBe('plan_approved');
    expect((await offer(stuffed.id)).status).toBe('planned');
    expect(await replyBindings(stuffed.id)).toEqual(['tokens', 'tokens', 'tokens', 'newest']);
    expect((await offer(f.offerId)).status).toBe('pending');
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
    // Asked only once the question went out: the router sends it, then stamps it.
    expect(await lastAsked(f)).toBe(kickersId);
    await replySent(asked);
    expect(await lastAsked(f)).toBe(f.offerId);

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
    await texted(f.familyId, recorded.id);
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

  it("after Hale's receipt for an approved plan, a bare yes never signs up for an older one-shot ask", async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const gymId = await gymAsk(f, 90);
    // The model's worst answer, stipulated for every ask; the readers' checks are the real ones.
    const planReader: PlanReader = {
      read: vi.fn(async (read) =>
        toPlanReading(
          {
            reason: 'r',
            said: 'yes',
            named: null,
            verdict: 'approve',
            choiceIds: ['sat-0900'],
            maxPriceCents: 9800,
            waiverSaid: null,
            waiverAccepted: false,
            question: null,
          },
          read.offer,
          read.text,
        ),
      ),
    };
    const consentReader: SignupConsentReader = {
      read: vi.fn(async (read) =>
        toSignupConsentReading(
          { verdict: 'consent', sessionId: 'gym-sat', question: null },
          read.offer,
        ),
      ),
    };
    const { planWriter, written } = fakes(null);
    const deps = {
      planReader,
      planWriter,
      consentReader,
      outcomeWriter: echoOutcomeWriter(),
      browser: null,
    };

    const planned = await runAuthorizedSignup(db.database, turn(f, 'yes'), deps);
    expect(planned.outcome).toBe('plan_approved');
    expect(consentReader.read).not.toHaveBeenCalled();
    // The router sends Hale's receipt for the swim plan, then stamps it.
    await replySent(planned);

    const result = await runAuthorizedSignup(db.database, turn(f, 'yes'), deps);
    expect(result).toEqual({
      claimed: false,
      outcome: 'signup_unnamed',
      reply: null,
      deliverOnThread: false,
    });
    expect(written.map((facts) => facts.moment)).toEqual(['approved']);
    expect((await offer(gymId)).status).toBe('pending');
    expect((await offer(f.offerId)).status).toBe('planned');

    // Positive control: a yes that names the gym ask asks back about it, and the bare yes
    // after that question signs up for it.
    const named = await runAuthorizedSignup(
      db.database,
      { ...turn(f, 'yes, sign her up for Gym Tots'), now: LATER },
      deps,
    );
    expect(named).toMatchObject({ claimed: true, outcome: 'clarify' });
    expect((await offer(gymId)).status).toBe('pending');
    await replySent(named);
    const signed = await runAuthorizedSignup(db.database, turn(f, 'yes'), deps);
    expect(signed).toMatchObject({ claimed: true, outcome: 'browser_unavailable' });
    expect((await offer(gymId)).status).toBe('handed_back');
  });

  it("a yes whose words name another of the parent's asks never binds the newest one-shot ask: the turn stops", async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const gymId = await gymAsk(f, 10);
    // The one-shot reader's worst answer: it reads the go-ahead as its own.
    const { reads, planReader, consentReader } = readers(
      { ...APPROVE, named: 'tokens' },
      { verdict: 'consent', sessionId: 'gym-sat' },
    );
    const { planWriter, written } = fakes(null);
    const result = await runAuthorizedSignup(
      db.database,
      turn(f, 'yes to the swim one, Sunday then Saturday, up to $105'),
      { planReader, planWriter, consentReader, outcomeWriter: echoOutcomeWriter(), browser: null },
    );

    expect(reads).toEqual(['one_shot:gym-tots']);
    expect(result).toEqual({
      claimed: false,
      outcome: 'signup_unnamed',
      reply: null,
      deliverOnThread: false,
    });
    expect(written).toEqual([]);
    expect((await offer(gymId)).status).toBe('pending');
    expect((await offer(f.offerId)).status).toBe('pending');

    // Positive control: words that name the one-shot ask too still reach it.
    const both = await runAuthorizedSignup(
      db.database,
      turn(f, 'yes to Gym Tots as well as the swim one'),
      { planReader, planWriter, consentReader, outcomeWriter: echoOutcomeWriter(), browser: null },
    );
    expect(both).toMatchObject({ claimed: true, outcome: 'browser_unavailable' });
    expect((await offer(gymId)).status).toBe('handed_back');
  });

  it('an older plan whose page title is stuffed with yes words never takes a bare yes past a newer one-shot ask', async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const stuffed = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'stuffed-title',
      activityLabel: 'Yes Please Okay Sure',
      registrationUrl: 'https://register.example-camp.test/yes',
      sessions: SESSIONS,
      approvedPriceCents: null,
      planOpensAt: OPENS,
      now: new Date(NOW.getTime() - 30 * 60_000),
    });
    if (!stuffed.ok) throw new Error(stuffed.reason);
    await texted(f.familyId, stuffed.id);
    const gymId = await gymAsk(f, 10); // the ask Hale asked last
    // The model's worst answer for every ask; the readers' checks are the real ones.
    const reads: string[] = [];
    const planReader: PlanReader = {
      read: vi.fn(async (read) => {
        reads.push(`plan:${read.offer.activity}`);
        return toPlanReading(
          {
            reason: 'r',
            said: 'yes please',
            named: 'yes please',
            verdict: 'approve',
            choiceIds: ['sat-0900'],
            maxPriceCents: 9800,
            waiverSaid: null,
            waiverAccepted: false,
            question: null,
          },
          read.offer,
          read.text,
        );
      }),
    };
    const consentReader: SignupConsentReader = {
      read: vi.fn(async (read) => {
        reads.push(`one_shot:${read.offer.activityKey}`);
        return toSignupConsentReading(
          { verdict: 'consent', sessionId: 'gym-sat', question: null },
          read.offer,
        );
      }),
    };
    const { planWriter, written } = fakes(null);
    const result = await runAuthorizedSignup(db.database, turn(f, 'yes please'), {
      planReader,
      planWriter,
      consentReader,
      outcomeWriter: echoOutcomeWriter(),
      browser: null,
    });

    expect(reads).toEqual(['one_shot:gym-tots']);
    expect(result).toEqual({
      claimed: false,
      outcome: 'signup_unnamed',
      reply: null,
      deliverOnThread: false,
    });
    expect(written).toEqual([]);
    expect((await offer(stuffed.id)).status).toBe('pending');
    expect((await offer(gymId)).status).toBe('pending');
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it("a one-shot ask stays answerable while a newer plan ask waits: the plan's unrelated passes it on, and Hale asks about it first", async () => {
    const f = await family(); // the swim plan ask, an hour ago
    const gymId = await gymAsk(f, 90);
    const { reads, planReader, consentReader } = readers(
      { verdict: 'unrelated' },
      { verdict: 'consent', sessionId: 'gym-sat' },
    );
    const { planWriter } = fakes(null);
    const outcomeWriter = echoOutcomeWriter();
    const deps = { planReader, planWriter, consentReader, outcomeWriter, browser: null };
    const asked = await runAuthorizedSignup(
      db.database,
      turn(f, 'yes, sign her up for Gym Tots'),
      deps,
    );

    expect(reads).toEqual(['plan:Preschool Swim', 'one_shot:gym-tots']);
    expect(asked).toMatchObject({ claimed: true, outcome: 'clarify' });
    expect(outcomeWriter.facts.map((facts) => [facts.outcome, facts.question])).toEqual([
      ['clarify', SIGNUP_ASK_BACK_QUESTION],
    ]);
    expect((await offer(gymId)).status).toBe('pending');
    expect((await offer(f.offerId)).status).toBe('pending');
    await replySent(asked);

    // The answer to Hale's question about it is the gym ask's, bare.
    const signed = await runAuthorizedSignup(db.database, turn(f, 'yes'), deps);
    expect(reads.slice(2)).toEqual(['one_shot:gym-tots']);
    expect(signed).toMatchObject({ claimed: true, outcome: 'browser_unavailable' });
    expect((await offer(gymId)).status).toBe('handed_back');
    expect((await offer(f.offerId)).status).toBe('pending');
  });

  it("a plan ask stays answerable while a newer one-shot ask waits: the one-shot's unrelated passes it on, and Hale asks about it first", async () => {
    const f = await family();
    const gymId = await gymAsk(f, 10);
    const { reads, planReader, consentReader } = readers(
      { ...APPROVE, named: 'tokens' },
      { verdict: 'unrelated' },
    );
    const { planWriter, written } = fakes(null);
    const asked = await runAuthorizedSignup(
      db.database,
      turn(f, 'yes to the swim one, Sunday then Saturday, up to $105'),
      { planReader, planWriter, consentReader },
    );

    expect(reads).toEqual(['one_shot:gym-tots', 'plan:Preschool Swim']);
    expect(asked.outcome).toBe('plan_clarify');
    expect(written.at(-1)?.question).toBe(PLAN_ASK_BACK_QUESTION);
    expect((await offer(f.offerId)).status).toBe('pending');
    expect((await offer(gymId)).status).toBe('pending');
    await replySent(asked);

    const approved = await runAuthorizedSignup(db.database, turn(f, 'yes'), {
      planReader,
      planWriter,
      consentReader,
    });
    expect(reads.slice(2)).toEqual(['plan:Preschool Swim']);
    expect(approved.outcome).toBe('plan_approved');
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
    await texted(f.familyId, older.id);
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

    // Positive control: words that carry its name reach it: Hale asks about it, and the bare
    // no after that question hands it back.
    const named = await runAuthorizedSignup(db.database, turn(f, 'cancel the toddler one'), deps);
    expect(named).toMatchObject({ claimed: true, outcome: 'clarify' });
    expect((await offer(older.id)).status).toBe('pending');
    await replySent(named);
    const declined = await runAuthorizedSignup(db.database, turn(f, 'no'), deps);
    expect(declined).toMatchObject({ claimed: true, outcome: 'declined' });
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
    await texted(f.familyId, older.id);
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
      await texted(seeded.familyId, recorded.id);
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
    // The production handler, as the router calls it: send the reply, then stamps it.
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
    await replySent(asked);

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
    await texted(f.familyId, kickers.id);
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

    // Positive control: words that carry its name reach it. Hale asks which pick they want
    // for it, emailing no one, and the pick after that question is its own.
    const named = await runAuthorizedSignup(
      db.database,
      turn(f, 'email the swim people'),
      deps({ verdict: 'email' }),
    );
    expect(named.outcome).toBe('plan_clarify');
    expect(written.at(-1)).toMatchObject({ moment: 'clarify', question: PICK_ASK_BACK_QUESTION });
    expect(sendProviderEmail).not.toHaveBeenCalled();
    expect((await offer(f.offerId)).planAvailability).toMatchObject({ kind: 'options_mismatch' });
    await replySent(named);
    const emailed = await runAuthorizedSignup(
      db.database,
      turn(f, 'email them'),
      deps({ verdict: 'email' }),
    );
    expect(emailed.outcome).toBe('plan_approved');
    expect(sendProviderEmail).toHaveBeenCalledTimes(1);
    expect((await offer(f.offerId)).planAvailability).toMatchObject({ kind: 'emailed' });
    expect((await offer(kickers.id)).status).toBe('pending');
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
    await texted(f.familyId, kickers.id);
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
    await replySent(asked);

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
