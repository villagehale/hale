import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import type {
  BrowserUsePlanCheckpoint,
  BrowserUsePlanInput,
  BrowserUsePlanResult,
} from '../browser-use/plan-engine';
import { runBrowserUsePlanForMode } from '../browser-use/assisted-engine';
import { browserUseApi } from '../browser-use/client';
import { storeProviderSession } from '../browser-use/vault';
import type { SignupConsentReader } from '../consent-reader';
import { AUTHORIZED_SIGNUP_ENABLED_ENV } from '../flag';
import { activityKeyFor, offerSignupFromFacts } from '../offer-from-facts';
import { offerSignupTool } from '../offer-tool';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from '../plan/flag';
import type { MismatchReader } from '../plan/mismatch-reader';
import { createPlanNotifier } from '../plan/notice';
import { recordPlanNotice } from '../plan/prep';
import { type PlanReader, type PlanReading, toPlanReading } from '../plan/reader';
import { type PlanOutcomeNotice, type PlanRunDeps, runDueSignupPlans } from '../plan/run';
import { cancelSignupPlan, parkSignupPlan } from '../plan/store';
import { type PlanReplyFacts, type PlanReplyWriter, planReplyUserMessage } from '../plan/writer';
import { runAuthorizedSignup } from '../run';
import { sentSignupText } from '../sent-text.fixture';
import { recordSignupOffer } from '../store';
import type { SignupSession } from '../types';
import { compareCart } from './cart';
import type { DobReader } from './dob-reader';
import type { PreflightReader, SignupPreflightRead } from './read-page';
import { termsAskStamp } from './store';

// Invented family details on a saved public page. The read and the replies are model calls
// with their own evals; here each is a stipulated answer, and what is tested is what the
// database does with it.
const PAGE = readFileSync(
  join(__dirname, '../../channel/spots/fixtures/markham-course.html'),
  'utf8',
);
const HOST = 'cityofmarkham.perfectmind.com';
const URL_ = `https://${HOST}/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=15f6af07-39c5-473e-b053-96653f77a406&courseId=4241ad2f-9b67-464f-9f19-ad5f46d4a92d`;
const NOW = new Date('2026-02-01T12:00:00.000Z');
const PAGE_OPEN = new Date('2026-02-24T11:30:00.000Z');
const SESSIONS = [
  {
    id: 's-1',
    label: 'Sat 9:30',
    startsAt: '2026-03-28T09:30:00',
    endsAt: '2026-03-28T10:30:00',
    full: false,
    priceCents: null,
  },
];
const BLANK: SignupPreflightRead = {
  refund_quote: null,
  prerequisite_quote: null,
  prerequisite: 'none_stated',
  age_band_quote: null,
  prices: [],
  tax_quote: null,
  tax: 'unknown',
  currency_quote: null,
  currency: null,
};
const YES: PlanReading = {
  verdict: 'approve',
  choiceIds: ['s-1'],
  maxPriceCents: 8488,
  waiverAccepted: false,
  named: null,
  prerequisiteMet: null,
};

let db: TestDb;
let phoneSeq = 0;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, 'true');
  vi.stubEnv(AUTHORIZED_SIGNUP_ENABLED_ENV, 'on');
  vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', 'true');
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function household(ageMonths = 62, postal: string | null = 'L3R 1A1') {
  const seeded = await seedFamily(db.database);
  if (postal) {
    await db.database
      .update(schema.families)
      .set({ postalCode: postal })
      .where(eq(schema.families.id, seeded.familyId));
  }
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', ageMonths, undefined, NOW);
  phoneSeq += 1;
  const phone = `+1202555${String(5000 + phoneSeq).padStart(4, '0')}`;
  await db.database.insert(schema.parentChannels).values({
    userId: seeded.parentUserId,
    familyId: seeded.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
  });
  const stored = await storeProviderSession(db.database, {
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    providerHost: HOST,
    storageState: { cookies: [{ name: 'SID', value: 'c', domain: `.${HOST}` }] },
    capturedAt: new Date(NOW.getTime() - 60 * 60_000),
  });
  expect(stored.ok).toBe(true);
  return { ...seeded, childId };
}

type Household = Awaited<ReturnType<typeof household>>;

/** Slack #ops on the real page path: every text the webhook is posted. */
function stubOps(): string[] {
  const posted: string[] = [];
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.test/ops-fixture');
  vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
    posted.push(JSON.parse(init?.body ?? '{}').text);
    return new Response('ok', { status: 200 });
  });
  return posted;
}

function writer() {
  const written: PlanReplyFacts[] = [];
  const planWriter: PlanReplyWriter = {
    write: vi.fn(async (facts: PlanReplyFacts) => {
      written.push(facts);
      return `text for ${facts.moment}`;
    }),
  };
  return { planWriter, written };
}

const pageDeps = (page = PAGE, read: SignupPreflightRead = BLANK) => ({
  fetchBody: async () => ({ outcome: 'fetched' as const, body: Buffer.from(page) }),
  preflightReader: { read: vi.fn(async () => read) } satisfies PreflightReader,
});

async function ask(
  f: Household,
  options: {
    now?: Date;
    planOpensAt?: Date | null;
    page?: string;
    read?: SignupPreflightRead;
    writer?: PlanReplyWriter;
    sessions?: readonly SignupSession[];
    approvedPriceCents?: number | null;
    evidence?: string;
  } = {},
) {
  const { planWriter } = writer();
  return offerSignupFromFacts(
    db.database,
    {
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      childId: f.childId,
      now: options.now ?? NOW,
      planOpensAt: options.planOpensAt ?? null,
      activityLabel: 'Get Ready Public Speaking',
      facts: {
        source: 'chat',
        evidence: options.evidence ?? 'sign Ada up',
        registrationUrl: URL_,
        sessions: [...(options.sessions ?? SESSIONS)],
        approvedPriceCents: options.approvedPriceCents ?? null,
        language: null,
      },
    },
    { planWriter: options.writer ?? planWriter, terms: pageDeps(options.page, options.read) },
  );
}

/** The router's send of the offer's own text: stamped, accepted, kept. */
async function offerTextSent(f: Household, offerId: string) {
  const keep = await termsAskStamp(db.database, {
    familyId: f.familyId,
    parentUserId: f.parentUserId,
    offerIds: [offerId],
  })();
  const sent = await sentSignupText(db.database, f);
  await keep(sent);
  return sent;
}

async function askedAndSent(f: Household, options: Parameters<typeof ask>[1] = {}) {
  const result = await ask(f, options);
  if (!result.ok) throw new Error(result.reason);
  await offerTextSent(f, result.offerId);
  return result.offerId;
}

async function inbound(f: Household, inGroup: boolean, body = 'yes') {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body,
      inGroup,
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('no inbound row');
  return row.id;
}

async function yes(
  f: Household,
  reading: PlanReading,
  options: {
    now?: Date;
    body?: string;
    inGroup?: boolean;
    writer?: PlanReplyWriter;
    reader?: PlanReader;
    declineSeat?: () => Promise<boolean>;
    dobReader?: DobReader;
    mismatchReader?: MismatchReader;
    sendProviderEmail?: (input: { to: string; subject: string; body: string }) => Promise<void>;
  } = {},
) {
  const planReader: PlanReader = options.reader ?? { read: vi.fn(async () => reading) };
  const { planWriter, written } = writer();
  const browserUseSignup = { run: vi.fn() };
  const result = await runAuthorizedSignup(
    db.database,
    {
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      body: options.body ?? 'yes',
      inboundChannelMessageId: await inbound(f, options.inGroup === true, options.body),
      existingThread: true,
      now: options.now ?? NOW,
    },
    {
      planReader,
      planWriter: options.writer ?? planWriter,
      declineSeat: options.declineSeat,
      dobReader: options.dobReader,
      mismatchReader: options.mismatchReader,
      sendProviderEmail: options.sendProviderEmail,
      browserUseSignup: browserUseSignup as never,
    },
  );
  return { result, planReader, written, browserUseSignup };
}

async function offerRow(offerId: string) {
  const [row] = await db.database
    .select()
    .from(schema.authorizedSignupOffers)
    .where(eq(schema.authorizedSignupOffers.id, offerId));
  if (!row) throw new Error('no offer');
  return row;
}

async function termsRow(offerId: string) {
  const [row] = await db.database
    .select()
    .from(schema.authorizedSignupTerms)
    .where(eq(schema.authorizedSignupTerms.offerId, offerId));
  return row ?? null;
}

async function offerCount(f: Household) {
  const rows = await db.database
    .select({ id: schema.authorizedSignupOffers.id })
    .from(schema.authorizedSignupOffers)
    .where(eq(schema.authorizedSignupOffers.familyId, f.familyId));
  return rows.length;
}

const RUN_RESULT: BrowserUsePlanResult = {
  outcome: 'needs_human',
  detail: 'cart_mismatch',
  cartDifferences: ['price'],
  choiceIndex: 0,
  liveViewUrl: 'https://live.browser-use.com/s/fixture-live-view-token',
  checkoutUrl: null,
  holdExpiresAt: new Date('2026-02-01T12:30:00.000Z'),
  cartTotalCents: 9760,
  confirmationNumber: null,
  opensAt: null,
  amountChargedCents: null,
  runId: 'run-1',
  sessionId: 'bu-session-1',
  costUsd: '0.0500',
  sessionCostUsd: '0.090000',
  browserId: 'browser-1',
  charged: 'nothing',
};

