import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { storeProviderSession } from '../browser-use/vault';
import { PROVIDER_CREDENTIALS_ENABLED_ENV } from '../credentials/flag';
import { PROVIDER_CREDENTIALS_MASTER_KEY_ENV } from '../credentials/kms';
import { markCredentialsStale, saveProviderCredentials } from '../credentials/store';
import { AUTHORIZED_SIGNUP_ENABLED_ENV } from '../flag';
import { lookupLoginLink } from '../login-link/store';
import { recordSignupOffer } from '../store';
import type { PlanNoticePart } from './bubbles';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from './flag';
import {
  PRE_OPEN_LEAD_MS,
  type PlanPrepFacts,
  plannedOfferDueForPrep,
  preOpenDueAt,
  runDueSignupPlanPrep,
  sendSignupPlanNotice,
} from './prep';
import { approveSignupPlan } from './store';

const NOW = new Date('2026-11-30T20:00:00.000Z');
const OPENS = new Date('2026-12-01T12:00:00.000Z');
const URL = 'https://haltonhills.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage';
const HOST = 'haltonhills.perfectmind.com';
const LOGIN_URL = /^https:\/\/app\.villagehale\.com\/l\/([0-9A-Za-z]{10})$/;
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

async function planned() {
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
    planOpensAt: OPENS,
    now: NOW,
  });
  if (!offer.ok) throw new Error(offer.reason);
  const approved = await approveSignupPlan(db.database, {
    offerId: offer.id,
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    messageId: 'msg-prep',
    choiceIds: ['sat-0900'],
    maxPriceCents: 10000,
    opensAt: OPENS,
    waiverAccepted: true,
    now: NOW,
  });
  expect(approved).toEqual({ ok: true });
  return { ...seeded, childId, offerId: offer.id };
}

function fakes() {
  const facts: PlanPrepFacts[] = [];
  const parts: PlanNoticePart[] = [];
  return {
    facts,
    parts,
    deps: {
      writer: {
        write: async (input: PlanPrepFacts) => {
          facts.push(input);
          return `text for ${input.kind}`;
        },
      },
      deliver: async (input: { parts: readonly PlanNoticePart[] }) => {
        parts.push(...input.parts);
        return 'sent' as const;
      },
    },
  };
}

/** {@link fakes}, keeping only one offer's parts: the sweep reads every planned offer. */
function fakesFor(offerId: string) {
  const all = fakes();
  const parts: PlanNoticePart[] = [];
  return {
    parts,
    deps: {
      writer: all.deps.writer,
      deliver: async (input: { offerId: string; parts: readonly PlanNoticePart[] }) => {
        if (input.offerId === offerId) parts.push(...input.parts);
        return 'sent' as const;
      },
    },
  };
}

function loginCode(part: PlanNoticePart | undefined): string {
  if (part?.type !== 'link') throw new Error(`expected a link part, got ${JSON.stringify(part)}`);
  const match = LOGIN_URL.exec(part.url);
  if (!match?.[1]) throw new Error(`not a login link: ${part.url}`);
  return match[1];
}

async function sentKinds(offerId: string): Promise<string[]> {
  const rows = await db.database
    .select({ kind: schema.providerLoginNotices.kind })
    .from(schema.providerLoginNotices)
    .where(eq(schema.providerLoginNotices.offerId, offerId));
  return rows.map((row) => row.kind).sort();
}

