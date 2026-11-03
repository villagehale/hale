import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import {
  type MockInstance,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { BrowserUseEngineThrew, type BrowserUseSignupResult } from './browser-use/engine';
import { storeProviderSession } from './browser-use/vault';
import { SHAREABLE_SIGNUP_FIELDS, signupProviderHost } from './consent';
import { authorizedSignupHandler } from './handler';
import type { LinkWalletApi } from './link/client';
import type { SignupOutcomeFacts } from './outcome-reply';
import { signupInfoPack } from './pack';
import {
  BROWSER_USE_REGISTRATION_RESERVE_USD,
  BROWSER_USE_RUN_ALLOWANCE_USD,
  runAuthorizedSignup,
} from './run';
import { browserUseRegistrationSpendUsd, loadSignupIdentity, recordSignupOffer } from './store';
import { echoOutcomeWriter, renderEcho, stubConsentReader } from './test-models';
import type { PageSnapshot, SignupBrowser, SignupPage } from './types';

// The consent read and the reply are model calls. Tests stand in for both (no live calls).
vi.mock('./consent-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./consent-reader')>();
  const { stubConsentReader } = await import('./test-models');
  return { ...actual, createSignupConsentReader: () => stubConsentReader() };
});
vi.mock('./outcome-reply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./outcome-reply')>();
  const { echoOutcomeWriter } = await import('./test-models');
  return { ...actual, createSignupOutcomeWriter: () => echoOutcomeWriter() };
});

const NOW = new Date('2026-09-29T15:00:00.000Z');
const ORIGIN = 'http://127.0.0.1';
// Invented: no Canadian postal code starts with Z.
const POSTAL = 'Z9Z9Z9';

const SAFE: PageSnapshot = {
  href: `${ORIGIN}/register`,
  captcha: false,
  confirmed: false,
  priceCents: [],
  formText: '',
  waitingRoom: false,
  controls: [
    {
      name: 'child_first_name',
      type: 'text',
      required: true,
      label: 'Child first name',
      autocomplete: null,
      options: [],
    },
    {
      name: 'parent_email',
      type: 'email',
      required: true,
      label: 'Parent email',
      autocomplete: null,
      options: [],
    },
    {
      name: 'postal_code',
      type: 'text',
      required: true,
      label: 'Postal code',
      autocomplete: null,
      options: [],
    },
    {
      name: 'session',
      type: 'select',
      required: true,
      label: 'Session',
      autocomplete: null,
      options: [{ value: 'tue-1630', label: 'Tue 4:30', disabled: false }],
    },
  ],
};

function browserFor(first: PageSnapshot, afterSubmit?: PageSnapshot) {
  const calls = { opened: 0, submitted: 0 };
  const browser: SignupBrowser = {
    async open(): Promise<SignupPage> {
      calls.opened += 1;
      let submitted = false;
      return {
        async snapshot() {
          return submitted && afterSubmit ? afterSubmit : first;
        },
        async fill() {},
        async select() {},
        async continue() {},
        async submit() {
          calls.submitted += 1;
          submitted = true;
        },
        async close() {},
      };
    },
  };
  return { browser, calls };
}

function postedCall(fetchImpl: { mock: { calls: readonly unknown[] } }): [unknown, RequestInit] {
  const calls = fetchImpl.mock.calls as unknown as unknown[][];
  const call = calls[0];
  if (!call || call.length < 2) throw new Error('expected a sandbox fetch call');
  return [call[0], call[1] as RequestInit];
}

