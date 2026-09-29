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
      approvedPriceCents: null,
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
    expect(result.reply).toContain('TODO-Design');
    expect(result.reply).toContain('reason=ambiguous_session');
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
    expect(result.reply).toContain(`${ORIGIN}/register`);
    expect(result.reply).toContain('prefilled=none');
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
    expect(result.reply).toBe('TODO-Design: authorized signup completed');
    expect(calls.submitted).toBe(1);
    const trail = await audits(seeded.familyId);
    expect(trail).toContain('tue-1630');
    expect(trail).not.toContain('Ada');
    expect(trail).not.toContain('@');
  });

  it('hands the parent the link and a pack when the provider is not allowlisted', async () => {
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
    expect(result.reply).toContain('TODO-Design: assisted handoff');
    expect(result.reply).toContain('https://www.toronto.ca/explore-enjoy/recreation/registrations');
    expect(result.reply).toContain('session=Tue 4:30');
    expect(result.reply).toContain('child_first_name=Ada');
    expect(result.reply).toContain('postal_code=M5V2T6');
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
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('assisted_handoff');
    expect(calls.opened).toBe(0);
  });

  it('stops an allowlisted form that asks for a waiver and does not submit', async () => {
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
        inboundChannelMessageId: null,
        existingThread: true,
        now: NOW,
      },
      { browser },
    );
    expect(result.outcome).toBe('waiver');
    expect(result.reply).toContain('reason=waiver');
    expect(result.reply).toContain('prefilled=none');
    expect(calls.opened).toBe(1);
    expect(calls.submitted).toBe(0);
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
        expect(item.body).toContain('TODO-Design');
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
});
