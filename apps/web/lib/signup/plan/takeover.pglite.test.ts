import { schema } from '@hale/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { browserUseApi } from '../browser-use/client';
import type { BrowserUseEngineDeps } from '../browser-use/engine';
import { BROWSER_USE_SIGNUP_PAYMENT_ENABLED_ENV } from '../browser-use/flag';
import {
  type BrowserUsePlanCheckpoint,
  type BrowserUsePlanInput,
  type BrowserUsePlanResult,
  type PlanResumeToken,
  releasePlanRun,
  runBrowserUsePlanSignup,
  settleBrowserUsePlanPayment,
} from '../browser-use/plan-engine';
import { storeProviderSession } from '../browser-use/vault';
import {
  PLAN_CITY_LOGIN_OWNER_ENABLED_ENV,
  PROVIDER_CREDENTIALS_ENABLED_ENV,
} from '../credentials/flag';
import { PROVIDER_CREDENTIALS_MASTER_KEY_ENV } from '../credentials/kms';
import { deleteProviderCredentials, saveProviderCredentials } from '../credentials/store';
import { hashLoginCode } from '../login-link/code';
import { lookupLoginLink, mintFreshLoginLink } from '../login-link/store';
import { recordSignupOffer } from '../store';
import { TAKEOVER_LINK_ENABLED_ENV } from '../takeover/flag';
import {
  type TakeoverToken,
  finishTakeover,
  lapseTakeover,
  takeoverLiveView,
} from '../takeover/store';
import type { PlanNoticePart } from './bubbles';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import type { PlanPrepFacts } from './prep';
import {
  PLAN_RUN_ALLOWANCE_USD,
  type PlanOutcomeNotice,
  type PlanRunDeps,
  runDueSignupPlans,
} from './run';
import {
  approveSignupPlan,
  cancelSignupPlan,
  freeLapsedParkedPlans,
  requestStopForRunningPlans,
} from './store';

// VIL-718 · the takeover link on the plan lane, over the real DDL. The Browser Use engine is
// its own tested unit (plan-engine.takeover.test.ts); here a stand-in runner returns the stops
// the engine returns, and stand-in writers return drafts (the words are the eval's job).
// Invented hosts and details only.
const OPENS = new Date('2026-12-01T12:00:00.000Z');
const NOW = new Date('2026-12-01T12:01:00.000Z');
const HOST = 'register.example-rec.test';
const URL_ = `https://${HOST}/Clients/BookMe4LandingPages/CoursesLandingPage`;
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
];

let db: TestDb;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  // One database for the file: each test's sweep sees only the plan that test set up.
  await db.database
    .update(schema.authorizedSignupOffers)
    .set({ status: 'handed_back' })
    .where(inArray(schema.authorizedSignupOffers.status, ['planned', 'submitting']));
  // The registration reserve sums every offer's hold: earlier tests' holds never settle here.
  await db.database.update(schema.authorizedSignupOffers).set({ browserUseCostUsd: null });
  vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, 'true');
  vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, 'true');
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const OPS_WEBHOOK = 'https://hooks.slack.test/ops-fixture';

function stubOpsSlack(): string[] {
  const posted: string[] = [];
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', OPS_WEBHOOK);
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === OPS_WEBHOOK) posted.push(JSON.parse(init?.body ?? '{}').text);
    return new Response('ok', { status: 200 });
  });
  return posted;
}

/** A family whose day-before plan is due now, with an enrolled phone and a saved session. */
async function plannedFamily() {
  const seeded = await seedFamily(db.database);
  seq += 1;
  const phone = `+1202555${String(300 + seq).padStart(4, '0')}`;
  await db.database.insert(schema.parentChannels).values({
    userId: seeded.parentUserId,
    familyId: seeded.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
  });
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
  const offer = await recordSignupOffer(db.database, {
    familyId: seeded.familyId,
    childId,
    parentUserId: seeded.parentUserId,
    activityKey: 'swim-preschool',
    registrationUrl: URL_,
    sessions: SESSIONS,
    approvedPriceCents: null,
    now: new Date(NOW.getTime() - 24 * 60 * 60_000),
  });
  if (!offer.ok) throw new Error(offer.reason);
  expect(
    await approveSignupPlan(db.database, {
      offerId: offer.id,
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      messageId: `msg-takeover-${seq}`,
      choiceIds: ['sat-0900'],
      maxPriceCents: 10000,
      opensAt: OPENS,
      waiverAccepted: true,
      now: new Date(NOW.getTime() - 20 * 60 * 60_000),
    }),
  ).toEqual({ ok: true });
  const stored = await storeProviderSession(db.database, {
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    providerHost: HOST,
    storageState: { cookies: [{ name: 'SID', value: 'c', domain: `.${HOST}` }] },
    capturedAt: new Date(NOW.getTime() - 60 * 60_000),
  });
  expect(stored.ok).toBe(true);
  return { ...seeded, offerId: offer.id };
}

/** What the engine returns for a stop it kept the browser for (takeover on). */
function stopAt(
  outcome: BrowserUsePlanResult['outcome'],
  detail: BrowserUsePlanResult['detail'],
  at: Date = NOW,
  runId = 'run-1',
): BrowserUsePlanResult {
  return {
    outcome,
    detail,
    choiceIndex: null,
    liveViewUrl: LIVE,
    checkoutUrl: null,
    holdExpiresAt: new Date(at.getTime() + 900 * 1000),
    cartTotalCents: null,
    confirmationNumber: null,
    opensAt: null,
    amountChargedCents: null,
    runId,
    sessionId: 'bu-session-1',
    costUsd: '0.0400',
    sessionCostUsd: null,
    browserId: 'browser-1',
    charged: 'nothing',
  };
}

const PAID: BrowserUsePlanResult = {
  ...stopAt('completed', 'none'),
  choiceIndex: 0,
  liveViewUrl: null,
  holdExpiresAt: null,
  cartTotalCents: 9800,
  confirmationNumber: 'R-55120',
  amountChargedCents: 9800,
  runId: 'run-q1',
  sessionCostUsd: '0.120000',
  charged: { cents: 9800 },
};

/** A runner that returns each result in turn and records what it was asked. */
function runnerReturning(...results: Array<BrowserUsePlanResult | BrowserUsePlanCheckpoint>) {
  const inputs: BrowserUsePlanInput[] = [];
  const released: PlanResumeToken[] = [];
  const runner = {
    run: vi.fn(async (input: BrowserUsePlanInput) => {
      inputs.push(input);
      const next = results.shift();
      if (!next) throw new Error('no more runs scripted');
      return next;
    }),
    release: vi.fn(async (resume: PlanResumeToken) => {
      released.push(resume);
      return '0.150000';
    }),
    settlePayment: vi.fn(async () => {
      throw new Error('no payment under way');
    }),
  };
  return { runner, inputs, released };
}

/** Stand-in writer and door for the takeover texts: they record what they were given. */
function takeoverDoor(
  options: {
    unwritten?: boolean;
    delivery?: 'sent' | 'failed' | 'withheld' | 'throws';
    /** When the text goes: the moment the run stopped, not when the sweep began. */
    now?: Date;
    /** What lands while the model is writing: the write is the slow part of an offer. */
    duringWrite?: () => Promise<void>;
  } = {},
) {
  const facts: PlanPrepFacts[] = [];
  const parts: PlanNoticePart[][] = [];
  return {
    facts,
    parts,
    deps: {
      writer: {
        write: async (input: PlanPrepFacts) => {
          facts.push(input);
          await options.duringWrite?.();
          if (options.unwritten) return null;
          return {
            bubbles: [`bubble for ${input.kind}`, 'second bubble'],
            card: input.loginCard
              ? { title: `Check on ${HOST}`, description: 'Swim Sat 9:00' }
              : null,
          };
        },
      },
      deliver: async (input: { parts: readonly PlanNoticePart[] }) => {
        parts.push([...input.parts]);
        if (options.delivery === 'throws') throw new Error('the door threw');
        return options.delivery ?? ('sent' as const);
      },
      now: () => options.now ?? NOW,
    },
  };
}

function sweepDeps(
  runner: ReturnType<typeof runnerReturning>['runner'],
  takeover = takeoverDoor(),
) {
  const notices: PlanOutcomeNotice[] = [];
  const deps: PlanRunDeps = {
    runner,
    autoHosts: [HOST],
    notifyParent: async (notice) => {
      notices.push(notice);
      return 'sent';
    },
    takeover: takeover.deps,
  };
  return { deps, notices, takeover };
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

async function linkRows(familyId: string) {
  return db.database
    .select()
    .from(schema.providerLoginLinks)
    .where(eq(schema.providerLoginLinks.familyId, familyId));
}

/** The code inside the card the door sent. */
function sentCode(parts: readonly PlanNoticePart[]): string {
  const link = parts.find((part) => part.type === 'link');
  if (link?.type !== 'link') throw new Error('no card went');
  const code = /\/l\/([0-9A-Za-z]{10})$/.exec(link.url)?.[1];
  if (!code) throw new Error(`not a card url: ${link.url}`);
  return code;
}

/** Runs the first sweep to a parked captcha takeover and hands back what the test needs. */
async function parkedCaptcha() {
  const family = await plannedFamily();
  const { runner, inputs, released } = runnerReturning(stopAt('needs_human', 'captcha'));
  const swept = sweepDeps(runner);
  const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);
  const sent = swept.takeover.parts[0] ?? [];
  return { family, result, runner, inputs, released, swept, sent, code: sentCode(sent) };
}

