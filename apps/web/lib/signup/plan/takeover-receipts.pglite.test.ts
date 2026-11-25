import { schema } from '@hale/db';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelTransport, OutboundMessage } from '~/lib/channel/intake/transport';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { recordSignupOffer } from '../store';
import type { PlanNoticePart } from './bubbles';
import { PLAN_PREP_TEMPLATE, createPlanPrepDeliver } from './notice';
import type { PlanNoticeKind } from './prep';
import { approveSignupPlan } from './store';

// VIL-718 · the takeover texts over the real 1:1 door and the real ledger. The transport is a
// stand-in for Linq's answers. Invented hosts and details only.
const NOW = new Date('2026-12-01T12:01:00.000Z');
const HOST = 'register.example-rec.test';
const URL_ = `https://${HOST}/Clients/BookMe4LandingPages/CoursesLandingPage`;
const LINE = '+12025550142';
const CARD = 'https://app.example.test/l/AbCd123456';

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
  vi.stubEnv('LINQ_FROM_E164', LINE);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.database.delete(schema.linqLineHealth);
});

async function family() {
  const seeded = await seedFamily(db.database);
  seq += 1;
  const phone = `+1202555${String(600 + seq).padStart(4, '0')}`;
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
    sessions: [
      {
        id: 'sat-0900',
        label: 'Preschool Swim Sat 9:00',
        startsAt: '2027-01-09T14:00:00.000Z',
        endsAt: '2027-01-09T14:45:00.000Z',
        full: false,
        priceCents: 9800,
      },
    ],
    approvedPriceCents: null,
    now: new Date(NOW.getTime() - 24 * 60 * 60_000),
  });
  if (!offer.ok) throw new Error(offer.reason);
  expect(
    await approveSignupPlan(db.database, {
      offerId: offer.id,
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      messageId: `msg-receipts-${seq}`,
      choiceIds: ['sat-0900'],
      maxPriceCents: 10000,
      opensAt: NOW,
      waiverAccepted: true,
      now: new Date(NOW.getTime() - 20 * 60 * 60_000),
    }),
  ).toEqual({ ok: true });
  return { ...seeded, offerId: offer.id };
}

/** Linq's answers in turn: an error is thrown, anything else is an accept. */
function linq(...answers: Array<LinqSendError | 'ok'>) {
  const sends: OutboundMessage[] = [];
  const transport: ChannelTransport = {
    send: async (message) => {
      sends.push(message);
      const answer = answers.shift() ?? 'ok';
      if (answer !== 'ok') throw answer;
      return {
        providerMessageId: `provider-${sends.length}`,
        transport: 'imessage',
        chatId: 'chat-fixture',
      };
    },
  };
  return { transport, sends };
}

const textPart = (body: string): PlanNoticePart => ({ type: 'text', body });

function deliverWith(
  transport: ChannelTransport,
  home: { familyId: string; parentUserId: string; offerId: string },
  kind: PlanNoticeKind,
  parts: readonly PlanNoticePart[],
  fetchImpl?: typeof fetch,
) {
  const noticeKey = `${home.offerId}:${kind}`;
  return createPlanPrepDeliver(db.database, { transport, fetch: fetchImpl })({
    familyId: home.familyId,
    parentUserId: home.parentUserId,
    offerId: home.offerId,
    kind,
    noticeKey,
    parts,
    now: NOW,
  });
}

async function ledger(familyId: string) {
  return db.database
    .select()
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        like(schema.channelMessages.templateKey, `${PLAN_PREP_TEMPLATE}:%`),
      ),
    );
}

