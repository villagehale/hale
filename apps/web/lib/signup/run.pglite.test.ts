import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { authorizedSignupHandler } from './handler';
import { runAuthorizedSignup } from './run';
import { recordSignupOffer } from './store';
import type { PageSnapshot, SignupBrowser, SignupPage } from './types';

const NOW = new Date('2026-09-29T15:00:00.000Z');
const ORIGIN = 'http://127.0.0.1';

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
      .set({ postalCode: 'M5V2T6' })
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
    expect(result.reply).toBe(
      `I can't tell which session you mean. Which one? Here's the page: ${ORIGIN}/register`,
    );
    expect(calls.opened).toBe(0);
    expect(await audits(seeded.familyId)).not.toContain('Ada');
  });

  it('does not enroll a teenager', async () => {
    const seeded = await familyWithOffer({ ageMonths: 14 * 12 });
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
    expect(result.outcome).toBe('teen_privacy');
    expect(calls.opened).toBe(0);
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
    expect(result.reply).toBe(
      `It's asking for payment, so that part is yours. Here's the page: ${ORIGIN}/register`,
    );
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
    expect(result.reply).toBe(`You're signed up for Tue 4:30.`);
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

  it('does not let a connector automate a denylisted host', async () => {
    const seeded = await familyWithOffer({
      ageMonths: 36,
      url: 'https://www.toronto.ca/explore-enjoy/recreation/registrations',
    });
    const { browser, calls } = browserFor(SAFE);
    let called = false;
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-toronto',
        existingThread: true,
        now: NOW,
      },
      {
        browser,
        connectors: [
          {
            id: 'should-not-run',
            matches: () => true,
            book: async () => {
              called = true;
              return { ok: true };
            },
          },
        ],
      },
    );
    expect(result.outcome).toBe('assisted_handoff');
    expect(called).toBe(false);
    expect(calls.opened).toBe(0);
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
    expect(result.reply).toContain(`I couldn't get through on my end.`);
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

  it('hands the parent the link and a pack for a municipal host', async () => {
    const seeded = await familyWithOffer({
      ageMonths: 36,
      url: 'https://www.toronto.ca/explore-enjoy/recreation/registrations',
    });
    const { browser, calls } = browserFor(SAFE, { ...SAFE, confirmed: true });
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-handoff',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('assisted_handoff');
    expect(result.reply).toContain(
      `This one has to be done by you. Here's the page: https://www.toronto.ca/explore-enjoy/recreation/registrations`,
    );
    expect(result.reply).toContain(`For Tue 4:30, you'll want `);
    expect(result.reply).toContain('child_first_name: Ada');
    expect(result.reply).toContain('postal_code: M5V2T6');
    expect(result.reply).not.toContain('pack=');
    expect(result.reply).not.toContain('session=');
    expect(calls.opened).toBe(0);
    expect(calls.submitted).toBe(0);
    const trail = await audits(seeded.familyId);
    expect(trail).toContain('assisted_handoff');
    expect(trail).not.toContain('Ada');
    expect(trail).not.toContain('M5V2T6');
    expect(trail).not.toContain('Test Parent');
    expect(trail).not.toContain('@');
  });

  it('does not open a browser for an ActiveNet host', async () => {
    const seeded = await familyWithOffer({
      ageMonths: 36,
      url: 'https://anc.ca.apm.activecommunities.com/toronto/activity/search',
    });
    const { browser, calls } = browserFor(SAFE);
    const result = await runAuthorizedSignup(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        body: 'Yes, sign us up',
        inboundChannelMessageId: 'msg-activenet',
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('assisted_handoff');
    expect(calls.opened).toBe(0);
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
    expect(result.reply).toBe(
      `There's a waiver to read and sign, so that part's yours. Here's the page: ${ORIGIN}/register`,
    );
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
        expect(item.body).toBe(`You're signed up for Tue 4:30.`);
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
      url: 'https://www.toronto.ca/explore-enjoy/recreation/registrations',
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
    expect(result.reply).toBe(
      `I stopped before finishing. Here's the page: https://www.toronto.ca/explore-enjoy/recreation/registrations`,
    );
    expect(result.reply).not.toContain('Ada');
    expect(result.reply).not.toContain('M5V2T6');
    expect(result.reply).not.toContain('TODO-Design');
    expect(calls.opened).toBe(0);
    const rows = await db.database
      .select({ id: schema.authorizedSignupConsents.id })
      .from(schema.authorizedSignupConsents)
      .where(eq(schema.authorizedSignupConsents.familyId, seeded.familyId));
    expect(rows).toEqual([]);
  });

  it('hands back when the consent field list is wider than the pack', async () => {
    const seeded = await familyWithOffer({
      ageMonths: 36,
      url: 'https://www.brampton.ca/recreation',
    });
    await db.database.insert(schema.authorizedSignupConsents).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      messageId: 'msg-wider',
      activityKey: 'swim-parent-tot',
      providerHost: 'www.brampton.ca',
      fieldsAllowed: [
        'child_first_name',
        'parent_first_name',
        'parent_email',
        'postal_code',
        'session',
      ],
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
    expect(result.reply).not.toContain('M5V2T6');
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
    expect(result.reply).toBe(`You're signed up for Tue 4:30.`);
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
      expect(result.reply).toBe(`You're signed up for Tue 4:30.`);
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
      expect(result.reply).toContain(`I couldn't get through on my end.`);
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

  it('does not call the sandbox connector for a denylisted host', async () => {
    vi.stubEnv('BOOKING_REFERENCE_CONNECTOR_ENABLED', 'on');
    vi.stubEnv('BOOKING_REFERENCE_CONNECTOR_BASE_URL', 'https://api.sandbox-partner.test');
    const href = 'https://www.toronto.ca/explore-enjoy/recreation/registrations';
    const seeded = await familyWithOffer({ ageMonths: 36, url: href });
    const { browser, calls } = browserFor(SAFE);
    const fetchMock = vi.fn(async () => Response.json({ status: 'booked' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await runAuthorizedSignup(
        db.database,
        {
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          body: 'Yes, sign us up',
          inboundChannelMessageId: 'msg-sandbox-deny',
          existingThread: true,
          now: NOW,
        },
        { browser },
      );
      expect(result.outcome).toBe('assisted_handoff');
      expect(calls.opened).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.reply).not.toMatch(/\bSTOP\b/);
      expect(result.reply).not.toContain('TODO-Design');
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
});