/** The same, parked on a code the site sent. */
async function parkedCode() {
  const family = await plannedFamily();
  const { runner } = runnerReturning(stopAt('needs_human', 'verification_code'));
  const swept = sweepDeps(runner);
  await runDueSignupPlans(db.database, { now: NOW }, swept.deps);
  return { family, code: sentCode(swept.takeover.parts[0] ?? []) };
}

describe('VIL-718 · a stop only the parent can do, on the plan lane', () => {
  it('parks the plan, sends one model-written text with one takeover card, and keeps the browser', async () => {
    const { family, result, inputs, released, swept, sent, code } = await parkedCaptcha();

    expect(result.plans.find((p) => p.offerId === family.offerId)).toEqual({
      offerId: family.offerId,
      outcome: 'checkpointed',
      phase: 'takeover',
    });
    // The run was told the link is on, and its allowance covers every turn after a parent's
    // step: the three takeovers a plan may ask for, at $2 a turn.
    expect(inputs[0]?.takeover).toBe(true);
    expect(inputs[0]?.takeoverResume).toBeNull();
    expect((await offerRow(family.offerId))?.browserUseCostUsd).toBe(
      (PLAN_RUN_ALLOWANCE_USD + 3 * 2).toFixed(6),
    );
    // The model's bubbles, the one Hale card after the first, never the live view itself.
    expect(sent.map((part) => (part.type === 'link' ? 'CARD' : part.body))).toEqual([
      'bubble for takeover',
      'CARD',
      'second bubble',
    ]);
    expect(JSON.stringify(sent)).not.toContain('live.browser-use.com');
    expect(swept.takeover.facts[0]).toMatchObject({
      kind: 'takeover',
      host: HOST,
      childFirstName: 'Ada',
      sessionLabel: 'Preschool Swim Sat 9:00',
      takeover: { purpose: 'captcha', mode: 'auto', minutes: 13, ended: null },
      loginCard: { sessionLabel: 'Preschool Swim Sat 9:00', opensAt: null, takeover: 'captcha' },
    });
    // Nothing ended: no run_finished notice, and the browser was not let go.
    expect(swept.notices).toEqual([]);
    expect(released).toEqual([]);

    // The card: single use, closing two minutes before the browser, sealed live view.
    const looked = await lookupLoginLink(db.database, code, NOW);
    expect(looked).toMatchObject({
      ok: true,
      offerId: family.offerId,
      providerHost: HOST,
      purpose: {
        kind: 'takeover',
        takeover: 'captcha',
        opensAt: null,
        card: { title: `Check on ${HOST}`, description: 'Swim Sat 9:00' },
      },
    });
    const [row] = await linkRows(family.familyId);
    expect(row?.expiresAt.toISOString()).toBe(new Date(NOW.getTime() + 13 * 60_000).toISOString());
    expect(row?.browserId).toBe('browser-1');
    expect(row?.browserHandleCiphertext).toBeTruthy();
    expect(row?.browserHandleCiphertext).not.toContain('live.browser-use.com');
    expect(row?.tokenHash).toBe(hashLoginCode(code));
    const opened = await takeoverLiveView(db.database, code, NOW);
    expect(opened).toMatchObject({ ok: true, liveViewUrl: LIVE });

    // The plan waits, still submitting, held until the card closes.
    const offer = await offerRow(family.offerId);
    expect(offer?.status).toBe('submitting');
    expect(offer?.planLeaseUntil?.toISOString()).toBe(row?.expiresAt.toISOString());
    expect(offer?.planResume).toEqual({
      phase: 'takeover',
      runId: 'run-1',
      sessionId: 'bu-session-1',
      browserId: 'browser-1',
      purpose: 'captcha',
      loginLinkId: row?.id,
      expiresAt: row?.expiresAt.toISOString(),
      round: 1,
      doneAt: null,
      lapsedAt: null,
    });
    expect((await steps(family.offerId)).map((s) => s.step)).toEqual([
      'plan_approved',
      'plan_started',
      'plan_takeover',
    ]);
    expect((await steps(family.offerId)).at(-1)).toEqual({
      step: 'plan_takeover',
      purpose: 'captcha',
      round: 1,
      minutes: 13,
      host: HOST,
    });
  });

  it('is not picked up again while the parent still holds the card', async () => {
    const { family } = await parkedCaptcha();
    const { runner } = runnerReturning();
    const later = new Date(NOW.getTime() + 60_000);
    const result = await runDueSignupPlans(db.database, { now: later }, sweepDeps(runner).deps);
    expect(result.plans.some((p) => p.offerId === family.offerId)).toBe(false);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('after the parent taps done, the next sweep picks the same session back up', async () => {
    const { family, code } = await parkedCaptcha();
    const tapped = new Date(NOW.getTime() + 4 * 60_000);
    const finished = await finishTakeover(db.database, { code, now: tapped });
    expect(finished).toEqual({
      ok: true,
      offerId: family.offerId,
      familyId: family.familyId,
      providerHost: HOST,
      purpose: 'captcha',
    });
    // Single use: the card is spent and its browser handle gone.
    expect(await finishTakeover(db.database, { code, now: tapped })).toEqual({
      ok: false,
      reason: 'used',
    });
    expect(await takeoverLiveView(db.database, code, tapped)).toEqual({
      ok: false,
      reason: 'used',
    });
    const [row] = await linkRows(family.familyId);
    expect(row?.browserHandleCiphertext).toBeNull();
    expect(row?.browserId).toBeNull();
    const parked = await offerRow(family.offerId);
    expect(parked?.planLeaseUntil).toBeNull();
    expect((parked?.planResume as TakeoverToken).doneAt).toBe(tapped.toISOString());

    const { runner, inputs, released } = runnerReturning(PAID);
    const swept = sweepDeps(runner);
    const next = new Date(tapped.getTime() + 60_000);
    const result = await runDueSignupPlans(db.database, { now: next }, swept.deps);
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'completed',
      notice: 'sent',
    });
    // The parent's done picks up the session: the takeover token is never waited on as a run.
    expect(inputs[0]?.resume).toBeNull();
    expect(inputs[0]?.takeoverResume).toEqual({
      sessionId: 'bu-session-1',
      browserId: 'browser-1',
      purpose: 'captcha',
      round: 1,
    });
    expect(released).toEqual([]);
    expect((await offerRow(family.offerId))?.status).toBe('completed');
    const trail = (await steps(family.offerId)).map((s) => s.step);
    expect(trail).toContain('plan_takeover_done');
    expect(trail.at(-1)).toBe('plan_finished');
  });

  it('when the card runs out first, lets the browser go, says so once, and retries nothing', async () => {
    const { family, code } = await parkedCaptcha();
    const { runner, released } = runnerReturning();
    const door = takeoverDoor();
    const swept = sweepDeps(runner, door);
    const late = new Date(NOW.getTime() + 14 * 60_000);
    const result = await runDueSignupPlans(db.database, { now: late }, swept.deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'takeover_unfinished',
      notice: 'sent',
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(released).toEqual([
      expect.objectContaining({ phase: 'takeover', browserId: 'browser-1' }),
    ]);
    expect(door.facts[0]).toMatchObject({
      kind: 'takeover_unfinished',
      takeover: { purpose: 'captcha', ended: 'ran_out', minutes: null },
      loginCard: null,
    });
    // The model's words, then the site's own page for the parent; no card.
    expect(door.parts[0]?.map((part) => (part.type === 'link' ? 'CARD' : part.body))).toEqual([
      'bubble for takeover_unfinished',
      'second bubble',
      URL_,
    ]);
    // run_finished is not sent on top of it.
    expect(swept.notices).toEqual([]);
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
    expect((await offerRow(family.offerId))?.browserUseCostUsd).toBe('0.150000');
    const trail = await steps(family.offerId);
    expect(trail.map((s) => s.step).slice(-2)).toEqual(['plan_takeover_lapsed', 'plan_finished']);
    expect(trail.at(-1)).toMatchObject({ detail: 'takeover_unfinished', notice: 'sent' });
    // A done after the end resumes nothing.
    expect((await finishTakeover(db.database, { code, now: late })).ok).toBe(false);
  });

  it('a done that lands first wins over the lapse', async () => {
    const { family, code } = await parkedCaptcha();
    const token = (await offerRow(family.offerId))?.planResume as TakeoverToken;
    const tapped = new Date(NOW.getTime() + 60_000);
    expect((await finishTakeover(db.database, { code, now: tapped })).ok).toBe(true);
    expect(
      await lapseTakeover(db.database, {
        offerId: family.offerId,
        familyId: family.familyId,
        loginLinkId: token.loginLinkId,
        actor: family.parentUserId,
        after: { step: 'plan_takeover_lapsed', purpose: 'captcha', round: 1, host: HOST },
        now: tapped,
      }),
    ).toBe(false);
    expect((await offerRow(family.offerId))?.planResume).toMatchObject({
      doneAt: tapped.toISOString(),
      lapsedAt: null,
    });
  });

  it('a lapse that lands first wins over the done', async () => {
    const { family, code } = await parkedCaptcha();
    const token = (await offerRow(family.offerId))?.planResume as TakeoverToken;
    const at = new Date(NOW.getTime() + 60_000);
    expect(
      await lapseTakeover(db.database, {
        offerId: family.offerId,
        familyId: family.familyId,
        loginLinkId: token.loginLinkId,
        actor: family.parentUserId,
        after: { step: 'plan_takeover_lapsed', purpose: 'captcha', round: 1, host: HOST },
        now: at,
      }),
    ).toBe(true);
    // The lapse spent the card, so the parent's done is gone and nothing resumes.
    expect(await finishTakeover(db.database, { code, now: at })).toEqual({
      ok: false,
      reason: 'used',
    });
    expect((await offerRow(family.offerId))?.planResume).toMatchObject({
      doneAt: null,
      lapsedAt: at.toISOString(),
    });
  });

  it('a text the model cannot write sends nothing, pages #ops, and lets the browser go', async () => {
    const posted = stubOpsSlack();
    const family = await plannedFamily();
    const { runner, released } = runnerReturning(stopAt('needs_login', 'login_wall'));
    const door = takeoverDoor({ unwritten: true });
    const swept = sweepDeps(runner, door);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      detail: 'takeover_unwritten',
      notice: 'failed',
    });
    expect(door.parts).toEqual([]);
    expect(swept.notices).toEqual([]);
    expect(await linkRows(family.familyId)).toEqual([]);
    expect(released).toEqual([expect.objectContaining({ runId: 'run-1', browserId: 'browser-1' })]);
    expect(posted.some((text) => text.includes('takeover_unwritten'))).toBe(true);
    expect(posted.join('\n')).not.toContain('live.browser-use.com');
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
  });

  it('a card that does not reach the parent is spent, and the run ends the way it always has', async () => {
    const family = await plannedFamily();
    const { runner, released } = runnerReturning(stopAt('needs_human', 'verification_code'));
    const swept = sweepDeps(runner, takeoverDoor({ delivery: 'failed' }));
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    const [row] = await linkRows(family.familyId);
    expect(row?.consumedAt?.toISOString()).toBe(NOW.toISOString());
    expect(row?.browserHandleCiphertext).toBeNull();
    expect(released).toHaveLength(1);
    expect(swept.notices).toEqual([
      expect.objectContaining({
        outcome: 'needs_human',
        detail: 'verification_code',
        liveViewUrl: null,
      }),
    ]);
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
  });

  it('never asks again for the step the parent just said they finished', async () => {
    const { family, code } = await parkedCaptcha();
    const tapped = new Date(NOW.getTime() + 2 * 60_000);
    expect((await finishTakeover(db.database, { code, now: tapped })).ok).toBe(true);
    const later = new Date(tapped.getTime() + 60_000);
    const { runner, released } = runnerReturning(stopAt('needs_human', 'captcha', later, 'run-q1'));
    const door = takeoverDoor();
    const swept = sweepDeps(runner, door);
    const result = await runDueSignupPlans(db.database, { now: later }, swept.deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      detail: 'takeover_unfinished',
      notice: 'sent',
    });
    expect(door.facts[0]).toMatchObject({
      kind: 'takeover_unfinished',
      takeover: { purpose: 'captcha', ended: 'still_there' },
    });
    expect(released).toEqual([expect.objectContaining({ runId: 'run-q1' })]);
    // No second card was minted.
    expect((await linkRows(family.familyId)).length).toBe(1);
  });

  it('asks for a new step after a done, then stops asking at the cap', async () => {
    const { family, code } = await parkedCaptcha();
    let at = new Date(NOW.getTime() + 60_000);
    expect((await finishTakeover(db.database, { code, now: at })).ok).toBe(true);

    // Round 2: the resumed run stops at a code.
    at = new Date(at.getTime() + 60_000);
    const second = runnerReturning(stopAt('needs_login', 'verification_code', at, 'run-q1'));
    const secondDoor = takeoverDoor({ now: at });
    await runDueSignupPlans(db.database, { now: at }, sweepDeps(second.runner, secondDoor).deps);
    expect(((await offerRow(family.offerId))?.planResume as TakeoverToken).round).toBe(2);
    expect(secondDoor.facts[0]?.takeover).toMatchObject({ purpose: 'code' });
    expect(
      (await finishTakeover(db.database, { code: sentCode(secondDoor.parts[0] ?? []), now: at }))
        .ok,
    ).toBe(true);

    // Round 3: a passkey.
    at = new Date(at.getTime() + 60_000);
    const third = runnerReturning(stopAt('needs_login', 'passkey', at, 'run-q2'));
    const thirdDoor = takeoverDoor({ now: at });
    await runDueSignupPlans(db.database, { now: at }, sweepDeps(third.runner, thirdDoor).deps);
    expect(((await offerRow(family.offerId))?.planResume as TakeoverToken).round).toBe(3);
    expect(
      (await finishTakeover(db.database, { code: sentCode(thirdDoor.parts[0] ?? []), now: at })).ok,
    ).toBe(true);

    // A fourth step: the plan has asked as often as it may.
    at = new Date(at.getTime() + 60_000);
    const fourth = runnerReturning(stopAt('needs_login', 'login_wall', at, 'run-q3'));
    const fourthDoor = takeoverDoor({ now: at });
    const result = await runDueSignupPlans(
      db.database,
      { now: at },
      sweepDeps(fourth.runner, fourthDoor).deps,
    );
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      detail: 'takeover_unfinished',
    });
    expect(fourthDoor.facts[0]).toMatchObject({
      kind: 'takeover_unfinished',
      takeover: { purpose: 'sign_in', ended: 'again' },
    });
    expect(fourth.released).toHaveLength(1);
  });

  it('counts the minutes it tells the parent from when the run stopped, not when the sweep began', async () => {
    const family = await plannedFamily();
    // The run stopped eight minutes into the sweep; the browser's keepAlive starts there.
    const stopped = new Date(NOW.getTime() + 8 * 60_000);
    const { runner } = runnerReturning(stopAt('needs_human', 'captcha', stopped));
    const door = takeoverDoor({ now: stopped });
    await runDueSignupPlans(db.database, { now: NOW }, sweepDeps(runner, door).deps);

    // 15 minutes of browser, less the 2 kept for the resume: 13 from the stop, whatever the sweep did.
    expect(door.facts[0]?.takeover).toMatchObject({ purpose: 'captcha', minutes: 13 });
    const [row] = await linkRows(family.familyId);
    expect(row?.expiresAt.toISOString()).toBe(
      new Date(stopped.getTime() + 13 * 60_000).toISOString(),
    );
    expect((await steps(family.offerId)).at(-1)).toMatchObject({
      step: 'plan_takeover',
      minutes: 13,
    });
  });

  it('a sweep that died right after the lapse: the next one finishes the close instead of looping', async () => {
    const { family } = await parkedCaptcha();
    const [link] = await linkRows(family.familyId);
    const late = new Date(NOW.getTime() + 14 * 60_000);
    // The dead sweep stamped the lapse and never reached the close.
    expect(
      await lapseTakeover(db.database, {
        offerId: family.offerId,
        familyId: family.familyId,
        loginLinkId: link?.id as string,
        actor: family.parentUserId,
        after: { step: 'plan_takeover_lapsed', purpose: 'captcha', round: 1, host: HOST },
        now: late,
      }),
    ).toBe(true);

    const { runner, released } = runnerReturning();
    const door = takeoverDoor();
    const next = new Date(late.getTime() + 60_000);
    const result = await runDueSignupPlans(
      db.database,
      { now: next },
      sweepDeps(runner, door).deps,
    );

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'takeover_unfinished',
      notice: 'sent',
    });
    expect(door.facts.map((f) => f.kind)).toEqual(['takeover_unfinished']);
    expect(released).toHaveLength(1);
    expect(runner.run).not.toHaveBeenCalled();
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
    // One lapse on the trail, though two sweeps touched it.
    expect(
      (await steps(family.offerId)).filter((s) => s.step === 'plan_takeover_lapsed'),
    ).toHaveLength(1);
  });

  it('a plan taken back while the parent holds the card is let go by the next sweep, with no text', async () => {
    const { family, code } = await parkedCaptcha();
    const at = new Date(NOW.getTime() + 2 * 60_000);
    expect(
      await cancelSignupPlan(db.database, {
        offerId: family.offerId,
        familyId: family.familyId,
        actor: family.parentUserId,
        now: at,
      }),
    ).toBe('cancel_requested');

    // A done after the take-back resumes nothing: the plan is no longer waiting on it.
    expect(await finishTakeover(db.database, { code, now: at })).toEqual({
      ok: false,
      reason: 'not_waiting',
    });

    const { runner, released } = runnerReturning();
    const door = takeoverDoor();
    const swept = sweepDeps(runner, door);
    // The next minute, long before the card would have run out.
    const next = new Date(at.getTime() + 60_000);
    const result = await runDueSignupPlans(db.database, { now: next }, swept.deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
      notice: 'withheld',
    });
    expect(door.facts).toEqual([]);
    expect(swept.notices).toEqual([]);
    expect(released).toHaveLength(1);
    expect(runner.run).not.toHaveBeenCalled();
    expect(await takeoverLiveView(db.database, code, next)).toEqual({ ok: false, reason: 'used' });
  });

  it('a take-back never clears the lease of a sweep that is already driving the plan', async () => {
    const { family, code } = await parkedCaptcha();
    const tapped = new Date(NOW.getTime() + 60_000);
    expect((await finishTakeover(db.database, { code, now: tapped })).ok).toBe(true);
    // A sweep has claimed the done plan and holds its own lease.
    const held = new Date(tapped.getTime() + 15 * 60_000);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ planLeaseUntil: held })
      .where(eq(schema.authorizedSignupOffers.id, family.offerId));

    await cancelSignupPlan(db.database, {
      offerId: family.offerId,
      familyId: family.familyId,
      actor: family.parentUserId,
      now: tapped,
    });
    expect((await offerRow(family.offerId))?.planLeaseUntil?.toISOString()).toBe(
      held.toISOString(),
    );
  });

  it('a resumed run that outlasts its sweep is still waited on when the saved login has gone', async () => {
    const { family, code } = await parkedCaptcha();
    const tapped = new Date(NOW.getTime() + 60_000);
    expect((await finishTakeover(db.database, { code, now: tapped })).ok).toBe(true);
    const goingToken: PlanResumeToken = {
      phase: 'signup',
      runId: 'run-q1',
      sessionId: 'bu-session-1',
      browserId: 'browser-1',
      takeover: { purpose: 'captcha', round: 1 },
    };
    const first = runnerReturning({ outcome: 'checkpointed', resume: goingToken });
    await runDueSignupPlans(db.database, { now: tapped }, sweepDeps(first.runner).deps);

    // The parent signed in on the browser itself; the saved session Hale started from is gone.
    await db.database
      .update(schema.providerSignupSessions)
      .set({ expiresAt: tapped })
      .where(eq(schema.providerSignupSessions.familyId, family.familyId));

    const second = runnerReturning(PAID);
    const result = await runDueSignupPlans(
      db.database,
      { now: new Date(tapped.getTime() + 60_000) },
      sweepDeps(second.runner).deps,
    );
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'completed',
    });
    expect(second.inputs[0]?.resume).toEqual(goingToken);
  });

  it('a done whose audit row cannot be written is not a done: the card stays open', async () => {
    const { family, code } = await parkedCaptcha();
    const tapped = new Date(NOW.getTime() + 60_000);
    await db.database.execute(
      sql.raw(`create function refuse_takeover_done() returns trigger language plpgsql as $$
        begin raise exception 'audit refused'; end $$`),
    );
    await db.database.execute(
      sql.raw(`create trigger refuse_takeover_done before insert on audit_log for each row
        when (new.after->>'step' = 'plan_takeover_done') execute function refuse_takeover_done()`),
    );
    try {
      await expect(finishTakeover(db.database, { code, now: tapped })).rejects.toThrow();
      expect(await takeoverLiveView(db.database, code, tapped)).toMatchObject({ ok: true });
      expect((await offerRow(family.offerId))?.planResume).toMatchObject({ doneAt: null });
    } finally {
      await db.database.execute(sql.raw('drop trigger refuse_takeover_done on audit_log'));
      await db.database.execute(sql.raw('drop function refuse_takeover_done'));
    }
    // The positive control: with the audit writable the same tap goes through.
    expect((await finishTakeover(db.database, { code, now: tapped })).ok).toBe(true);
  });

  it('a send that throws is a send that failed: the card is spent and the run ends as it always has', async () => {
    const family = await plannedFamily();
    const { runner, released } = runnerReturning(stopAt('needs_human', 'captcha'));
    const door = takeoverDoor({ delivery: 'throws' });
    const swept = sweepDeps(runner, door);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'captcha',
      notice: 'sent',
    });
    const [row] = await linkRows(family.familyId);
    expect(row?.consumedAt).toEqual(NOW);
    expect(row?.browserHandleCiphertext).toBeNull();
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
    expect(released).toHaveLength(1);
    expect(swept.notices).toHaveLength(1);
  });
});