describe('VIL-718 · the takeover text keeps a true receipt', () => {
  it('a timeout is on the ledger as unconfirmed, never as a plain failure', async () => {
    const home = await family();
    const { transport } = linq(new LinqSendError('timeout', 0, false));
    expect(await deliverWith(transport, home, 'takeover_unfinished', [textPart('closing')])).toBe(
      'failed',
    );
    const [row] = await ledger(home.familyId);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'unconfirmed:timeout', sentAt: null });
  });

  it('a 409 is permanent but not a certain refusal: it stays unconfirmed', async () => {
    const home = await family();
    const { transport } = linq(new LinqSendError('conflict', 409, true));
    await deliverWith(transport, home, 'takeover_unfinished', [textPart('closing')]);
    const [row] = await ledger(home.familyId);
    expect(row?.errorCode).toBe('unconfirmed:conflict');
  });

  it('a retry of a send that may have landed carries the same provider key', async () => {
    const home = await family();
    const { transport, sends } = linq(new LinqSendError('timeout', 0, false), 'ok');
    await deliverWith(transport, home, 'takeover_unfinished', [textPart('first words')]);
    expect(await deliverWith(transport, home, 'takeover_unfinished', [textPart('new words')])).toBe(
      'sent',
    );
    expect(sends).toHaveLength(2);
    expect(sends[0]?.sendKey).toBe(`${PLAN_PREP_TEMPLATE}:${home.offerId}:takeover_unfinished:0`);
    expect(sends[1]?.sendKey).toBe(sends[0]?.sendKey);
    const [row] = await ledger(home.familyId);
    expect(row).toMatchObject({ status: 'sent', providerMessageId: 'provider-2' });
    expect(row?.sentAt).toEqual(NOW);
  });

  it('a run that died mid-send is not counted as sent: the retry goes under the same key', async () => {
    const home = await family();
    await db.database.insert(schema.channelMessages).values({
      familyId: home.familyId,
      parentUserId: home.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      templateKey: `${PLAN_PREP_TEMPLATE}:takeover_unfinished`,
      dedupeKey: `${PLAN_PREP_TEMPLATE}:${home.offerId}:takeover_unfinished:0`,
      status: 'queued',
      sentAt: null,
    });
    const { transport, sends } = linq('ok');
    expect(await deliverWith(transport, home, 'takeover_unfinished', [textPart('closing')])).toBe(
      'sent',
    );
    expect(sends.map((send) => send.sendKey)).toEqual([
      `${PLAN_PREP_TEMPLATE}:${home.offerId}:takeover_unfinished:0`,
    ]);
    const [row] = await ledger(home.familyId);
    expect(row?.providerMessageId).toBe('provider-1');
  });

  it('a certain refusal stays refused: a retry calls Linq no more', async () => {
    const home = await family();
    const { transport, sends } = linq(new LinqSendError('invalid_number', 422, true), 'ok');
    await deliverWith(transport, home, 'takeover_unfinished', [textPart('closing')]);
    const [row] = await ledger(home.familyId);
    expect(row?.errorCode).toBe('refused:invalid_number');
    expect(await deliverWith(transport, home, 'takeover_unfinished', [textPart('again')])).toBe(
      'failed',
    );
    expect(sends).toHaveLength(1);
  });

  it('a paused Linq line holds the text at send; a healthy line sends it', async () => {
    const home = await family();
    await db.database.insert(schema.linqLineHealth).values({
      phoneNumber: LINE,
      status: 'flagged/critical',
      paused: true,
      updatedAt: NOW,
    });
    const held = linq('ok');
    expect(await deliverWith(held.transport, home, 'takeover', [textPart('tap the link')])).toBe(
      'withheld',
    );
    expect(held.sends).toEqual([]);
    expect(await ledger(home.familyId)).toEqual([]);

    await db.database.delete(schema.linqLineHealth);
    const open = linq('ok');
    expect(await deliverWith(open.transport, home, 'takeover', [textPart('tap the link')])).toBe(
      'sent',
    );
    expect(open.sends).toHaveLength(1);
  });

  it('a card whose preview timed out goes as text under the preview key', async () => {
    vi.stubEnv('LINQ_API_KEY', 'fixture-linq-key');
    const home = await family();
    const keys: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      keys.push(JSON.parse(String(init?.body)).message.idempotency_key);
      throw new DOMException('timed out', 'TimeoutError');
    }) as unknown as typeof fetch;
    const { transport, sends } = linq('ok', 'ok');
    const parts: PlanNoticePart[] = [
      textPart('tap the link'),
      { type: 'link', url: CARD, loginLinkId: '00000000-0000-4000-8000-0000000000c1' },
    ];
    expect(await deliverWith(transport, home, 'takeover', parts, fetchImpl)).toBe('sent');
    const linkKey = `${PLAN_PREP_TEMPLATE}:${home.offerId}:takeover:link`;
    expect(keys).toHaveLength(1);
    expect(sends[1]).toMatchObject({ body: CARD, sendKey: linkKey });
  });

  it('a card whose preview was refused for certain goes as text under its own key', async () => {
    vi.stubEnv('LINQ_API_KEY', 'fixture-linq-key');
    const home = await family();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: 'invalid' } }), { status: 422 }),
    ) as unknown as typeof fetch;
    const { transport, sends } = linq('ok', 'ok');
    const parts: PlanNoticePart[] = [
      textPart('tap the link'),
      { type: 'link', url: CARD, loginLinkId: '00000000-0000-4000-8000-0000000000c2' },
    ];
    expect(await deliverWith(transport, home, 'takeover', parts, fetchImpl)).toBe('sent');
    expect(sends[1]).toMatchObject({
      body: CARD,
      sendKey: `${PLAN_PREP_TEMPLATE}:${home.offerId}:takeover:link:text`,
    });
  });

  it('every other notice kind keeps the door it has today: no provider key is passed', async () => {
    const home = await family();
    const { transport, sends } = linq('ok');
    expect(await deliverWith(transport, home, 'login_ask', [textPart('sign in tonight')])).toBe(
      'sent',
    );
    expect(sends[0]?.sendKey).toBeUndefined();
  });
});
