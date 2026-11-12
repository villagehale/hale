import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import { createDisambiguationStore } from '~/lib/channel/router/disambiguation';
import { FakeReplyTransport, type ReplySent } from '~/lib/channel/router/reply-route';
import type { ChannelRouterDeps } from '~/lib/channel/router/route';
import { routeChannelMessage } from '~/lib/channel/router/route';
import {
  auditSmokeAlarmClaim,
  auditTurnLedger,
  defaultOpenQuestionReader,
  loadInboundContext,
} from '~/lib/channel/router/wiring';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { calendarOffersIdle } from '~/lib/integrations/calendar-offer-read';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { AUTHORIZED_SIGNUP_ENABLED_ENV } from '../flag';
import { authorizedSignupHandler } from '../handler';
import { recordSignupOffer } from '../store';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import { recordPlanNotice, runDueSignupPlanPrep } from './prep';
import type { PlanReader, PlanReading } from './reader';
import type { PlanReplyWriter } from './writer';

// Which of a parent's sign-up asks a bare yes, no or stop answers, end to end: the coach turn
// that texts an offer, the router that delivers each reply, the minute sweep that texts
// notices, and the signup handler that reads the parent's answer, on real Postgres. The plan
// read and every reply are model calls with their own recorded evals (signup-plan-read,
// signup-plan-reply); here each is a stipulated answer, and what is tested is which ask the
// database lets that answer move. Invented hosts and details only.
const NOW = new Date('2026-11-30T20:00:00.000Z');
const SWIM = {
  activityKey: 'swim-preschool',
  activityLabel: 'Preschool Swim',
  registrationUrl: 'https://register.example-rec.test/Clients/BookMe4LandingPages/Courses',
  host: 'register.example-rec.test',
  opensAt: new Date('2026-12-01T12:00:00.000Z'),
};
const KICKERS = {
  activityKey: 'kickers-sat',
  activityLabel: 'Little Kickers',
  registrationUrl: 'https://kickers.example-sport.test/register/sat',
  host: 'kickers.example-sport.test',
  opensAt: new Date('2026-12-08T12:00:00.000Z'),
};
type Program = typeof SWIM;
const SESSIONS = [
  {
    id: 'sat-0900',
    label: 'Sat 9:00',
    startsAt: '2027-01-09T14:00:00.000Z',
    endsAt: '2027-01-09T14:45:00.000Z',
    full: false,
    priceCents: 9800,
  },
];
const APPROVE: PlanReading = {
  verdict: 'approve',
  choiceIds: ['sat-0900'],
  maxPriceCents: 9800,
  waiverAccepted: false,
  named: null,
};
const TAKE_BACK: PlanReading = { verdict: 'take_back', named: null };
const UNRELATED: PlanReading = { verdict: 'unrelated' };

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
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Household = { familyId: string; parentUserId: string; childId: string };

let phones = 0;

async function household(): Promise<Household> {
  phones += 1;
  const phone = `+1416555${String(1000 + phones).slice(-4)}`;
  const seeded = await seedFamily(db.database);
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
  await db.database.insert(schema.parentChannels).values({
    familyId: seeded.familyId,
    userId: seeded.parentUserId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(NOW.getTime() - 24 * 3_600_000),
  });
  return { ...seeded, childId };
}

/** Stands in for the model: one stipulated reading per program. */
function readerBy(readings: Record<string, PlanReading>): PlanReader {
  return { read: vi.fn(async ({ offer }) => readings[offer.activity ?? ''] ?? null) };
}

const planWriter: PlanReplyWriter = {
  write: vi.fn(async (facts) => `reply for ${facts.moment}`),
};

/** What a coach turn does when it offers a sign-up: the offer tool's row, and its text. */
type CoachOffer = (turn: { now: Date }) => Promise<{ offerId: string; text: string } | null>;