describe('VIL-718 · an offer never goes to a parent who took the plan back or whose yes lapsed', () => {
  const lapseFamily = (familyId: string) =>
    db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: new Date(NOW.getTime() + 24 * 60 * 60_000) })
      .where(eq(schema.families.id, familyId));
  // A run with no checkpoint yet has no resume token for cancelSignupPlan to find, so the
  // take-back's own column is set directly.
  const takeBack = (offerId: string) =>
    db.database
      .update(schema.authorizedSignupOffers)
      .set({ planCancelRequestedAt: NOW })
      .where(eq(schema.authorizedSignupOffers.id, offerId));

  /** The run stops at a captcha; `landed` happens as the engine hands the stop back. */
  function stoppingRunner(landed: () => Promise<unknown>) {
    const scripted = runnerReturning(stopAt('needs_human', 'captcha'));
    const run = scripted.runner.run;
    scripted.runner.run = vi.fn(async (input: BrowserUsePlanInput) => {
      const result = await run(input);
      await landed();
      return result;
    });
    return scripted;
  }

  async function expectSilentEnd(
    family: { offerId: string; familyId: string },
    result: Awaited<ReturnType<typeof runDueSignupPlans>>,
    swept: ReturnType<typeof sweepDeps>,
    released: PlanResumeToken[],
  ) {
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
      notice: 'withheld',
    });
    expect(swept.takeover.parts).toEqual([]);
    expect(swept.notices).toEqual([]);
    expect(released).toEqual([expect.objectContaining({ runId: 'run-1', browserId: 'browser-1' })]);
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
    for (const row of await linkRows(family.familyId)) {
      expect(row.consumedAt).not.toBeNull();
      expect(row.browserHandleCiphertext).toBeNull();
    }
  }

  it('a take-back that landed during the run: no write, no card, no text', async () => {
    const family = await plannedFamily();
    const { runner, released } = stoppingRunner(() => takeBack(family.offerId));
    const swept = sweepDeps(runner);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(swept.takeover.facts).toEqual([]);
    expect(await linkRows(family.familyId)).toEqual([]);
    await expectSilentEnd(family, result, swept, released);
  });

  it('a yes that lapsed during the run (erasure scheduled): no write, no card, no text', async () => {
    const family = await plannedFamily();
    const { runner, released } = stoppingRunner(() => lapseFamily(family.familyId));
    const swept = sweepDeps(runner);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(swept.takeover.facts).toEqual([]);
    expect(await linkRows(family.familyId)).toEqual([]);
    await expectSilentEnd(family, result, swept, released);
  });

  it('a take-back during the model write: no card is minted, the plan is not parked, nothing goes', async () => {
    const family = await plannedFamily();
    const { runner, released } = runnerReturning(stopAt('needs_human', 'captcha'));
    const door = takeoverDoor({
      duringWrite: () => takeBack(family.offerId).then(() => undefined),
    });
    const swept = sweepDeps(runner, door);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(door.facts).toHaveLength(1);
    expect(await linkRows(family.familyId)).toHaveLength(0);
    expect((await offerRow(family.offerId))?.planResume?.phase).toBe('signup');
    await expectSilentEnd(family, result, swept, released);
  });

  it('a lapse during the model write: no card is minted, nothing goes', async () => {
    const family = await plannedFamily();
    const { runner, released } = runnerReturning(stopAt('needs_human', 'verification_code'));
    const door = takeoverDoor({
      duringWrite: () => lapseFamily(family.familyId).then(() => undefined),
    });
    const swept = sweepDeps(runner, door);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(door.facts).toHaveLength(1);
    expect(await linkRows(family.familyId)).toHaveLength(0);
    await expectSilentEnd(family, result, swept, released);
  });

  it('a plan withdrawn during the write leaves another open card on the same host alive', async () => {
    const family = await plannedFamily();
    const other = await mintFreshLoginLink(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      offerId: null,
      providerHost: HOST,
      purpose: { kind: 'password_rejected', sessionLabel: null, opensAt: null, card: null },
      now: NOW,
    });
    const otherCode = other.url.split('/l/')[1] ?? '';
    expect(await lookupLoginLink(db.database, otherCode, NOW)).toMatchObject({ ok: true });
    const { runner } = runnerReturning(stopAt('needs_human', 'captcha'));
    const door = takeoverDoor({
      duringWrite: () => takeBack(family.offerId).then(() => undefined),
    });
    await runDueSignupPlans(db.database, { now: NOW }, sweepDeps(runner, door).deps);

    expect(door.facts).toHaveLength(1);
    expect(await lookupLoginLink(db.database, otherCode, NOW)).toMatchObject({
      ok: true,
      id: other.id,
    });
    expect(await linkRows(family.familyId)).toHaveLength(1);
  });

  it('a yes that still stands after the write replaces the host’s open card', async () => {
    const family = await plannedFamily();
    const other = await mintFreshLoginLink(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      offerId: null,
      providerHost: HOST,
      purpose: { kind: 'password_rejected', sessionLabel: null, opensAt: null, card: null },
      now: NOW,
    });
    const otherCode = other.url.split('/l/')[1] ?? '';
    const { runner } = runnerReturning(stopAt('needs_human', 'captcha'));
    await runDueSignupPlans(db.database, { now: NOW }, sweepDeps(runner).deps);

    expect(await lookupLoginLink(db.database, otherCode, NOW)).toEqual({
      ok: false,
      reason: 'used',
    });
    expect(await linkRows(family.familyId)).toHaveLength(2);
  });

  it('a stop with a charge it cannot rule out is still reported, without the live browser', async () => {
    const family = await plannedFamily();
    const stop = { ...stopAt('needs_human', 'captcha'), charged: 'unknown' as const };
    const { runner, released } = runnerReturning(stop);
    runner.run = vi.fn(async () => {
      await takeBack(family.offerId);
      return stop;
    });
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(swept.takeover.parts).toEqual([]);
    expect(swept.notices).toEqual([
      expect.objectContaining({ charged: 'unknown', liveViewUrl: null }),
    ]);
    expect(released).toHaveLength(1);
  });

  it('an ops stop during a run that ends at a passkey: no text, no page, and the real stop is kept', async () => {
    const posted = stubOpsSlack();
    const family = await plannedFamily();
    const { runner, released } = stoppingRunner(() =>
      requestStopForRunningPlans(db.database, { now: NOW }),
    );
    runner.run = vi.fn(async () => {
      await db.database
        .update(schema.authorizedSignupOffers)
        .set({ planResume: { phase: 'signup', runId: 'run-1', sessionId: null, browserId: null } })
        .where(eq(schema.authorizedSignupOffers.id, family.offerId));
      await requestStopForRunningPlans(db.database, { now: NOW });
      return stopAt('needs_login', 'passkey');
    });
    const swept = sweepDeps(runner);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
      notice: 'withheld',
    });
    expect(swept.takeover.parts).toEqual([]);
    expect(swept.notices).toEqual([]);
    expect(released).toHaveLength(1);
    expect(posted.join('\n')).not.toContain('registration_stop_unverified');
    const finished = (await steps(family.offerId)).find((row) => row.step === 'plan_finished');
    expect(finished?.stoppedFrom).toEqual({ outcome: 'needs_login', detail: 'passkey' });
  });

  it('an ops stop on a parked plan is let go by the next sweep and never reads as nothing charged', async () => {
    const posted = stubOpsSlack();
    const { family } = await parkedCaptcha();
    await requestStopForRunningPlans(db.database, { now: NOW });
    const { runner, released } = runnerReturning();
    const door = takeoverDoor();
    const swept = sweepDeps(runner, door);
    // The next minute, long before the card would have run out.
    const next = new Date(NOW.getTime() + 60_000);
    const result = await runDueSignupPlans(db.database, { now: next }, swept.deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'unconfirmed',
    });
    expect(door.facts).toEqual([]);
    expect(swept.notices).toEqual([
      expect.objectContaining({ charged: 'unknown', liveViewUrl: null }),
    ]);
    expect(released).toHaveLength(1);
    expect(runner.run).not.toHaveBeenCalled();
    expect(posted.join('\n')).toContain('registration_stop_unverified');
  });

  it('an ops stop after the parent tapped done still reads as unknown', async () => {
    const posted = stubOpsSlack();
    const { family, code } = await parkedCaptcha();
    const tapped = new Date(NOW.getTime() + 60_000);
    expect((await finishTakeover(db.database, { code, now: tapped })).ok).toBe(true);
    await requestStopForRunningPlans(db.database, { now: tapped });
    const { runner, released } = runnerReturning();
    const swept = sweepDeps(runner, takeoverDoor());
    const next = new Date(tapped.getTime() + 60_000);
    const result = await runDueSignupPlans(db.database, { now: next }, swept.deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'unconfirmed',
    });
    expect(swept.notices).toEqual([expect.objectContaining({ charged: 'unknown' })]);
    expect(released).toHaveLength(1);
    expect(runner.run).not.toHaveBeenCalled();
    expect(posted.join('\n')).toContain('registration_stop_unverified');
  });

  describe('an ops stop on a plan whose browser the parent has had', () => {
    const stopNow = (at: Date) => requestStopForRunningPlans(db.database, { now: at });

    /** Parked, the parent tapped done, and the resumed turn runs while `landed` happens. */
    async function resumedTurn(
      answer: BrowserUsePlanResult,
      landed: (at: Date) => Promise<unknown>,
      door = takeoverDoor(),
    ) {
      const posted = stubOpsSlack();
      const { family, code } = await parkedCaptcha();
      const tapped = new Date(NOW.getTime() + 60_000);
      expect((await finishTakeover(db.database, { code, now: tapped })).ok).toBe(true);
      const { runner, released } = runnerReturning();
      runner.run = vi.fn(async () => {
        await landed(tapped);
        return answer;
      });
      const swept = sweepDeps(runner, door);
      const next = new Date(tapped.getTime() + 60_000);
      const result = await runDueSignupPlans(db.database, { now: next }, swept.deps);
      return { family, posted, released, swept, door, result };
    }

    it.each([
      ['a code the site asks for', 'needs_human', 'verification_code'],
      ['a page error', 'needs_human', 'page_error'],
      ['a new sign-in wall', 'needs_login', 'login_wall'],
    ] as const)(
      'during the turn after done, ending at %s: unconfirmed, the parent told, #ops paged',
      async (_why, outcome, detail) => {
        const { family, posted, released, swept, door, result } = await resumedTurn(
          stopAt(outcome, detail, NOW, 'run-q1'),
          stopNow,
        );

        expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
          outcome: 'needs_human',
          detail: 'unconfirmed',
          notice: 'sent',
        });
        expect(swept.notices).toEqual([
          expect.objectContaining({
            outcome: 'needs_human',
            detail: 'unconfirmed',
            charged: 'unknown',
            liveViewUrl: null,
            holdExpiresAt: null,
          }),
        ]);
        expect(door.parts).toEqual([]);
        expect(released).toHaveLength(1);
        expect(posted.join('\n')).toContain('registration_stop_unverified');
      },
    );

    it('during the resumed turn that stops on the same step: the parent still hears it', async () => {
      const { family, posted, swept, door, result } = await resumedTurn(
        stopAt('needs_human', 'captcha', NOW, 'run-q1'),
        stopNow,
      );

      expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
        outcome: 'needs_human',
        detail: 'unconfirmed',
        notice: 'sent',
      });
      expect(door.parts).toEqual([]);
      expect(swept.notices).toEqual([
        expect.objectContaining({ detail: 'unconfirmed', charged: 'unknown' }),
      ]);
      expect(posted.join('\n')).toContain('registration_stop_unverified');
    });

    it('during the write of the ran-out close: the parent still hears it', async () => {
      const posted = stubOpsSlack();
      const { family } = await parkedCaptcha();
      const late = new Date(NOW.getTime() + 14 * 60_000);
      const door = takeoverDoor({
        duringWrite: async () => {
          await stopNow(late);
        },
      });
      const { runner, released } = runnerReturning();
      const swept = sweepDeps(runner, door);
      const result = await runDueSignupPlans(db.database, { now: late }, swept.deps);

      expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
        outcome: 'needs_human',
        detail: 'unconfirmed',
        notice: 'sent',
      });
      expect(door.parts).toEqual([]);
      expect(swept.notices).toEqual([
        expect.objectContaining({ detail: 'unconfirmed', charged: 'unknown' }),
      ]);
      expect(released).toHaveLength(1);
      expect(posted.join('\n')).toContain('registration_stop_unverified');
    });

    it('after the close already went: no second text, and #ops is still paged', async () => {
      const posted = stubOpsSlack();
      const { family } = await parkedCaptcha();
      const late = new Date(NOW.getTime() + 14 * 60_000);
      const door = takeoverDoor();
      const deliver = door.deps.deliver;
      door.deps.deliver = async (input) => {
        const sent = await deliver(input);
        await stopNow(late);
        return sent;
      };
      const { runner } = runnerReturning();
      const swept = sweepDeps(runner, door);
      const result = await runDueSignupPlans(db.database, { now: late }, swept.deps);

      expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
        detail: 'unconfirmed',
        notice: 'sent',
      });
      expect(door.parts).toHaveLength(1);
      expect(swept.notices).toEqual([]);
      expect(posted.join('\n')).toContain('registration_stop_unverified');
    });
  });

  it.each([
    ['an ops stop', () => requestStopForRunningPlans(db.database, { now: NOW })],
    [
      'a take-back',
      (family: { offerId: string; familyId: string; parentUserId: string }) =>
        cancelSignupPlan(db.database, {
          offerId: family.offerId,
          familyId: family.familyId,
          actor: family.parentUserId,
          now: NOW,
        }),
    ],
  ] as const)('%s never clears a lease a sweep is driving a parked plan with', async (_w, stop) => {
    const { family } = await parkedCaptcha();
    const parkedRow = await offerRow(family.offerId);
    const resume = parkedRow?.planResume as TakeoverToken;
    expect(parkedRow?.planLeaseUntil?.toISOString()).toBe(new Date(resume.expiresAt).toISOString());
    const driven = new Date(new Date(resume.expiresAt).getTime() + 15 * 60_000);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ planLeaseUntil: driven })
      .where(eq(schema.authorizedSignupOffers.id, family.offerId));

    await stop(family);

    const after = await offerRow(family.offerId);
    expect(after?.planCancelRequestedAt).not.toBeNull();
    expect(after?.planLeaseUntil?.toISOString()).toBe(driven.toISOString());
  });

  it('a done after the parent’s yes lapsed is refused and leaves the card for the sweep to close', async () => {
    const { family, code } = await parkedCaptcha();
    await lapseFamily(family.familyId);

    expect(await finishTakeover(db.database, { code, now: NOW })).toEqual({
      ok: false,
      reason: 'not_waiting',
    });
    const [card] = await linkRows(family.familyId);
    expect(card?.consumedAt).toBeNull();
    const resume = (await offerRow(family.offerId))?.planResume as TakeoverToken;
    expect(resume.doneAt).toBeNull();
  });

  it.each([
    [
      'the parent took the plan back',
      (family: { offerId: string; familyId: string; parentUserId: string }) =>
        cancelSignupPlan(db.database, {
          offerId: family.offerId,
          familyId: family.familyId,
          actor: family.parentUserId,
          now: NOW,
        }),
    ],
    ['an ops stop is on the plan', () => requestStopForRunningPlans(db.database, { now: NOW })],
    [
      'the parent left the family',
      (family: { familyId: string; parentUserId: string }) =>
        db.database
          .delete(schema.familyMembers)
          .where(
            and(
              eq(schema.familyMembers.familyId, family.familyId),
              eq(schema.familyMembers.userId, family.parentUserId),
            ),
          ),
    ],
    [
      'the family asked to be erased',
      (family: { familyId: string }) =>
        db.database
          .update(schema.families)
          .set({ scheduledDeletionAt: NOW })
          .where(eq(schema.families.id, family.familyId)),
    ],
  ] as const)('the live view opens nothing once %s', async (_why, change) => {
    const { family, code } = await parkedCaptcha();
    expect(await takeoverLiveView(db.database, code, NOW)).toMatchObject({
      ok: true,
      liveViewUrl: LIVE,
    });

    await change(family);

    expect(await takeoverLiveView(db.database, code, NOW)).toEqual({ ok: false, reason: 'gone' });
  });
});