function sweepDeps(result: BrowserUsePlanResult = RUN_RESULT) {
  const inputs: BrowserUsePlanInput[] = [];
  const notices: PlanOutcomeNotice[] = [];
  const deps: PlanRunDeps = {
    runner: {
      run: vi.fn(async (input): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> => {
        inputs.push(input);
        return result;
      }),
      release: vi.fn(async () => null),
      settlePayment: vi.fn(),
    },
    notifyParent: vi.fn(async (notice: PlanOutcomeNotice) => {
      notices.push(notice);
      return 'sent' as const;
    }),
  };
  return { deps, inputs, notices };
}

const sweep = (deps: PlanRunDeps, now: Date) => runDueSignupPlans(db.database, { now }, deps);

describe('the ask', () => {
  it('an in-band child gets one offer and one terms row, with nothing yet asked', async () => {
    const f = await household();
    const result = await ask(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const offer = await offerRow(result.offerId);
    expect(offer.status).toBe('pending');
    expect(offer.planOpensAt?.toISOString()).toBe(PAGE_OPEN.toISOString());
    expect(offer.planAlreadyOpen).toBe(false);
    const terms = await termsRow(result.offerId);
    expect(terms?.askedMessageId).toBeNull();
    expect(terms?.approved).toBeNull();
    expect(terms?.shown).toMatchObject({
      read: 'course_model',
      residency: 'resident',
      currency: 'cad',
      countsAgainstSeason: true,
      age: { fit: 'in_band', band: '4 to 6' },
      prerequisite: { required: 'no' },
      program: { name: 'Get Ready Public Speaking' },
    });
    // Program facts only: the stored terms never carry the child.
    expect(JSON.stringify(terms?.shown)).not.toContain('Ada');
  });

  it.each([
    ['over', 100],
    ['under', 30],
  ])('a child %s the band stops at the ask: no offer, no text', async (_name, months) => {
    const f = await household(months);
    const { planWriter } = writer();
    const result = await ask(f, { writer: planWriter });
    expect(result).toEqual({ ok: false, reason: 'age_outside_band', ageBand: '4 to 6' });
    expect(await offerCount(f)).toBe(0);
    expect(planWriter.write).not.toHaveBeenCalled();
  });

  it('a text the writer cannot write stores nothing and pages #ops', async () => {
    const posted = stubOps();
    const f = await household();
    const result = await ask(f, { writer: { write: async () => null } });
    expect(result).toEqual({ ok: false, reason: 'unwritten' });
    expect(await offerCount(f)).toBe(0);
    expect(posted.join(' ')).toContain('registration_text_unwritten');
  });

  it('a yes whose reply the writer cannot write sends nothing and pages #ops', async () => {
    const posted = stubOps();
    const f = await household();
    await askedAndSent(f);
    const turn = await yes(f, YES, { writer: { write: async () => null } });
    expect(turn.result).toMatchObject({
      claimed: true,
      reply: null,
      deliverOnThread: false,
      unsent: 'reply_unwritten',
    });
    expect(posted.join(' ')).toContain('registration_text_unwritten');
    expect(posted.join(' ')).toContain('moment reply');
  });

  it('a run notice the writer cannot write sends nothing and pages #ops', async () => {
    const posted = stubOps();
    const f = await household();
    const offerId = await askedAndSent(f);
    await yes(f, YES);
    const row = await termsRow(offerId);
    const send = vi.fn();
    const notify = createPlanNotifier(db.database, {
      writer: { write: async () => null },
      transport: { send },
      now: () => NOW,
    });
    const outcome = await notify({
      offerId,
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      outcome: 'needs_human',
      detail: 'cart_mismatch',
      choiceIndex: 0,
      cartTotalCents: 9760,
      amountChargedCents: null,
      charged: 'nothing',
      confirmationNumber: null,
      liveViewUrl: null,
      holdExpiresAt: null,
      cartDifferences: ['price'],
      terms: { shown: row?.shown as never, approved: row?.approved as never },
    });
    expect(outcome).toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect(posted.join(' ')).toContain('registration_text_unwritten');
    expect(posted.join(' ')).toContain('moment run_notice');
  });

  it('a one-shot hand-back the writer cannot write sends nothing and pages #ops', async () => {
    const posted = stubOps();
    const f = await household();
    const offer = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'public-speaking',
      registrationUrl: URL_,
      sessions: SESSIONS,
      approvedPriceCents: null,
      now: NOW,
    });
    if (!offer.ok) throw new Error(offer.reason);
    await (
      await (
        await import('../store')
      ).askStamp(db.database, {
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        offerIds: [offer.id],
      })()
    )(await sentSignupText(db.database, f));
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        body: 'yes',
        inboundChannelMessageId: await inbound(f, false),
        existingThread: true,
        now: NOW,
      },
      {
        consentReader: {
          read: vi.fn(async () => ({
            verdict: 'consent' as const,
            sessionId: 's-1',
            approvedPriceCents: null,
            activityKey: 'public-speaking',
            said: 'yes',
          })),
        } as never,
        outcomeWriter: { write: async () => null },
        browserUseSignup: { run: vi.fn() } as never,
      },
    );
    expect(result).toMatchObject({ reply: null, unsent: 'reply_unwritten' });
    expect((await offerRow(offer.id)).status).toBe('handed_back');
    expect(posted.join(' ')).toContain('registration_text_unwritten');
  });

  it('a group offer_signup records nothing, and the same call 1:1 records a row', async () => {
    const f = await household();
    const { planWriter } = writer();
    const call = (audience: 'group' | 'direct') =>
      offerSignupTool({
        database: db.database,
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        now: NOW,
        parentWords: `sign Ada up ${URL_}`,
        optOutUnread: false,
        audience,
        linksThisTurn: () => [],
        planWriter,
        termsDeps: pageDeps(),
        onRecorded: () => undefined,
      }).handler(
        {
          child: 'Ada',
          activity: 'Get Ready Public Speaking',
          source: 'chat',
          registrationUrl: URL_,
          evidence: 'sign Ada up',
          sessions: SESSIONS,
          approvedPriceCents: null,
          opensAt: null,
        } as never,
        { familyId: f.familyId } as never,
      );
    await expect(call('group')).resolves.toEqual({
      recorded: false,
      reason: 'terms_in_private',
    });
    expect(await offerCount(f)).toBe(0);
    await expect(call('direct')).resolves.toMatchObject({ recorded: true });
    expect(await offerCount(f)).toBe(1);
  });
});

