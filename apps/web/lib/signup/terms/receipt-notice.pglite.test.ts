import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import type { ReceiptResult } from '../browser-use/receipt';
import { MAX_RECEIPT_IMAGE_BYTES, PLAN_RECEIPT_TEMPLATE, createPlanNotifier } from '../plan/notice';
import type { PlanOutcomeNotice } from '../plan/run';
import { recordSignupOffer } from '../store';

const NOW = new Date('2026-12-01T12:05:00.000Z');
const URL_ = 'https://register.example-rec.test/Clients/BookMe4LandingPages/CoursesLandingPage';
const OPS = 'https://hooks.slack.test/ops-fixture';
const PNG = Buffer.from('fake-masked-png-bytes');

let db: TestDb;
let seq = 0;
let posted: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  posted = [];
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', OPS);
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === OPS) posted.push(JSON.parse(init?.body ?? '{}').text);
    return new Response('ok', { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function plan() {
  seq += 1;
  const seeded = await seedFamily(db.database);
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 60, undefined, NOW);
  const phone = `+1202555${String(7000 + seq).padStart(4, '0')}`;
  await db.database.insert(schema.parentChannels).values({
    userId: seeded.parentUserId,
    familyId: seeded.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
  });
  const offer = await recordSignupOffer(db.database, {
    familyId: seeded.familyId,
    childId,
    parentUserId: seeded.parentUserId,
    activityKey: 'speaking',
    registrationUrl: URL_,
    sessions: [
      {
        id: 's-1',
        label: 'Sat 9:30',
        startsAt: '2026-12-05T09:30:00',
        endsAt: '2026-12-05T10:30:00',
        full: false,
        priceCents: 8488,
      },
    ],
    approvedPriceCents: null,
    planOpensAt: NOW,
    planAlreadyOpen: true,
    now: NOW,
  });
  if (!offer.ok) throw new Error(offer.reason);
  await db.database
    .update(schema.authorizedSignupOffers)
    .set({ status: 'completed', planChoiceIds: ['s-1'], planMaxPriceCents: 8488 })
    .where(eq(schema.authorizedSignupOffers.id, offer.id));
  return { ...seeded, phone, offerId: offer.id };
}

const notice = (
  f: Awaited<ReturnType<typeof plan>>,
  receipt?: ReceiptResult,
): PlanOutcomeNotice => ({
  offerId: f.offerId,
  familyId: f.familyId,
  parentUserId: f.parentUserId,
  outcome: 'completed',
  detail: 'none',
  choiceIndex: 0,
  cartTotalCents: 8488,
  amountChargedCents: 8488,
  charged: { cents: 8488 },
  confirmationNumber: 'R-55120',
  liveViewUrl: null,
  holdExpiresAt: null,
  ...(receipt ? { receipt } : {}),
});

const CAPTURED: ReceiptResult = {
  ok: true,
  receipt: { png: PNG, sha256: 'abc', bytes: PNG.byteLength, kept: ['R-55120'] },
};

function transport(sendImage?: ChannelTransport['sendImage']) {
  const order: string[] = [];
  const carrier: ChannelTransport = {
    send: vi.fn(async () => {
      order.push('text');
      return { providerMessageId: 'msg-text', transport: 'imessage' as const, chatId: 'chat-1' };
    }),
    ...(sendImage
      ? {
          sendImage: vi.fn(async (input: Parameters<NonNullable<typeof sendImage>>[0]) => {
            order.push('image');
            return sendImage(input);
          }),
        }
      : {}),
  };
  return { carrier, order };
}

const notifier = (carrier: ChannelTransport) =>
  createPlanNotifier(db.database, {
    writer: { write: async () => 'She is registered.' },
    transport: carrier,
    now: () => NOW,
  });

async function receiptRow(familyId: string) {
  const [row] = await db.database
    .select()
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.templateKey, PLAN_RECEIPT_TEMPLATE),
      ),
    );
  return row ?? null;
}

async function deliveryAudit(familyId: string) {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
  return rows
    .map((row) => row.after as Record<string, unknown> | null)
    .filter((after) => after?.step === 'plan_receipt_delivery');
}

