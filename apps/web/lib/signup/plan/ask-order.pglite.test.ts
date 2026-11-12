import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import type { OptOutReader } from '~/lib/channel/intake/opt-out-reader';
import { SCRIPTED_STOP_CONFIRMATION } from '~/lib/channel/intake/scripted-opt-out-reader.fixture';
import { type ChannelTransport, FakeTransport } from '~/lib/channel/intake/transport';
import { handleLinqInboundRequest } from '~/lib/channel/linq/inbound';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import { type InboundBurst, createInboundBurst } from '~/lib/channel/router/burst';
import { createDisambiguationStore } from '~/lib/channel/router/disambiguation';
import { FakeReplyTransport, type ReplySent } from '~/lib/channel/router/reply-route';
import type { ChannelRouterDeps } from '~/lib/channel/router/route';
import { routeChannelMessage } from '~/lib/channel/router/route';
import { darkSideTurn } from '~/lib/channel/router/side-turn.fixture';
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
import { createPlanNotifier, createPlanPrepDeliver } from './notice';
import { type PlanPrepDeps, recordPlanNotice, runDueSignupPlanPrep } from './prep';
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

type Household = { familyId: string; parentUserId: string; childId: string; phone: string };

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
  return { ...seeded, childId, phone };
}

/**
 * The minute sweep with its production deliver, over a carrier that records what reached this
 * household, in order: each text by the site it is about, and the login link as `link`.
 */
function sweep(f: Household, wire: string[], options: { afterTaken?: Error } = {}): PlanPrepDeps {
  const transport: ChannelTransport = {
    async send(input) {
      if (input.to === f.phone) {
        wire.push(
          input.body.includes('/l/') ? 'link' : (input.body.split(' at ')[1] ?? input.body),
        );
      }
      if (options.afterTaken) throw options.afterTaken;
      return { providerMessageId: `sweep-${f.familyId}-${wire.length}` };
    },
  };
  return {
    writer: {
      write: async (facts) => ({
        bubbles: [`text for ${facts.kind} at ${facts.host}`],
        card: null,
      }),
    },
    deliver: createPlanPrepDeliver(db.database, {
      transport,
      fetch: async () => {
        throw new Error('ask-order.pglite.test: this test makes no network calls');
      },
    }),
  };
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
    burst?: InboundBurst;
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
    burst: options.burst ?? { plan: async () => ({ kind: 'lone', waitedMs: 0, why: 'flag_off' }) },
    sideTurn: darkSideTurn(),
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
const seconds = (n: number) => new Date(NOW.getTime() + n * 1_000);

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
  it('one sweep texting two plans: a bare stop takes back the one whose text went last, whatever their ids', async () => {
    const f = await household();
    const suffix = f.familyId.slice(-12);
    // Ids that sort Swim above Kickers, so an ordering that broke a tie on ids would pick Swim.
    const { swimId, kickersId } = await twoApprovedPlans(f, {
      swim: `ffffffff-ffff-4fff-bfff-${suffix}`,
      kickers: `00000000-0000-4000-8000-${suffix}`,
    });
    const wire: string[] = [];
    await runDueSignupPlanPrep(db.database, { now: NOW }, sweep(f, wire));
    const texts = wire.filter((sent) => sent !== 'link');
    expect([...texts].sort()).toEqual([KICKERS.host, SWIM.host].sort());
    const idOf = (host: string) => (host === SWIM.host ? swimId : kickersId);
    const last = idOf(texts.at(-1) as string);
    const first = idOf(texts[0] as string);

    await parentTexts(f, 'stop', minutes(1), {
      planReader: readerBy({ 'Little Kickers': TAKE_BACK, 'Preschool Swim': TAKE_BACK }),
    });
    expect((await offerRow(last)).status).toBe('handed_back');
    expect((await offerRow(first)).status).toBe('planned');
    expect((await offerRow(first)).planCancelRequestedAt).toBeNull();
  });
});