describe('VIL-718 · a link never opens a browser that may hold a login this parent cannot see', () => {
  const SECRET = 'fixture-co-parent-city-secret';
  const QUEUED: BrowserUsePlanCheckpoint = {
    outcome: 'checkpointed',
    resume: { phase: 'signup', runId: 'run-1', sessionId: 'bu-session-1', browserId: 'browser-1' },
  };

  function armSavedLogins() {
    vi.stubEnv(PROVIDER_CREDENTIALS_ENABLED_ENV, 'true');
    vi.stubEnv(PROVIDER_CREDENTIALS_MASTER_KEY_ENV, Buffer.alloc(32, 9).toString('base64'));
  }

  async function saveLogin(family: { familyId: string; parentUserId: string }) {
    const saved = await saveProviderCredentials(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      providerHost: HOST,
      username: 'fixture-user',
      password: SECRET,
      now: NOW,
    });
    expect(saved.ok).toBe(true);
  }

  async function dropSavedSession(familyId: string) {
    await db.database
      .delete(schema.providerSignupSessions)
      .where(eq(schema.providerSignupSessions.familyId, familyId));
  }

  /** The plan now belongs to a co-parent who is enrolled and consented; the saver is not them. */
  async function giveToCoParent(family: { familyId: string; offerId: string }) {
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: `co-${family.offerId}@example.test`, name: 'Co Parent' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('no co-parent');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: family.familyId, userId: user.id, role: 'co_parent' });
    seq += 1;
    const phone = `+1202556${String(300 + seq).padStart(4, '0')}`;
    await db.database.insert(schema.parentChannels).values({
      userId: user.id,
      familyId: family.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ parentUserId: user.id })
      .where(eq(schema.authorizedSignupOffers.id, family.offerId));
    await db.database
      .update(schema.authorizedSignupConsents)
      .set({ parentUserId: user.id })
      .where(eq(schema.authorizedSignupConsents.familyId, family.familyId));
    return user.id;
  }

  async function expectNoCard(
    family: { offerId: string; familyId: string },
    swept: ReturnType<typeof sweepDeps>,
  ) {
    expect(swept.takeover.facts).toEqual([]);
    expect(swept.takeover.parts).toEqual([]);
    expect(await linkRows(family.familyId)).toEqual([]);
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
    expect(swept.notices).toHaveLength(1);
  }

  it.each([
    ['a captcha', 'needs_human', 'captcha'],
    ['a sign-in wall', 'needs_login', 'login_wall'],
  ] as const)(
    'a co-parent’s saved login with the owner check off: %s mints no card',
    async (_name, outcome, detail) => {
      armSavedLogins();
      const family = await plannedFamily();
      await saveLogin(family);
      await dropSavedSession(family.familyId);
      await giveToCoParent(family);
      const { runner, inputs } = runnerReturning(stopAt(outcome, detail));
      const swept = sweepDeps(runner);
      await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

      expect(inputs[0]?.credentials?.password).toBe(SECRET);
      expect(inputs[0]?.takeover).toBe(false);
      await expectNoCard(family, swept);
    },
  );

  it('a co-parent’s saved session with the owner check off mints no card', async () => {
    const family = await plannedFamily();
    await giveToCoParent(family);
    const { runner, inputs } = runnerReturning(stopAt('needs_human', 'captcha'));
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(inputs[0]?.credentials).toBeNull();
    expect(inputs[0]?.takeover).toBe(false);
    await expectNoCard(family, swept);
  });

  it('with the owner check on, the parent’s own saved password still bars the card', async () => {
    armSavedLogins();
    vi.stubEnv(PLAN_CITY_LOGIN_OWNER_ENABLED_ENV, 'true');
    const family = await plannedFamily();
    await saveLogin(family);
    await dropSavedSession(family.familyId);
    const { runner, inputs } = runnerReturning(stopAt('needs_human', 'captcha'));
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(inputs[0]?.credentials?.password).toBe(SECRET);
    expect(inputs[0]?.takeover).toBe(false);
    await expectNoCard(family, swept);
  });

  it('a barred run stopped at a captcha with a live view: the browser goes and no text carries it', async () => {
    const family = await plannedFamily();
    await giveToCoParent(family);
    const { runner, inputs, released } = runnerReturning(stopAt('needs_human', 'captcha'));
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(inputs[0]?.takeover).toBe(false);
    await expectNoCard(family, swept);
    expect(released).toEqual([expect.objectContaining({ runId: 'run-1', browserId: 'browser-1' })]);
    expect(swept.notices[0]).toMatchObject({
      detail: 'captcha',
      liveViewUrl: null,
      holdExpiresAt: null,
    });
  });

  it('a barred run stopped at a sign-in wall keeps today’s live view', async () => {
    const family = await plannedFamily();
    await giveToCoParent(family);
    const { runner, released } = runnerReturning(stopAt('needs_login', 'login_wall'));
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    await expectNoCard(family, swept);
    expect(released).toEqual([]);
    expect(swept.notices[0]).toMatchObject({ detail: 'login_wall', liveViewUrl: LIVE });
  });

  it('with the owner check on, the parent’s own captured session and no password gets the card', async () => {
    vi.stubEnv(PLAN_CITY_LOGIN_OWNER_ENABLED_ENV, 'true');
    const family = await plannedFamily();
    const { runner, inputs } = runnerReturning(stopAt('needs_human', 'captcha'));
    const swept = sweepDeps(runner);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(inputs[0]?.credentials).toBeNull();
    expect(inputs[0]?.takeover).toBe(true);
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'checkpointed',
      phase: 'takeover',
    });
    expect(await linkRows(family.familyId)).toHaveLength(1);
    expect(swept.takeover.parts).toHaveLength(1);
  });

  it('a login bound when the run began still bars the card after it is deleted mid-queue', async () => {
    armSavedLogins();
    const family = await plannedFamily();
    await saveLogin(family);
    await giveToCoParent(family);
    const { runner, inputs } = runnerReturning(QUEUED, stopAt('needs_human', 'captcha'));
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);
    expect(await deleteProviderCredentials(db.database, { familyId: family.familyId })).toBe(1);
    await db.database
      .update(schema.providerSignupSessions)
      .set({ parentUserId: (await offerRow(family.offerId))?.parentUserId })
      .where(eq(schema.providerSignupSessions.familyId, family.familyId));
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.credentials).toBeNull();
    expect(inputs[1]?.takeover).toBe(false);
    await expectNoCard(family, swept);
  });

  it('a run with no such login keeps its card across a queue checkpoint', async () => {
    const family = await plannedFamily();
    const { runner, inputs } = runnerReturning(QUEUED, stopAt('needs_human', 'captcha'));
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.takeover).toBe(true);
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'checkpointed',
      phase: 'takeover',
    });
    expect(await linkRows(family.familyId)).toHaveLength(1);
  });
});

