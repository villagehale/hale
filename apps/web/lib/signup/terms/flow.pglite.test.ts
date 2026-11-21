import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import type {
  BrowserUsePlanCheckpoint,
  BrowserUsePlanInput,
  BrowserUsePlanResult,
} from '../browser-use/plan-engine';
import { storeProviderSession } from '../browser-use/vault';
import type { SignupConsentReader } from '../consent-reader';
import { AUTHORIZED_SIGNUP_ENABLED_ENV } from '../flag';
import { offerSignupFromFacts } from '../offer-from-facts';
import { offerSignupTool } from '../offer-tool';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from '../plan/flag';
import type { MismatchReader } from '../plan/mismatch-reader';
import { createPlanNotifier } from '../plan/notice';
import { recordPlanNotice } from '../plan/prep';
import type { PlanReader, PlanReading } from '../plan/reader';
import { type PlanOutcomeNotice, type PlanRunDeps, runDueSignupPlans } from '../plan/run';
import { parkSignupPlan } from '../plan/store';
import type { PlanReplyFacts, PlanReplyWriter } from '../plan/writer';
import { runAuthorizedSignup } from '../run';
import { sentSignupText } from '../sent-text.fixture';
import { recordSignupOffer } from '../store';
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
  limitWrittenCents: null,
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
        evidence: 'sign Ada up',
        registrationUrl: URL_,
        sessions: SESSIONS,
        approvedPriceCents: null,
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
    dobReader?: DobReader;
    mismatchReader?: MismatchReader;
    sendProviderEmail?: (input: { to: string; subject: string; body: string }) => Promise<void>;
  } = {},
) {
  const planReader: PlanReader = { read: vi.fn(async () => reading) };
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
      limitCents: null,
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
      read: vi.fn(async () => ({ said: 'March 21, 2021', date: '2021-03-21' })),
    };
    await yes(f, { verdict: 'unrelated' }, { body: 'she is five', dobReader: notTheirs });
    const before = await db.database
      .select({ precision: schema.children.dobPrecision })
      .from(schema.children)
      .where(eq(schema.children.id, f.childId));
    expect(before[0]?.precision).toBe('derived');

    const theirs: DobReader = {
      read: vi.fn(async () => ({ said: 'March 21, 2021', date: '2021-03-21' })),
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
      read: vi.fn(async () => ({ said: 'June 1, 2016', date: '2016-06-01' })),
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
    const reader: DobReader = { read: vi.fn(async () => ({ said: null, date: null })) };
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
  });
});