describe('an offer whose text never reached the parent', () => {
  it('takes no bare yes, and nor does the older ask: a failed send may still have reached them', async () => {
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

    // The carrier's error does not prove the text never left, so the yes binds nothing.
    const bare = await parentTexts(f, 'yes', minutes(-30), {
      planReader: readerBy({ 'Little Kickers': APPROVE, 'Preschool Swim': APPROVE }),
    });
    expect(bare.handler).not.toBe('authorized_signup');
    expect((await offerRow(swimId)).status).toBe('pending');
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

describe('the ask number is drawn when the send starts, not when it was accepted', () => {
  it('the carrier accepts the question about Swim, then the sweep texts Kickers before the router is done: a bare no takes back Kickers', async () => {
    const f = await household();
    const { swimId, kickersId } = await twoApprovedPlans(f);
    for (const kind of ['login_ask', 'account_prep']) {
      await recordPlanNotice(db.database, {
        familyId: f.familyId,
        offerId: swimId,
        providerHost: SWIM.host,
        kind,
        now: minutes(-30),
      });
    }

    // The question about Swim reaches the parent first; the sweep, which started its send
    // after the router started Swim's, lands while the router is still finishing that send.
    // (The reverse, the sweep's text landing first while the router's call is still open,
    // ranks the same way: the router sees only when its call starts and ends, and asks rank
    // by start. That is the residual askStamp names.)
    const wire: string[] = [];
    const transport = new FakeReplyTransport();
    const send = transport.send.bind(transport);
    let swept = false;
    transport.send = async (input): Promise<ReplySent> => {
      const sent = await send(input);
      wire.push('swim question');
      if (!swept) {
        swept = true;
        await runDueSignupPlanPrep(
          db.database,
          { now: new Date(NOW.getTime() + 2_000) },
          sweep(f, wire),
        );
      }
      return sent;
    };
    await parentTexts(f, 'cancel the swim one', NOW, {
      transport,
      planReader: readerBy({
        'Little Kickers': UNRELATED,
        'Preschool Swim': { verdict: 'take_back', named: 'tokens' },
      }),
    });
    expect(wire).toEqual(['swim question', KICKERS.host, 'link']);

    await parentTexts(f, 'no', minutes(1), {
      planReader: readerBy({ 'Little Kickers': TAKE_BACK, 'Preschool Swim': TAKE_BACK }),
    });
    expect((await offerRow(kickersId)).status).toBe('handed_back');
    const swim = await offerRow(swimId);
    expect(swim.status).toBe('planned');
    expect(swim.planCancelRequestedAt).toBeNull();
  });
});

describe('a text that went whose ask number could not be kept', () => {
  async function failKickersStamps() {
    await db.database.execute(sql`create or replace function ask_order_test_fail_stamp() returns trigger as $$
      begin
        if new.activity_key = 'kickers-sat' and new.last_asked_seq is distinct from old.last_asked_seq then
          raise exception 'ask-order.pglite.test: the stamp fails';
        end if;
        return new;
      end $$ language plpgsql`);
    await db.database.execute(
      sql`create trigger ask_order_test_fail_stamp before update on authorized_signup_offers for each row execute function ask_order_test_fail_stamp()`,
    );
  }
  async function stampsWork() {
    await db.database.execute(
      sql`drop trigger if exists ask_order_test_fail_stamp on authorized_signup_offers`,
    );
  }
  afterEach(stampsWork);

  it('binds no bare answer to an older ask until a later text about an ask is kept', async () => {
    const f = await household();
    await parentTexts(f, 'can you sign Ada up for swim', minutes(-60), {
      coachOffer: offering(f, SWIM),
    });
    const swimId = await offerIdFor(f, SWIM);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    await failKickersStamps();
    const transport = new FakeReplyTransport();
    await parentTexts(f, 'and kickers on saturdays', minutes(-40), {
      transport,
      planReader: readerBy({ 'Preschool Swim': UNRELATED }),
      coachOffer: offering(f, KICKERS),
    });
    await stampsWork();
    const kickersId = await offerIdFor(f, KICKERS);
    // The parent has the Kickers offer; nothing records that it was the last ask they got.
    expect(transport.bodies()).toEqual(['Want me to sign Ada up for Little Kickers?']);
    expect((await offerRow(kickersId)).lastAskedSeq).toBeNull();

    // Their bare yes, which the model reads as a yes to either: it binds nothing.
    const bare = await parentTexts(f, 'yes', minutes(-30), {
      planReader: readerBy({ 'Little Kickers': APPROVE, 'Preschool Swim': APPROVE }),
    });
    expect(bare.handler).not.toBe('authorized_signup');
    expect((await offerRow(swimId)).status).toBe('pending');
    expect((await offerRow(kickersId)).status).toBe('pending');

    // Words that name Kickers get it asked about; that question's number is kept.
    const asked = new FakeReplyTransport();
    const named = await parentTexts(f, 'yes to the kickers one', minutes(-25), {
      transport: asked,
      planReader: readerBy({
        'Preschool Swim': UNRELATED,
        'Little Kickers': { ...APPROVE, named: 'tokens' },
      }),
    });
    expect(named.handler).toBe('authorized_signup');
    expect(asked.bodies()).toEqual(['reply for clarify']);
    expect((await offerRow(kickersId)).status).toBe('pending');

    // The bare yes after that question answers it.
    await parentTexts(f, 'yes', minutes(-20), {
      planReader: readerBy({ 'Little Kickers': APPROVE, 'Preschool Swim': APPROVE }),
    });
    expect((await offerRow(kickersId)).status).toBe('planned');
    expect((await offerRow(swimId)).status).toBe('pending');
    vi.restoreAllMocks();
  });

  it('positive control: the same offer whose number was kept takes the bare yes', async () => {
    const f = await household();
    await parentTexts(f, 'can you sign Ada up for swim', minutes(-60), {
      coachOffer: offering(f, SWIM),
    });
    const swimId = await offerIdFor(f, SWIM);
    await parentTexts(f, 'and kickers on saturdays', minutes(-40), {
      planReader: readerBy({ 'Preschool Swim': UNRELATED }),
      coachOffer: offering(f, KICKERS),
    });
    const kickersId = await offerIdFor(f, KICKERS);
    await parentTexts(f, 'yes', minutes(-30), {
      planReader: readerBy({ 'Little Kickers': APPROVE, 'Preschool Swim': APPROVE }),
    });
    expect((await offerRow(kickersId)).status).toBe('planned');
    expect((await offerRow(swimId)).status).toBe('pending');
  });
});

/** Every write to the parent's order-uncertain row fails, from now until `marksWork`. */
async function failMarks() {
  await db.database.execute(sql`create or replace function ask_order_test_fail_mark() returns trigger as $$
    begin
      raise exception 'ask-order.pglite.test: the order-uncertain write fails';
    end $$ language plpgsql`);
  await db.database.execute(
    sql`create trigger ask_order_test_fail_mark before insert or update or delete on authorized_signup_ask_order_uncertain for each row execute function ask_order_test_fail_mark()`,
  );
}
async function marksWork() {
  await db.database.execute(
    sql`drop trigger if exists ask_order_test_fail_mark on authorized_signup_ask_order_uncertain`,
  );
}

describe('a text whose carrier call failed after the carrier may have taken it', () => {
  afterEach(async () => {
    await marksWork();
    await db.database.execute(
      sql`drop trigger if exists ask_order_test_fail_stamp on authorized_signup_offers`,
    );
    vi.restoreAllMocks();
  });

  it('a coach offer whose call timed out after Linq took it: the bare yes moves no ask', async () => {
    const f = await household();
    await parentTexts(f, 'can you sign Ada up for swim', minutes(-60), {
      coachOffer: offering(f, SWIM),
    });
    const swimId = await offerIdFor(f, SWIM);
    const wire: string[] = [];
    const timedOut = new FakeReplyTransport();
    timedOut.send = async (input) => {
      wire.push(input.body);
      throw new LinqSendError('timeout', 0, false);
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await parentTexts(f, 'and kickers on saturdays', minutes(-40), {
      transport: timedOut,
      planReader: readerBy({ 'Preschool Swim': UNRELATED }),
      coachOffer: offering(f, KICKERS),
    }).catch(() => undefined);
    // The parent may well have the Kickers offer.
    expect(wire[0]).toBe('Want me to sign Ada up for Little Kickers?');
    const kickersId = await offerIdFor(f, KICKERS);

    const bare = await parentTexts(f, 'yes', minutes(-30), {
      planReader: readerBy({ 'Little Kickers': APPROVE, 'Preschool Swim': APPROVE }),
    });
    expect(bare.handler).not.toBe('authorized_signup');
    expect((await offerRow(swimId)).status).toBe('pending');
    expect((await offerRow(kickersId)).status).toBe('pending');
  });

  it('notices whose calls came back 2xx with no message id: the bare no takes nothing back', async () => {
    const f = await household();
    const { swimId, kickersId } = await twoApprovedPlans(f);
    const wire: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runDueSignupPlanPrep(
      db.database,
      { now: NOW },
      sweep(f, wire, { afterTaken: new LinqSendError('missing_message_id', 201, false) }),
    );
    expect(wire.length).toBeGreaterThan(0);

    await parentTexts(f, 'no', minutes(1), {
      planReader: readerBy({ 'Little Kickers': TAKE_BACK, 'Preschool Swim': TAKE_BACK }),
    });
    for (const offerId of [swimId, kickersId]) {
      const row = await offerRow(offerId);
      expect(row.status).toBe('planned');
      expect(row.planCancelRequestedAt).toBeNull();
    }
  });

  it('a coach offer that went, whose keep and every write after it failed: the bare yes moves no ask', async () => {
    const f = await household();
    await parentTexts(f, 'can you sign Ada up for swim', minutes(-60), {
      coachOffer: offering(f, SWIM),
    });
    const swimId = await offerIdFor(f, SWIM);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = new FakeReplyTransport();
    const send = transport.send.bind(transport);
    transport.send = async (input): Promise<ReplySent> => {
      const sent = await send(input);
      // Linq took it. From here every write about its number fails.
      await db.database.execute(sql`create or replace function ask_order_test_fail_stamp() returns trigger as $$
        begin
          if new.activity_key = 'kickers-sat' and new.last_asked_seq is distinct from old.last_asked_seq then
            raise exception 'ask-order.pglite.test: the stamp fails';
          end if;
          return new;
        end $$ language plpgsql`);
      await db.database.execute(
        sql`create trigger ask_order_test_fail_stamp before update on authorized_signup_offers for each row execute function ask_order_test_fail_stamp()`,
      );
      await failMarks();
      return sent;
    };
    await parentTexts(f, 'and kickers on saturdays', minutes(-40), {
      transport,
      planReader: readerBy({ 'Preschool Swim': UNRELATED }),
      coachOffer: offering(f, KICKERS),
    });
    await db.database.execute(
      sql`drop trigger ask_order_test_fail_stamp on authorized_signup_offers`,
    );
    await marksWork();
    expect(transport.bodies()).toEqual(['Want me to sign Ada up for Little Kickers?']);
    const kickersId = await offerIdFor(f, KICKERS);

    const bare = await parentTexts(f, 'yes', minutes(-30), {
      planReader: readerBy({ 'Little Kickers': APPROVE, 'Preschool Swim': APPROVE }),
    });
    expect(bare.handler).not.toBe('authorized_signup');
    expect((await offerRow(swimId)).status).toBe('pending');
    expect((await offerRow(kickersId)).status).toBe('pending');
  });
});

describe('a text about an ask whose mark cannot be written before its send', () => {
  afterEach(async () => {
    await marksWork();
    vi.restoreAllMocks();
  });

  it('a coach offer: nothing is sent, no apology either, and the turn is closed as failed', async () => {
    const f = await household();
    await parentTexts(f, 'can you sign Ada up for swim', minutes(-60), {
      coachOffer: offering(f, SWIM),
    });
    const swimId = await offerIdFor(f, SWIM);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await failMarks();
    const transport = new FakeReplyTransport();
    const result = await parentTexts(f, 'and kickers on saturdays', minutes(-40), {
      transport,
      planReader: readerBy({ 'Preschool Swim': UNRELATED }),
      coachOffer: offering(f, KICKERS),
    });
    await marksWork();
    expect(transport.bodies()).toEqual([]);
    expect(result.status).toBe('agent_failed');
    const failed = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, f.familyId),
          eq(schema.auditLog.actionTaken, 'sms_turn_failed'),
        ),
      );
    expect(failed.map((row) => row.after)).toEqual([
      { lane: 'coach', reason: 'ask_order_unmarked' },
    ]);
    const kickersId = await offerIdFor(f, KICKERS);
    expect((await offerRow(kickersId)).lastAskedSeq).toBeNull();

    // Nothing went, so the order on file is still right: the bare yes is Swim's.
    await parentTexts(f, 'yes', minutes(-30), {
      planReader: readerBy({ 'Little Kickers': APPROVE, 'Preschool Swim': APPROVE }),
    });
    expect((await offerRow(swimId)).status).toBe('planned');
    expect((await offerRow(kickersId)).status).toBe('pending');
  });

  it('a sweep notice: nothing is sent', async () => {
    const f = await household();
    await twoApprovedPlans(f);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await failMarks();
    const wire: string[] = [];
    await runDueSignupPlanPrep(db.database, { now: NOW }, sweep(f, wire));
    await marksWork();
    expect(wire).toEqual([]);
  });

  it("a plan's outcome notice: nothing is sent, and its key is left free for a later call to send it", async () => {
    const f = await household();
    const { swimId } = await twoApprovedPlans(f);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire: string[] = [];
    const notify = createPlanNotifier(db.database, {
      writer: { write: async () => 'Swim is booked.' },
      transport: {
        async send(input) {
          wire.push(input.body);
          return { providerMessageId: `notice-${f.familyId}-${wire.length}` };
        },
      },
      now: () => NOW,
    });
    const notice = {
      offerId: swimId,
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      outcome: 'completed' as const,
      detail: 'none' as const,
      choiceIndex: 0,
      cartTotalCents: 9800,
      amountChargedCents: 9800,
      confirmationNumber: 'C-1',
      liveViewUrl: null,
      holdExpiresAt: null,
    };

    await failMarks();
    const unmarked = await notify(notice);
    await marksWork();
    expect(unmarked).toBe('failed');
    expect(wire).toEqual([]);

    // Nothing went, so nothing may read as sent: the next call sends it, once.
    expect(await notify(notice)).toBe('sent');
    expect(wire).toEqual(['Swim is booked.']);
    expect(await notify(notice)).toBe('sent');
    expect(wire).toEqual(['Swim is booked.']);
  });
});

/**
 * A parent's text through the door it really comes in by: Linq's signed webhook, the intake
 * machine (its opt-out read is the shared reader, the scripted one in tests: vitest.setup.ts;
 * the model's own read of these words is the opt-out-read eval), then every turn the door
 * hands off, run through the router.
 */
describe('a bare stop from a parent with a planned sign-up', () => {
  const LINQ_KEY = Buffer.alloc(32, 9);
  beforeEach(() => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${LINQ_KEY.toString('base64')}`);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function webhook(f: Household, text: string, at: Date): Request {
    const messageId = `in-${f.familyId.slice(-8)}-${at.getTime()}`;
    const ts = String(Math.floor(at.getTime() / 1000));
    const body = JSON.stringify({
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'message.received',
      event_id: `evt-${messageId}`,
      created_at: at.toISOString(),
      data: {
        chat: { id: `chat-${f.familyId.slice(-8)}`, is_group: false },
        id: messageId,
        direction: 'inbound',
        sender_handle: { handle: f.phone, is_me: false, service: 'iMessage' },
        parts: [{ type: 'text', value: text }],
        sent_at: at.toISOString(),
        service: 'iMessage',
      },
    });
    const mac = createHmac('sha256', LINQ_KEY)
      .update(`evt-${messageId}.${ts}.${body}`)
      .digest('base64');
    return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': `evt-${messageId}`,
        'webhook-timestamp': ts,
        'webhook-signature': `v1,${mac}`,
      },
      body,
    });
  }

  /** The signed webhook and the intake machine only: what the door confirmed and queued. */
  async function throughTheDoor(
    f: Household,
    text: string,
    at: Date,
    options: { optOutReader?: OptOutReader },
  ) {
    const jobs: ChannelMessageReceivedJob[] = [];
    const intakeTransport = new FakeTransport();
    const intake: IntakeDeps = {
      transport: intakeTransport,
      threadMessage: async () => 'conv-1',
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([]),
      radar: fakeRadar,
      answerComposer: fakeSilentAnswerComposer,
      openQuestions: fakeNoOpenQuestions,
      identityAsk: new FakeIdentityAsk(),
      limiter: new FakeRateLimiter(() => at.getTime()),
      now: at,
      ...(options.optOutReader ? { optOutReader: options.optOutReader } : {}),
    };
    const door = {
      database: db.database,
      intake: () => intake,
      enqueue: async (queued: ChannelMessageReceivedJob) => {
        jobs.push(queued);
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      now: () => at,
      markRead: async () => ({ status: 'accepted' as const }),
      sendGroupText: async () => ({ providerMessageId: 'unused' }),
    } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
    const response = await handleLinqInboundRequest(webhook(f, text, at), door);
    return {
      outcome: ((await response.json()) as { outcome?: string }).outcome,
      jobs,
      confirmed: intakeTransport.bodies(),
    };
  }

  /** Each queued job through the router, in order; what the router sent. */
  async function routed(
    jobs: readonly ChannelMessageReceivedJob[],
    at: Date,
    options: { planReader: PlanReader; burst?: InboundBurst },
  ) {
    const said: string[] = [];
    for (const job of jobs) {
      const transport = new FakeReplyTransport();
      await routeChannelMessage(deps(at, { transport, ...options }), job);
      said.push(...transport.bodies());
    }
    return said;
  }

  async function textsTheDoor(
    f: Household,
    text: string,
    at: Date,
    options: { planReader: PlanReader; optOutReader?: OptOutReader },
  ) {
    const door = await throughTheDoor(f, text, at, options);
    return {
      outcome: door.outcome,
      jobs: door.jobs,
      handedOff: door.jobs.length,
      confirmed: door.confirmed,
      routerSaid: await routed(door.jobs, at, options),
    };
  }

  /** The door's write of the hold row fails, as a database refusing one insert would. */
  async function failHoldWrites() {
    await db.database.execute(
      sql.raw(`create or replace function test_fail_hold() returns trigger as $$
        begin raise exception 'test: the hold write fails'; end $$ language plpgsql`),
    );
    await db.database.execute(
      sql`create trigger test_fail_hold before insert on opt_out_held_messages for each row execute function test_fail_hold()`,
    );
  }
  async function allowHoldWrites() {
    await db.database.execute(sql`drop trigger if exists test_fail_hold on opt_out_held_messages`);
  }

  /** A burst planner that is on and reads every settled text as one ask. */
  function foldingBurst(): InboundBurst {
    return createInboundBurst(db.database, {
      enabled: () => true,
      reader: {
        read: async (input) => ({ status: 'read', groups: [input.messages.map((m) => m.ref)] }),
      },
      // The rows' created_at is the database clock: a minute on, the texts have settled.
      now: () => new Date(Date.now() + 60_000),
      sleep: async () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
  }
  const unreadable: OptOutReader = { read: async () => null };

  async function revokedAt(f: Household) {
    const [row] = await db.database
      .select({ revokedAt: schema.parentChannels.revokedAt })
      .from(schema.parentChannels)
      .where(eq(schema.parentChannels.userId, f.parentUserId));
    return row?.revokedAt ?? null;
  }

  async function cancelAudits(f: Household) {
    const rows = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, f.familyId),
          eq(schema.auditLog.actionTaken, 'authorized_signup_step'),
        ),
      );
    return rows.filter((row) => JSON.stringify(row.after).includes('plan_cancel'));
  }

  // The plan reader would take either plan back on these words, so only the order the door
  // runs things in keeps them.
  const takesBack = readerBy({ 'Little Kickers': TAKE_BACK, 'Preschool Swim': TAKE_BACK });

  it.each(['stop', 'STOP', 'unsubscribe', 'Arrête'])(
    '%s is the opt-out, read at the door: no turn reaches the router and both plans stand',
    async (word) => {
      const f = await household();
      const { swimId, kickersId } = await twoApprovedPlans(f);

      const turn = await textsTheDoor(f, word, minutes(1), { planReader: takesBack });

      expect(turn.handedOff).toBe(0);
      expect(turn.routerSaid).toEqual([]);
      expect(await revokedAt(f)).not.toBeNull();
      // The reply is the opt-out's own confirmation, never a word about a plan.
      expect(turn.confirmed).toEqual([SCRIPTED_STOP_CONFIRMATION]);
      for (const offerId of [swimId, kickersId]) {
        const row = await offerRow(offerId);
        expect(row.status).toBe('planned');
        expect(row.planCancelRequestedAt).toBeNull();
      }
      expect(await cancelAudits(f)).toEqual([]);
    },
  );

  it('a stop the opt-out read could not read holds the number and takes no plan back', async () => {
    const f = await household();
    const { swimId, kickersId } = await twoApprovedPlans(f);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Words no earlier test read, so no cached read of them stands in for this one.
    const turn = await textsTheDoor(f, 'STOP!!', minutes(1), {
      planReader: takesBack,
      optOutReader: { read: async () => null },
    });

    // The door could not tell, so the turn goes on to the router, held as a possible stop.
    expect(turn.handedOff).toBe(1);
    const held = await db.database.select().from(schema.optOutHeldMessages);
    expect(held).toHaveLength(1);
    for (const offerId of [swimId, kickersId]) {
      const row = await offerRow(offerId);
      expect(row.status).toBe('planned');
      expect(row.planCancelRequestedAt).toBeNull();
    }
    expect(await cancelAudits(f)).toEqual([]);
    expect(turn.routerSaid).not.toContain('reply for cancelled');
    await db.database.delete(schema.optOutHeldMessages);
  });

  it('a stop the opt-out read could not read takes no plan back when its hold could not be written', async () => {
    const f = await household();
    const { swimId, kickersId } = await twoApprovedPlans(f);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await failHoldWrites();
    const turn = await textsTheDoor(f, 'STOP!!', minutes(1), {
      planReader: takesBack,
      optOutReader: unreadable,
    }).finally(allowHoldWrites);

    // No row says this parent is held: only the turn itself can say the read failed.
    expect(await db.database.select().from(schema.optOutHeldMessages)).toEqual([]);
    expect(turn.handedOff).toBe(1);
    for (const offerId of [swimId, kickersId]) {
      const row = await offerRow(offerId);
      expect(row.status).toBe('planned');
      expect(row.planCancelRequestedAt).toBeNull();
    }
    expect(await cancelAudits(f)).toEqual([]);
    expect(turn.routerSaid).not.toContain('reply for cancelled');
    expect(turn.jobs[0]?.opt_out_unread).toBe(true);
  });

  it('two texts read as one turn take no plan back when the read could not read one of them', async () => {
    const f = await household();
    const { swimId, kickersId } = await twoApprovedPlans(f);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await failHoldWrites();
    const first = await throughTheDoor(f, 'no', minutes(1), {});
    const second = await throughTheDoor(f, 'STOP!!', seconds(65), {
      optOutReader: unreadable,
    }).finally(allowHoldWrites);
    // The first text was read, so its own job says nothing is unread; the second's does.
    expect(first.jobs.map((job) => job.opt_out_unread)).toEqual([false]);
    expect(second.jobs.map((job) => job.opt_out_unread)).toEqual([true]);

    const said = await routed([...first.jobs, ...second.jobs], minutes(2), {
      planReader: takesBack,
      burst: foldingBurst(),
    });

    for (const offerId of [swimId, kickersId]) {
      const row = await offerRow(offerId);
      expect(row.status).toBe('planned');
      expect(row.planCancelRequestedAt).toBeNull();
    }
    expect(await cancelAudits(f)).toEqual([]);
    expect(said).not.toContain('reply for cancelled');
  });

  it('positive control: two texts both read, read as one turn, take the newest plan back', async () => {
    const f = await household();
    const { swimId, kickersId } = await twoApprovedPlans(f);

    const first = await throughTheDoor(f, 'no', minutes(1), {});
    const second = await throughTheDoor(f, 'not that one', seconds(65), {});
    const said = await routed([...first.jobs, ...second.jobs], minutes(2), {
      planReader: takesBack,
      burst: foldingBurst(),
    });

    // One turn answered both texts: one reply, and the second job stopped as folded.
    expect(said).toEqual(['reply for cancelled']);
    expect((await offerRow(kickersId)).status).toBe('handed_back');
    expect((await offerRow(swimId)).status).toBe('planned');
    expect(await cancelAudits(f)).toHaveLength(1);
  });

  it('positive control: a bare no through the same door reaches the router and takes the newest plan back', async () => {
    const f = await household();
    const { swimId, kickersId } = await twoApprovedPlans(f);

    const turn = await textsTheDoor(f, 'no', minutes(1), { planReader: takesBack });

    expect(turn.handedOff).toBe(1);
    expect(await revokedAt(f)).toBeNull();
    expect(turn.confirmed).toEqual([]);
    expect((await offerRow(kickersId)).status).toBe('handed_back');
    expect((await offerRow(swimId)).status).toBe('planned');
    expect(await cancelAudits(f)).toHaveLength(1);
  });
});