describe('VIL-718 · a stop that was not handed over', () => {
  /** A stop whose browser has too little time left for a card. */
  const noWindow = (stop: BrowserUsePlanResult): BrowserUsePlanResult => ({
    ...stop,
    holdExpiresAt: new Date(NOW.getTime() + 60_000),
  });

  it.each([
    ['too little time left', noWindow(stopAt('needs_human', 'captcha'))],
    ['no session to resume', { ...stopAt('needs_human', 'captcha'), sessionId: null }],
    ['a passkey with too little time left', noWindow(stopAt('needs_human', 'passkey'))],
    ['a captcha read as a sign-in stop', noWindow(stopAt('needs_login', 'captcha'))],
  ] as const)('%s: the browser is let go and no live view reaches the text', async (_w, stop) => {
    const family = await plannedFamily();
    const { runner, released } = runnerReturning(stop);
    const swept = sweepDeps(runner);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(await linkRows(family.familyId)).toEqual([]);
    expect(swept.takeover.parts).toEqual([]);
    expect(released).toEqual([expect.objectContaining({ runId: 'run-1', browserId: 'browser-1' })]);
    expect(swept.notices).toHaveLength(1);
    expect(swept.notices[0]).toMatchObject({
      detail: stop.detail,
      liveViewUrl: null,
      holdExpiresAt: null,
    });
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: stop.outcome,
      detail: stop.detail,
    });
    const finished = (await steps(family.offerId)).find((row) => row.step === 'plan_finished');
    expect(finished?.sessionCostUsd).toBe('0.150000');
    expect(finished?.holdExpiresAt).toBeNull();
  });

  it('a sign-in stop with too little time left keeps today’s live view', async () => {
    const family = await plannedFamily();
    const stop = noWindow(stopAt('needs_login', 'login_wall'));
    const { runner, released } = runnerReturning(stop);
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(await linkRows(family.familyId)).toEqual([]);
    expect(released).toEqual([]);
    expect(swept.notices[0]).toMatchObject({ detail: 'login_wall', liveViewUrl: LIVE });
  });

  it('a checkout hand-off is no takeover stop and keeps its live view', async () => {
    const family = await plannedFamily();
    const { runner, released } = runnerReturning({
      ...stopAt('needs_human', 'payment_off'),
      choiceIndex: 0,
      cartTotalCents: 9800,
    });
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(await linkRows(family.familyId)).toEqual([]);
    expect(released).toEqual([]);
    expect(swept.notices[0]).toMatchObject({ detail: 'payment_off', liveViewUrl: LIVE });
  });
});

