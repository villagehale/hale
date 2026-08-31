import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeDb, makeFakeDb } from '~/lib/channel/intake/fakes';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  WHATSAPP_SESSION_WINDOW_MS,
  createOwnerReplyDecider,
  createReplyTransport,
  selectReplyTransport,
} from './reply-transport';

/**
 * The reply-destination seam (WhatsApp v1): last-inbound-transport wins, but only
 * inside Meta's 24-hour customer-service window and only while the WhatsApp sender
 * is provisioned. Every SMS fallback is NAMED (rule #11) — 'not_configured' while
 * the leg is dark, 'window_expired' outside the session, 'no_whatsapp_history' for
 * everyone who has only ever texted.
 */

const NOW = new Date('2026-08-31T12:00:00.000Z');
const PHONE = '+14165551234';
const KEY = Buffer.alloc(32, 7).toString('base64');

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

describe('selectReplyTransport', () => {
  const whatsappJustNow = { transport: 'whatsapp' as const, receivedAt: NOW };

  it('unconfigured means SMS unconditionally — the degrade is to the working transport, named', () => {
    expect(
      selectReplyTransport({ configured: false, lastInbound: whatsappJustNow, now: NOW }),
    ).toEqual({ transport: 'sms', reason: 'not_configured' });
  });

  it('no inbound history means SMS, named', () => {
    expect(selectReplyTransport({ configured: true, lastInbound: null, now: NOW })).toEqual({
      transport: 'sms',
      reason: 'no_whatsapp_history',
    });
  });

  it('a parent who last wrote by SMS is answered by SMS', () => {
    expect(
      selectReplyTransport({
        configured: true,
        lastInbound: { transport: 'sms', receivedAt: NOW },
        now: NOW,
      }),
    ).toEqual({ transport: 'sms', reason: 'no_whatsapp_history' });
  });

  it('a WhatsApp message inside the 24h window is answered on WhatsApp', () => {
    const receivedAt = new Date(NOW.getTime() - (WHATSAPP_SESSION_WINDOW_MS - 1));
    expect(
      selectReplyTransport({
        configured: true,
        lastInbound: { transport: 'whatsapp', receivedAt },
        now: NOW,
      }),
    ).toEqual({ transport: 'whatsapp' });
  });

  it('exactly 24h old is OUTSIDE the window — a free-form send would earn Twilio 63016', () => {
    const receivedAt = new Date(NOW.getTime() - WHATSAPP_SESSION_WINDOW_MS);
    expect(
      selectReplyTransport({
        configured: true,
        lastInbound: { transport: 'whatsapp', receivedAt },
        now: NOW,
      }),
    ).toEqual({ transport: 'sms', reason: 'window_expired' });
  });
});

describe('createReplyTransport', () => {
  function harness(decision: Awaited<ReturnType<typeof selectReplyTransport>>) {
    const sms = new FakeTransport();
    const whatsapp = new FakeTransport();
    const asked: string[] = [];
    const transport = createReplyTransport({
      sms,
      whatsapp,
      decide: async (to) => {
        asked.push(to);
        return decision;
      },
    });
    return { sms, whatsapp, asked, transport };
  }

  it('rides WhatsApp when the decision says so, and NAMES the pipe in the result', async () => {
    const h = harness({ transport: 'whatsapp' });
    const result = await h.transport.send({ to: PHONE, body: 'hello' });
    expect(h.whatsapp.bodies()).toEqual(['hello']);
    expect(h.sms.sent).toEqual([]);
    expect(h.asked).toEqual([PHONE]);
    expect(result.transport).toBe('whatsapp');
    expect(result.providerMessageId).toBe('fake-out-1');
  });

  it('rides SMS on a fallback decision', async () => {
    const h = harness({ transport: 'sms', reason: 'window_expired' });
    const result = await h.transport.send({ to: PHONE, body: 'hello' });
    expect(h.sms.bodies()).toEqual(['hello']);
    expect(h.whatsapp.sent).toEqual([]);
    expect(result.transport).toBe('sms');
  });

  it('media always rides SMS — the WhatsApp leg cannot carry the vCard, and dropping it is forbidden', async () => {
    const h = harness({ transport: 'whatsapp' });
    const result = await h.transport.send({
      to: PHONE,
      body: 'card attached',
      mediaUrls: ['https://villagehale.com/hale.vcf'],
    });
    expect(h.whatsapp.sent).toEqual([]);
    expect(h.sms.media()).toEqual([['https://villagehale.com/hale.vcf']]);
    expect(result.transport).toBe('sms');
    // The decision was never even consulted: media has exactly one capable pipe.
    expect(h.asked).toEqual([]);
  });
});

