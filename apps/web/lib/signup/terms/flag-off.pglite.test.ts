import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { browserUseApi } from '../browser-use/client';
import type { BrowserUseEngineDeps } from '../browser-use/engine';
import {
  BROWSER_USE_PLAN_OUTPUT_SCHEMA,
  BROWSER_USE_REVIEW_OUTPUT_SCHEMA,
} from '../browser-use/outcome';
import { type BrowserUsePlanInput, runBrowserUsePlanSignup } from '../browser-use/plan-engine';
import { offerSignupFromFacts } from '../offer-from-facts';
import { REGISTRATION_PLAN_RUN_ENABLED_ENV } from '../plan/flag';
import { type PlanReadOffer, signupPlanReadUserMessage } from '../plan/reader';
import {
  REGISTRATION_FREE_CHECKOUT_ENABLED_ENV,
  REGISTRATION_FREE_CHECKOUT_FAMILIES_ENV,
  registrationFreeCheckoutEnabled,
  registrationPreflightEnabled,
} from './flag';

const NOW = new Date('2026-02-01T12:00:00.000Z');
const URL_ =
  'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=15f6af07-39c5-473e-b053-96653f77a406&courseId=4241ad2f-9b67-464f-9f19-ad5f46d4a92d';
const SESSIONS = [
  {
    id: 's-1',
    label: 'Sat 9:30',
    startsAt: '2026-03-28T09:30:00',
    endsAt: '2026-03-28T10:30:00',
    full: false,
    priceCents: 8488,
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
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function askWith(value: string | undefined) {
  vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', value as string);
  const seeded = await seedFamily(db.database);
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 60, undefined, NOW);
  const fetchBody = vi.fn(async () => ({
    outcome: 'failed' as const,
    reason: 'timeout' as const,
  }));
  const reader = { read: vi.fn(async () => null) };
  const result = await offerSignupFromFacts(
    db.database,
    {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      childId,
      now: NOW,
      planOpensAt: new Date('2026-02-24T11:30:00.000Z'),
      activityLabel: 'Get Ready Public Speaking',
      facts: {
        source: 'chat',
        evidence: 'sign Ada up',
        registrationUrl: URL_,
        sessions: SESSIONS,
        approvedPriceCents: 8488,
        language: null,
      },
    },
    {
      planWriter: { write: async () => 'plan text' },
      terms: { fetchBody, preflightReader: reader },
    },
  );
  const rows = await db.database
    .select({ id: schema.authorizedSignupTerms.id })
    .from(schema.authorizedSignupTerms)
    .where(eq(schema.authorizedSignupTerms.familyId, seeded.familyId));
  return { result, fetchBody, reader, termsRows: rows.length };
}

describe('with the flag off', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['with a newline', 'true\n'],
    ['upper case', 'TRUE'],
    ['one', '1'],
  ])('%s: no page is read and no terms row is written', async (_name, value) => {
    const off = await askWith(value);
    expect(off.result.ok).toBe(true);
    expect(off.fetchBody).not.toHaveBeenCalled();
    expect(off.reader.read).not.toHaveBeenCalled();
    expect(off.termsRows).toBe(0);
  });

  it('exact true reads the page and stores the terms (positive control)', async () => {
    const on = await askWith('true');
    expect(on.result.ok).toBe(true);
    expect(on.fetchBody).toHaveBeenCalledTimes(1);
    expect(on.termsRows).toBe(1);
  });

  it('is off unless the plan lane is on too', () => {
    vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', 'true');
    vi.stubEnv(REGISTRATION_PLAN_RUN_ENABLED_ENV, '');
    expect(registrationPreflightEnabled('family-1')).toBe(false);
  });

  it('a family list narrows it to the families on the list', () => {
    vi.stubEnv('REGISTRATION_PREFLIGHT_ENABLED', 'true');
    vi.stubEnv('REGISTRATION_PREFLIGHT_FAMILIES', 'family-1, family-2');
    expect(registrationPreflightEnabled('family-2')).toBe(true);
    expect(registrationPreflightEnabled('family-3')).toBe(false);
  });

  it('an unbound run sends today task and today output schemas, byte for byte', async () => {
    const created: { task: string; outputSchema: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname.replace('/api/v4', '');
      const method = init.method ?? 'GET';
      if (method === 'POST' && path === '/runs') {
        created.push(JSON.parse(String(init.body)));
        return Response.json({ id: `run-${created.length}`, sessionId: 'bu-session-1' });
      }
      if (path.endsWith('/status')) return Response.json({ status: 'completed' });
      if (path.includes('/events')) {
        return Response.json({
          events: [
            {
              id: 1,
              type: 'browser.ready',
              data: {
                live_view_url: 'https://live.browser-use.com/s/fixture',
                browser_session_id: 'browser-1',
              },
            },
          ],
          nextAfter: null,
        });
      }
      if (path.startsWith('/runs/')) {
        const output =
          created.length === 1
            ? {
                outcome: 'reached_checkout',
                detail: 'none',
                choice_index: 0,
                checkout_url: 'https://register.example-rec.test/Checkout',
                cart_total_cents: 8488,
                cart_currency: 'cad',
                hold_minutes: 5,
                saved_card_on_file: true,
                security_code_required: false,
                payment_details_entered: false,
              }
            : {
                outcome: 'needs_human',
                detail: 'captcha',
                total_cents: null,
                currency: null,
                tax_cents: null,
                fees_cents: null,
                saved_card_selected: false,
                order_placed: false,
              };
        return Response.json({
          id: 'x',
          status: 'completed',
          sessionId: 'bu-session-1',
          output,
          error: null,
          totalCostUsd: '0.01',
        });
      }
      if (method === 'PATCH') return Response.json({});
      return Response.json({ sessionId: 'bu-session-1', totalCostUsd: '0.02' });
    });
    let clock = NOW.getTime();
    const deps: BrowserUseEngineDeps = {
      api: browserUseApi({ apiKey: 'test-key', fetch: fetchImpl }),
      seeder: null,
      loadTask: async (skill) => `# skill ${skill}`,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => new Date(clock),
    };
    const input: BrowserUsePlanInput = {
      mode: 'auto',
      correlationId: 'offer-fixture',
      registrationUrl: 'https://register.example-rec.test/Clients/x',
      identity: {
        childFirstName: 'Ada',
        childLastName: 'Lovelace',
        childDob: '2022-04-01',
        parentFirstName: 'Grace',
        parentEmail: 'grace@example.test',
        postalCode: 'A1A1A1',
        teenager: false,
      },
      fieldsAllowed: ['child_first_name', 'session'],
      choices: [{ label: 'Sat', startsAt: '2026-12-05T09:30:00', endsAt: '2026-12-05T10:30:00' }],
      maxPriceCents: 10_000,
      waiverAccepted: false,
      paymentEnabled: true,
      providerSession: { storageState: { cookies: [], origins: [] }, browserUseProfileId: 'p-1' },
      onProfileCreated: async () => undefined,
      proxyCountryCode: 'ca',
      credentials: null,
      accountCreate: false,
      joinWaitlist: false,
      askedStart: null,
      checkSpendingCap: async () => ({ ok: true, reason: 'within' }),
      stillAuthorized: async () => true,
      onStep: async () => undefined,
      resume: null,
      waitUntil: new Date(NOW.getTime() + 10 * 60_000),
      onCheckpoint: async () => true,
    };
    await runBrowserUsePlanSignup(input, deps);
    expect(created[0]?.task.startsWith('# skill browser-use-plan-signup\n')).toBe(true);
    expect(created[0]?.task).not.toContain('browser-use-cart-read');
    expect(created[0]?.outputSchema).toEqual(BROWSER_USE_PLAN_OUTPUT_SCHEMA);
    expect(created[1]?.task.startsWith('# skill browser-use-checkout-review\n')).toBe(true);
    expect(created[1]?.task).not.toContain('browser-use-cart-read');
    expect(created[1]?.outputSchema).toEqual(BROWSER_USE_REVIEW_OUTPUT_SCHEMA);
  });

  it('the plan read keeps its request when the ask has no terms', () => {
    const offer: PlanReadOffer = {
      status: 'pending',
      activity: 'Swim',
      host: 'example-rec.test',
      opensAt: NOW,
      sessions: SESSIONS,
      approvedPriceCents: null,
      plan: null,
      asksWaiver: false,
    };
    expect(signupPlanReadUserMessage({ text: 'yes', offer })).not.toContain('terms');
    expect(
      signupPlanReadUserMessage({
        text: 'yes',
        offer: {
          ...offer,
          terms: {
            sessionPrices: [{ sessionId: 's-1', cents: [8488] }],
            freeSessionIds: [],
          },
        },
      }),
    ).toContain('"terms"');
  });
});

describe('the free checkout switch', () => {
  it.each([
    ['on, and the family is listed', 'true', 'family-1,family-2', true],
    ['an empty list', 'true', '', false],
    ['another family', 'true', 'family-2', false],
    ['with a newline', 'true\n', 'family-1', false],
    ['upper case', 'TRUE', 'family-1', false],
    ['unset', undefined, 'family-1', false],
  ])('%s', (_name, flag, families, expected) => {
    vi.stubEnv(REGISTRATION_FREE_CHECKOUT_ENABLED_ENV, flag as string);
    vi.stubEnv(REGISTRATION_FREE_CHECKOUT_FAMILIES_ENV, families);
    expect(registrationFreeCheckoutEnabled('family-1')).toBe(expected);
  });
});