describe('plan prep before the open', () => {
  it('asks for the login with the one live card for the host, then account prep beside that card, then the 30-minute reminder', async () => {
    const family = await planned();
    await db.database
      .update(schema.users)
      .set({ timezone: 'America/Toronto', proactiveLanguage: 'zh' })
      .where(eq(schema.users.id, family.parentUserId));
    const row = await db.database
      .select()
      .from(schema.authorizedSignupOffers)
      .then((rows) => rows.find((r) => r.id === family.offerId));
    expect(row?.status).toBe('planned');
    expect(plannedOfferDueForPrep({ status: 'planned', planOpensAt: OPENS }, NOW)).toBe(true);
    expect(PRE_OPEN_LEAD_MS).toBe(30 * 60_000);
    expect(preOpenDueAt(OPENS).toISOString()).toBe('2026-12-01T11:30:00.000Z');

    // 12:00Z on 1 December is 7:00 in Toronto (EST, UTC-5).
    const opensAt = {
      local: 'Tuesday, December 1, 2026 at 7:00 a.m.',
      timeZone: 'America/Toronto',
    };
    const first = fakes();
    const login = await runDueSignupPlanPrep(db.database, { now: NOW }, first.deps);
    expect(login.notices).toEqual([
      { offerId: family.offerId, kind: 'login_ask', outcome: 'sent' },
    ]);
    expect(first.facts[0]).toMatchObject({
      kind: 'login_ask',
      opensAt,
      language: 'zh',
      host: HOST,
      sessionLabel: 'Preschool Swim Sat 9:00',
    });
    expect(first.parts[0]).toEqual({ type: 'text', body: 'text for login_ask' });
    const askCode = loginCode(first.parts[1]);
    expect(await lookupLoginLink(db.database, askCode, NOW)).toMatchObject({
      ok: true,
      providerHost: HOST,
      purpose: { kind: 'login_ask', sessionLabel: 'Preschool Swim Sat 9:00', opensAt },
    });

    // Account prep follows a sweep later. The login-ask card is still open, so it stays the
    // one live card for the host: account prep mints none and kills none.
    const second = fakes();
    const account = await runDueSignupPlanPrep(db.database, { now: NOW }, second.deps);
    expect(account.notices).toEqual([
      { offerId: family.offerId, kind: 'account_prep', outcome: 'sent' },
    ]);
    expect(second.parts).toEqual([{ type: 'text', body: 'text for account_prep' }]);
    expect(await lookupLoginLink(db.database, askCode, NOW)).toMatchObject({ ok: true });

    const tooSoon = fakes();
    const waiting = await runDueSignupPlanPrep(db.database, { now: NOW }, tooSoon.deps);
    expect(waiting.notices).toEqual([]);

    const reminderAt = preOpenDueAt(OPENS);
    const third = fakes();
    const reminder = await runDueSignupPlanPrep(db.database, { now: reminderAt }, third.deps);
    expect(reminder.notices).toEqual([
      { offerId: family.offerId, kind: 'pre_open', outcome: 'sent' },
    ]);
    expect(third.parts).toEqual([{ type: 'text', body: 'text for pre_open' }]);

    expect(await sentKinds(family.offerId)).toEqual(['account_prep', 'login_ask', 'pre_open']);
  });

  it('does not ask for a login the run can already use, and asks again once it goes stale', async () => {
    vi.stubEnv(PROVIDER_CREDENTIALS_ENABLED_ENV, 'true');
    vi.stubEnv(PROVIDER_CREDENTIALS_MASTER_KEY_ENV, Buffer.alloc(32, 9).toString('base64'));
    const family = await planned();
    expect(
      await saveProviderCredentials(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        providerHost: HOST,
        username: 'parent-login',
        password: 'fixture-pass',
        now: NOW,
      }),
    ).toEqual({ ok: true });

    const saved = fakes();
    expect((await runDueSignupPlanPrep(db.database, { now: NOW }, saved.deps)).notices).toEqual([]);
    expect(saved.parts).toEqual([]);
    const reminder = fakes();
    expect(
      (await runDueSignupPlanPrep(db.database, { now: preOpenDueAt(OPENS) }, reminder.deps))
        .notices,
    ).toEqual([{ offerId: family.offerId, kind: 'pre_open', outcome: 'sent' }]);

    // Positive control: the same family, once the saved password is stale, is asked.
    await markCredentialsStale(db.database, {
      familyId: family.familyId,
      providerHost: HOST,
      now: NOW,
    });
    const stale = fakes();
    expect((await runDueSignupPlanPrep(db.database, { now: NOW }, stale.deps)).notices).toEqual([
      { offerId: family.offerId, kind: 'login_ask', outcome: 'sent' },
    ]);
    expect(loginCode(stale.parts[1])).toMatch(/^[0-9A-Za-z]{10}$/);
  });

  it('counts a provider session only when it lasts through the open', async () => {
    const storageState = { cookies: [{ name: 'SID', value: 'c', domain: `.${HOST}` }] };
    const short = await planned();
    const shortSession = await storeProviderSession(db.database, {
      familyId: short.familyId,
      parentUserId: short.parentUserId,
      providerHost: HOST,
      storageState,
      capturedAt: new Date(OPENS.getTime() - 49 * 60 * 60_000),
    });
    expect(shortSession).toMatchObject({
      ok: true,
      expiresAt: new Date(OPENS.getTime() - 60 * 60_000),
    });
    const lasting = await planned();
    const lastingSession = await storeProviderSession(db.database, {
      familyId: lasting.familyId,
      parentUserId: lasting.parentUserId,
      providerHost: HOST,
      storageState,
      capturedAt: NOW,
    });
    expect(lastingSession.ok).toBe(true);

    const sweep = fakes();
    const result = await runDueSignupPlanPrep(db.database, { now: NOW }, sweep.deps);
    const kindFor = (offerId: string) =>
      result.notices.filter((n) => n.offerId === offerId).map((n) => n.kind);
    expect(kindFor(short.offerId)).toEqual(['login_ask']);
    expect(kindFor(lasting.offerId)).toEqual([]);
  });

  it('does not send when the model writes nothing', async () => {
    const family = await planned();
    const result = await runDueSignupPlanPrep(
      db.database,
      { now: NOW },
      {
        writer: { write: async () => null },
        deliver: async () => 'sent' as const,
      },
    );
    expect(result.notices.filter((n) => n.offerId === family.offerId)).toEqual([
      { offerId: family.offerId, kind: 'login_ask', outcome: 'unwritten' },
    ]);
    const notices = await db.database
      .select()
      .from(schema.providerLoginNotices)
      .where(eq(schema.providerLoginNotices.offerId, family.offerId));
    expect(notices).toEqual([]);
  });

  // These leave offers mid-prep, so they come last and read only their own offer's parts.
  it('gives account prep its own card once the login-ask card has expired', async () => {
    const family = await planned();
    const first = fakesFor(family.offerId);
    await runDueSignupPlanPrep(db.database, { now: NOW }, first.deps);
    const askCode = loginCode(first.parts[1]);

    const later = new Date(NOW.getTime() + 31 * 60_000);
    const second = fakesFor(family.offerId);
    const account = await runDueSignupPlanPrep(db.database, { now: later }, second.deps);
    expect(account.notices.filter((n) => n.offerId === family.offerId)).toEqual([
      { offerId: family.offerId, kind: 'account_prep', outcome: 'sent' },
    ]);
    const prepCode = loginCode(second.parts[1]);
    expect(await lookupLoginLink(db.database, prepCode, later)).toMatchObject({
      ok: true,
      purpose: { kind: 'account_prep' },
    });
    expect(await lookupLoginLink(db.database, askCode, later)).toEqual({
      ok: false,
      reason: 'used',
    });
  });

  it('names a notice that did not go, and leaves it for the next sweep', async () => {
    const family = await planned();
    const result = await runDueSignupPlanPrep(
      db.database,
      { now: NOW },
      { writer: fakes().deps.writer, deliver: async () => 'failed' as const },
    );
    expect(result.notices.filter((n) => n.offerId === family.offerId)).toEqual([
      { offerId: family.offerId, kind: 'login_ask', outcome: 'failed' },
    ]);
    expect(await sentKinds(family.offerId)).toEqual([]);
  });

  it('sends each bubble and puts a fresh login link after the first on a rejected password', async () => {
    const family = await planned();
    const parts: PlanNoticePart[] = [];
    const sent = await sendSignupPlanNotice(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        offerId: family.offerId,
        providerHost: HOST,
        kind: 'password_rejected',
        facts: {
          kind: 'password_rejected',
          childFirstName: 'Ada',
          opensAt: { local: '7:00', timeZone: 'UTC' },
          host: HOST,
          language: 'en',
          passwordRejectionMessage: 'Password must include a number',
          passwordRule: '8 characters and a number',
        },
        link: 'https://app.villagehale.com/l/AbCdef1234',
        linkAfter: 0,
        now: NOW,
      },
      {
        writer: {
          write: async () => [
            'They did not take that password.',
            'Their rule is eight and a number.',
          ],
        },
        deliver: async (input) => {
          parts.push(...input.parts);
          return 'sent' as const;
        },
      },
    );
    expect(sent).toBe(true);
    expect(parts).toEqual([
      { type: 'text', body: 'They did not take that password.' },
      { type: 'link', url: 'https://app.villagehale.com/l/AbCdef1234' },
      { type: 'text', body: 'Their rule is eight and a number.' },
    ]);
  });
});