describe('the masked receipt, after the confirmation text', () => {
  it('audits an image the transport accepted, with no image content', async () => {
    const f = await plan();
    const { carrier } = transport(async () => ({
      providerMessageId: 'msg-image',
      transport: 'imessage',
      chatId: 'chat-1',
    }));
    await notifier(carrier)(notice(f, CAPTURED));
    const rows = await deliveryAudit(f.familyId);
    expect(rows).toEqual([
      { step: 'plan_receipt_delivery', outcome: 'accepted', bytes: PNG.byteLength },
    ]);
    expect(JSON.stringify(rows)).not.toContain(PNG.toString('base64'));
  });

  it('audits an image the transport refused', async () => {
    const f = await plan();
    const { carrier } = transport(async () => {
      throw new LinqSendError('upload_http_500', 500, false);
    });
    await notifier(carrier)(notice(f, CAPTURED));
    expect(await deliveryAudit(f.familyId)).toEqual([
      {
        step: 'plan_receipt_delivery',
        outcome: 'refused',
        reason: 'send_failed',
        bytes: PNG.byteLength,
      },
    ]);
  });

  it('audits an image never handed to the transport, by reason', async () => {
    const f = await plan();
    const { carrier } = transport();
    await notifier(carrier)(notice(f, CAPTURED));
    expect(await deliveryAudit(f.familyId)).toEqual([
      {
        step: 'plan_receipt_delivery',
        outcome: 'not_sent',
        reason: 'transport_unsupported',
        bytes: PNG.byteLength,
      },
    ]);
  });

  it('goes after the text, to the parent, and is ledgered sent once accepted', async () => {
    const f = await plan();
    const { carrier, order } = transport(async () => ({
      providerMessageId: 'msg-image',
      transport: 'imessage',
      chatId: 'chat-1',
    }));
    await expect(notifier(carrier)(notice(f, CAPTURED))).resolves.toBe('sent');
    expect(order).toEqual(['text', 'image']);
    expect(carrier.sendImage).toHaveBeenCalledWith({
      to: f.phone,
      png: PNG,
      filename: 'registration-receipt.png',
    });
    const row = await receiptRow(f.familyId);
    expect(row).toMatchObject({
      direction: 'out',
      providerMessageId: 'msg-image',
      providerChatId: 'chat-1',
      channel: 'imessage',
      dedupeKey: `${PLAN_RECEIPT_TEMPLATE}:${f.offerId}`,
    });
    expect(row?.sentAt).not.toBeNull();
    expect(row?.status).not.toBe('queued');
    expect(posted).toEqual([]);
  });

  it('a failed image leaves the text sent, the row failed, and pages #ops', async () => {
    const f = await plan();
    const { carrier, order } = transport(async () => {
      throw new LinqSendError('upload_http_500', 500, false);
    });
    await expect(notifier(carrier)(notice(f, CAPTURED))).resolves.toBe('sent');
    expect(order).toEqual(['text', 'image']);
    const row = await receiptRow(f.familyId);
    expect(row?.status).toBe('failed');
    expect(row?.sentAt).toBeNull();
    expect(posted.join(' ')).toContain('registration_receipt_unsent');
    expect(posted.join(' ')).toContain('send_failed');
  });

  it('a capture that failed sends no image; the run already named it on #ops', async () => {
    const f = await plan();
    const { carrier, order } = transport(async () => ({ providerMessageId: 'msg-image' }));
    await expect(
      notifier(carrier)(notice(f, { ok: false, reason: 'verify_failed' })),
    ).resolves.toBe('sent');
    expect(order).toEqual(['text']);
    expect(await receiptRow(f.familyId)).toBeNull();
    expect(posted).toEqual([]);
    expect(await deliveryAudit(f.familyId)).toEqual([]);
  });

  it('a transport that cannot carry an image is a named absence', async () => {
    const f = await plan();
    const { carrier, order } = transport();
    await expect(notifier(carrier)(notice(f, CAPTURED))).resolves.toBe('sent');
    expect(order).toEqual(['text']);
    expect(posted.join(' ')).toContain('transport_unsupported');
  });

  it('refuses an image over the limit by name', async () => {
    const f = await plan();
    const { carrier, order } = transport(async () => ({ providerMessageId: 'msg-image' }));
    const big: ReceiptResult = {
      ok: true,
      receipt: { png: PNG, sha256: 'abc', bytes: MAX_RECEIPT_IMAGE_BYTES + 1, kept: ['R-55120'] },
    };
    await notifier(carrier)(notice(f, big));
    expect(order).toEqual(['text']);
    expect(posted.join(' ')).toContain('too_large');
  });

  it('with no receipt on the notice, no image is tried (flag off)', async () => {
    const f = await plan();
    const { carrier, order } = transport(async () => ({ providerMessageId: 'msg-image' }));
    await expect(notifier(carrier)(notice(f))).resolves.toBe('sent');
    expect(order).toEqual(['text']);
    expect(carrier.sendImage).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });
});