describe('VIL-718 · a stop where a payment may exist is never handed over', () => {
  const PLAN_SKILL = '# skill browser-use-plan-signup';
  const REVIEW_SKILL = '# skill browser-use-checkout-review';
  const PAYMENT_SKILL = '# skill browser-use-saved-card-payment';
  const AT_CHECKOUT = {
    outcome: 'reached_checkout',
    detail: 'none',
    choice_index: 0,
    checkout_url: `https://${HOST}/Checkout`,
    cart_total_cents: 9800,
    cart_currency: 'cad',
    hold_minutes: 15,
    saved_card_on_file: true,
    security_code_required: false,
    payment_details_entered: false,
  };
  const READY_TO_PLACE = {
    outcome: 'ready_to_place',
    detail: 'none',
    total_cents: 9800,
    currency: 'cad',
    tax_cents: 0,
    fees_cents: 0,
    saved_card_selected: true,
    order_placed: false,
  };
  const BANK_CODE = {
    outcome: 'needs_human',
    detail: 'verification_code',
    confirmation_number: null,
    amount_charged_cents: null,
  };

  /** The real engine over a fake Browser Use API. Each run answers as the skill it was given. */
  function realEngine(answers: Record<string, unknown>) {
    const created: string[] = [];
    const skillOf = new Map<string, string>();
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const method = init.method ?? 'GET';
      const path = `${parsed.pathname.replace('/api/v4', '')}${parsed.search}`;
      if (method === 'POST' && path === '/runs') {
        const body = JSON.parse(String(init.body));
        const skill = String(body.task).split('\n')[0] ?? '';
        created.push(skill);
        const id = `run-${created.length}`;
        skillOf.set(id, skill);
        return Response.json({ id, sessionId: 'bu-session-1' });
      }
      if (method === 'PATCH' && path === '/browsers/browser-1') return Response.json({});
      if (path === '/sessions/bu-session-1/cost') {
        return Response.json({ sessionId: 'bu-session-1', totalCostUsd: '0.090000' });
      }
      const run = /^\/runs\/(run-\d+)/.exec(path)?.[1];
      if (!run) throw new Error(`unexpected ${method} ${path}`);
      if (path.endsWith('/status')) return Response.json({ status: 'completed' });
      if (path.endsWith('/cancel')) return Response.json({ id: run, status: 'cancelled' });
      if (path.includes('/events')) {
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
      return Response.json({
        id: run,
        status: 'completed',
        sessionId: 'bu-session-1',
        output: answers[skillOf.get(run) ?? ''],
        error: null,
        totalCostUsd: '0.0400',
      });
    });
    const engine: BrowserUseEngineDeps = {
      api: browserUseApi({ apiKey: 'test-key', fetch: fetchImpl }),
      seeder: null,
      loadTask: async (skill) => `# skill ${skill}`,
      sleep: async () => undefined,
      now: () => NOW,
    };
    const runner = {
      run: (input: BrowserUsePlanInput) => runBrowserUsePlanSignup(input, engine),
      release: (resume: PlanResumeToken) => releasePlanRun(resume, engine),
      settlePayment: (input: Parameters<typeof settleBrowserUsePlanPayment>[0]) =>
        settleBrowserUsePlanPayment(input, engine),
    };
    return { runner, created };
  }

  function engineDeps(runner: ReturnType<typeof realEngine>['runner']) {
    const door = takeoverDoor();
    const notices: PlanOutcomeNotice[] = [];
    const deps: PlanRunDeps = {
      runner,
      autoHosts: [HOST],
      notifyParent: async (notice) => {
        notices.push(notice);
        return 'sent';
      },
      checkSpendingCap: async () => ({ ok: true, reason: 'within' }),
      takeover: door.deps,
    };
    return { deps, door, notices };
  }

  async function familyWithProfile() {
    const family = await plannedFamily();
    await db.database
      .update(schema.providerSignupSessions)
      .set({ browserUseProfileId: 'profile-seeded' })
      .where(eq(schema.providerSignupSessions.familyId, family.familyId));
    return family;
  }

  const stoppedAtBankCode = () =>
    realEngine({
      [PLAN_SKILL]: AT_CHECKOUT,
      [REVIEW_SKILL]: READY_TO_PLACE,
      [PAYMENT_SKILL]: BANK_CODE,
    });

  it('a payment run stopped on a bank code gets no card, no second payment, and an honest unknown', async () => {
    vi.stubEnv(BROWSER_USE_SIGNUP_PAYMENT_ENABLED_ENV, 'true');
    const family = await familyWithProfile();
    const { runner, created } = stoppedAtBankCode();
    const { deps, door, notices } = engineDeps(runner);

    const result = await runDueSignupPlans(db.database, { now: NOW }, deps);

    expect(await linkRows(family.familyId)).toEqual([]);
    expect(door.parts).toEqual([]);
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'verification_code',
      notice: 'sent',
    });
    expect(notices).toEqual([
      expect.objectContaining({
        outcome: 'needs_human',
        detail: 'verification_code',
        charged: 'unknown',
      }),
    ]);
    const after = await steps(family.offerId);
    expect(after.some((row) => row.step === 'plan_takeover')).toBe(false);
    expect(after.find((row) => row.step === 'plan_finished')).toMatchObject({
      charged: 'unknown',
    });
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');

    await runDueSignupPlans(db.database, { now: new Date(NOW.getTime() + 60_000) }, deps);
    expect(created).toEqual([PLAN_SKILL, REVIEW_SKILL, PAYMENT_SKILL]);
    expect(notices).toHaveLength(1);
  });

  it('that ending is the one the flag-off path gives', async () => {
    const ending = async (flag: 'true' | 'false') => {
      vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, flag);
      vi.stubEnv(BROWSER_USE_SIGNUP_PAYMENT_ENABLED_ENV, 'true');
      await familyWithProfile();
      const { runner } = stoppedAtBankCode();
      const { deps, notices } = engineDeps(runner);
      await runDueSignupPlans(db.database, { now: NOW }, deps);
      expect(notices).toHaveLength(1);
      const { offerId: _o, familyId: _f, parentUserId: _p, ...facts } = notices[0] ?? {};
      return facts;
    };
    const off = await ending('false');
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'handed_back', browserUseCostUsd: null })
      .where(inArray(schema.authorizedSignupOffers.status, ['planned', 'submitting']));
    await db.database.update(schema.authorizedSignupOffers).set({ browserUseCostUsd: null });
    const on = await ending('true');

    expect(off).toMatchObject({
      detail: 'verification_code',
      charged: 'unknown',
      liveViewUrl: LIVE,
    });
    expect(on).toEqual(off);
  });

  /** A runner whose run stores the `paying` checkpoint, as the engine does, and then stops. */
  function payingThen(stop: BrowserUsePlanResult) {
    const made = runnerReturning();
    made.runner.run = vi.fn(async (input: BrowserUsePlanInput) => {
      made.inputs.push(input);
      expect(
        await input.onCheckpoint({
          phase: 'paying',
          runId: 'run-pay',
          sessionId: 'bu-session-1',
          browserId: 'browser-1',
          choiceIndex: 0,
          cartTotalCents: 9800,
          holdExpiresAt: null,
          costUsd: '0.0400',
        }),
      ).toBe(true);
      return stop;
    });
    return made;
  }

  it('a stored paying checkpoint bars the card even on a stop that reads as nothing charged', async () => {
    const family = await plannedFamily();
    const { runner } = payingThen(stopAt('needs_human', 'verification_code'));
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(await linkRows(family.familyId)).toEqual([]);
    expect(swept.takeover.parts).toEqual([]);
    expect(swept.notices).toEqual([expect.objectContaining({ detail: 'verification_code' })]);
  });

  it('a resumed turn that stops in payment on the same step is reported as unknown, not as unfinished', async () => {
    const { family, code } = await parkedCode();
    const tapped = new Date(NOW.getTime() + 2 * 60_000);
    expect((await finishTakeover(db.database, { code, now: tapped })).ok).toBe(true);
    const later = new Date(tapped.getTime() + 60_000);
    const { runner, released } = payingThen({
      ...stopAt('needs_human', 'verification_code', later, 'run-q1'),
      choiceIndex: 0,
      charged: 'unknown',
    });
    const door = takeoverDoor();
    const swept = sweepDeps(runner, door);
    const result = await runDueSignupPlans(db.database, { now: later }, swept.deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_human',
      detail: 'verification_code',
      notice: 'sent',
    });
    expect(door.facts).toEqual([]);
    expect(swept.notices).toEqual([
      expect.objectContaining({ detail: 'verification_code', charged: 'unknown' }),
    ]);
    expect(released).toEqual([]);
    expect(await linkRows(family.familyId)).toHaveLength(1);
  });

  it('a code stop before checkout, where no payment can exist, still gets the card', async () => {
    vi.stubEnv(BROWSER_USE_SIGNUP_PAYMENT_ENABLED_ENV, 'true');
    const family = await familyWithProfile();
    const { runner, created } = realEngine({
      [PLAN_SKILL]: { ...AT_CHECKOUT, outcome: 'needs_human', detail: 'verification_code' },
    });
    const { deps, door, notices } = engineDeps(runner);

    const result = await runDueSignupPlans(db.database, { now: NOW }, deps);

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'checkpointed',
      phase: 'takeover',
    });
    expect(await linkRows(family.familyId)).toHaveLength(1);
    expect(door.parts).toHaveLength(1);
    expect(notices).toEqual([]);
    expect(created).toEqual([PLAN_SKILL]);
  });
});