function offering(f: Household, program: Program, options: { id?: string } = {}): CoachOffer {
  return async (turn) => {
    const recorded = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: program.activityKey,
      activityLabel: program.activityLabel,
      registrationUrl: program.registrationUrl,
      sessions: SESSIONS,
      approvedPriceCents: null,
      planOpensAt: program.opensAt,
      now: turn.now,
    });
    if (!recorded.ok) throw new Error(recorded.reason);
    if (options.id) {
      // Pins the row's id before anything points at it, so an ordering that fell back on
      // ids would pick a known ask (see the sweep test).
      await db.database
        .update(schema.authorizedSignupOffers)
        .set({ id: options.id })
        .where(eq(schema.authorizedSignupOffers.id, recorded.id));
    }
    return {
      offerId: options.id ?? recorded.id,
      text: `Want me to sign Ada up for ${program.activityLabel}?`,
    };
  };
}

function deps(
  now: Date,
  options: {
    transport: FakeReplyTransport;
    planReader?: PlanReader;
    coachOffer?: CoachOffer;
  },
): ChannelRouterDeps {
  return {
    database: db.database,
    loadContext: loadInboundContext,
    transport: options.transport,
    handlers: [
      authorizedSignupHandler({
        planReader: options.planReader ?? readerBy({}),
        planWriter,
      }),
    ],
    questions: defaultOpenQuestionReader(),
    offDomain: { consider: async () => ({ status: 'in_domain', fallback: null }) },
    coach: {
      async respond(turn) {
        const offered = options.coachOffer ? await options.coachOffer(turn) : null;
        return {
          reply: offered ? offered.text : 'Sure thing.',
          planOffer: null,
          activityPromise: null,
          spotWatch: null,
          signupOffers: offered ? [offered] : [],
        };
      },
    },
    smokeAlarm: auditSmokeAlarmClaim(db.database),
    turns: auditTurnLedger(db.database),
    apology: { compose: async () => ({ status: 'composed', reply: 'sorry' }) },
    holdingLine: { compose: async () => ({ status: 'composed', line: 'on it' }) },
    floodLine: { compose: async () => ({ status: 'composed', line: 'busy' }) },
    recordPlanOffer: async () => ({ status: 'recorded' }),
    recordCapabilityNotes: async () => ({ status: 'recorded', declined: 0, corrected: 0 }),
    recordActivityPromise: async () => ({
      status: 'recorded',
      commitmentId: '77777777-7777-4777-8777-777777777777',
    }),
    replyResolver: { read: async () => ({ status: 'unresolved', reason: 'no_target' }) },
    calendarOffers: calendarOffersIdle,
    weekdayCareReader: { read: async () => ({ status: 'nothing_stated' as const }) },
    disambiguation: createDisambiguationStore(),
    reconcileView: loadReconcileView,
    claimShadow: { coachTurn: () => 'off', sweep: () => 'off', dispatch: () => 'off' },
    claimEnforcer: {
      enforces: () => false,
      read: async () => {
        throw new Error('the claim reader is not enforced here');
      },
    },
    recordStatedState: async () => ({ status: 'nothing_stated' }),
    weekdayCareAnswerTarget: async () => ({ status: 'no_open_ask' as const }),
    searchWeekdays: async () => ({ status: 'abstain' as const, reason: 'not_configured' }),
    recordWeekdayCare: async (_db, input) => ({
      status: 'recorded' as const,
      care: input.care,
      providerNamed: input.provider !== null,
    }),
    recordRegistrationWatch: async () => ({ status: 'recorded' }),
    armWatchedSpot: async () => ({ status: 'armed', spotId: 'spot-1' }),
    dispatchDeepResearch: async () => ({ status: 'enqueued' }),
    limiter: new FakeRateLimiter(() => now.getTime()),
    now: () => now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

/** The parent texts Hale; the router reads it and sends whatever answers it. */
async function parentTexts(
  f: Household,
  body: string,
  at: Date,
  options: { transport?: FakeReplyTransport; planReader?: PlanReader; coachOffer?: CoachOffer },
) {
  const providerMessageId = `SM-${f.familyId}-${at.getTime()}`;
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId,
      status: 'delivered',
      body,
      createdAt: at,
      sentAt: at,
    })
    .returning({ id: schema.channelMessages.id });
  const transport = options.transport ?? new FakeReplyTransport();
  return routeChannelMessage(deps(at, { ...options, transport }), {
    family_id: f.familyId,
    parent_user_id: f.parentUserId,
    channel_message_id: row?.id as string,
    provider_message_id: providerMessageId,
    received_at: at.toISOString(),
    in_group: false,
  });
}