describe('the yes', () => {
  it('binds the terms, answers on the turn and starts no run', async () => {
    const f = await household();
    const offerId = await askedAndSent(f);
    const turn = await yes(f, YES);
    expect(turn.result.outcome).toBe('plan_approved');
    expect(turn.browserUseSignup.run).not.toHaveBeenCalled();
    expect((await offerRow(offerId)).status).toBe('planned');
    expect((await offerRow(offerId)).planMaxPriceCents).toBe(8488);
    const terms = await termsRow(offerId);
    expect(terms?.approved?.sessions[0]?.amount).toEqual({
      kind: 'exact',
      cents: [8488],
      currency: 'cad',
      plusTax: null,
    });
    expect(terms?.approved?.hold).toBeNull();
    expect(turn.written.at(-1)?.terms?.runsNow).toBe(false);
  });

  it('a yes typed in a group reads nothing and moves nothing; 1:1 it binds', async () => {
    const f = await household();
    const offerId = await askedAndSent(f);
    const inGroup = await yes(f, YES, { inGroup: true });
    expect(inGroup.result).toMatchObject({ claimed: false, outcome: 'asks_held_for_private' });
    expect(inGroup.planReader.read).not.toHaveBeenCalled();
    expect((await offerRow(offerId)).status).toBe('pending');
    const direct = await yes(f, YES);
    expect(direct.result.outcome).toBe('plan_approved');
    expect((await offerRow(offerId)).status).toBe('planned');
  });

  describe('a yes with money of their own beside it', () => {
    const body = 'yes up to $100';
    // The stipulated model output takes the worst read: a plain approval of the stated price.
    const approvesPrice: PlanReader = {
      read: vi.fn(async ({ text, offer }) =>
        toPlanReading(
          {
            reason: 'r',
            said: text,
            named: null,
            verdict: 'approve',
            choiceIds: ['s-1'],
            maxPriceCents: 8488,
            waiverSaid: null,
            waiverAccepted: false,
            question: null,
            prerequisiteSaid: null,
            prerequisiteMet: null,
          },
          offer,
          text,
        ),
      ),
    };

    it('asks about the stated price with the price in hand, then a plain yes binds it', async () => {
      const f = await household();
      const offerId = await askedAndSent(f);
      const turn = await yes(f, YES, { body, reader: approvesPrice });
      expect(turn.result.outcome).toBe('plan_clarify');
      const asked = turn.written.at(-1);
      expect(asked?.question).toMatch(/stated price/);
      expect(asked?.terms?.rates.map((row) => row.cents)).toEqual([8488]);
      expect((await offerRow(offerId)).status).toBe('pending');
      expect((await termsRow(offerId))?.approved).toBeNull();

      const next = await yes(f, YES);
      expect(next.result.outcome).toBe('plan_approved');
      expect((await termsRow(offerId))?.approved?.sessions[0]?.amount).toEqual({
        kind: 'exact',
        cents: [8488],
        currency: 'cad',
        plusTax: null,
      });
    });

    it('a seat that may not authorize this sign-up is not told the price', async () => {
      const f = await household();
      const offerId = await askedAndSent(f);
      const turn = await yes(f, YES, {
        body,
        reader: approvesPrice,
        declineSeat: async () => true,
      });
      expect(turn.result.outcome).toBe('plan_clarify');
      expect(turn.written.at(-1)?.moment).toBe('clarify');
      expect(turn.written.at(-1)?.terms).toBeUndefined();
      expect((await termsRow(offerId))?.approved).toBeNull();
    });
  });

  it('terms that never reached them bind nothing: they go out as a new ask, then bind', async () => {
    const f = await household();
    const result = await ask(f);
    if (!result.ok) throw new Error(result.reason);
    // The coach's reply lost the offer's text to a cut: no send carried it. A question
    // back on this ask made it the one a bare yes answers, without carrying the terms.
    const keep = await (await import('../store')).askStamp(db.database, {
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      offerIds: [result.offerId],
    })();
    await keep(await sentSignupText(db.database, f));
    const first = await yes(f, YES);
    expect((await offerRow(result.offerId)).status).toBe('pending');
    expect((await termsRow(result.offerId))?.approved).toBeNull();
    expect(first.written.at(-1)?.moment).toBe('offer');
    expect(first.result.stamp).toBeDefined();
    // Sending that reply is what records the terms as received.
    const kept = await first.result.stamp?.();
    await kept?.(await sentSignupText(db.database, f));
    expect((await termsRow(result.offerId))?.askedMessageId).not.toBeNull();
    const second = await yes(f, YES);
    expect(second.result.outcome).toBe('plan_approved');
    expect((await offerRow(result.offerId)).status).toBe('planned');
  });

  it('a prerequisite the parent did not confirm keeps the offer pending, and asks', async () => {
    const f = await household();
    const page = PAGE.replace('"PrerequisiteEvents":false', '"PrerequisiteEvents":true');
    const offerId = await askedAndSent(f, { page });
    const turn = await yes(f, YES);
    expect(turn.result.outcome).toBe('plan_clarify');
    expect((await offerRow(offerId)).status).toBe('pending');
    expect((await termsRow(offerId))?.approved).toBeNull();
    const confirmed = await yes(f, { ...YES, prerequisiteMet: true });
    expect(confirmed.result.outcome).toBe('plan_approved');
    expect((await termsRow(offerId))?.approved?.prerequisiteConfirmed).toBe(true);
  });

  it('a yes after the open binds as open now and starts no run on the turn', async () => {
    const f = await household();
    const opens = new Date(NOW.getTime() + 60_000);
    const offerId = await askedAndSent(f, { planOpensAt: opens });
    const later = new Date(NOW.getTime() + 2 * 60_000);
    const turn = await yes(f, YES, { now: later });
    expect(turn.result.outcome).toBe('plan_approved');
    expect(turn.browserUseSignup.run).not.toHaveBeenCalled();
    const row = await offerRow(offerId);
    expect(row.status).toBe('planned');
    expect(row.planAlreadyOpen).toBe(true);
    expect(row.planOpensAt?.toISOString()).toBe(later.toISOString());
    expect(turn.written.at(-1)?.terms?.runsNow).toBe(true);
  });

  it('a one-shot ask from before the flag never reaches a browser', async () => {
    const f = await household();
    const offer = await recordSignupOffer(db.database, {
      familyId: f.familyId,
      childId: f.childId,
      parentUserId: f.parentUserId,
      activityKey: 'public-speaking',
      registrationUrl: URL_,
      sessions: SESSIONS,
      approvedPriceCents: null,
      now: NOW,
    });
    if (!offer.ok) throw new Error(offer.reason);
    await (
      await (
        await import('../store')
      ).askStamp(db.database, {
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        offerIds: [offer.id],
      })()
    )(await sentSignupText(db.database, f));
    const browserUseSignup = { run: vi.fn() };
    const consentReader: SignupConsentReader = {
      read: vi.fn(async () => ({
        verdict: 'consent' as const,
        sessionId: 's-1',
        approvedPriceCents: null,
        activityKey: 'public-speaking',
        said: 'yes',
      })),
    } as never;
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        body: 'yes',
        inboundChannelMessageId: await inbound(f, false),
        existingThread: true,
        now: NOW,
      },
      {
        consentReader,
        outcomeWriter: { write: async () => 'not this way, here is the link' },
        browserUseSignup: browserUseSignup as never,
      },
    );
    expect(browserUseSignup.run).not.toHaveBeenCalled();
    expect(result.claimed).toBe(true);
    expect(result.outcome).toBe('error');
    expect((await offerRow(offer.id)).status).toBe('handed_back');
  });

  it('a birth date answered after the ask is stored exact and re-checked', async () => {
    const f = await household();
    await db.database
      .update(schema.children)
      .set({ dobPrecision: 'derived' })
      .where(eq(schema.children.id, f.childId));
    const offerId = await askedAndSent(f);
    await recordPlanNotice(db.database, {
      familyId: f.familyId,
      offerId,
      providerHost: HOST,
      kind: 'ask_dob',
      now: NOW,
    });
    const notTheirs: DobReader = {
      read: vi.fn(async () => ({
        said: 'March 21, 2021',
        date: '2021-03-21',
        otherPerson: false,
      })),
    };
    await yes(f, { verdict: 'unrelated' }, { body: 'she is five', dobReader: notTheirs });
    const before = await db.database
      .select({ precision: schema.children.dobPrecision })
      .from(schema.children)
      .where(eq(schema.children.id, f.childId));
    expect(before[0]?.precision).toBe('derived');

    const theirs: DobReader = {
      read: vi.fn(async () => ({
        said: 'March 21, 2021',
        date: '2021-03-21',
        otherPerson: false,
      })),
    };
    const turn = await yes(
      f,
      { verdict: 'unrelated' },
      { body: 'She was born March 21, 2021', dobReader: theirs },
    );
    expect(turn.result.outcome).toBe('plan_clarify');
    const [child] = await db.database
      .select({ dob: schema.children.dateOfBirth, precision: schema.children.dobPrecision })
      .from(schema.children)
      .where(eq(schema.children.id, f.childId));
    expect(child).toEqual({ dob: '2021-03-21', precision: 'exact' });
    // A date is not a yes.
    expect((await offerRow(offerId)).status).toBe('pending');
  });

  it('a birth date lands with its audit row or not at all, and records what it replaced', async () => {
    const f = await household();
    await db.database
      .update(schema.children)
      .set({ dobPrecision: 'derived' })
      .where(eq(schema.children.id, f.childId));
    const childRow = async () => {
      const [row] = await db.database
        .select({
          dateOfBirth: schema.children.dateOfBirth,
          dobPrecision: schema.children.dobPrecision,
        })
        .from(schema.children)
        .where(eq(schema.children.id, f.childId));
      return row;
    };
    const prior = await childRow();
    const offerId = await askedAndSent(f);
    await recordPlanNotice(db.database, {
      familyId: f.familyId,
      offerId,
      providerHost: HOST,
      kind: 'ask_dob',
      now: NOW,
    });
    const dobReader: DobReader = {
      read: vi.fn(async () => ({
        said: 'March 21, 2021',
        date: '2021-03-21',
        otherPerson: false,
      })),
    };
    const answer = { body: 'She was born March 21, 2021', dobReader };
    await db.database.execute(
      sql.raw(`CREATE FUNCTION refuse_dob_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.after->>'step' = 'plan_dob_recorded' THEN RAISE EXCEPTION 'audit refused'; END IF;
          RETURN NEW;
        END $$`),
    );
    await db.database.execute(
      sql.raw(
        'CREATE TRIGGER refuse_dob_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_dob_audit()',
      ),
    );
    try {
      await expect(yes(f, { verdict: 'unrelated' }, answer)).rejects.toThrow();
    } finally {
      await db.database.execute(sql.raw('DROP TRIGGER refuse_dob_audit ON audit_log'));
      await db.database.execute(sql.raw('DROP FUNCTION refuse_dob_audit()'));
    }
    expect(await childRow()).toEqual(prior);

    await yes(f, { verdict: 'unrelated' }, answer);
    expect(await childRow()).toEqual({ dateOfBirth: '2021-03-21', dobPrecision: 'exact' });
    const edits = await db.database
      .select({ before: schema.auditLog.before, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actionTaken, 'child_updated'),
          eq(schema.auditLog.targetId, f.childId),
        ),
      );
    expect(edits).toEqual([
      {
        before: { dateOfBirth: prior?.dateOfBirth, dobPrecision: 'derived' },
        after: { dateOfBirth: '2021-03-21', dobPrecision: 'exact' },
      },
    ]);
  });

  it('a birth date outside the band closes the offer and says why', async () => {
    const f = await household();
    await db.database
      .update(schema.children)
      .set({ dobPrecision: 'derived' })
      .where(eq(schema.children.id, f.childId));
    const offerId = await askedAndSent(f);
    await recordPlanNotice(db.database, {
      familyId: f.familyId,
      offerId,
      providerHost: HOST,
      kind: 'ask_dob',
      now: NOW,
    });
    const reader: DobReader = {
      read: vi.fn(async () => ({ said: 'June 1, 2016', date: '2016-06-01', otherPerson: false })),
    };
    const turn = await yes(f, YES, { body: 'She was born June 1, 2016', dobReader: reader });
    expect((await offerRow(offerId)).status).toBe('handed_back');
    expect(turn.written.at(-1)).toMatchObject({ moment: 'refused', refusal: 'age_outside_band' });
    expect(turn.result.reply).toBe('text for refused');
  });

  it('an age the yes cannot confirm binds with a hold', async () => {
    const f = await household();
    await db.database
      .update(schema.children)
      .set({ dobPrecision: 'derived' })
      .where(eq(schema.children.id, f.childId));
    const offerId = await askedAndSent(f);
    // Hale asked once for the date; the next yes goes ahead with the date still derived.
    await recordPlanNotice(db.database, {
      familyId: f.familyId,
      offerId,
      providerHost: HOST,
      kind: 'ask_dob',
      now: NOW,
    });
    const reader: DobReader = {
      read: vi.fn(async () => ({ said: null, date: null, otherPerson: false })),
    };
    const turn = await yes(f, YES, { dobReader: reader });
    expect(turn.result.outcome).toBe('plan_approved');
    expect((await termsRow(offerId))?.approved?.hold).toBe('age_unconfirmed');
    expect(turn.written.at(-1)?.terms?.hold).toBe('age_unconfirmed');
  });

  it('an earlier run that may have charged holds the next plan, and the one after', async () => {
    const f = await household();
    const first = await askedAndSent(f);
    await yes(f, YES);
    await db.database.insert(schema.auditLog).values({
      familyId: f.familyId,
      actor: f.parentUserId,
      actionTaken: 'authorized_signup_step',
      targetTable: 'authorized_signup_offers',
      targetId: first,
      after: { step: 'plan_finished', charged: 'unknown' },
    });
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'handed_back' })
      .where(eq(schema.authorizedSignupOffers.id, first));

    const second = await askedAndSent(f);
    expect((await termsRow(second))?.shown.priorChargeUnknown).toBe(true);
    await yes(f, YES);
    expect((await termsRow(second))?.approved?.hold).toBe('prior_charge_unknown');
    // A held attempt ends `nothing`: that must not clear the doubt.
    await db.database.insert(schema.auditLog).values({
      familyId: f.familyId,
      actor: f.parentUserId,
      actionTaken: 'authorized_signup_step',
      targetTable: 'authorized_signup_offers',
      targetId: second,
      after: { step: 'plan_finished', charged: 'nothing' },
    });
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'handed_back' })
      .where(eq(schema.authorizedSignupOffers.id, second));
    const third = await askedAndSent(f);
    expect((await termsRow(third))?.shown.priorChargeUnknown).toBe(true);
  });

  it('a run that died after moving out of submitting still counts as a possible charge', async () => {
    const f = await household();
    const first = await askedAndSent(f);
    await yes(f, YES);
    // The offer moved to handed_back with a paying token, and the sweep died before its
    // plan_finished row: nothing in audit_log says a charge may exist.
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({
        status: 'handed_back',
        planResume: {
          phase: 'paying',
          runId: 'run-1',
          sessionId: 'bu-session-1',
          browserId: 'browser-1',
          choiceIndex: 0,
          cartTotalCents: 8488,
          holdExpiresAt: null,
          costUsd: null,
        },
      })
      .where(eq(schema.authorizedSignupOffers.id, first));
    const second = await askedAndSent(f);
    expect((await termsRow(second))?.shown.priorChargeUnknown).toBe(true);
    await yes(f, YES);
    expect((await termsRow(second))?.approved?.hold).toBe('prior_charge_unknown');
  });

  it('a review that may have placed the order and never finished counts too', async () => {
    const f = await household();
    const first = await askedAndSent(f);
    await yes(f, YES);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({
        status: 'handed_back',
        planResume: {
          phase: 'signup',
          runId: 'run-1',
          sessionId: 'bu-session-1',
          browserId: 'browser-1',
          reviewStarted: true,
        },
      })
      .where(eq(schema.authorizedSignupOffers.id, first));
    const second = await askedAndSent(f);
    expect((await termsRow(second))?.shown.priorChargeUnknown).toBe(true);
  });

  it('a finished run whose token says paying is not a possible charge (control)', async () => {
    const f = await household();
    const first = await askedAndSent(f);
    await yes(f, YES);
    await db.database.insert(schema.auditLog).values({
      familyId: f.familyId,
      actor: f.parentUserId,
      actionTaken: 'authorized_signup_step',
      targetTable: 'authorized_signup_offers',
      targetId: first,
      after: { step: 'plan_finished', charged: 'nothing' },
    });
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({
        status: 'handed_back',
        planResume: {
          phase: 'paying',
          runId: 'run-1',
          sessionId: 'bu-session-1',
          browserId: 'browser-1',
          choiceIndex: 0,
          cartTotalCents: 8488,
          holdExpiresAt: null,
          costUsd: null,
        },
      })
      .where(eq(schema.authorizedSignupOffers.id, first));
    const second = await askedAndSent(f);
    expect((await termsRow(second))?.shown.priorChargeUnknown).toBe(false);
  });

  it('a no-stated-open ask counts against the season, even with a future page open', async () => {
    vi.stubEnv('MAX_ENTITLEMENTS_ENABLED', 'true');
    const f = await household();
    await db.database
      .update(schema.users)
      .set({ timezone: 'America/Toronto' })
      .where(eq(schema.users.id, f.parentUserId));
    const offerId = await askedAndSent(f);
    expect((await offerRow(offerId)).planAlreadyOpen).toBe(false);
    await yes(f, YES);
    const [season] = await db.database
      .select()
      .from(schema.familySignupHelpSeasons)
      .where(eq(schema.familySignupHelpSeasons.familyId, f.familyId));
    expect(season?.attempted).toBe(1);
    expect((await termsRow(offerId))?.approved?.seasonKey).toBe(season?.seasonKey);
  });

  it('a spent season refuses the yes and stores no plan', async () => {
    vi.stubEnv('MAX_ENTITLEMENTS_ENABLED', 'true');
    const f = await household();
    await db.database
      .update(schema.users)
      .set({ timezone: 'America/Toronto' })
      .where(eq(schema.users.id, f.parentUserId));
    const offerId = await askedAndSent(f);
    const { registrationSeasonOf } = await import('@hale/types');
    await db.database.insert(schema.familySignupHelpSeasons).values({
      familyId: f.familyId,
      seasonKey: registrationSeasonOf(new Date('2026-02-01T12:00:00'), 'America/Toronto').key,
      attempted: 50,
    });
    const turn = await yes(f, YES);
    expect(turn.result.outcome).toBe('plan_refused');
    expect(turn.written.at(-1)).toMatchObject({ moment: 'refused', refusal: 'season_cap' });
    expect((await offerRow(offerId)).status).toBe('pending');
  });
});