describe('VIL-718 · a lapse frees a parked browser at the next sweep', () => {
  const NEXT = new Date(NOW.getTime() + 60_000);
  const lapses: Array<
    [string, (family: { familyId: string; parentUserId: string }) => Promise<unknown>]
  > = [
    [
      'the parent left the family',
      (family) =>
        db.database
          .delete(schema.familyMembers)
          .where(
            and(
              eq(schema.familyMembers.familyId, family.familyId),
              eq(schema.familyMembers.userId, family.parentUserId),
            ),
          ),
    ],
    [
      'the family asked to be erased',
      (family) =>
        db.database
          .update(schema.families)
          .set({ scheduledDeletionAt: NOW })
          .where(eq(schema.families.id, family.familyId)),
    ],
  ];

  it.each(lapses)(
    '%s: the browser is released and the card spent, with no text',
    async (_w, lapse) => {
      const { family, code } = await parkedCaptcha();
      await lapse(family);

      const { runner, released } = runnerReturning();
      const door = takeoverDoor();
      const swept = sweepDeps(runner, door);
      const result = await runDueSignupPlans(db.database, { now: NEXT }, swept.deps);

      expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
        outcome: 'needs_human',
        detail: 'takeover_unfinished',
        notice: 'withheld',
      });
      expect(released).toEqual([
        expect.objectContaining({ phase: 'takeover', browserId: 'browser-1' }),
      ]);
      expect(runner.run).not.toHaveBeenCalled();
      expect(door.parts).toEqual([]);
      expect(swept.notices).toEqual([]);
      expect((await offerRow(family.offerId))?.status).toBe('handed_back');
      const [card] = await linkRows(family.familyId);
      expect(card?.consumedAt).not.toBeNull();
      expect(card?.browserHandleCiphertext).toBeNull();
      expect(await takeoverLiveView(db.database, code, NEXT)).toEqual({
        ok: false,
        reason: 'used',
      });
    },
  );

  it('a parked plan whose yes stands keeps its lease and its browser', async () => {
    const { family, code } = await parkedCaptcha();
    const before = await offerRow(family.offerId);
    const resume = before?.planResume as TakeoverToken;

    const { runner, released } = runnerReturning();
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NEXT }, swept.deps);

    expect(released).toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
    const after = await offerRow(family.offerId);
    expect(after?.status).toBe('submitting');
    expect(after?.planLeaseUntil?.toISOString()).toBe(new Date(resume.expiresAt).toISOString());
    expect(await takeoverLiveView(db.database, code, NEXT)).toMatchObject({ ok: true });
  });

  it('a lease a sweep is driving with is never freed, even after a lapse', async () => {
    const { family } = await parkedCaptcha();
    const driven = new Date(NOW.getTime() + 15 * 60_000);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ planLeaseUntil: driven })
      .where(eq(schema.authorizedSignupOffers.id, family.offerId));
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: NOW })
      .where(eq(schema.families.id, family.familyId));

    expect(await freeLapsedParkedPlans(db.database)).toBe(0);
    expect((await offerRow(family.offerId))?.planLeaseUntil?.toISOString()).toBe(
      driven.toISOString(),
    );
  });

  it('a lapse read that throws frees nothing for that plan and still frees the next one', async () => {
    const first = await parkedCaptcha();
    const second = await parkedCaptcha();
    for (const family of [first.family, second.family]) {
      await db.database
        .update(schema.families)
        .set({ scheduledDeletionAt: NOW })
        .where(eq(schema.families.id, family.familyId));
    }
    let selects = 0;
    const flaky = new Proxy(db.database, {
      get(target, prop, receiver) {
        if (prop !== 'select') return Reflect.get(target, prop, receiver);
        return (...args: Parameters<typeof target.select>) => {
          selects += 1;
          if (selects === 2) throw new Error('read failed');
          return target.select(...args);
        };
      },
    });

    expect(await freeLapsedParkedPlans(flaky)).toBe(1);

    const leases = await Promise.all(
      [first.family, second.family].map(async (family) => {
        const row = await offerRow(family.offerId);
        return row?.planLeaseUntil ?? null;
      }),
    );
    expect(leases.filter((lease) => lease === null)).toHaveLength(1);
    expect(leases.filter((lease) => lease !== null)).toHaveLength(1);
  });
});

