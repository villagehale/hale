import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { recordSignupOffer } from '../store';
import { REGISTRATION_ASSISTED_RUN_ENABLED_ENV } from './flag';
import {
  PLAN_NOTICE_TEMPLATE,
  PLAN_PREP_TEMPLATE,
  createPlanNotifier,
  createPlanPrepDeliver,
} from './notice';
import type { PlanOutcomeNotice } from './run';
import { approveSignupPlan } from './store';
import type { PlanReplyFacts, PlanReplyWriter } from './writer';

// Invented hosts and details only. The text itself is a model call with its own recorded
// eval (signup-plan-reply); here the writer is a stipulated answer, and what is tested is
// who gets the text, what it carries and what is kept.
const NOW = new Date('2026-12-01T12:06:00.000Z');
const OPENS = new Date('2026-12-01T12:00:00.000Z');
const URL = 'https://register.example-rec.test/Clients/BookMe4LandingPages/CoursesLandingPage';
const TOKEN = 'fixture-live-view-token';
const LIVE = `https://live.browser-use.com/s/${TOKEN}`;
const SESSIONS = [
  {
    id: 'sat-0900',
    label: 'Preschool Swim Sat 9:00',
    startsAt: '2027-01-09T14:00:00.000Z',
    endsAt: '2027-01-09T14:45:00.000Z',
    full: false,
    priceCents: 9800,
  },
  {
    id: 'sun-1000',
    label: 'Preschool Swim Sun 10:00',
    startsAt: '2027-01-10T15:00:00.000Z',
    endsAt: '2027-01-10T15:45:00.000Z',
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
beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function plannedFamily(options: { enrolled?: boolean; url?: string } = {}) {
  const seeded = await seedFamily(db.database);
  seq += 1;
  const phone = `+1202555${String(150 + seq).padStart(4, '0')}`;
  if (options.enrolled !== false) {
    await db.database.insert(schema.parentChannels).values({
      userId: seeded.parentUserId,
      familyId: seeded.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });
  }
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
  const offer = await recordSignupOffer(db.database, {
    familyId: seeded.familyId,
    childId,
    parentUserId: seeded.parentUserId,
    activityKey: 'swim-preschool',
    registrationUrl: options.url ?? URL,
    sessions: SESSIONS,
    approvedPriceCents: null,
    planOpensAt: OPENS,
    now: new Date(NOW.getTime() - 24 * 60 * 60_000),
  });
  if (!offer.ok) throw new Error(offer.reason);
  const approved = await approveSignupPlan(db.database, {
    offerId: offer.id,
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    messageId: `msg-notice-${seq}`,
    choiceIds: ['sun-1000', 'sat-0900'],
    maxPriceCents: 10000,
    opensAt: OPENS,
    waiverAccepted: true,
    now: new Date(NOW.getTime() - 20 * 60 * 60_000),
  });
  expect(approved).toEqual({ ok: true });
  return { ...seeded, phone, offerId: offer.id };
}

function notice(
  f: { familyId: string; parentUserId: string; offerId: string },
  over: Partial<PlanOutcomeNotice> = {},
): PlanOutcomeNotice {
  return {
    offerId: f.offerId,
    familyId: f.familyId,
    parentUserId: f.parentUserId,
    outcome: 'needs_human',
    detail: 'security_code',
    choiceIndex: 0,
    cartTotalCents: 9800,
    amountChargedCents: null,
    confirmationNumber: null,
    liveViewUrl: LIVE,
    holdExpiresAt: new Date(NOW.getTime() + 9 * 60_000),
    ...over,
  };
}

function rig(text: string | null = 'Sunday is in your cart, finish in the open browser.') {
  const facts: PlanReplyFacts[] = [];
  const sent: { to: string; body: string }[] = [];
  const writer: PlanReplyWriter = {
    write: vi.fn(async (input: PlanReplyFacts) => {
      facts.push(input);
      return text;
    }),
  };
  const transport: ChannelTransport = {
    send: vi.fn(async (input: { to: string; body: string }) => {
      sent.push({ to: input.to, body: input.body });
      return { providerMessageId: `prov-${sent.length}` };
    }),
  } as unknown as ChannelTransport;
  const notify = createPlanNotifier(db.database, { writer, transport, now: () => NOW });
  return { notify, facts, sent, writer, transport };
}

async function storedThread(familyId: string) {
  const rows = await db.database
    .select({ content: schema.messages.content })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(eq(schema.conversations.familyId, familyId));
  return rows.map((row) => row.content);
}

describe('the parent notice after a plan run', () => {
  it('texts the approving parent 1:1 with the live browser link, and keeps the link out of history and out of the model', async () => {
    const f = await plannedFamily();
    const { notify, facts, sent } = rig();
    expect(await notify(notice(f))).toBe('sent');

    expect(sent).toEqual([
      { to: f.phone, body: `Sunday is in your cart, finish in the open browser.\n${LIVE}` },
    ]);
    expect(facts[0]?.moment).toBe('run_finished');
    expect(facts[0]?.run).toMatchObject({
      outcome: 'needs_human',
      detail: 'security_code',
      confirmed: false,
      sessionLabel: 'Preschool Swim Sun 10:00',
      liveBrowser: true,
      holdMinutes: 9,
    });
    expect(JSON.stringify(facts)).not.toContain(TOKEN);

    const thread = await storedThread(f.familyId);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toContain('Sunday is in your cart');
    expect(thread[0]).not.toContain(TOKEN);

    const [ledger] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, f.familyId),
          eq(schema.channelMessages.templateKey, PLAN_NOTICE_TEMPLATE),
        ),
      );
    expect(ledger).toMatchObject({ direction: 'out', providerMessageId: 'prov-1' });
    expect(ledger?.sentAt).not.toBeNull();
  });

  it('hands an ActiveNet parent a filled registration on the generic auto path, with the live browser after the text', async () => {
    vi.stubEnv(REGISTRATION_ASSISTED_RUN_ENABLED_ENV, 'true');
    const f = await plannedFamily({
      url: 'https://anc.ca.apm.activecommunities.com/exampleville/activity/search/detail/7',
    });
    const { notify, facts, sent } = rig('Ada is filled in for Sunday: check it, submit and pay.');
    expect(
      await notify(
        notice(f, {
          outcome: 'ready_for_parent',
          detail: 'none',
          holdExpiresAt: new Date(NOW.getTime() + 15 * 60_000),
        }),
      ),
    ).toBe('sent');

    expect(sent[0]?.body).toBe(`Ada is filled in for Sunday: check it, submit and pay.\n${LIVE}`);
    expect(facts[0]).toMatchObject({
      moment: 'run_finished',
      mode: 'auto',
      run: { outcome: 'ready_for_parent', liveBrowser: true, holdMinutes: 15, confirmed: false },
    });
    expect(JSON.stringify(facts)).not.toContain(TOKEN);
    const thread = await storedThread(f.familyId);
    expect(thread[0]).toContain('Ada is filled in for Sunday');
    expect(thread[0]).not.toContain(TOKEN);
  });

  it('a live view on any other host is never sent: the registration page is', async () => {
    const f = await plannedFamily();
    const { notify, facts, sent } = rig();
    const foreign = `https://live.browser-use.example.test/s/${TOKEN}`;
    expect(await notify(notice(f, { liveViewUrl: foreign }))).toBe('sent');
    expect(sent[0]?.body).toBe(`Sunday is in your cart, finish in the open browser.\n${URL}`);
    expect(facts[0]?.run?.liveBrowser).toBe(false);
  });

  it('a confirmed registration carries no link', async () => {
    const f = await plannedFamily();
    const { notify, sent } = rig('Ada is registered for Sunday.');
    const result = await notify(
      notice(f, {
        outcome: 'completed',
        detail: 'none',
        confirmationNumber: 'R-1',
        amountChargedCents: 9800,
        liveViewUrl: null,
        holdExpiresAt: null,
      }),
    );
    expect(result).toBe('sent');
    expect(sent[0]?.body).toBe('Ada is registered for Sunday.');
  });

  it('a parent who left the family is not texted, though their channel still works', async () => {
    const f = await plannedFamily();
    await db.database
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, f.parentUserId));
    const { notify, writer, transport } = rig();
    expect(await notify(notice(f))).toBe('withheld');
    expect(writer.write).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('a parent whose channel is no longer enrolled is not texted, and the code names no reason', async () => {
    const f = await plannedFamily({ enrolled: false });
    const { notify, writer, transport } = rig();
    expect(await notify(notice(f))).toBe('withheld');
    expect(writer.write).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('a text the model could not write is a named failure, and nothing is sent', async () => {
    const f = await plannedFamily();
    const { notify, transport } = rig(null);
    expect(await notify(notice(f))).toBe('failed');
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('a second notice for the same plan is not sent twice', async () => {
    const f = await plannedFamily();
    const { notify, sent } = rig();
    await notify(notice(f));
    await notify(notice(f));
    expect(sent).toHaveLength(1);
  });
});

describe('the login card in a prep notice', () => {
  const CARD = 'https://app.villagehale.com/l/AbCdef1234';
  const PARTS = [
    { type: 'text', body: 'Hale needs the swim login for Saturday.' },
    { type: 'link', url: CARD },
    { type: 'text', body: 'It takes a minute.' },
  ] as const;

  function phoneTransport(carried: { transport?: 'imessage'; chatId?: string }) {
    const bodies: string[] = [];
    const transport: ChannelTransport = {
      async send(input) {
        bodies.push(input.body);
        return { providerMessageId: `prov-${bodies.length}`, ...carried };
      },
    };
    return { transport, bodies };
  }

  function linqFetch() {
    return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ message: { id: 'card-1' } }, { status: 201 }),
    );
  }

  async function ledger(familyId: string) {
    return db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, familyId));
  }

  it('sends the card as a Linq link part on iMessage, and ledgers every send', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const f = await plannedFamily();
    const { transport, bodies } = phoneTransport({ transport: 'imessage', chatId: 'chat-1' });
    const fetchMock = linqFetch();
    const deliver = createPlanPrepDeliver(db.database, { transport, fetch: fetchMock });

    const delivered = await deliver({
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      offerId: f.offerId,
      kind: 'login_ask',
      parts: PARTS,
      now: NOW,
    });

    expect(delivered).toBe(true);
    expect(bodies).toEqual(['Hale needs the swim login for Saturday.', 'It takes a minute.']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(sentBody.message.parts).toEqual([{ type: 'link', value: CARD }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('chat-1');
    const rows = await ledger(f.familyId);
    expect(
      rows.map((row) => [row.templateKey, row.providerMessageId, row.channel, row.status]),
    ).toEqual(
      expect.arrayContaining([
        [`${PLAN_PREP_TEMPLATE}:login_ask`, 'prov-1', 'imessage', 'sent'],
        ['linq:link_preview', 'card-1', 'imessage', 'sent'],
        [`${PLAN_PREP_TEMPLATE}:login_ask`, 'prov-2', 'imessage', 'sent'],
      ]),
    );
    expect(rows).toHaveLength(3);
  });

  it('sends the card as its own text off iMessage, and names that fallback without the link', async () => {
    const f = await plannedFamily();
    const { transport, bodies } = phoneTransport({});
    const fetchMock = linqFetch();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const deliver = createPlanPrepDeliver(db.database, { transport, fetch: fetchMock });

    const delivered = await deliver({
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      offerId: f.offerId,
      kind: 'account_prep',
      parts: PARTS,
      now: NOW,
    });

    expect(delivered).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bodies).toEqual(['Hale needs the swim login for Saturday.', CARD, 'It takes a minute.']);
    const rows = await ledger(f.familyId);
    expect(rows.map((row) => [row.templateKey, row.channel, row.status]).sort()).toEqual([
      ['linq:link_text', 'sms', 'queued'],
      [`${PLAN_PREP_TEMPLATE}:account_prep`, 'sms', 'queued'],
      [`${PLAN_PREP_TEMPLATE}:account_prep`, 'sms', 'queued'],
    ]);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('not_imessage');
    expect(logged).not.toContain(CARD);
    info.mockRestore();
  });

  it('stops at a refused text, marks its row failed, and sends nothing after it', async () => {
    const f = await plannedFamily();
    const transport: ChannelTransport = {
      async send() {
        throw new LinqSendError('21610', 400, true);
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = linqFetch();
    const deliver = createPlanPrepDeliver(db.database, { transport, fetch: fetchMock });

    const delivered = await deliver({
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      offerId: f.offerId,
      kind: 'login_ask',
      parts: PARTS,
      now: NOW,
    });

    expect(delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await ledger(f.familyId);
    expect(rows.map((row) => [row.templateKey, row.status, row.errorCode])).toEqual([
      [`${PLAN_PREP_TEMPLATE}:login_ask`, 'failed', '21610'],
    ]);
    warn.mockRestore();
  });
});