describe('the yes, against what happened since the ask', () => {
  const unknownCharge = (f: Household, offerId: string) =>
    db.database.insert(schema.auditLog).values({
      familyId: f.familyId,
      actor: f.parentUserId,
      actionTaken: 'authorized_signup_step',
      targetTable: 'authorized_signup_offers',
      targetId: offerId,
      after: { step: 'plan_finished', charged: 'unknown' },
    });

  it('a charge that went unknown after this ask was made holds the yes', async () => {
    const f = await household();
    const earlier = await askedAndSent(f);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'planned', planMaxPriceCents: 8488 })
      .where(eq(schema.authorizedSignupOffers.id, earlier));
    // A second ask on the class is made while the first is still clean.
    const second = await askedAndSent(f);
    expect((await termsRow(second))?.shown.priorChargeUnknown).toBe(false);
    await unknownCharge(f, earlier);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'handed_back' })
      .where(eq(schema.authorizedSignupOffers.id, earlier));
    const turn = await yes(f, YES);
    expect(turn.result.outcome).toBe('plan_approved');
    expect((await termsRow(second))?.approved?.hold).toBe('prior_charge_unknown');
    expect(turn.written.at(-1)?.terms?.hold).toBe('prior_charge_unknown');
  });

  describe('the question about what the class needs', () => {
    const NEEDS = PAGE.replace('"PrerequisiteEvents":false', '"PrerequisiteEvents":true');

    /** The router's send of a reply: its stamp, then the row that recorded it. */
    const sendReply = async (f: Household, turn: { result: { stamp?: unknown } }) => {
      const stamp = turn.result.stamp as
        | (() => Promise<(id: string) => Promise<unknown>>)
        | undefined;
      if (!stamp) throw new Error('that reply carries no stamp');
      const keep = await stamp();
      await keep(await sentSignupText(db.database, f));
    };
    const toldAsked = (turn: { planReader: PlanReader }) =>
      (turn.planReader.read as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.offer.terms
        ?.prerequisiteAsked;

    it('a plain yes to that question counts, once Hale asked it', async () => {
      const f = await household();
      const offerId = await askedAndSent(f, { page: NEEDS });
      // The first yes is to the ask itself: it says nothing about the prerequisite.
      const first = await yes(f, YES);
      expect(toldAsked(first)).toBe(false);
      expect(first.result.outcome).toBe('plan_clarify');
      expect((await offerRow(offerId)).status).toBe('pending');
      await sendReply(f, first);
      // The reader is told, so a plain yes reads as the answer to that question.
      const second = await yes(f, { ...YES, prerequisiteMet: true });
      expect(toldAsked(second)).toBe(true);
      expect(second.result.outcome).toBe('plan_approved');
      expect((await termsRow(offerId))?.approved?.prerequisiteConfirmed).toBe(true);
    });

    it('the question carries no page words: the writer gets them as a marked fact', async () => {
      const f = await household();
      const quote = 'Must have completed Pottery 1.';
      await askedAndSent(f, {
        page: NEEDS.replace('</body>', `<p>${quote}</p></body>`),
        read: { ...BLANK, prerequisite: 'required', prerequisite_quote: quote },
      });
      const turn = await yes(f, YES);
      expect(turn.result.outcome).toBe('plan_clarify');
      const facts = turn.written.at(-1);
      if (!facts) throw new Error('nothing was written');
      expect(facts.question).not.toContain('Pottery');
      const seen = JSON.parse(planReplyUserMessage(facts, null)).facts;
      expect(seen.terms.prerequisite.untrusted_quote).toBe(quote);
    });

    it('a question that never reached them is not the one a yes answers', async () => {
      const f = await household();
      await askedAndSent(f, { page: NEEDS });
      await yes(f, YES);
      // Its send failed: no stamp was kept, so nothing says the parent saw the question.
      const again = await yes(f, YES);
      expect(toldAsked(again)).toBe(false);
    });

    it('another question sent after it means a later yes does not answer it', async () => {
      const f = await household();
      await askedAndSent(f, { page: NEEDS });
      await sendReply(f, await yes(f, YES));
      const between = await yes(f, {
        verdict: 'unclear',
        question: 'Which session do you want?',
        named: null,
      });
      await sendReply(f, between);
      const after = await yes(f, YES);
      expect(toldAsked(after)).toBe(false);
      expect(after.result.outcome).toBe('plan_clarify');
    });

    it('a no ends the ask instead of asking again', async () => {
      const f = await household();
      const offerId = await askedAndSent(f, { page: NEEDS });
      await sendReply(f, await yes(f, YES));
      const turn = await yes(f, { ...YES, prerequisiteMet: false });
      expect(turn.result.outcome).toBe('plan_declined');
      expect((await offerRow(offerId)).status).toBe('handed_back');
      expect((await termsRow(offerId))?.approved).toBeNull();
    });
  });

  it("a date given for a sibling is stored nowhere, and Hale asks for this child's", async () => {
    const f = await household();
    await db.database
      .update(schema.children)
      .set({ dobPrecision: 'derived' })
      .where(eq(schema.children.id, f.childId));
    const [before] = await db.database
      .select({ dob: schema.children.dateOfBirth })
      .from(schema.children)
      .where(eq(schema.children.id, f.childId));
    const offerId = await askedAndSent(f);
    await recordPlanNotice(db.database, {
      familyId: f.familyId,
      offerId,
      providerHost: HOST,
      kind: 'ask_dob',
      now: NOW,
    });
    const read = vi.fn(async () => ({ said: null, date: null, otherPerson: true }));
    const turn = await yes(
      f,
      { verdict: 'unrelated' },
      { body: 'her brother was born March 21, 2019', dobReader: { read } },
    );
    expect(read).toHaveBeenCalledWith({
      text: 'her brother was born March 21, 2019',
      childFirstName: 'Ada',
    });
    expect(turn.result.outcome).toBe('plan_clarify');
    expect(turn.written.at(-1)?.question).toContain("this child's date of birth");
    const [after] = await db.database
      .select({ dob: schema.children.dateOfBirth, precision: schema.children.dobPrecision })
      .from(schema.children)
      .where(eq(schema.children.id, f.childId));
    expect(after).toEqual({ dob: before?.dob, precision: 'derived' });
    expect((await offerRow(offerId)).status).toBe('pending');
  });

  describe('a birth date, from a seat that may not answer or a date Hale cannot read', () => {
    const asked = async () => {
      const f = await household();
      await db.database
        .update(schema.children)
        .set({ dobPrecision: 'derived' })
        .where(eq(schema.children.id, f.childId));
      const offerId = await askedAndSent(f);
      await recordPlanNotice(db.database, {
        familyId: f.familyId,
        offerId,
        providerHost: HOST,
        kind: 'ask_dob',
        now: NOW,
      });
      return { f, offerId };
    };

    it('a declined seat reads and stores no date', async () => {
      const { f } = await asked();
      const read = vi.fn(async () => ({
        said: 'March 21, 2021',
        date: '2021-03-21',
        otherPerson: false,
      }));
      const declineSeat = vi.fn(async () => true);
      const planReader: PlanReader = {
        read: vi.fn(async (): Promise<PlanReading> => ({ verdict: 'unrelated' })),
      };
      const { planWriter } = writer();
      await runAuthorizedSignup(
        db.database,
        {
          familyId: f.familyId,
          parentUserId: f.parentUserId,
          body: 'born March 21, 2021',
          inboundChannelMessageId: await inbound(f, false, 'born March 21, 2021'),
          existingThread: true,
          now: NOW,
        },
        { planReader, planWriter, dobReader: { read }, declineSeat },
      );
      expect(declineSeat).toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      const [child] = await db.database
        .select({ precision: schema.children.dobPrecision })
        .from(schema.children)
        .where(eq(schema.children.id, f.childId));
      expect(child?.precision).toBe('derived');
    });

    it('a seat that may answer still stores it (control)', async () => {
      const { f } = await asked();
      const read = vi.fn(async () => ({
        said: 'March 21, 2021',
        date: '2021-03-21',
        otherPerson: false,
      }));
      const { planWriter } = writer();
      await runAuthorizedSignup(
        db.database,
        {
          familyId: f.familyId,
          parentUserId: f.parentUserId,
          body: 'born March 21, 2021',
          inboundChannelMessageId: await inbound(f, false, 'born March 21, 2021'),
          existingThread: true,
          now: NOW,
        },
        {
          planReader: { read: vi.fn(async (): Promise<PlanReading> => ({ verdict: 'unrelated' })) },
          planWriter,
          dobReader: { read },
          declineSeat: async () => false,
        },
      );
      expect(read).toHaveBeenCalledTimes(1);
      const [child] = await db.database
        .select({ precision: schema.children.dobPrecision })
        .from(schema.children)
        .where(eq(schema.children.id, f.childId));
      expect(child?.precision).toBe('exact');
    });

    it('a date whose parts could be swapped is not stored, and Hale asks again', async () => {
      const { f } = await asked();
      const read = vi.fn(async () => ({
        said: '03/04/2021',
        date: '2021-03-04',
        otherPerson: false,
      }));
      const turn = await yes(
        f,
        { verdict: 'unrelated' },
        { body: 'her birthday is 03/04/2021', dobReader: { read } },
      );
      expect(turn.result.outcome).toBe('plan_clarify');
      expect(turn.written.at(-1)?.question).toContain('date of birth');
      const [child] = await db.database
        .select({ precision: schema.children.dobPrecision })
        .from(schema.children)
        .where(eq(schema.children.id, f.childId));
      expect(child?.precision).toBe('derived');
    });
  });

  it('on a page with no course model, the class is bound by the offer name', async () => {
    const f = await household();
    const offerId = await askedAndSent(f, { page: '<html><body>Swim class</body></html>' });
    const turn = await yes(f, YES);
    expect(turn.result.outcome).toBe('plan_approved');
    const session = (await termsRow(offerId))?.approved?.sessions[0];
    if (!session) throw new Error('no bound session');
    expect(session.program).toEqual({ courseIds: [], name: 'Get Ready Public Speaking' });
    const cart = {
      provider_course_id: 'SW-881',
      session_label: 'Get Ready Public Speaking',
      session_date: '2026-03-28',
      session_time: '09:30',
      participant_first_name: 'Ada',
      line_count: 1,
      quantity: 1,
      totalCents: 8488,
      taxCents: 0,
      feesCents: 0,
      currency: 'cad',
    };
    const who = { childFirstName: 'Ada', siblingFirstNames: [], timeZone: 'America/Toronto' };
    expect(compareCart(session, cart, who, 'cart')).toEqual([]);
    expect(compareCart(session, { ...cart, session_label: 'Chess' }, who, 'cart')).toEqual([
      'session',
    ]);
  });

  describe('a season sign-up on a plan taken back', () => {
    const seasoned = async () => {
      vi.stubEnv('MAX_ENTITLEMENTS_ENABLED', 'true');
      vi.stubEnv('SIGNUP_HELP_SLOT_RELEASE_ENABLED', 'true');
      const f = await household();
      await db.database
        .update(schema.users)
        .set({ timezone: 'America/Toronto' })
        .where(eq(schema.users.id, f.parentUserId));
      const offerId = await askedAndSent(f);
      await yes(f, YES);
      return { f, offerId };
    };
    const attempted = async (f: Household) =>
      (
        await db.database
          .select({ attempted: schema.familySignupHelpSeasons.attempted })
          .from(schema.familySignupHelpSeasons)
          .where(eq(schema.familySignupHelpSeasons.familyId, f.familyId))
      )[0]?.attempted;
    const cancel = (f: Household, offerId: string) =>
      cancelSignupPlan(db.database, {
        offerId,
        familyId: f.familyId,
        actor: f.parentUserId,
        now: NOW,
      });

    it('comes back when the plan never started', async () => {
      const { f, offerId } = await seasoned();
      expect(await attempted(f)).toBe(1);
      expect(await cancel(f, offerId)).toBe('cancelled');
      expect((await offerRow(offerId)).status).toBe('handed_back');
      expect(await attempted(f)).toBe(0);
    });

    it('stays spent when a run of the plan reached the provider', async () => {
      const { f, offerId } = await seasoned();
      await parkSignupPlan(db.database, {
        offerId,
        familyId: f.familyId,
        availability: { kind: 'options_mismatch', choices: [], askedStart: 'Sat 9:30' },
        now: NOW,
      });
      expect(await cancel(f, offerId)).toBe('cancelled');
      expect(await attempted(f)).toBe(1);
    });

    it('stays spent while the release switch is off', async () => {
      const { f, offerId } = await seasoned();
      vi.stubEnv('SIGNUP_HELP_SLOT_RELEASE_ENABLED', '');
      expect(await cancel(f, offerId)).toBe('cancelled');
      expect(await attempted(f)).toBe(1);
    });
  });
});