describe('VIL-718 · with the takeover link off', () => {
  it('ends a sign-in wall exactly as before: the live view in the notice, no card, no park', async () => {
    vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, 'true\n');
    const family = await plannedFamily();
    const stop = { ...stopAt('needs_login', 'login_wall'), holdExpiresAt: null };
    const { runner, inputs, released } = runnerReturning(stop);
    const door = takeoverDoor();
    const swept = sweepDeps(runner, door);
    const result = await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(inputs[0]?.takeover).toBe(false);
    expect((await offerRow(family.offerId))?.browserUseCostUsd).toBe(
      PLAN_RUN_ALLOWANCE_USD.toFixed(6),
    );
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      outcome: 'needs_login',
      detail: 'login_wall',
      notice: 'sent',
    });
    expect(swept.notices).toEqual([expect.objectContaining({ liveViewUrl: LIVE })]);
    expect(door.facts).toEqual([]);
    expect(await linkRows(family.familyId)).toEqual([]);
    expect(released).toEqual([]);
    expect((await offerRow(family.offerId))?.status).toBe('handed_back');
  });

  it('a captcha stop that carries a live view keeps it, as it does today', async () => {
    vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, 'false');
    const family = await plannedFamily();
    const { runner, released } = runnerReturning(stopAt('needs_human', 'captcha'));
    const swept = sweepDeps(runner);
    await runDueSignupPlans(db.database, { now: NOW }, swept.deps);

    expect(await linkRows(family.familyId)).toEqual([]);
    expect(released).toEqual([]);
    expect(swept.notices[0]).toMatchObject({ detail: 'captcha', liveViewUrl: LIVE });
  });

  it('a card already out still frees its browser at the next sweep once the yes lapses', async () => {
    const { family } = await parkedCaptcha();
    vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, undefined);
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: NOW })
      .where(eq(schema.families.id, family.familyId));
    const { runner, released } = runnerReturning();
    const door = takeoverDoor();
    const result = await runDueSignupPlans(
      db.database,
      { now: new Date(NOW.getTime() + 60_000) },
      sweepDeps(runner, door).deps,
    );

    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      detail: 'takeover_unfinished',
      notice: 'withheld',
    });
    expect(released).toHaveLength(1);
    expect(door.parts).toEqual([]);
  });

  it('a takeover already in flight still finishes: its lapse is told, and new cards stop', async () => {
    const { family } = await parkedCaptcha();
    vi.stubEnv(TAKEOVER_LINK_ENABLED_ENV, undefined);
    const { runner, released } = runnerReturning();
    const door = takeoverDoor();
    const late = new Date(NOW.getTime() + 14 * 60_000);
    const result = await runDueSignupPlans(
      db.database,
      { now: late },
      sweepDeps(runner, door).deps,
    );
    expect(result.plans.find((p) => p.offerId === family.offerId)).toMatchObject({
      detail: 'takeover_unfinished',
    });
    expect(released).toHaveLength(1);
    expect(door.facts[0]?.kind).toBe('takeover_unfinished');
  });
});