async function offerRow(offerId: string) {
  const [row] = await db.database
    .select()
    .from(schema.authorizedSignupOffers)
    .where(eq(schema.authorizedSignupOffers.id, offerId));
  if (!row) throw new Error('no offer');
  return row;
}

async function offerIdFor(f: Household, program: Program) {
  const [row] = await db.database
    .select({ id: schema.authorizedSignupOffers.id })
    .from(schema.authorizedSignupOffers)
    .where(
      and(
        eq(schema.authorizedSignupOffers.familyId, f.familyId),
        eq(schema.authorizedSignupOffers.activityKey, program.activityKey),
      ),
    );
  if (!row) throw new Error(`no ${program.activityKey} offer`);
  return row.id;
}

const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

/**
 * Two approved plans, each offered by a coach turn and approved by the parent's bare yes,
 * Kickers after Swim: Hale's last text before NOW was Kickers' receipt.
 */
async function twoApprovedPlans(f: Household, ids: { swim?: string; kickers?: string } = {}) {
  await parentTexts(f, 'can you sign Ada up for swim', minutes(-60), {
    coachOffer: offering(f, SWIM, { id: ids.swim }),
  });
  const swimId = await offerIdFor(f, SWIM);
  await parentTexts(f, 'yes', minutes(-50), {
    planReader: readerBy({ 'Preschool Swim': APPROVE }),
  });
  await parentTexts(f, 'and kickers on saturdays', minutes(-40), {
    planReader: readerBy({ 'Preschool Swim': UNRELATED }),
    coachOffer: offering(f, KICKERS, { id: ids.kickers }),
  });
  const kickersId = await offerIdFor(f, KICKERS);
  await parentTexts(f, 'yes', minutes(-30), {
    planReader: readerBy({ 'Little Kickers': APPROVE, 'Preschool Swim': UNRELATED }),
  });
  expect((await offerRow(swimId)).status).toBe('planned');
  expect((await offerRow(kickersId)).status).toBe('planned');
  return { swimId, kickersId };
}

describe('a bare answer moves the ask whose text reached the parent last', () => {
  it('a notice the sweep sends while a turn asks back about Swim goes first: the bare no after takes back Swim', async () => {
    const f = await household();
    const { swimId, kickersId } = await twoApprovedPlans(f);
    // Swim's prep texts went long ago; only Kickers has one due.
    for (const kind of ['login_ask', 'account_prep']) {
      await recordPlanNotice(db.database, {
        familyId: f.familyId,
        offerId: swimId,
        providerHost: SWIM.host,
        kind,
        now: minutes(-30),
      });
    }

    // The parent names Swim at NOW. While the router is still sending Hale's question back,
    // the minute sweep (started two seconds later) texts Kickers' login ask, which reaches
    // the parent first; the question about Swim is the last text they get.
    const wire: string[] = [];
    const transport = new FakeReplyTransport();
    const send = transport.send.bind(transport);
    let swept = false;
    transport.send = async (input): Promise<ReplySent> => {
      if (!swept) {
        swept = true;
        await runDueSignupPlanPrep(
          db.database,
          { now: new Date(NOW.getTime() + 2_000) },
          {
            writer: { write: async (facts) => `text for ${facts.kind}` },
            deliver: async (notice) => {
              if (notice.parentUserId === f.parentUserId) {
                wire.push(notice.offerId === kickersId ? 'kickers' : 'swim');
              }
              return true;
            },
          },
        );
      }
      wire.push('swim question');
      return send(input);
    };
    const asked = await parentTexts(f, 'cancel the swim one', NOW, {
      transport,
      planReader: readerBy({
        'Little Kickers': UNRELATED,
        'Preschool Swim': { verdict: 'take_back', named: 'tokens' },
      }),
    });
    expect(asked.handler).toBe('authorized_signup');
    expect(wire).toEqual(['kickers', 'kickers', 'swim question']);
    expect((await offerRow(swimId)).status).toBe('planned');

    // The model's worst reading: both asks hear the bare no as a take-back.
    await parentTexts(f, 'no', minutes(1), {
      planReader: readerBy({ 'Little Kickers': TAKE_BACK, 'Preschool Swim': TAKE_BACK }),
    });
    expect((await offerRow(swimId)).status).toBe('handed_back');
    const kickers = await offerRow(kickersId);
    expect(kickers.status).toBe('planned');
    expect(kickers.planCancelRequestedAt).toBeNull();
  });

  it('one sweep texting two plans: a bare stop takes back the one whose text went last, whatever their ids', async () => {
    const f = await household();
    const suffix = f.familyId.slice(-12);
    // Ids that sort Swim above Kickers, so an ordering that broke a tie on ids would pick Swim.
    const { swimId, kickersId } = await twoApprovedPlans(f, {
      swim: `ffffffff-ffff-4fff-bfff-${suffix}`,
      kickers: `00000000-0000-4000-8000-${suffix}`,
    });
    const wire: string[] = [];
    await runDueSignupPlanPrep(
      db.database,
      { now: NOW },
      {
        writer: { write: async (facts) => `text for ${facts.kind}` },
        deliver: async (notice) => {
          if (notice.parentUserId === f.parentUserId && !notice.body.startsWith('https://')) {
            wire.push(notice.offerId);
          }
          return true;
        },
      },
    );
    expect([...wire].sort()).toEqual([swimId, kickersId].sort());
    const last = wire.at(-1) as string;
    const first = wire[0] as string;

    await parentTexts(f, 'stop', minutes(1), {
      planReader: readerBy({ 'Little Kickers': TAKE_BACK, 'Preschool Swim': TAKE_BACK }),
    });
    expect((await offerRow(last)).status).toBe('handed_back');
    expect((await offerRow(first)).status).toBe('planned');
    expect((await offerRow(first)).planCancelRequestedAt).toBeNull();
  });
});