describe('an ask with terms, after the flag goes off', () => {
  beforeEach(async () => {
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'handed_back' })
      .where(eq(schema.authorizedSignupOffers.status, 'planned'));
  });

  it('a yes binds its terms and holds, and the run carries them', async () => {
    const f = await household();
    await db.database
      .update(schema.children)
      .set({ dobPrecision: 'derived' })
      .where(eq(schema.children.id, f.childId));
    const offerId = await askedAndSent(f, { planOpensAt: new Date(NOW.getTime() - 60_000) });
    await recordPlanNotice(db.database, {
      familyId: f.familyId,
      offerId,
      providerHost: HOST,
      kind: 'ask_dob',
      now: NOW,
    });
    vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', '');
    const reader: DobReader = {
      read: vi.fn(async () => ({ said: null, date: null, otherPerson: false })),
    };
    const turn = await yes(f, YES, { dobReader: reader });
    expect(turn.result.outcome).toBe('plan_approved');
    const terms = await termsRow(offerId);
    expect(terms?.approved?.hold).toBe('age_unconfirmed');
    const { deps, inputs } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.binding?.approved.hold).toBe('age_unconfirmed');
  });

  it('with no terms row the ask is the one of today (positive control)', async () => {
    const f = await household();
    const offerId = await askedAndSent(f, { planOpensAt: new Date(NOW.getTime() + 60_000) });
    await db.database
      .delete(schema.authorizedSignupTerms)
      .where(eq(schema.authorizedSignupTerms.offerId, offerId));
    vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', '');
    const turn = await yes(f, YES);
    expect(turn.result.outcome).toBe('plan_approved');
    expect(await termsRow(offerId)).toBeNull();
    expect((await offerRow(offerId)).status).toBe('planned');
  });

  it('past its open it goes back, and never runs as a one-shot', async () => {
    const f = await household();
    const offerId = await askedAndSent(f, { planOpensAt: new Date(NOW.getTime() + 60_000) });
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ planOpensAt: new Date(NOW.getTime() - 60_000), planAlreadyOpen: false })
      .where(eq(schema.authorizedSignupOffers.id, offerId));
    vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', '');
    const offered = await offerRow(offerId);
    const browserUseSignup = {
      run: vi.fn(async () => {
        throw new Error('a one-shot run must not start on an ask with terms');
      }),
    };
    const consentReader: SignupConsentReader = {
      read: vi.fn(async () => ({
        verdict: 'consent' as const,
        sessionId: 's-1',
        approvedPriceCents: 8488,
        activityKey: activityKeyFor(offered.registrationUrl),
        said: 'yes',
      })),
    } as never;
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        body: 'yes',
        inboundChannelMessageId: await inbound(f, false),
        existingThread: true,
        now: NOW,
      },
      {
        consentReader,
        outcomeWriter: { write: async () => 'not this way, here is the link' },
        browserUseSignup: browserUseSignup as never,
        browser: null,
      },
    );
    expect(browserUseSignup.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: true, outcome: 'error' });
    expect((await offerRow(offerId)).status).toBe('handed_back');
  });

  it('a yes in a group still moves nothing', async () => {
    const f = await household();
    const offerId = await askedAndSent(f);
    vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', '');
    const turn = await yes(f, YES, { inGroup: true });
    expect(turn.result).toMatchObject({ claimed: false, outcome: 'asks_held_for_private' });
    expect(turn.planReader.read).not.toHaveBeenCalled();
    expect((await offerRow(offerId)).status).toBe('pending');
  });
});