describe('createOwnerReplyDecider', () => {
  function seedOwner(fake: FakeDb): { familyId: string; userId: string } {
    const familyId = '00000000-0000-4000-8000-0000000000f1';
    const userId = '00000000-0000-4000-8000-0000000000u1';
    fake.db.insert(schema.parentChannels).values({
      userId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: NOW,
    } as never);
    return { familyId, userId };
  }

  function seedInbound(
    fake: FakeDb,
    owner: { familyId: string; userId: string },
    row: { channel: string; direction: string; sentAt: Date; providerMessageId: string },
  ): void {
    fake.db.insert(schema.channelMessages).values({
      familyId: owner.familyId,
      parentUserId: owner.userId,
      channel: row.channel,
      direction: row.direction,
      category: 'reply',
      providerMessageId: row.providerMessageId,
      status: 'delivered',
      sentAt: row.sentAt,
      createdAt: row.sentAt,
    } as never);
  }

  it('answers a parent whose newest inbound was WhatsApp, in window, on WhatsApp', async () => {
    const fake = makeFakeDb();
    const owner = seedOwner(fake);
    seedInbound(fake, owner, {
      channel: 'sms',
      direction: 'in',
      sentAt: new Date(NOW.getTime() - 3_600_000 * 30),
      providerMessageId: 'SMold',
    });
    seedInbound(fake, owner, {
      channel: 'whatsapp',
      direction: 'in',
      sentAt: new Date(NOW.getTime() - 3_600_000),
      providerMessageId: 'SMnew',
    });

    const decide = createOwnerReplyDecider(fake.db, { now: () => NOW, configured: () => true });
    await expect(decide(PHONE)).resolves.toEqual({ transport: 'whatsapp' });
  });

  it('a WhatsApp session older than 24h falls back to SMS, named window_expired', async () => {
    const fake = makeFakeDb();
    const owner = seedOwner(fake);
    seedInbound(fake, owner, {
      channel: 'whatsapp',
      direction: 'in',
      sentAt: new Date(NOW.getTime() - WHATSAPP_SESSION_WINDOW_MS - 1),
      providerMessageId: 'SMold',
    });

    const decide = createOwnerReplyDecider(fake.db, { now: () => NOW, configured: () => true });
    await expect(decide(PHONE)).resolves.toEqual({ transport: 'sms', reason: 'window_expired' });
  });

  it('an OUTBOUND whatsapp row is not a session — only what the parent sent opens the window', async () => {
    const fake = makeFakeDb();
    const owner = seedOwner(fake);
    seedInbound(fake, owner, {
      channel: 'sms',
      direction: 'in',
      sentAt: new Date(NOW.getTime() - 7_200_000),
      providerMessageId: 'SMin',
    });
    seedInbound(fake, owner, {
      channel: 'whatsapp',
      direction: 'out',
      sentAt: new Date(NOW.getTime() - 60_000),
      providerMessageId: 'SMout',
    });

    const decide = createOwnerReplyDecider(fake.db, { now: () => NOW, configured: () => true });
    await expect(decide(PHONE)).resolves.toEqual({
      transport: 'sms',
      reason: 'no_whatsapp_history',
    });
  });

  it('a number with no verified channel is SMS — the decider never guesses an owner', async () => {
    const fake = makeFakeDb();
    const decide = createOwnerReplyDecider(fake.db, { now: () => NOW, configured: () => true });
    await expect(decide(PHONE)).resolves.toEqual({
      transport: 'sms',
      reason: 'no_whatsapp_history',
    });
  });

  it('with TWILIO_WHATSAPP_FROM unset the default decider is dark: SMS, named not_configured', async () => {
    vi.stubEnv('TWILIO_WHATSAPP_FROM', '');
    const fake = makeFakeDb();
    const owner = seedOwner(fake);
    seedInbound(fake, owner, {
      channel: 'whatsapp',
      direction: 'in',
      sentAt: NOW,
      providerMessageId: 'SMnew',
    });

    const decide = createOwnerReplyDecider(fake.db, { now: () => NOW });
    await expect(decide(PHONE)).resolves.toEqual({ transport: 'sms', reason: 'not_configured' });
  });
});