describe('an offer whose text never reached the parent', () => {
  it('takes no bare yes: the yes goes to the ask whose text they last got', async () => {
    const f = await household();
    await parentTexts(f, 'can you sign Ada up for swim', minutes(-60), {
      coachOffer: offering(f, SWIM),
    });
    const swimId = await offerIdFor(f, SWIM);
    // The coach records the Kickers offer, and its text never leaves.
    const refusing = new FakeReplyTransport();
    refusing.send = async () => {
      throw new Error('carrier refused');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await parentTexts(f, 'and kickers on saturdays', minutes(-40), {
      transport: refusing,
      planReader: readerBy({ 'Preschool Swim': UNRELATED }),
      coachOffer: offering(f, KICKERS),
    }).catch(() => undefined);
    const kickersId = await offerIdFor(f, KICKERS);
    expect((await offerRow(kickersId)).status).toBe('pending');

    await parentTexts(f, 'yes', minutes(-30), {
      planReader: readerBy({ 'Little Kickers': APPROVE, 'Preschool Swim': APPROVE }),
    });
    expect((await offerRow(swimId)).status).toBe('planned');
    expect((await offerRow(kickersId)).status).toBe('pending');
    vi.restoreAllMocks();
  });

  it('alone, a bare yes moves nothing; words that name it get it asked about, and the yes after that moves it', async () => {
    const f = await household();
    const refusing = new FakeReplyTransport();
    refusing.send = async () => {
      throw new Error('carrier refused');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await parentTexts(f, 'can you sign Ada up for swim', minutes(-60), {
      transport: refusing,
      coachOffer: offering(f, SWIM),
    }).catch(() => undefined);
    const swimId = await offerIdFor(f, SWIM);

    const bare = await parentTexts(f, 'yes', minutes(-30), {
      planReader: readerBy({ 'Preschool Swim': APPROVE }),
    });
    expect(bare.handler).not.toBe('authorized_signup');
    expect((await offerRow(swimId)).status).toBe('pending');

    const transport = new FakeReplyTransport();
    const named = await parentTexts(f, 'yes to swim', minutes(-25), {
      transport,
      planReader: readerBy({ 'Preschool Swim': { ...APPROVE, named: 'tokens' } }),
    });
    expect(named.handler).toBe('authorized_signup');
    expect(transport.bodies()).toEqual(['reply for clarify']);
    expect((await offerRow(swimId)).status).toBe('pending');

    // That question reached them: their next bare yes is its.
    await parentTexts(f, 'yes', minutes(-20), {
      planReader: readerBy({ 'Preschool Swim': APPROVE }),
    });
    expect((await offerRow(swimId)).status).toBe('planned');
    vi.restoreAllMocks();
  });
});