describe('the run', () => {
  // A sweep claims across every family, so an earlier test's plan must not be due here.
  beforeEach(async () => {
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'handed_back' })
      .where(eq(schema.authorizedSignupOffers.status, 'planned'));
  });

  const approveAndClaimable = async (f: Household) => {
    const opensNow = new Date(NOW.getTime() - 60_000);
    const offerId = await askedAndSent(f, { planOpensAt: opensNow });
    await yes(f, YES);
    return offerId;
  };

  it('hands the approval to the engine', async () => {
    const f = await household();
    await approveAndClaimable(f);
    const { deps, inputs } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.binding?.approved.sessions[0]?.amount).toMatchObject({ cents: [8488] });
    expect(inputs[0]?.binding?.childFirstName).toBe('Ada');
    expect(inputs[0]?.binding?.timeZone).toBe('America/Toronto');
    expect(inputs[0]?.maxPriceCents).toBe(8488);
    // The receipt is armed only for a bound run while the flag is on.
    expect(typeof inputs[0]?.onConfirmed).toBe('function');
  });

  it('a confirmed run with no browser id is named: an audit row and an #ops page', async () => {
    const posted = stubOps();
    const f = await household();
    const offerId = await askedAndSent(f, { planOpensAt: new Date(NOW.getTime() - 60_000) });
    await yes(f, YES);
    const confirmed: BrowserUsePlanResult = {
      ...RUN_RESULT,
      outcome: 'completed',
      detail: 'none',
      cartDifferences: undefined,
      confirmationNumber: 'R-55120',
      amountChargedCents: 8488,
      charged: { cents: 8488 },
      browserId: null,
      liveViewUrl: null,
      holdExpiresAt: null,
    };
    const { deps, notices } = sweepDeps(confirmed);
    (deps.runner as NonNullable<PlanRunDeps['runner']>).run = vi.fn(
      async (input: BrowserUsePlanInput) => {
        await input.onConfirmed?.({
          browserId: null,
          confirmationNumber: 'R-55120',
          amountChargedCents: 8488,
          choiceIndex: 0,
          waitUntil: input.waitUntil,
          getCdpUrl: async () => null,
        });
        return confirmed;
      },
    );
    await sweep(deps, NOW);
    expect(notices[0]?.receipt).toEqual({ ok: false, reason: 'no_browser' });
    const rows = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, offerId));
    expect(rows.map((row) => row.after)).toContainEqual(
      expect.objectContaining({ step: 'plan_receipt', ok: false, reason: 'no_browser' }),
    );
    const text = posted.join(' ');
    expect(text).toContain('registration_receipt_unsent');
    expect(text).toContain('no_browser');
    expect((await offerRow(offerId)).status).toBe('completed');
  });

  it('keeps enforcing an approved plan after the flag goes off', async () => {
    const f = await household();
    await approveAndClaimable(f);
    vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', '');
    const { deps, inputs } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    expect(inputs[0]?.binding?.approved.sessions[0]?.amount).toMatchObject({ cents: [8488] });
    // The checks outlive the flag. The receipt does not.
    expect(inputs[0]?.onConfirmed).toBeUndefined();
  });

  it('after an abort the offer is handed back and the next two sweeps claim nothing', async () => {
    const f = await household();
    const offerId = await approveAndClaimable(f);
    const { deps, inputs, notices } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    expect((await offerRow(offerId)).status).toBe('handed_back');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ detail: 'cart_mismatch', charged: 'nothing' });
    expect(notices[0]?.cartDifferences).toEqual(['price']);
    await sweep(deps, new Date(NOW.getTime() + 2 * 60_000));
    await sweep(deps, new Date(NOW.getTime() + 3 * 60_000));
    expect(inputs).toHaveLength(1);
  });

  it('a retry is a new offer with a new yes, and its notice goes out', async () => {
    const f = await household();
    const first = await approveAndClaimable(f);
    const { deps, notices } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    const second = await askedAndSent(f, { planOpensAt: new Date(NOW.getTime() - 30_000) });
    expect(second).not.toBe(first);
    await yes(f, YES, { now: new Date(NOW.getTime() + 90_000) });
    await sweep(deps, new Date(NOW.getTime() + 2 * 60_000));
    expect(notices.map((notice) => notice.offerId)).toEqual([first, second]);
  });

  it('a plan with no terms row hands back and pages while the flag is on', async () => {
    const posted = stubOps();
    const f = await household();
    const offerId = await approveAndClaimable(f);
    await db.database
      .delete(schema.authorizedSignupTerms)
      .where(eq(schema.authorizedSignupTerms.offerId, offerId));
    const { deps, inputs, notices } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    expect(inputs).toHaveLength(0);
    expect((await offerRow(offerId)).status).toBe('handed_back');
    expect(notices[0]).toMatchObject({ detail: 'terms_unreadable', charged: 'nothing' });
    expect(posted.join(' ')).toContain('registration_terms_unreadable');
  });

  it('a running plan the parent took back hears nothing, even with no terms row', async () => {
    const posted = stubOps();
    const f = await household();
    const offerId = await approveAndClaimable(f);
    await db.database
      .delete(schema.authorizedSignupTerms)
      .where(eq(schema.authorizedSignupTerms.offerId, offerId));
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({
        status: 'submitting',
        planResume: { phase: 'signup', runId: 'run-1', sessionId: null, browserId: null },
        planLeaseUntil: null,
        planCancelRequestedAt: NOW,
      })
      .where(eq(schema.authorizedSignupOffers.id, offerId));
    const { deps, inputs, notices } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    expect(inputs).toHaveLength(0);
    expect(notices).toEqual([]);
    expect(posted.join(' ')).not.toContain('registration_terms_unreadable');
    expect((await offerRow(offerId)).status).toBe('handed_back');
  });

  it('with the flag off, a plan with no terms row runs as it does today', async () => {
    const f = await household();
    const offerId = await approveAndClaimable(f);
    await db.database
      .delete(schema.authorizedSignupTerms)
      .where(eq(schema.authorizedSignupTerms.offerId, offerId));
    vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', '');
    const { deps, inputs } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.binding).toBeNull();
  });

  it('an unreadable approval hands back, whatever the flag says', async () => {
    const f = await household();
    const offerId = await approveAndClaimable(f);
    await db.database
      .update(schema.authorizedSignupTerms)
      .set({ approved: { v: 1, sessions: 'garbage' } as never })
      .where(eq(schema.authorizedSignupTerms.offerId, offerId));
    vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', '');
    const { deps, inputs, notices } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    expect(inputs).toHaveLength(0);
    expect(notices[0]).toMatchObject({ detail: 'terms_unreadable' });
  });

  it('a class free for residents and paid for others reaches the run on its yes', async () => {
    const f = await household();
    const offerId = await askedAndSent(f, { planOpensAt: new Date(NOW.getTime() - 60_000) });
    const row = await termsRow(offerId);
    if (!row) throw new Error('no terms');
    await db.database
      .update(schema.authorizedSignupTerms)
      .set({
        shown: {
          ...row.shown,
          residency: 'unknown',
          sessions: [
            {
              sessionId: 's-1',
              rates: [
                { rate: 'resident', cents: 0 },
                { rate: 'non_resident', cents: 4000 },
              ],
              tax: 'included',
              source: 'course_model',
            },
          ],
        },
      })
      .where(eq(schema.authorizedSignupTerms.offerId, offerId));
    const turn = await yes(f, { ...YES, maxPriceCents: 4000 });
    expect(turn.result.outcome).toBe('plan_approved');
    const { deps, inputs, notices } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.binding?.approved.sessions[0]?.amount).toMatchObject({ cents: [0, 4000] });
    expect(inputs[0]?.maxPriceCents).toBe(4000);
    expect(notices[0]?.detail).toBe('cart_mismatch');
  });

  it('gives a season slot back when no run reached the provider', async () => {
    vi.stubEnv('MAX_ENTITLEMENTS_ENABLED', 'true');
    const f = await household();
    await db.database
      .update(schema.users)
      .set({ timezone: 'America/Toronto' })
      .where(eq(schema.users.id, f.parentUserId));
    vi.stubEnv('SIGNUP_HELP_SLOT_RELEASE_ENABLED', 'true');
    const offerId = await askedAndSent(f, { planOpensAt: null });
    await yes(f, YES);
    const seasonRow = () =>
      db.database
        .select({ attempted: schema.familySignupHelpSeasons.attempted })
        .from(schema.familySignupHelpSeasons)
        .where(eq(schema.familySignupHelpSeasons.familyId, f.familyId));
    expect((await seasonRow())[0]?.attempted).toBe(1);
    // The saved login went away, so the run ends before it reaches the provider.
    await db.database
      .delete(schema.providerSignupSessions)
      .where(eq(schema.providerSignupSessions.familyId, f.familyId));
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ planOpensAt: new Date(NOW.getTime() - 1000) })
      .where(eq(schema.authorizedSignupOffers.id, offerId));
    const { deps, inputs } = sweepDeps();
    await sweep(deps, new Date(NOW.getTime() + 60_000));
    expect(inputs).toHaveLength(0);
    expect((await seasonRow())[0]?.attempted).toBe(0);
  });
});