describe('authorized signup runner', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(() => {
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
    vi.stubEnv('BOOKING_REFERENCE_CONNECTOR_ENABLED', '');
    vi.stubEnv('BOOKING_REFERENCE_CONNECTOR_BASE_URL', '');
  });

  async function familyWithOffer(input: {
    ageMonths: number;
    sessions?: {
      id: string;
      label: string;
      startsAt: string;
      endsAt: string;
      full: boolean;
      priceCents: number | null;
    }[];
    url?: string;
    approvedPriceCents?: number | null;
  }) {
    const seeded = await seedFamily(db.database);
    await db.database
      .update(schema.families)
      .set({ postalCode: POSTAL })
      .where(eq(schema.families.id, seeded.familyId));
    const childId = await seedChild(
      db.database,
      seeded.familyId,
      'Ada',
      input.ageMonths,
      undefined,
      NOW,
    );
    const stored = await recordSignupOffer(db.database, {
      familyId: seeded.familyId,
      childId,
      parentUserId: seeded.parentUserId,
      activityKey: 'swim-parent-tot',
      registrationUrl: input.url ?? `${ORIGIN}/register`,
      sessions: input.sessions ?? [
        {
          id: 'tue-1630',
          label: 'Tue 4:30',
          startsAt: '2026-10-06T20:30:00.000Z',
          endsAt: '2026-10-06T21:15:00.000Z',
          full: false,
          priceCents: null,
        },
      ],
      approvedPriceCents: input.approvedPriceCents ?? null,
      now: NOW,
    });
    expect(stored.ok).toBe(true);
    return seeded;
  }

  async function audits(familyId: string): Promise<string> {
    const rows = await db.database
      .select({ after: schema.auditLog.after, actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    return JSON.stringify(rows);
  }

  it('does not open a browser for a bare yes', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser, calls } = browserFor(SAFE, { ...SAFE, confirmed: true });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'yes',
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.claimed).toBe(false);
    expect(calls.opened).toBe(0);
  });

  it('reads consent with the model in any language and script, beside the offer', async () => {
    for (const [body, id] of [
      ['好的，帮我们报名吧', 'msg-zh'],
      ['네, 등록해 주세요', 'msg-ko'],
      ['go ahead and book it', 'msg-en'],
    ] as const) {
      const seeded = await familyWithOffer({ ageMonths: 36 });
      const { browser, calls } = browserFor(SAFE, { ...SAFE, confirmed: true });
      const consentReader = stubConsentReader(() => ({ verdict: 'consent', sessionId: null }));
      const outcomeWriter = echoOutcomeWriter();
      const result = await runAuthorizedSignup(
        db.database,
        {
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          body,
          inboundChannelMessageId: id,
          existingThread: true,
          now: NOW,
        },
        { browser, consentReader, outcomeWriter },
      );
      expect(consentReader.calls).toEqual([body]);
      expect(result.outcome).toBe('completed');
      expect(calls.submitted).toBe(1);
      expect(outcomeWriter.facts[0]).toMatchObject({ outcome: 'completed', confirmed: true });
    }
  });

  it('asks the clarifying question and opens no browser when the reply is unclear', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser, calls } = browserFor(SAFE);
    const outcomeWriter = echoOutcomeWriter();
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'hmm maybe, is it the Tuesday one?',
        inboundChannelMessageId: 'msg-unclear',
        existingThread: true,
        now: NOW,
      },
      {
        browser,
        outcomeWriter,
        consentReader: stubConsentReader(() => ({
          verdict: 'unclear',
          question: 'Want me to book the Tue 4:30 session?',
        })),
      },
    );
    expect(result).toMatchObject({ claimed: true, outcome: 'clarify', deliverOnThread: true });
    expect(outcomeWriter.facts[0]).toMatchObject({
      outcome: 'clarify',
      confirmed: false,
      question: 'Want me to book the Tue 4:30 session?',
    });
    expect(calls.opened).toBe(0);
    const [offer] = await db.database
      .select({ status: schema.authorizedSignupOffers.status })
      .from(schema.authorizedSignupOffers)
      .where(eq(schema.authorizedSignupOffers.familyId, seeded.familyId));
    expect(offer?.status).toBe('pending');
  });

  it('closes the offer and opens no browser on a refusal', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser, calls } = browserFor(SAFE);
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: '先不用了，我自己来',
        inboundChannelMessageId: 'msg-no',
        existingThread: true,
        now: NOW,
      },
      { browser, consentReader: stubConsentReader(() => ({ verdict: 'decline' })) },
    );
    expect(result.outcome).toBe('declined');
    expect(calls.opened).toBe(0);
    const [offer] = await db.database
      .select({ status: schema.authorizedSignupOffers.status })
      .from(schema.authorizedSignupOffers)
      .where(eq(schema.authorizedSignupOffers.familyId, seeded.familyId));
    expect(offer?.status).toBe('handed_back');
  });

  it('does not claim the message when the consent read is unreadable (no model)', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser, calls } = browserFor(SAFE);
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-null',
        existingThread: true,
        now: NOW,
      },
      { browser, consentReader: stubConsentReader(() => null) },
    );
    expect(result.claimed).toBe(false);
    expect(calls.opened).toBe(0);
  });

  it('sends nothing when the reply model writes nothing: there is no fixed fallback', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser } = browserFor(SAFE, { ...SAFE, confirmed: true });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-nowriter',
        existingThread: true,
        now: NOW,
      },
      { browser, outcomeWriter: { write: async () => null } },
    );
    expect(result).toMatchObject({ outcome: 'completed', reply: null, deliverOnThread: false });
  });

  it('reports unconfirmed, never completed, when the page after submit shows no confirmation', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser } = browserFor(SAFE, { ...SAFE, confirmed: false });
    const outcomeWriter = echoOutcomeWriter();
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-unconf',
        existingThread: true,
        now: NOW,
      },
      { browser, outcomeWriter },
    );
    expect(result.outcome).toBe('unconfirmed');
    expect(outcomeWriter.facts[0]?.confirmed).toBe(false);
  });

  it('does not enroll when the flag is off', async () => {
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', '');
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser, calls } = browserFor(SAFE);
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result).toMatchObject({ claimed: false, outcome: 'flag_off' });
    expect(calls.opened).toBe(0);
  });

  it('stops before the browser when two sessions fit', async () => {
    const seeded = await familyWithOffer({
      ageMonths: 36,
      sessions: [
        {
          id: 'tue-1630',
          label: 'Tue 4:30',
          startsAt: '2026-10-06T20:30:00.000Z',
          endsAt: '2026-10-06T21:15:00.000Z',
          full: false,
          priceCents: null,
        },
        {
          id: 'wed-1000',
          label: 'Wed 10:00',
          startsAt: '2026-10-07T14:00:00.000Z',
          endsAt: '2026-10-07T14:45:00.000Z',
          full: false,
          priceCents: null,
        },
      ],
    });
    const { browser, calls } = browserFor(SAFE);
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'sign us up',
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('ambiguous_session');
    expect(result.reply).toContain('outcome=ambiguous_session');
    expect(calls.opened).toBe(0);
    expect(await audits(seeded.familyId)).not.toContain('Ada');
  });

  it("enrolls a teenager on the parent's yes", async () => {
    const seeded = await familyWithOffer({ ageMonths: 14 * 12 });
    const { browser, calls } = browserFor(SAFE);
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-teen',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).not.toBe('teen_privacy');
    expect(calls.opened).toBe(1);
    expect(await audits(seeded.familyId)).not.toContain('Ada');
  });

  it('does not enroll when reporting would start a new 1:1', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser, calls } = browserFor(SAFE);
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: null,
        existingThread: false,
        now: NOW,
      },
      { browser },
    );
    expect(result).toMatchObject({
      outcome: 'would_initiate_1_1',
      deliverOnThread: false,
      reply: null,
    });
    expect(calls.opened).toBe(0);
  });

  it('hands back on a card field without submitting', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser, calls } = browserFor({
      ...SAFE,
      controls: [
        ...SAFE.controls,
        {
          name: 'card_number',
          type: 'text',
          required: true,
          label: 'Card number',
          autocomplete: 'cc-number',
          options: [],
        },
      ],
    });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-1',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('payment');
    expect(result.reply).toContain('outcome=payment');
    expect(calls.opened).toBe(1);
    expect(calls.submitted).toBe(0);
    const trail = await audits(seeded.familyId);
    expect(trail).not.toContain('Ada');
    expect(trail).not.toContain('@');
    expect(trail).toContain('payment');
  });

  it('completes one authorized session and reports on the existing thread', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser, calls } = browserFor(SAFE, { ...SAFE, confirmed: true });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-2',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('completed');
    expect(result.deliverOnThread).toBe(true);
    expect(result.reply).toContain('outcome=completed reason= confirmed=true session=Tue 4:30');
    expect(result.reply).not.toContain('TODO-Design');
    expect(calls.submitted).toBe(1);
    const trail = await audits(seeded.familyId);
    expect(trail).toContain('tue-1630');
    expect(trail).not.toContain('Ada');
    expect(trail).not.toContain('@');
    const [consent] = await db.database
      .select()
      .from(schema.authorizedSignupConsents)
      .where(eq(schema.authorizedSignupConsents.familyId, seeded.familyId));
    expect(consent).toMatchObject({
      familyId: seeded.familyId,
      messageId: 'msg-2',
      activityKey: 'swim-parent-tot',
      providerHost: '127.0.0.1',
      fieldsAllowed: [
        'child_first_name',
        'child_dob',
        'parent_first_name',
        'parent_email',
        'postal_code',
        'session',
        'visit_date',
      ],
    });
    expect(consent?.createdAt).toEqual(NOW);
    const stored = JSON.stringify(consent);
    expect(stored).not.toContain('Ada');
    expect(stored).not.toContain('Test Parent');
    expect(stored).not.toContain('@');
    expect(consent?.fieldsAllowed.join(' ')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('books a private host in the sandbox browser', async () => {
    const href = 'https://tickets.example-zoo.test/book';
    const seeded = await familyWithOffer({ ageMonths: 36, url: href });
    const page = { ...SAFE, href };
    const { browser, calls } = browserFor(page, { ...page, confirmed: true });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-private',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('completed');
    expect(calls.opened).toBe(1);
    expect(calls.submitted).toBe(1);
  });

  it('uses a connector and does not open the browser', async () => {
    const href = 'https://book.example-swim.test/lessons';
    const seeded = await familyWithOffer({ ageMonths: 36, url: href });
    const { browser, calls } = browserFor(SAFE);
    let seenSession = '';
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-connector',
        existingThread: true,
        now: NOW,
      },
      {
        browser,
        connectors: [
          {
            id: 'example-swim-api',
            matches: (url) => url.hostname === 'book.example-swim.test',
            book: async (booking) => {
              seenSession = booking.sessionId;
              return { ok: true };
            },
          },
        ],
      },
    );
    expect(result.outcome).toBe('completed');
    expect(seenSession).toBe('tue-1630');
    expect(calls.opened).toBe(0);
    expect(await audits(seeded.familyId)).not.toContain('Ada');
  });

  it('returns connector_failed and does not fall through to the browser', async () => {
    const href = 'https://book.example-swim.test/lessons';
    const seeded = await familyWithOffer({ ageMonths: 36, url: href });
    const { browser, calls } = browserFor({ ...SAFE, href }, { ...SAFE, href, confirmed: true });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-connector-failed',
        existingThread: true,
        now: NOW,
      },
      {
        browser,
        connectors: [
          {
            id: 'example-swim-api',
            matches: (url) => url.hostname === 'book.example-swim.test',
            book: async () => {
              throw new Error('partner down');
            },
          },
        ],
      },
    );
    expect(result.outcome).toBe('connector_failed');
    expect(result.reply).toContain('confirmed=false');
    expect(result.reply).not.toMatch(/\bSTOP\b/);
    expect(result.reply).not.toContain('TODO-Design');
    expect(calls.opened).toBe(0);
    expect(calls.submitted).toBe(0);
    expect(await audits(seeded.familyId)).not.toContain('Ada');
  });

  it('does not open a browser when the session price was not approved', async () => {
    const seeded = await familyWithOffer({
      ageMonths: 36,
      sessions: [
        {
          id: 'sat-1100',
          label: 'Sat 11:00',
          startsAt: '2026-10-10T15:00:00.000Z',
          endsAt: '2026-10-10T16:00:00.000Z',
          full: false,
          priceCents: 1800,
        },
      ],
    });
    const { browser, calls } = browserFor(SAFE);
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('price_not_approved');
    expect(calls.opened).toBe(0);
  });

  it('hands back when the page price changed after approval', async () => {
    const seeded = await familyWithOffer({
      ageMonths: 36,
      approvedPriceCents: 1800,
      sessions: [
        {
          id: 'sat-1100',
          label: 'Sat 11:00',
          startsAt: '2026-10-10T15:00:00.000Z',
          endsAt: '2026-10-10T16:00:00.000Z',
          full: false,
          priceCents: 1800,
        },
      ],
    });
    const { browser, calls } = browserFor({ ...SAFE, priceCents: [2400] });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-price',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('price_change');
    expect(calls.opened).toBe(1);
    expect(calls.submitted).toBe(0);
    expect(await audits(seeded.familyId)).not.toContain('Ada');
  });

  it('stops a booking form that asks for a waiver and does not submit', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser, calls } = browserFor({
      ...SAFE,
      formText: 'Please sign the waiver to continue',
    });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-waiver',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('waiver');
    expect(result.reply).toContain('outcome=waiver');
    expect(calls.opened).toBe(1);
    expect(calls.submitted).toBe(0);
    expect(await audits(seeded.familyId)).not.toContain('Ada');
  });

  it('walks a ticket cart from the date to the time slot without a second host', async () => {
    const href = 'https://tickets.example-museum.test/cart';
    const seeded = await familyWithOffer({
      ageMonths: 36,
      url: href,
      approvedPriceCents: 1800,
      sessions: [
        {
          id: 'sat-1100',
          label: 'Sat 11:00',
          startsAt: '2026-10-10T15:00:00.000Z',
          endsAt: '2026-10-10T16:00:00.000Z',
          full: false,
          priceCents: 1800,
        },
      ],
    });
    const datePage: PageSnapshot = {
      href,
      captcha: false,
      confirmed: false,
      priceCents: [1800],
      formText: '',
      waitingRoom: false,
      controls: [
        {
          name: 'visit_date',
          type: 'select',
          required: true,
          label: 'Visit date',
          autocomplete: null,
          options: [{ value: '2026-10-10', label: 'Sat Oct 10', disabled: false }],
        },
      ],
    };
    const timePage: PageSnapshot = {
      ...datePage,
      href: `${href}/time`,
      controls: [
        {
          name: 'guest_name',
          type: 'text',
          required: true,
          label: 'Your name',
          autocomplete: null,
          options: [],
        },
        {
          name: 'showtime',
          type: 'select',
          required: true,
          label: 'Showtime',
          autocomplete: null,
          options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
        },
      ],
    };
    const calls = { opened: 0, continued: 0, submitted: 0 };
    let index = 0;
    let submitted = false;
    const browser: SignupBrowser = {
      async open(): Promise<SignupPage> {
        calls.opened += 1;
        return {
          async snapshot() {
            if (submitted) return { ...timePage, confirmed: true };
            return index === 0 ? datePage : timePage;
          },
          async fill() {},
          async select() {},
          async continue() {
            calls.continued += 1;
            index += 1;
          },
          async submit() {
            calls.submitted += 1;
            submitted = true;
          },
          async close() {},
        };
      },
    };
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-cart',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('completed');
    expect(calls).toEqual({ opened: 1, continued: 1, submitted: 1 });
    expect(await audits(seeded.familyId)).not.toContain('Ada');
  });

  it('sends the result to the co-parent group and not as a new 1:1 reply', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: 'group-chat-1' })
      .where(eq(schema.families.id, seeded.familyId));
    const { browser } = browserFor(SAFE, { ...SAFE, confirmed: true });
    const sent: string[] = [];
    const handler = authorizedSignupHandler({
      browser,
      deliverGroup: async (item) => {
        sent.push(item.chatId);
        expect(item.body).toContain('outcome=completed reason= confirmed=true session=Tue 4:30');
        return 'sent';
      },
    });
    const verdict = await handler.handle(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      conversationId: 'conv-1',
      body: 'Yes, sign us up',
      now: NOW,
      send: async () => {
        throw new Error('handler must not send a 1:1 itself');
      },
      resolved: null,
      openQuestions: async () => [],
      inboundChannelMessageId: 'msg-3',
    });
    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed) return;
    expect(verdict.reply).toBeNull();
    expect(sent).toEqual(['group-chat-1']);
  });

  it('hands back before a browser or a pack when the yes has no message id', async () => {
    const seeded = await familyWithOffer({
      ageMonths: 36,
      url: 'https://register.example-city.test/recreation/registrations',
    });
    const { browser, calls } = browserFor(SAFE, { ...SAFE, confirmed: true });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('consent_missing');
    expect(result.reply).toContain('outcome=consent_missing');
    expect(result.reply).not.toContain('Ada');
    expect(result.reply).not.toContain(POSTAL);
    expect(result.reply).not.toContain('TODO-Design');
    expect(calls.opened).toBe(0);
    const rows = await db.database
      .select({ id: schema.authorizedSignupConsents.id })
      .from(schema.authorizedSignupConsents)
      .where(eq(schema.authorizedSignupConsents.familyId, seeded.familyId));
    expect(rows).toEqual([]);
  });

  it('hands back when the consent field list is wider than the typed slots', async () => {
    const seeded = await familyWithOffer({
      ageMonths: 36,
      url: 'https://swim.example-school.test/register',
    });
    await db.database.insert(schema.authorizedSignupConsents).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      messageId: 'msg-wider',
      activityKey: 'swim-parent-tot',
      providerHost: 'swim.example-school.test',
      fieldsAllowed: [...SHAREABLE_SIGNUP_FIELDS],
      createdAt: NOW,
    });
    const { browser, calls } = browserFor(SAFE);
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-wider',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('consent_wider');
    expect(result.reply).not.toContain('Ada');
    expect(result.reply).not.toContain(POSTAL);
    expect(result.reply).not.toContain('@');
    expect(calls.opened).toBe(0);
  });

  it('hands back before the browser when the grant omits a slot that would be typed', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    await db.database.insert(schema.authorizedSignupConsents).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      messageId: 'msg-short',
      activityKey: 'swim-parent-tot',
      providerHost: '127.0.0.1',
      fieldsAllowed: ['session'],
      createdAt: NOW,
    });
    const { browser, calls } = browserFor(SAFE, { ...SAFE, confirmed: true });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-short',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('consent_short');
    expect(calls.opened).toBe(0);
    expect(calls.submitted).toBe(0);
    expect(result.reply).not.toContain('Ada');
  });

  it('collapses a padded session label on the completed line', async () => {
    const seeded = await familyWithOffer({
      ageMonths: 36,
      sessions: [
        {
          id: 'tue-1630',
          label: '  Tue   4:30 \n',
          startsAt: '2026-10-06T20:30:00.000Z',
          endsAt: '2026-10-06T21:15:00.000Z',
          full: false,
          priceCents: null,
        },
      ],
    });
    const { browser } = browserFor(SAFE, { ...SAFE, confirmed: true });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-label',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('completed');
    expect(result.reply).toContain('outcome=completed reason= confirmed=true session=Tue 4:30');
  });

  it('uses the sandbox partnership connector before the browser when the flag is on', async () => {
    vi.stubEnv('BOOKING_REFERENCE_CONNECTOR_ENABLED', 'on');
    vi.stubEnv('BOOKING_REFERENCE_CONNECTOR_BASE_URL', 'https://api.sandbox-partner.test');
    const href = 'https://book.sandbox-partner.test/lessons';
    const seeded = await familyWithOffer({ ageMonths: 36, url: href });
    const { browser, calls } = browserFor({ ...SAFE, href }, { ...SAFE, href, confirmed: true });
    const fetchMock = vi.fn(async () => Response.json({ status: 'booked', id: 'sb_1' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await runAuthorizedSignup(
        db.database,
        {
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          body: 'Yes, sign us up',
          inboundChannelMessageId: 'msg-sandbox-booked',
          existingThread: true,
          now: NOW,
        },
        { browser },
      );
      expect(result.outcome).toBe('completed');
      expect(result.reply).toContain('outcome=completed reason= confirmed=true session=Tue 4:30');
      expect(result.reply).not.toMatch(/\bSTOP\b/);
      expect(result.reply).not.toContain('TODO-Design');
      expect(calls.opened).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = postedCall(fetchMock);
      expect(String(url)).toBe('https://api.sandbox-partner.test/v1/bookings');
      const headers = init.headers as Record<string, string>;
      expect(headers).not.toHaveProperty('authorization');
      const body = JSON.parse(String(init.body)) as {
        slots: { slot: string; value: string }[];
      };
      expect(body.slots.map((slot) => slot.slot)).toContain('child_first_name');
      expect(body.slots.map((slot) => slot.slot)).toContain('session');
      expect(body.slots.map((slot) => slot.slot)).not.toContain('phone');
      expect(JSON.stringify(body)).not.toMatch(/card|cvv|payment/i);
      const trail = await audits(seeded.familyId);
      expect(trail).toContain('sandbox-partnership');
      expect(trail).not.toContain('Ada');
      expect(trail).not.toContain('@');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns connector_failed from the sandbox connector and does not open the browser', async () => {
    vi.stubEnv('BOOKING_REFERENCE_CONNECTOR_ENABLED', 'on');
    vi.stubEnv('BOOKING_REFERENCE_CONNECTOR_BASE_URL', 'https://api.sandbox-partner.test');
    const href = 'https://book.sandbox-partner.test/lessons';
    const seeded = await familyWithOffer({ ageMonths: 36, url: href });
    const { browser, calls } = browserFor({ ...SAFE, href }, { ...SAFE, href, confirmed: true });
    const fetchMock = vi.fn(async () => new Response('no', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await runAuthorizedSignup(
        db.database,
        {
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          body: 'Yes, sign us up',
          inboundChannelMessageId: 'msg-sandbox-failed',
          existingThread: true,
          now: NOW,
        },
        { browser },
      );
      expect(result.outcome).toBe('connector_failed');
      expect(result.reply).toContain('confirmed=false');
      expect(result.reply).toContain(href);
      expect(result.reply).not.toMatch(/\bSTOP\b/);
      expect(result.reply).not.toContain('TODO-Design');
      expect(calls.opened).toBe(0);
      expect(calls.submitted).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the sandbox host on the browser when the reference flag is off', async () => {
    const href = 'https://book.sandbox-partner.test/lessons';
    const seeded = await familyWithOffer({ ageMonths: 36, url: href });
    const page = { ...SAFE, href };
    const { browser, calls } = browserFor(page, { ...page, confirmed: true });
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch must not run');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await runAuthorizedSignup(
        db.database,
        {
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          body: 'Yes, sign us up',
          inboundChannelMessageId: 'msg-sandbox-off',
          existingThread: true,
          now: NOW,
        },
        { browser },
      );
      expect(result.outcome).toBe('completed');
      expect(calls.opened).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('hands a timed open to the parent with the open time, the link and the prefill', async () => {
    const seeded = await familyWithOffer({ ageMonths: 36 });
    const { browser } = browserFor({
      ...SAFE,
      timedOpen: true,
      formText: 'Registration opens on Monday, January 5 at 7:00 AM',
    });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-rush',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('timed_open');
    expect(result.rush).toMatchObject({
      signal: 'timed_open',
      opensAt: 'Monday, January 5 at 7:00 AM',
      link: `${ORIGIN}/register`,
    });
    expect(result.rush?.prefill).toContainEqual({ slot: 'child_first_name', value: 'Ada' });
    const log = await audits(seeded.familyId);
    expect(log).toContain('Monday, January 5 at 7:00 AM');
    expect(log).not.toContain('Ada');
  });

  describe('browser use engine (T8)', () => {
    const CHECKOUT = {
      outcome: 'reached_checkout' as const,
      detail: 'none' as const,
      liveViewUrl: 'https://live.browser-use.com/s/fixture-live-view-token',
      checkoutUrl: 'https://anc.ca.apm.activecommunities.com/exampleville/checkout',
      holdExpiresAt: new Date('2026-10-05T12:10:00.000Z'),
      cartTotalCents: 9800,
      confirmationNumber: null,
      opensAt: null,
      amountChargedCents: null,
      runId: 'run-fixture',
      sessionId: 'bu-session-fixture',
      costUsd: '0.0243',
      sessionCostUsd: null,
      browserId: null,
    };
    const ACTIVENET =
      'https://anc.ca.apm.activecommunities.com/exampleville/activity/search/detail/123';

    beforeEach(async () => {
      // Each run holds its allowance against the shared $25 reserve; start every test clean.
      await db.database.update(schema.authorizedSignupOffers).set({ browserUseCostUsd: null });
      vi.stubEnv('BROWSER_USE_SIGNUP_ENABLED', 'true');
      vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    });

    async function withProviderSession(
      seeded: { familyId: string; parentUserId: string },
      providerHost = 'anc.ca.apm.activecommunities.com',
    ) {
      const result = await storeProviderSession(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        providerHost,
        storageState: {
          cookies: [{ name: 'JSESSIONID', value: 'c', domain: '.activecommunities.com' }],
        },
        capturedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      });
      expect(result.ok).toBe(true);
    }

    function yes(seeded: { familyId: string; parentUserId: string }, messageId: string) {
      return {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: messageId,
        existingThread: true,
        now: NOW,
      };
    }

    it('drives an ActiveNet host to checkout and returns the live view with no fixed copy', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      const { browser, calls } = browserFor(SAFE);
      const run = vi.fn(async () => CHECKOUT);
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-1'), {
        browser,
        browserUseSignup: { run },
      });
      expect(result).toMatchObject({
        claimed: true,
        outcome: 'reached_checkout',
        deliverOnThread: true,
      });
      expect(result.reply).toContain('outcome=reached_checkout');
      expect(result.browserUse?.liveViewUrl).toBe(CHECKOUT.liveViewUrl);
      expect(calls.opened).toBe(0);
      const [engineInput] = run.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(engineInput).toMatchObject({ registrationUrl: ACTIVENET });
      const [offer] = await db.database
        .select({ status: schema.authorizedSignupOffers.status })
        .from(schema.authorizedSignupOffers)
        .where(eq(schema.authorizedSignupOffers.familyId, seeded.familyId));
      expect(offer?.status).toBe('handed_back');
      const log = await audits(seeded.familyId);
      expect(log).toContain('browser_use');
      expect(log).not.toContain('fixture-live-view-token');
      expect(log).not.toContain('Ada');
    });

    it('passes the Link wallet only after the spending cap, and records a paid sign-up', async () => {
      vi.stubEnv('BROWSER_USE_SIGNUP_PAYMENT_ENABLED', 'true');
      const seeded = await familyWithOffer({
        ageMonths: 36,
        url: ACTIVENET,
        approvedPriceCents: 9800,
      });
      await withProviderSession(seeded);
      const wallet = {
        kind: 'stripe_link_agent_wallet' as const,
        api: linkApiStub(),
        approvalWindowMinutes: 5,
      };
      const checkSpendingCap = vi.fn(async () => ({ ok: true, reason: 'within cap' }));
      const run = vi.fn(async () => ({
        ...CHECKOUT,
        outcome: 'completed' as const,
        liveViewUrl: null,
        confirmationNumber: 'R-55120',
        amountChargedCents: 9800,
      }));
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-pay'), {
        browserUseSignup: { run },
        paymentWallet: { forParent: async () => ({ wallet, skipped: null }) },
        checkSpendingCap,
      });
      expect(result.outcome).toBe('completed');
      expect(checkSpendingCap).toHaveBeenCalledWith(seeded.familyId, {
        amountUsd: expect.any(Number),
        category: 'registration',
      });
      const [engineInput] = run.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(engineInput.payment).toEqual(wallet);
      const [offer] = await db.database
        .select({ status: schema.authorizedSignupOffers.status })
        .from(schema.authorizedSignupOffers)
        .where(eq(schema.authorizedSignupOffers.familyId, seeded.familyId));
      expect(offer?.status).toBe('completed');
      const log = await audits(seeded.familyId);
      expect(log).toContain('"confirmed":true');
    });

    it('stops at checkout with no wallet when the spending cap rejects', async () => {
      vi.stubEnv('BROWSER_USE_SIGNUP_PAYMENT_ENABLED', 'true');
      const seeded = await familyWithOffer({
        ageMonths: 36,
        url: ACTIVENET,
        approvedPriceCents: 9800,
      });
      await withProviderSession(seeded);
      const forParent = vi.fn();
      const run = vi.fn(async () => CHECKOUT);
      await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-cap'), {
        browserUseSignup: { run },
        paymentWallet: { forParent },
        checkSpendingCap: async () => ({ ok: false, reason: 'over cap' }),
      });
      const [engineInput] = run.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(engineInput.payment).toBeNull();
      expect(forParent).not.toHaveBeenCalled();
      expect(await audits(seeded.familyId)).toContain('"paymentSkipped":"spending_cap"');
    });

    it('caps a sign-up payment at the approved price and never above $500', async () => {
      vi.stubEnv('BROWSER_USE_SIGNUP_PAYMENT_ENABLED', 'true');
      const seeded = await familyWithOffer({
        ageMonths: 36,
        url: ACTIVENET,
        approvedPriceCents: 60000,
      });
      await withProviderSession(seeded);
      const forParent = vi.fn();
      const run = vi.fn(async () => CHECKOUT);
      await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-ceiling'), {
        browserUseSignup: { run },
        paymentWallet: { forParent },
      });
      const [engineInput] = run.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(engineInput.payment).toBeNull();
      expect(forParent).not.toHaveBeenCalled();
      expect(await audits(seeded.familyId)).toContain('"paymentSkipped":"spending_cap"');
    });

    it('asks the yes-saying parent for their own Link wallet, not a shared one', async () => {
      vi.stubEnv('BROWSER_USE_SIGNUP_PAYMENT_ENABLED', 'true');
      const seeded = await familyWithOffer({
        ageMonths: 36,
        url: ACTIVENET,
        approvedPriceCents: 9800,
      });
      await withProviderSession(seeded);
      const forParent = vi.fn(async () => ({ wallet: null, skipped: 'not_linked' as const }));
      const run = vi.fn(async () => CHECKOUT);
      await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-own'), {
        browserUseSignup: { run },
        paymentWallet: { forParent },
      });
      expect(forParent).toHaveBeenCalledWith({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        now: NOW,
      });
      const [engineInput] = run.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(engineInput.payment).toBeNull();
      expect(await audits(seeded.familyId)).toContain('"paymentSkipped":"not_linked"');
    });

    it('keeps payment off without its own flag', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      const forParent = vi.fn();
      const run = vi.fn(async () => CHECKOUT);
      await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-noflag'), {
        browserUseSignup: { run },
        paymentWallet: { forParent },
        checkSpendingCap: async () => ({ ok: true, reason: 'within cap' }),
      });
      const [engineInput] = run.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(engineInput.payment).toBeNull();
      expect(forParent).not.toHaveBeenCalled();
    });

    it('hands a Browser Use rush to the parent with the open time, the link and the prefill', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      const run = vi.fn(async () => ({
        ...CHECKOUT,
        outcome: 'rush' as const,
        detail: 'waiting_room' as const,
        liveViewUrl: null,
        checkoutUrl: null,
        holdExpiresAt: null,
        cartTotalCents: null,
        opensAt: '7:00 AM',
      }));
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-rush'), {
        browserUseSignup: { run },
      });
      expect(result.outcome).toBe('rush');
      expect(result.rush).toMatchObject({
        signal: 'waiting_room',
        opensAt: '7:00 AM',
        link: ACTIVENET,
      });
      expect(result.rush?.prefill).toContainEqual({ slot: 'child_first_name', value: 'Ada' });
      expect(await audits(seeded.familyId)).not.toContain('Ada');
    });

    it('does not start the engine on a bare yes', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      const run = vi.fn(async () => CHECKOUT);
      const result = await runAuthorizedSignup(
        db.database,
        { ...yes(seeded, 'msg-bu-bare'), body: 'yes' },
        { browserUseSignup: { run } },
      );
      expect(result.claimed).toBe(false);
      expect(run).not.toHaveBeenCalled();
    });

    it('never reports completed from the engine without a confirmation number', async () => {
      vi.stubEnv('BROWSER_USE_SIGNUP_PAYMENT_ENABLED', 'true');
      const seeded = await familyWithOffer({
        ageMonths: 36,
        url: ACTIVENET,
        approvedPriceCents: 9800,
      });
      await withProviderSession(seeded);
      const run = vi.fn(async () => ({
        ...CHECKOUT,
        outcome: 'completed' as const,
        liveViewUrl: null,
        confirmationNumber: null,
        amountChargedCents: 9800,
      }));
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-noconf'), {
        browserUseSignup: { run },
        paymentWallet: {
          forParent: async () => ({
            wallet: {
              kind: 'stripe_link_agent_wallet' as const,
              api: linkApiStub(),
              approvalWindowMinutes: 5,
            },
            skipped: null,
          }),
        },
        checkSpendingCap: async () => ({ ok: true, reason: 'within cap' }),
      });
      expect(result.outcome).toBe('needs_human');
      expect(result.browserUse?.detail).toBe('unconfirmed');
      const [offer] = await db.database
        .select({ status: schema.authorizedSignupOffers.status })
        .from(schema.authorizedSignupOffers)
        .where(eq(schema.authorizedSignupOffers.familyId, seeded.familyId));
      expect(offer?.status).toBe('handed_back');
    });

    it('returns needs_login without calling Browser Use when no session was captured', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      const run = vi.fn(async () => CHECKOUT);
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-2'), {
        browserUseSignup: { run },
      });
      expect(result.outcome).toBe('needs_login');
      expect(result.browserUse?.detail).toBe('no_provider_session');
      expect(run).not.toHaveBeenCalled();
    });

    async function setSpentUsd(familyId: string, usd: string) {
      await db.database.update(schema.authorizedSignupOffers).set({ browserUseCostUsd: null });
      await db.database
        .update(schema.authorizedSignupOffers)
        .set({ browserUseCostUsd: usd })
        .where(eq(schema.authorizedSignupOffers.familyId, familyId));
    }

    it('stops before Browser Use once the $25 registration reserve cannot cover a worst-case run', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      // 20.5 spent + 5 allowance (3 signup + 1 payment + 1 browser/proxy) would pass 25.
      await setSpentUsd(seeded.familyId, '20.500000');
      const run = vi.fn(async () => CHECKOUT);
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-reserve'), {
        browserUseSignup: { run },
      });
      expect(BROWSER_USE_REGISTRATION_RESERVE_USD).toBe(25);
      expect(result.outcome).toBe('error');
      expect(result.browserUse?.detail).toBe('spend_reserve_reached');
      expect(run).not.toHaveBeenCalled();
      expect(await browserUseRegistrationSpendUsd(db.database)).toBeCloseTo(20.5);
    });

    it('still runs Browser Use while the worst-case run fits under the reserve', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      await setSpentUsd(seeded.familyId, '0.000000');
      const run = vi.fn(async () => CHECKOUT);
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-under'), {
        browserUseSignup: { run },
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(result.outcome).toBe('reached_checkout');
      // A live-view handoff has no final session cost yet: the allowance stays held.
      expect(await browserUseRegistrationSpendUsd(db.database)).toBeCloseTo(
        BROWSER_USE_RUN_ALLOWANCE_USD,
      );
    });

    it('replaces the held allowance with the real session cost once the browser stopped', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      await setSpentUsd(seeded.familyId, '0.000000');
      const run = vi.fn(async () => ({
        ...CHECKOUT,
        outcome: 'needs_human' as const,
        liveViewUrl: null,
        sessionCostUsd: '0.412000',
      }));
      await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-settled'), {
        browserUseSignup: { run },
      });
      expect(await browserUseRegistrationSpendUsd(db.database)).toBeCloseTo(0.412);
    });

    it('releases the held allowance when the engine throws before any session', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      await setSpentUsd(seeded.familyId, '0.000000');
      const run = vi.fn(async () => {
        throw new BrowserUseEngineThrew(new Error('browser setup failed'), {
          runId: null,
          sessionId: null,
          browserId: null,
          sessionCostUsd: null,
        });
      });
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-threw'), {
        browserUseSignup: { run },
      });
      expect(result.browserUse?.detail).toBe('engine_threw');
      expect(await browserUseRegistrationSpendUsd(db.database)).toBe(0);
    });

    it('keeps the held allowance when the engine throws after a session started', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      await setSpentUsd(seeded.familyId, '0.000000');
      const run = vi.fn(async () => {
        throw new BrowserUseEngineThrew(new Error('worker killed'), {
          runId: 'run-started',
          sessionId: 'session-started',
          browserId: null,
          sessionCostUsd: null,
        });
      });
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-threw-late'), {
        browserUseSignup: { run },
      });
      expect(result.browserUse?.detail).toBe('engine_threw');
      expect(result.browserUse?.sessionId).toBe('session-started');
      expect(await browserUseRegistrationSpendUsd(db.database)).toBeCloseTo(
        BROWSER_USE_RUN_ALLOWANCE_USD,
      );
    });

    it('settles to the real session cost when a throw after a session could read it', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      await setSpentUsd(seeded.familyId, '0.000000');
      const run = vi.fn(async () => {
        throw new BrowserUseEngineThrew(new Error('worker killed'), {
          runId: 'run-started',
          sessionId: 'session-started',
          browserId: null,
          sessionCostUsd: '0.250000',
        });
      });
      await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-threw-cost'), {
        browserUseSignup: { run },
      });
      expect(await browserUseRegistrationSpendUsd(db.database)).toBeCloseTo(0.25);
    });

    it('keeps the held allowance when a runner throws without saying whether a session started', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      await setSpentUsd(seeded.familyId, '0.000000');
      const run = vi.fn(async () => {
        throw new Error('unknown runner failure');
      });
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-threw-unknown'), {
        browserUseSignup: { run },
      });
      expect(result.browserUse?.detail).toBe('engine_threw');
      expect(await browserUseRegistrationSpendUsd(db.database)).toBeCloseTo(
        BROWSER_USE_RUN_ALLOWANCE_USD,
      );
    });

    it('never starts Browser Use when the spend total cannot be read', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      await setSpentUsd(seeded.familyId, '0.000000');
      const run = vi.fn(async () => CHECKOUT);
      const realTransaction = db.database.transaction.bind(db.database);
      const spy = vi.spyOn(db.database, 'transaction').mockImplementation((async (
        fn: (tx: unknown) => Promise<unknown>,
      ) =>
        realTransaction(async (tx) =>
          fn(
            new Proxy(tx, {
              get(target, prop, receiver) {
                if (prop === 'select') {
                  return () => ({ from: async () => [{ total: 'not-a-number' }] });
                }
                return Reflect.get(target, prop, receiver);
              },
            }),
          ),
        )) as never);
      try {
        const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-unreadable'), {
          browserUseSignup: { run },
        });
        expect(result.browserUse?.detail).toBe('spend_reserve_reached');
      } finally {
        spy.mockRestore();
      }
      expect(run).not.toHaveBeenCalled();
    });

    it('names a missing engine as not_configured', async () => {
      const seeded = await familyWithOffer({ ageMonths: 36, url: ACTIVENET });
      await withProviderSession(seeded);
      const result = await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-3'), {
        browserUseSignup: null,
      });
      expect(result.outcome).toBe('error');
      expect(result.browserUse?.detail).toBe('not_configured');
    });

    it('keeps the engine off and uses the browser path when the flag is not exactly true', async () => {
      vi.stubEnv('BROWSER_USE_SIGNUP_ENABLED', 'TRUE');
      const seeded = await familyWithOffer({ ageMonths: 36 });
      const { browser, calls } = browserFor(SAFE);
      const run = vi.fn(async () => CHECKOUT);
      await runAuthorizedSignup(db.database, yes(seeded, 'msg-bu-4'), {
        browser,
        browserUseSignup: { run },
      });
      expect(run).not.toHaveBeenCalled();
      expect(calls.opened).toBe(1);
    });

    describe('a parent who says yes always hears what happened (VIL-558)', () => {
      const REC = 'https://register.example-rec.test/activity/42';
      const REC_HOST = signupProviderHost(new URL(REC).hostname);
      const LIVE = CHECKOUT.liveViewUrl;

      async function inboundYes(
        seeded: { familyId: string; parentUserId: string },
        inGroup: boolean | null,
        channel: 'imessage' | 'sms' = 'imessage',
        providerChatId: string | null = null,
      ): Promise<string> {
        const [row] = await db.database
          .insert(schema.channelMessages)
          .values({
            familyId: seeded.familyId,
            parentUserId: seeded.parentUserId,
            channel,
            direction: 'in',
            category: 'reply',
            status: 'delivered',
            body: 'Yes, sign us up',
            inGroup,
            providerChatId,
            sentAt: NOW,
          })
          .returning({ id: schema.channelMessages.id });
        if (!row) throw new Error('inboundYes: insert returned no row');
        return row.id;
      }

      async function seededPack(seeded: { familyId: string; parentUserId: string }) {
        const [child] = await db.database
          .select({ id: schema.children.id })
          .from(schema.children)
          .where(eq(schema.children.familyId, seeded.familyId));
        if (!child) throw new Error('seededPack: no child');
        const identity = await loadSignupIdentity(db.database, {
          familyId: seeded.familyId,
          childId: child.id,
          parentUserId: seeded.parentUserId,
          now: NOW,
        });
        if (!identity) throw new Error('seededPack: no identity');
        return signupInfoPack(identity);
      }

      async function reportAudit(familyId: string): Promise<Record<string, unknown>> {
        const rows = await db.database
          .select({ after: schema.auditLog.after })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.familyId, familyId));
        const report = rows
          .map((row) => row.after as Record<string, unknown>)
          .find((after) => after.step === 'report');
        if (!report) throw new Error('reportAudit: no report row');
        return report;
      }

      function engineSays(overrides: Partial<BrowserUseSignupResult>) {
        return vi.fn(async (): Promise<BrowserUseSignupResult> => ({ ...CHECKOUT, ...overrides }));
      }

      const UNRESOLVED_LINE = 'authorized signup: yes thread unresolved, details withheld';
      let info: MockInstance<typeof console.info>;
      beforeEach(() => {
        info = vi.spyOn(console, 'info').mockImplementation(() => {});
      });
      afterEach(() => {
        info.mockRestore();
      });
      function unresolvedLines() {
        return info.mock.calls.filter((call) => call[1] === UNRESOLVED_LINE);
      }

      it('speaks needs_login on a 1:1 yes: the link, the prepared details, no run', async () => {
        const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
        const messageId = await inboundYes(seeded, false);
        const run = vi.fn(async () => CHECKOUT);
        const outcomeWriter = echoOutcomeWriter();
        const result = await runAuthorizedSignup(db.database, yes(seeded, messageId), {
          browserUseSignup: { run },
          outcomeWriter,
        });
        const pack = await seededPack(seeded);
        expect(pack).toContainEqual({ slot: 'child_first_name', value: 'Ada' });
        expect(result.withheld).toBeUndefined();
        expect(unresolvedLines()).toEqual([]);
        expect(outcomeWriter.facts).toHaveLength(1);
        expect(outcomeWriter.facts[0]).toMatchObject({
          outcome: 'needs_login',
          reason: 'no_provider_session',
          confirmed: false,
          link: REC,
          linkIs: 'registration_page',
          audience: 'direct',
          holdMinutes: null,
          sessionLabel: 'Tue 4:30',
          pack,
        });
        expect(result).toMatchObject({
          claimed: true,
          outcome: 'needs_login',
          deliverOnThread: true,
        });
        expect(result.reply).toBe(renderEcho(outcomeWriter.facts[0] as SignupOutcomeFacts));
        expect(result.browserUse?.detail).toBe('no_provider_session');
        expect(run).not.toHaveBeenCalled();
      });

      it('gives a yes typed in the co-parent group only the public link, never the details', async () => {
        const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
        const groupId = await inboundYes(seeded, true);
        const outcomeWriter = echoOutcomeWriter();
        const result = await runAuthorizedSignup(db.database, yes(seeded, groupId), {
          browserUseSignup: { run: vi.fn(async () => CHECKOUT) },
          outcomeWriter,
        });
        expect(outcomeWriter.facts[0]).toMatchObject({
          outcome: 'needs_login',
          link: REC,
          linkIs: 'registration_page',
          audience: 'group',
        });
        expect(outcomeWriter.facts[0]?.pack ?? []).toEqual([]);
        expect(JSON.stringify(outcomeWriter.facts[0])).not.toContain('Ada');
        expect(result.deliverOnThread).toBe(true);
        // A known group is not an unplaced thread: nothing is named withheld.
        expect(result.withheld).toBeUndefined();
        expect(unresolvedLines()).toEqual([]);
      });

      it('treats a thread it cannot identify as the group: unknown id, or no group bit on iMessage', async () => {
        for (const messageId of ['msg-not-a-row', null] as const) {
          const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
          const id = messageId ?? (await inboundYes(seeded, null, 'imessage'));
          const outcomeWriter = echoOutcomeWriter();
          await runAuthorizedSignup(db.database, yes(seeded, id), {
            browserUseSignup: { run: vi.fn(async () => CHECKOUT) },
            outcomeWriter,
          });
          expect(outcomeWriter.facts[0]?.outcome).toBe('needs_login');
          expect(outcomeWriter.facts[0]?.pack ?? []).toEqual([]);
        }
        // Positive control: SMS has no group, so a null bit there is a 1:1.
        const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
        const smsId = await inboundYes(seeded, null, 'sms');
        const outcomeWriter = echoOutcomeWriter();
        await runAuthorizedSignup(db.database, yes(seeded, smsId), {
          browserUseSignup: { run: vi.fn(async () => CHECKOUT) },
          outcomeWriter,
        });
        expect(outcomeWriter.facts[0]?.pack).toContainEqual({
          slot: 'child_first_name',
          value: 'Ada',
        });
      });

      it('withholds the details from a null group bit on iMessage it cannot place, and names why', async () => {
        const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
        const outcomeWriter = echoOutcomeWriter();
        const result = await runAuthorizedSignup(
          db.database,
          yes(seeded, await inboundYes(seeded, null, 'imessage', 'chat-unknown-vil558')),
          { browserUseSignup: { run: vi.fn(async () => CHECKOUT) }, outcomeWriter },
        );
        expect(outcomeWriter.facts[0]).toMatchObject({
          outcome: 'needs_login',
          link: REC,
          linkIs: 'registration_page',
        });
        expect(outcomeWriter.facts[0]?.pack ?? []).toEqual([]);
        expect(JSON.stringify(outcomeWriter.facts[0])).not.toContain('Ada');
        expect(result).toMatchObject({ deliverOnThread: true, withheld: 'thread_unresolved' });
        expect(unresolvedLines()).toEqual([[{ outcome: 'thread_unresolved' }, UNRESOLVED_LINE]]);
      });

      it("withholds the details when a valid id is not this family's own inbound yes", async () => {
        const unplaced: Array<
          (seeded: { familyId: string; parentUserId: string }) => Promise<string>
        > = [
          // No row at all.
          async () => randomUUID(),
          // Another family's 1:1 yes.
          async () => inboundYes(await familyWithOffer({ ageMonths: 36, url: REC }), false),
          // Hale's own outbound row in this family, marked 1:1.
          async (seeded) => {
            const [row] = await db.database
              .insert(schema.channelMessages)
              .values({
                familyId: seeded.familyId,
                parentUserId: seeded.parentUserId,
                channel: 'imessage',
                direction: 'out',
                category: 'reply',
                status: 'delivered',
                inGroup: false,
                sentAt: NOW,
              })
              .returning({ id: schema.channelMessages.id });
            if (!row) throw new Error('outbound insert returned no row');
            return row.id;
          },
        ];
        for (const idFor of unplaced) {
          const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
          const outcomeWriter = echoOutcomeWriter();
          const result = await runAuthorizedSignup(db.database, yes(seeded, await idFor(seeded)), {
            browserUseSignup: { run: vi.fn(async () => CHECKOUT) },
            outcomeWriter,
          });
          expect(outcomeWriter.facts[0]).toMatchObject({
            outcome: 'needs_login',
            link: REC,
            linkIs: 'registration_page',
          });
          expect(outcomeWriter.facts[0]?.pack ?? []).toEqual([]);
          expect(result).toMatchObject({ deliverOnThread: true, withheld: 'thread_unresolved' });
        }
        // Positive control: this family's own 1:1 inbound yes carries the details.
        const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
        const outcomeWriter = echoOutcomeWriter();
        const result = await runAuthorizedSignup(
          db.database,
          yes(seeded, await inboundYes(seeded, false)),
          { browserUseSignup: { run: vi.fn(async () => CHECKOUT) }, outcomeWriter },
        );
        expect(outcomeWriter.facts[0]?.pack).toEqual(await seededPack(seeded));
        expect(result.withheld).toBeUndefined();
      });

      it('never hands the live browser to the group; a 1:1 yes gets it with the minutes left', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          const t = new Date('2026-10-05T12:00:00.000Z');
          vi.setSystemTime(t);
          const holdExpiresAt = new Date(t.getTime() + 10 * 60_000);

          const inGroup = await familyWithOffer({ ageMonths: 36, url: REC });
          await withProviderSession(inGroup, REC_HOST);
          const groupWriter = echoOutcomeWriter();
          const groupResult = await runAuthorizedSignup(
            db.database,
            yes(inGroup, await inboundYes(inGroup, true)),
            {
              browserUseSignup: { run: engineSays({ holdExpiresAt }) },
              outcomeWriter: groupWriter,
            },
          );
          expect(groupWriter.facts[0]).toMatchObject({
            outcome: 'reached_checkout',
            link: REC,
            linkIs: 'registration_page',
            holdMinutes: null,
          });
          expect(groupWriter.facts[0]?.pack ?? []).toEqual([]);
          expect(groupResult.reply).not.toContain('fixture-live-view-token');

          const direct = await familyWithOffer({ ageMonths: 36, url: REC });
          await withProviderSession(direct, REC_HOST);
          const directWriter = echoOutcomeWriter();
          const directResult = await runAuthorizedSignup(
            db.database,
            yes(direct, await inboundYes(direct, false)),
            {
              browserUseSignup: { run: engineSays({ holdExpiresAt }) },
              outcomeWriter: directWriter,
            },
          );
          expect(directWriter.facts[0]).toMatchObject({
            outcome: 'reached_checkout',
            reason: null,
            link: LIVE,
            linkIs: 'live_browser',
            holdMinutes: 10,
          });
          expect(directWriter.facts[0]?.pack ?? []).toEqual([]);
          expect(directResult).toMatchObject({ deliverOnThread: true });
          expect(directResult.reply).toContain('fixture-live-view-token');
          expect(await audits(direct.familyId)).not.toContain('fixture-live-view-token');
        } finally {
          vi.useRealTimers();
        }
      });

      it('sends private facts after a 1:1 yes on that thread, never through the family group', async () => {
        const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
        await db.database
          .update(schema.families)
          .set({ linqGroupChatId: 'group-chat-vil558' })
          .where(eq(schema.families.id, seeded.familyId));
        await withProviderSession(seeded, REC_HOST);
        const deliverGroup = vi.fn(async () => 'sent' as const);
        const result = await runAuthorizedSignup(
          db.database,
          yes(seeded, await inboundYes(seeded, false)),
          { browserUseSignup: { run: engineSays({}) }, deliverGroup },
        );
        expect(deliverGroup).not.toHaveBeenCalled();
        expect(result.deliverOnThread).toBe(true);
        expect(result.reply).toContain('fixture-live-view-token');

        // Positive control: an outcome with nothing private keeps the family's group door.
        const other = await familyWithOffer({ ageMonths: 36, url: REC });
        await db.database
          .update(schema.families)
          .set({ linqGroupChatId: 'group-chat-vil558-b' })
          .where(eq(schema.families.id, other.familyId));
        await withProviderSession(other, REC_HOST);
        const groupSpy = vi.fn(async () => 'sent' as const);
        const outcomeWriter = echoOutcomeWriter();
        const soldOut = await runAuthorizedSignup(
          db.database,
          yes(other, await inboundYes(other, false)),
          {
            browserUseSignup: {
              run: engineSays({ outcome: 'sold_out', liveViewUrl: null }),
            },
            deliverGroup: groupSpy,
            outcomeWriter,
          },
        );
        expect(groupSpy).toHaveBeenCalledTimes(1);
        expect(soldOut.outcome).toBe('sold_out');
        expect(outcomeWriter.facts[0]).toMatchObject({
          outcome: 'sold_out',
          reason: null,
          audience: 'group',
        });
        expect(outcomeWriter.facts[0]?.pack ?? []).toEqual([]);
      });

      it('speaks every absent-engine outcome with its reason and the details on a 1:1 yes', async () => {
        const cases = [
          { detail: 'not_configured', deps: { browserUseSignup: null }, session: true },
          {
            detail: 'engine_threw',
            deps: {
              browserUseSignup: {
                run: vi.fn(async () => {
                  throw new Error('runner failure');
                }),
              },
            },
            session: true,
          },
          {
            detail: 'spend_reserve_reached',
            deps: { browserUseSignup: { run: vi.fn(async () => CHECKOUT) } },
            session: true,
            // Past the $25 reserve once a worst-case run is added (see the reserve cases above).
            spentUsd: '20.500000',
          },
        ] as const;
        for (const item of cases) {
          const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
          if (item.session) await withProviderSession(seeded, REC_HOST);
          if ('spentUsd' in item) await setSpentUsd(seeded.familyId, item.spentUsd);
          const outcomeWriter = echoOutcomeWriter();
          const result = await runAuthorizedSignup(
            db.database,
            yes(seeded, await inboundYes(seeded, false)),
            { ...item.deps, outcomeWriter },
          );
          expect(outcomeWriter.facts).toHaveLength(1);
          expect(outcomeWriter.facts[0]).toMatchObject({
            outcome: 'error',
            reason: item.detail,
            confirmed: false,
            link: REC,
            linkIs: 'registration_page',
            holdMinutes: null,
            pack: await seededPack(seeded),
          });
          expect(outcomeWriter.facts[0]?.pack).toContainEqual({
            slot: 'child_first_name',
            value: 'Ada',
          });
          expect(result).toMatchObject({ outcome: 'error', deliverOnThread: true });
          expect(result.browserUse?.detail).toBe(item.detail);
        }
      });

      it('speaks a rush with the open time and the details to have ready', async () => {
        const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
        await withProviderSession(seeded, REC_HOST);
        const outcomeWriter = echoOutcomeWriter();
        const result = await runAuthorizedSignup(
          db.database,
          yes(seeded, await inboundYes(seeded, false)),
          {
            browserUseSignup: {
              run: engineSays({
                outcome: 'rush',
                detail: 'waiting_room',
                liveViewUrl: null,
                opensAt: '7:00 AM',
              }),
            },
            outcomeWriter,
          },
        );
        expect(outcomeWriter.facts[0]).toMatchObject({
          outcome: 'rush',
          reason: 'waiting_room',
          link: REC,
          linkIs: 'registration_page',
          rush: { signal: 'waiting_room', opensAt: '7:00 AM' },
        });
        expect(outcomeWriter.facts[0]?.pack).toContainEqual({
          slot: 'child_first_name',
          value: 'Ada',
        });
        expect(result.deliverOnThread).toBe(true);
      });

      it('claims a sign-up only with a confirmation number; without one it is unconfirmed', async () => {
        vi.stubEnv('BROWSER_USE_SIGNUP_PAYMENT_ENABLED', 'true');
        const wallet = {
          kind: 'stripe_link_agent_wallet' as const,
          api: linkApiStub(),
          approvalWindowMinutes: 5,
        };
        const paid = async (confirmationNumber: string | null) => {
          const seeded = await familyWithOffer({
            ageMonths: 36,
            url: REC,
            approvedPriceCents: 9800,
          });
          await withProviderSession(seeded, REC_HOST);
          const outcomeWriter = echoOutcomeWriter();
          await runAuthorizedSignup(db.database, yes(seeded, await inboundYes(seeded, false)), {
            browserUseSignup: {
              run: engineSays({
                outcome: 'completed',
                liveViewUrl: null,
                confirmationNumber,
                amountChargedCents: 9800,
              }),
            },
            paymentWallet: { forParent: async () => ({ wallet, skipped: null }) },
            checkSpendingCap: async () => ({ ok: true, reason: 'within cap' }),
            outcomeWriter,
          });
          return outcomeWriter.facts[0];
        };
        const confirmed = await paid('R-55120');
        expect(confirmed).toMatchObject({
          outcome: 'completed',
          confirmed: true,
          link: '',
          linkIs: null,
        });
        expect(JSON.stringify(confirmed)).not.toContain('R-55120');
        const unconfirmed = await paid(null);
        expect(unconfirmed).toMatchObject({
          outcome: 'needs_human',
          reason: 'unconfirmed',
          confirmed: false,
          link: REC,
        });
        expect(unconfirmed?.pack ?? []).toEqual([]);
      });

      it('hands a captcha to the parent on the live browser, without the details', async () => {
        const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
        await withProviderSession(seeded, REC_HOST);
        const outcomeWriter = echoOutcomeWriter();
        await runAuthorizedSignup(db.database, yes(seeded, await inboundYes(seeded, false)), {
          browserUseSignup: {
            run: engineSays({ outcome: 'needs_human', detail: 'captcha' }),
          },
          outcomeWriter,
        });
        expect(outcomeWriter.facts[0]).toMatchObject({
          outcome: 'needs_human',
          reason: 'captcha',
          link: LIVE,
          linkIs: 'live_browser',
        });
        expect(outcomeWriter.facts[0]?.pack ?? []).toEqual([]);
      });

      it('names an unwritten reply and sends nothing; logs carry the outcome name only', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
          const result = await runAuthorizedSignup(
            db.database,
            yes(seeded, await inboundYes(seeded, false)),
            {
              browserUseSignup: { run: vi.fn(async () => CHECKOUT) },
              outcomeWriter: { write: async () => null },
            },
          );
          expect(result).toMatchObject({
            claimed: true,
            outcome: 'needs_login',
            reply: null,
            deliverOnThread: false,
            unsent: 'reply_unwritten',
          });
          const named = warn.mock.calls.filter(
            (call) => call[1] === 'authorized signup: outcome reply unwritten',
          );
          expect(named).toEqual([
            [{ outcome: 'needs_login' }, 'authorized signup: outcome reply unwritten'],
          ]);
          const logged = JSON.stringify(named);
          expect(logged).not.toContain(seeded.familyId);
          expect(logged).not.toContain('example-rec');
          expect(logged).not.toContain('Ada');
          expect(await reportAudit(seeded.familyId)).toMatchObject({
            outcome: 'needs_login',
            replied: false,
          });

          // Positive control: a written reply is not named unsent, and the audit says replied.
          const spoken = await familyWithOffer({ ageMonths: 36, url: REC });
          const ok = await runAuthorizedSignup(
            db.database,
            yes(spoken, await inboundYes(spoken, false)),
            {
              browserUseSignup: { run: vi.fn(async () => CHECKOUT) },
              outcomeWriter: echoOutcomeWriter(),
            },
          );
          expect(ok.unsent).toBeUndefined();
          expect(ok.deliverOnThread).toBe(true);
          expect(await reportAudit(spoken.familyId)).toMatchObject({ replied: true });
        } finally {
          warn.mockRestore();
        }
      });

      it('gives the router a reply for a claimed yes, or names the turn unwritten', async () => {
        vi.stubEnv('BROWSER_USE_API_KEY', '');
        const turn = (seeded: { familyId: string; parentUserId: string }, messageId: string) => ({
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          conversationId: 'conv-vil558',
          body: 'Yes, sign us up',
          now: NOW,
          send: async () => {
            throw new Error('handler must not send a 1:1 itself');
          },
          resolved: null,
          openQuestions: async () => [],
          inboundChannelMessageId: messageId,
        });
        const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
        await withProviderSession(seeded, REC_HOST);
        const outcomeWriter = echoOutcomeWriter();
        const verdict = await authorizedSignupHandler({ outcomeWriter }).handle(
          db.database,
          turn(seeded, await inboundYes(seeded, false)),
        );
        expect(verdict.claimed).toBe(true);
        if (!verdict.claimed) return;
        expect(outcomeWriter.facts[0]).toMatchObject({
          outcome: 'error',
          reason: 'not_configured',
        });
        expect(verdict.outcome).toBe('error');
        expect(verdict.reply).toBe(renderEcho(outcomeWriter.facts[0] as SignupOutcomeFacts));

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const silent = await familyWithOffer({ ageMonths: 36, url: REC });
          await withProviderSession(silent, REC_HOST);
          const unwritten = await authorizedSignupHandler({
            outcomeWriter: { write: async () => null },
          }).handle(db.database, turn(silent, await inboundYes(silent, false)));
          expect(unwritten).toMatchObject({
            claimed: true,
            outcome: 'reply_unwritten',
            reply: null,
          });
        } finally {
          warn.mockRestore();
        }
      });

      it("writes in the parent's language: their texted locale, else the family's", async () => {
        const languageFor = async (locale: string | null, texted: boolean) => {
          const seeded = await familyWithOffer({ ageMonths: 36, url: REC });
          if (locale !== null) {
            await db.database
              .update(schema.users)
              .set({ locale })
              .where(eq(schema.users.id, seeded.parentUserId));
          }
          const messageId = texted ? await inboundYes(seeded, false) : 'msg-untexted';
          const outcomeWriter = echoOutcomeWriter();
          await runAuthorizedSignup(db.database, yes(seeded, messageId), {
            browserUseSignup: { run: vi.fn(async () => CHECKOUT) },
            outcomeWriter,
          });
          return outcomeWriter.facts[0]?.language;
        };
        expect(await languageFor('fr', true)).toBe('fr');
        expect(await languageFor('en-CA', true)).toBe('en-ca');
        expect(await languageFor('fr', false)).toBe('en');
      });
    });
  });
});

function linkApiStub(): LinkWalletApi {
  return {
    createSpendRequest: vi.fn(),
    retrieveSpendRequest: vi.fn(),
    retrieveCard: vi.fn(),
    cancelSpendRequest: vi.fn(),
  };
}