describe('a pick after the options did not match', () => {
  const CHOICES = [
    {
      id: 'opt-1',
      label: 'Public Speaking Sunday',
      starts_at: '2026-03-29T10:00:00',
      price_cents: 8488,
      waitlist: false,
      billing_note: null,
      provider_email: 'desk@example-rec.test',
    },
  ];

  const parked = async (f: Household) => {
    const offerId = await askedAndSent(f, { planOpensAt: new Date(NOW.getTime() - 60_000) });
    await yes(f, YES);
    await parkSignupPlan(db.database, {
      offerId,
      familyId: f.familyId,
      availability: { kind: 'options_mismatch', choices: CHOICES, askedStart: 'Sat 9:30' },
      now: NOW,
    });
    return offerId;
  };

  it('a pick is a new ask that needs a new yes, and holds at checkout', async () => {
    const f = await household();
    const oldOffer = await parked(f);
    const mismatchReader: MismatchReader = {
      read: vi.fn(async () => ({ verdict: 'option' as const, choiceId: 'opt-1' })),
    };
    const pick = await yes(f, YES, { body: 'Sunday works', mismatchReader });
    const askFacts = pick.written.at(-1);
    if (!askFacts) throw new Error('nothing was written');
    const askSeen = JSON.parse(planReplyUserMessage(askFacts, null)).facts;
    expect(askSeen.sessions[0]).not.toHaveProperty('label');
    expect(askSeen.sessions[0].untrusted_label).toBe('Public Speaking Sunday');
    expect((await offerRow(oldOffer)).status).toBe('handed_back');
    expect(pick.written.at(-1)?.moment).toBe('offer');
    const offers = await db.database
      .select()
      .from(schema.authorizedSignupOffers)
      .where(
        and(
          eq(schema.authorizedSignupOffers.familyId, f.familyId),
          eq(schema.authorizedSignupOffers.status, 'pending'),
        ),
      );
    expect(offers).toHaveLength(1);
    const next = offers[0];
    if (!next) throw new Error('no new offer');
    expect(next.planAlreadyOpen).toBe(true);
    expect(next.sessions[0]).toMatchObject({
      label: 'Public Speaking Sunday',
      startsAt: '2026-03-29T10:00:00',
      priceCents: 8488,
    });
    const terms = await termsRow(next.id);
    expect(terms?.shown.read).toBe('unread');
    expect(terms?.shown.sessions[0]).toMatchObject({
      source: 'site_option',
      rates: [{ rate: 'flat', cents: 8488 }],
    });
    // Its own send, its own yes: until then it binds nothing.
    const kept = await pick.result.stamp?.();
    await kept?.(await sentSignupText(db.database, f));
    const sessionId = next.sessions[0]?.id as string;
    await yes(f, { ...YES, choiceIds: [sessionId] });
    expect((await termsRow(next.id))?.approved?.hold).toBe('site_option');
    expect((await offerRow(next.id)).status).toBe('planned');
  });

  it('a plan parked on options, whose question cannot be written, pages #ops', async () => {
    const posted = stubOps();
    const f = await household();
    const offerId = await askedAndSent(f, { planOpensAt: new Date(NOW.getTime() - 60_000) });
    await yes(f, YES);
    const mismatch: BrowserUsePlanResult = {
      ...RUN_RESULT,
      outcome: 'options_mismatch' as never,
      detail: 'none',
      cartDifferences: undefined,
      siteChoices: CHOICES,
    } as BrowserUsePlanResult;
    const { deps } = sweepDeps(mismatch);
    const delivered = vi.fn(async () => 'sent' as const);
    deps.prep = {
      writer: { write: vi.fn(async () => null) },
      deliver: delivered,
    } as unknown as PlanRunDeps['prep'];
    await sweep(deps, NOW);
    const row = await offerRow(offerId);
    expect(row.status).toBe('planned');
    expect(delivered).not.toHaveBeenCalled();
    expect(posted.join(' ')).toContain('registration_text_unwritten');
  });

  it('an option with no start gets the refusal and the link', async () => {
    const f = await household();
    const oldOffer = await parked(f);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({
        planAvailability: {
          kind: 'options_mismatch',
          choices: [{ ...CHOICES[0], starts_at: null }],
          askedStart: 'Sat 9:30',
        },
      })
      .where(eq(schema.authorizedSignupOffers.id, oldOffer));
    const mismatchReader: MismatchReader = {
      read: vi.fn(async () => ({ verdict: 'option' as const, choiceId: 'opt-1' })),
    };
    const pick = await yes(f, YES, { body: 'Sunday', mismatchReader });
    expect(pick.written.at(-1)?.moment).toBe('refused');
    expect(pick.result.reply).toContain(URL_);
    expect(await offerCount(f)).toBe(1);
  });

  it('asking Hale to email the provider sends nothing', async () => {
    const f = await household();
    const offerId = await parked(f);
    const send = vi.fn(async () => undefined);
    const mismatchReader: MismatchReader = {
      read: vi.fn(async () => ({ verdict: 'email' as const })),
    };
    const turn = await yes(f, YES, {
      body: 'email them',
      mismatchReader,
      sendProviderEmail: send,
    });
    expect(send).not.toHaveBeenCalled();
    expect(turn.result.claimed).toBe(true);
    expect((await offerRow(offerId)).status).toBe('planned');
    const facts = turn.written.at(-1);
    if (!facts) throw new Error('nothing was written');
    expect(facts.question).not.toContain('Public Speaking Sunday');
    const seen = JSON.parse(planReplyUserMessage(facts, null)).facts;
    expect(seen.untrusted_site_options).toContain('Public Speaking Sunday');
  });
});

describe('a class whose page states no price', () => {
  const LIVE = 'https://live.browser-use.com/s/fixture-live-view-token';
  const CHECKOUT = {
    outcome: 'reached_checkout',
    detail: 'none',
    choice_index: 0,
    checkout_url: `https://${HOST}/Checkout`,
    cart_total_cents: 12300,
    cart_currency: 'cad',
    hold_minutes: 5,
    saved_card_on_file: true,
    security_code_required: false,
    payment_details_entered: false,
    cart_read: {
      provider_course_id: null,
      session_label: 'Get Ready Public Speaking',
      session_date: '2026-03-28',
      session_time: '09:30',
      participant_first_name: 'Ada',
      line_count: 1,
      quantity: 1,
    },
  };

  // The stipulated model output takes the worst read: an approval carrying their figure.
  const approvesWith = (maxPriceCents: number | null): PlanReader => ({
    read: vi.fn(async ({ text, offer }) =>
      toPlanReading(
        {
          reason: 'r',
          said: text,
          named: null,
          verdict: 'approve',
          choiceIds: ['s-1'],
          maxPriceCents,
          waiverSaid: null,
          waiverAccepted: false,
          question: null,
          prerequisiteSaid: null,
          prerequisiteMet: null,
        },
        offer,
        text,
      ),
    ),
  });

  /** The real engine over a fake Browser Use. It records every run it was asked to create. */
  function realEngine(plan: Record<string, unknown>) {
    const created: string[] = [];
    const stopped: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const method = init.method ?? 'GET';
      const path = `${parsed.pathname.replace('/api/v4', '')}${parsed.search}`;
      if (method === 'POST' && path === '/runs') {
        created.push(String(JSON.parse(String(init.body)).task).split('\n')[0] ?? '');
        return Response.json({ id: 'run-1', sessionId: 'bu-session-1' });
      }
      if (path === '/runs/run-1/status') return Response.json({ status: 'completed' });
      if (path.startsWith('/runs/run-1/events')) {
        return Response.json({
          events: [
            {
              id: 1,
              type: 'browser.ready',
              data: { live_view_url: LIVE, browser_session_id: 'browser-1' },
            },
          ],
          nextAfter: null,
        });
      }
      if (path === '/runs/run-1') {
        return Response.json({
          id: 'run-1',
          status: 'completed',
          sessionId: 'bu-session-1',
          output: plan,
          error: null,
          totalCostUsd: '0.0100',
        });
      }
      if (method === 'PATCH' && path.startsWith('/browsers/')) {
        stopped.push(path);
        return Response.json({});
      }
      if (path === '/sessions/bu-session-1/cost') {
        return Response.json({ sessionId: 'bu-session-1', totalCostUsd: '0.020000' });
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    const engine = {
      api: browserUseApi({ apiKey: 'test-key', fetch: fetchImpl as never }),
      seeder: null,
      loadTask: async (skill: string) => `# skill ${skill}`,
      sleep: async () => undefined,
      now: () => NOW,
    };
    const notices: PlanOutcomeNotice[] = [];
    const deps: PlanRunDeps = {
      runner: {
        run: (input) =>
          runBrowserUsePlanForMode(
            {
              ...input,
              providerSession: { ...input.providerSession, browserUseProfileId: 'p-1' },
            } as BrowserUsePlanInput,
            engine,
          ),
        release: vi.fn(async () => null),
        settlePayment: vi.fn(),
      },
      notifyParent: vi.fn(async (notice: PlanOutcomeNotice) => {
        notices.push(notice);
        return 'sent' as const;
      }),
    };
    return { deps, created, stopped, notices };
  }

  // A sweep claims across every family, and earlier runs' costs count against the shared reserve.
  beforeEach(async () => {
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'handed_back' })
      .where(eq(schema.authorizedSignupOffers.status, 'planned'));
    await db.database.update(schema.authorizedSignupOffers).set({ browserUseCostUsd: null });
  });

  /** The page read gave the age rule and no rate. */
  const askedUnpriced = async (f: Household, options: Parameters<typeof ask>[1] = {}) => {
    const offerId = await askedAndSent(f, options);
    const row = await termsRow(offerId);
    if (!row) throw new Error('no terms');
    await db.database
      .update(schema.authorizedSignupTerms)
      .set({
        shown: {
          ...row.shown,
          sessions: [{ sessionId: 's-1', rates: [], tax: 'unknown', source: 'offer' }],
        },
      })
      .where(eq(schema.authorizedSignupTerms.offerId, offerId));
    return offerId;
  };

  it.each([
    ['yes', null, CHECKOUT],
    ['yes up to $150', 15000, CHECKOUT],
    ['yes up to ¥5000', 500000, CHECKOUT],
    ['500元', 50000, CHECKOUT],
    ['up to one fifty', 15000, CHECKOUT],
    ['yes', null, { ...CHECKOUT, cart_total_cents: 0, cart_currency: null }],
  ])('case %# binds the same hold, and the run stops at checkout', async (body, figure, plan) => {
    vi.stubEnv('BROWSER_USE_SIGNUP_PAYMENT_ENABLED', 'true');
    vi.stubEnv('REGISTRATION_FREE_CHECKOUT_ENABLED', 'true');
    const posted = stubOps();
    const f = await household();
    vi.stubEnv('REGISTRATION_FREE_CHECKOUT_FAMILIES', f.familyId);
    const offerId = await askedUnpriced(f, { planOpensAt: new Date(NOW.getTime() - 60_000) });

    const turn = await yes(f, YES, { body, reader: approvesWith(figure) });
    expect(turn.result.outcome).toBe('plan_approved');
    const row = await termsRow(offerId);
    expect(row?.approved).toMatchObject({ hold: 'price_unstated', maxCents: 0 });
    expect(row?.approved?.sessions[0]?.amount).toEqual({ kind: 'unstated' });
    const offer = await offerRow(offerId);
    expect(offer.status).toBe('planned');
    expect(offer.planMaxPriceCents).toBe(0);
    const ack = turn.written.at(-1);
    expect(ack?.moment).toBe('approved');
    expect(ack?.maxPriceCents).toBeNull();
    expect(ack?.terms?.hold).toBe('price_unstated');

    const engine = realEngine(plan);
    await sweep(engine.deps, new Date(NOW.getTime() + 60_000));
    expect(engine.created).toEqual(['# skill browser-use-plan-signup']);
    expect(engine.stopped).toEqual([]);
    const notice = engine.notices[0];
    expect(notice).toMatchObject({
      outcome: 'needs_human',
      detail: 'price_unstated',
      charged: 'nothing',
      liveViewUrl: LIVE,
    });

    const written: PlanReplyFacts[] = [];
    const notify = createPlanNotifier(db.database, {
      writer: {
        write: async (facts) => {
          written.push(facts);
          return null;
        },
      },
      transport: { send: vi.fn() },
      now: () => NOW,
    });
    if (!notice) throw new Error('no notice');
    await notify(notice);
    expect(written[0]?.run).toMatchObject({ detail: 'price_unstated', charged: 'nothing' });
    expect(written[0]?.maxPriceCents).toBeNull();
    expect(written[0]?.terms?.unread).toContain('price');
    expect(written[0]?.terms?.free).toBe(false);
    expect(posted.join(' ')).toContain('registration_text_unwritten');
  });

  it('a later text about a held plan states no maximum', async () => {
    const f = await household();
    await askedUnpriced(f);
    await yes(f, YES, { body: 'yes', reader: approvesWith(null) });
    const later = await yes(
      f,
      { verdict: 'unclear', question: 'Should Hale take this plan back?', named: null },
      { body: 'can it be the sunday one instead' },
    );
    expect(later.written.at(-1)?.moment).toBe('clarify');
    expect(later.written.at(-1)?.maxPriceCents).toBeNull();
  });

  describe('a figure the coach passed for the class', () => {
    const COACH_SESSIONS = SESSIONS.map((session) => ({ ...session, priceCents: 15000 }));
    // Both rows' printed figures stop parsing, so the course model yields no rate.
    const NO_READABLE_PRICE = PAGE.replaceAll(
      '"DisplayAmount":"$84.88"',
      '"DisplayAmount":"Varies"',
    ).replaceAll('"DisplayAmount":"$97.60"', '"DisplayAmount":"Varies"');

    it('on a page with no readable price is never stated, bound or paid', async () => {
      vi.stubEnv('BROWSER_USE_SIGNUP_PAYMENT_ENABLED', 'true');
      stubOps();
      const f = await household();
      const asked = writer();
      const offerId = await askedAndSent(f, {
        page: NO_READABLE_PRICE,
        sessions: COACH_SESSIONS,
        approvedPriceCents: 15000,
        evidence: 'sign Ada up, I can do up to $150',
        planOpensAt: new Date(NOW.getTime() - 60_000),
        writer: asked.planWriter,
      });

      const shown = (await termsRow(offerId))?.shown;
      expect(shown?.read).toBe('course_model');
      expect(shown?.age.fit).toBe('in_band');
      expect(shown?.sessions).toEqual([
        { sessionId: 's-1', rates: [], tax: 'unknown', source: 'offer' },
      ]);
      const stored = await offerRow(offerId);
      expect(stored.sessions[0]?.priceCents).toBeNull();
      expect(stored.approvedPriceCents).toBeNull();
      const offerFacts = asked.written[0];
      expect(offerFacts?.sessions[0]?.priceCents).toBeNull();
      expect(offerFacts?.maxPriceCents).toBeNull();
      expect(offerFacts?.terms?.rates).toEqual([]);
      expect(offerFacts?.terms?.unread).toContain('price');

      await yes(f, YES, { reader: approvesWith(null) });
      const approved = (await termsRow(offerId))?.approved;
      expect(approved).toMatchObject({ hold: 'price_unstated', maxCents: 0 });
      expect(approved?.sessions[0]?.amount).toEqual({ kind: 'unstated' });

      const engine = realEngine({ ...CHECKOUT, cart_total_cents: 15000 });
      await sweep(engine.deps, new Date(NOW.getTime() + 60_000));
      expect(engine.created).toEqual(['# skill browser-use-plan-signup']);
      expect(engine.notices[0]).toMatchObject({
        outcome: 'needs_human',
        detail: 'price_unstated',
        charged: 'nothing',
      });
    });

    it('on a page with a price, the page is what is stated and bound (control)', async () => {
      const f = await household();
      const asked = writer();
      const offerId = await askedAndSent(f, {
        sessions: COACH_SESSIONS,
        approvedPriceCents: 15000,
        writer: asked.planWriter,
      });
      const offerFacts = asked.written[0];
      expect(offerFacts?.terms?.rates.map((row) => row.cents)).toEqual([8488]);
      expect(offerFacts?.sessions[0]?.priceCents).toBeNull();
      expect(offerFacts?.maxPriceCents).toBeNull();
      await yes(f, YES);
      expect((await termsRow(offerId))?.approved).toMatchObject({ hold: null, maxCents: 8488 });
    });
  });

  it('a priced class on the same path binds its price with no hold (control)', async () => {
    const f = await household();
    const offerId = await askedAndSent(f);
    await yes(f, YES);
    expect((await termsRow(offerId))?.approved).toMatchObject({ hold: null, maxCents: 8488 });
  });
});
