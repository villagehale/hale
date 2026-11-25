import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { scriptedFriendVoice } from '~/lib/channel/intake/scripted-friend-voice.fixture';
import { loadOpenSession } from '~/lib/channel/intake/session';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { setSharedSpokenLineWriter } from '~/lib/channel/spoken-line';
import { OTP_TTL_MS } from '~/lib/channels/otp';
import {
  FakeOtpSender,
  type OtpSender,
  createOtpSender,
  otpMessage,
} from '~/lib/channels/otp-sender';
import { maskPhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { askWriter, yesNoReader } from '~/lib/testing/consent-double';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';
import { recordBillingNoticeIntent } from './notices/record';
import {
  PRICING_ATTEMPT_CAP,
  PRICING_CODE_SEND_CAP,
  erasePricingCheckoutRows,
  recordPricingDirectCheckout,
  recordPricingSubscriptionEnded,
  sendPricingCheckoutCode,
  verifyPricingCheckoutCode,
} from './pricing-checkout';

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-11-25T18:00:00.000Z');
const NOON = new Date('2026-07-30T16:00:00.000Z');

let db: TestDb;
let serial = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  setSharedSpokenLineWriter(scriptedSpokenLineWriter);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setSharedSpokenLineWriter(null);
});

function sessionId(): string {
  serial += 1;
  return `cs_test_pricing_${serial}`;
}

function paidEvent(id: string, phone: string, tier = 'plus') {
  return {
    id: `evt_${id}`,
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id,
        payment_status: 'paid',
        customer: `cus_${id}`,
        subscription: `sub_${id}`,
        customer_details: { phone },
        metadata: {
          source: 'pricing_direct',
          tier,
          sku: tier === 'plus' ? 'promo_plus_annual' : 'promo_max_annual',
          currency: 'CAD',
        },
      },
    },
  };
}

async function payment(id: string) {
  const [row] = await db.database
    .select()
    .from(schema.pricingCheckoutPayments)
    .where(eq(schema.pricingCheckoutPayments.stripeSessionId, id))
    .limit(1);
  return row ?? null;
}

async function familyCount(): Promise<number> {
  const rows = await db.database.select({ id: schema.families.id }).from(schema.families);
  return rows.length;
}

function later(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

describe('the verification text', () => {
  it('is the one fixed sentence', async () => {
    const bodies: string[] = [];
    const sender = createOtpSender({
      async sendSms(_to, body) {
        bodies.push(body);
      },
    });
    await sender.sendCode({ phoneE164: '+14165550100', code: '123456' });
    expect(bodies).toEqual([otpMessage('123456')]);
    expect(bodies[0]).toBe('Your Hale verification code is 123456. It expires in 10 minutes.');
  });
});

describe('pricing checkout payments', () => {
  it('ignores anything that is not a paid pricing checkout, without a query', async () => {
    const database = new Proxy({} as Database, {
      get() {
        throw new Error('queried');
      },
    });
    const familyCheckout = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_family_checkout',
          payment_status: 'paid',
          metadata: { familyId: 'fam', tier: 'plus' },
        },
      },
    };
    const unpaid = paidEvent('cs_test_unpaid', '+14165550100');
    unpaid.data.object.payment_status = 'unpaid';
    await expect(recordPricingDirectCheckout(database, familyCheckout)).resolves.toBe('ignored');
    await expect(recordPricingDirectCheckout(database, unpaid)).resolves.toBe('ignored');
    await expect(recordPricingDirectCheckout(database, { type: 'invoice.paid' })).resolves.toBe(
      'ignored',
    );
  });

  it('stores one row on replay, and a second event does not change the tier or the phone', async () => {
    const id = sessionId();
    const phone = '+14165551001';
    await expect(
      recordPricingDirectCheckout(db.database, paidEvent(id, phone, 'plus')),
    ).resolves.toBe('stored');
    await expect(
      recordPricingDirectCheckout(db.database, paidEvent(id, '+14165551099', 'max')),
    ).resolves.toBe('replay');
    const row = await payment(id);
    expect(row?.tier).toBe('plus');
    expect(row?.phoneE164Hash).toBe(phoneBlindIndex(phone));
    expect(row?.boundAt).toBeNull();
    const rows = await db.database
      .select({ id: schema.pricingCheckoutPayments.id })
      .from(schema.pricingCheckoutPayments)
      .where(eq(schema.pricingCheckoutPayments.stripeSessionId, id));
    expect(rows).toHaveLength(1);
  });

  it('stores a pricing checkout while billing notices are dark, and skips a normal checkout', async () => {
    const id = sessionId();
    await expect(
      recordBillingNoticeIntent(db.database, paidEvent(id, '+14165551002'), { status: 'unbound' }),
    ).resolves.toBe('dark');
    expect(await payment(id)).not.toBeNull();

    const other = sessionId();
    await recordBillingNoticeIntent(
      db.database,
      {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: other,
            payment_status: 'paid',
            metadata: { familyId: 'fam', tier: 'plus' },
          },
        },
      },
      { status: 'unbound' },
    );
    expect(await payment(other)).toBeNull();
  });
});

describe('pricing checkout codes', () => {
  async function pay(phone: string, tier = 'plus'): Promise<{ id: string; sender: FakeOtpSender }> {
    const id = sessionId();
    await recordPricingDirectCheckout(db.database, paidEvent(id, phone, tier));
    return { id, sender: new FakeOtpSender() };
  }

  it('sends once, expires, and will not take the same code twice', async () => {
    const phone = '+14165552001';
    const { id, sender } = await pay(phone);
    const sent = await sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender });
    expect(sent).toMatchObject({ status: 'sent', phone, direct: true, bound: false });
    const again = await sendPricingCheckoutCode(db.database, {
      sessionId: id,
      now: later(1_000),
      sender,
    });
    expect(again.status).toBe('sent');
    expect(sender.sent).toHaveLength(1);

    const code = sender.sent[0]?.code ?? '';
    await expect(
      verifyPricingCheckoutCode(db.database, { sessionId: id, code, now: later(OTP_TTL_MS) }),
    ).resolves.toMatchObject({ status: 'expired' });
    expect((await payment(id))?.boundAt).toBeNull();

    const fresh = new FakeOtpSender();
    const resent = await sendPricingCheckoutCode(db.database, {
      sessionId: id,
      now: later(OTP_TTL_MS),
      sender: fresh,
      resend: true,
    });
    expect(resent.status).toBe('sent');
    const verified = await verifyPricingCheckoutCode(db.database, {
      sessionId: id,
      code: fresh.sent[0]?.code ?? '',
      now: later(OTP_TTL_MS),
    });
    expect(verified.status).toBe('verified');
    const families = await familyCount();
    await expect(
      verifyPricingCheckoutCode(db.database, {
        sessionId: id,
        code: fresh.sent[0]?.code ?? '',
        now: later(OTP_TTL_MS + 1),
      }),
    ).resolves.toMatchObject({ status: 'already_bound' });
    expect(await familyCount()).toBe(families);
    expect((await payment(id))?.boundPhoneE164Hash).toBe(phoneBlindIndex(phone));
  });

  it('waits out the resend cooldown and stops at the send cap', async () => {
    const { id, sender } = await pay('+14165552002');
    await sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender });
    const cooled = await sendPricingCheckoutCode(db.database, {
      sessionId: id,
      now: later(1_000),
      sender,
      resend: true,
    });
    expect(cooled.status).toBe('cooldown');
    expect(sender.sent).toHaveLength(1);

    let at = NOW;
    for (let n = 1; n < PRICING_CODE_SEND_CAP; n += 1) {
      at = new Date(at.getTime() + 61_000);
      const sent = await sendPricingCheckoutCode(db.database, {
        sessionId: id,
        now: at,
        sender,
        resend: true,
      });
      expect(sent.status).toBe('sent');
    }
    expect(sender.sent).toHaveLength(PRICING_CODE_SEND_CAP);
    const blocked = await sendPricingCheckoutCode(db.database, {
      sessionId: id,
      now: new Date(at.getTime() + 61_000),
      sender,
      resend: true,
    });
    expect(blocked.status).toBe('send_limited');
    expect(sender.sent).toHaveLength(PRICING_CODE_SEND_CAP);
  });

  it('locks a code after three wrong guesses and the session after the attempt cap', async () => {
    const { id, sender } = await pay('+14165552003');
    await sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender });
    const code = sender.sent[0]?.code ?? '';
    await verifyPricingCheckoutCode(db.database, { sessionId: id, code: '000000', now: NOW });
    await verifyPricingCheckoutCode(db.database, { sessionId: id, code: '000000', now: NOW });
    await expect(
      verifyPricingCheckoutCode(db.database, { sessionId: id, code: '000000', now: NOW }),
    ).resolves.toMatchObject({ status: 'locked' });
    await expect(
      verifyPricingCheckoutCode(db.database, { sessionId: id, code, now: NOW }),
    ).resolves.toMatchObject({ status: 'locked' });

    // Three more wrong guesses on a fresh code. Six spent, still under the cap.
    const secondAt = later(61_000);
    const second = new FakeOtpSender();
    await sendPricingCheckoutCode(db.database, {
      sessionId: id,
      now: secondAt,
      sender: second,
      resend: true,
    });
    await verifyPricingCheckoutCode(db.database, { sessionId: id, code: '111111', now: secondAt });
    await verifyPricingCheckoutCode(db.database, { sessionId: id, code: '111111', now: secondAt });
    await expect(
      verifyPricingCheckoutCode(db.database, { sessionId: id, code: '111111', now: secondAt }),
    ).resolves.toMatchObject({ status: 'locked' });

    // Two more reach eight. The code that was just sent no longer binds.
    const thirdAt = later(122_000);
    const third = new FakeOtpSender();
    await sendPricingCheckoutCode(db.database, {
      sessionId: id,
      now: thirdAt,
      sender: third,
      resend: true,
    });
    const current = third.sent[0]?.code ?? '';
    await expect(
      verifyPricingCheckoutCode(db.database, { sessionId: id, code: '222222', now: thirdAt }),
    ).resolves.toMatchObject({ status: 'wrong_code' });
    await expect(
      verifyPricingCheckoutCode(db.database, { sessionId: id, code: '222222', now: thirdAt }),
    ).resolves.toMatchObject({ status: 'attempts_limited' });
    await expect(
      verifyPricingCheckoutCode(db.database, { sessionId: id, code: current, now: thirdAt }),
    ).resolves.toMatchObject({ status: 'attempts_limited' });
    expect((await payment(id))?.boundAt).toBeNull();
    expect(PRICING_ATTEMPT_CAP).toBe(8);
  });

  it('counts a second session on the same number toward the send cap and the attempt cap', async () => {
    const phone = '+14165552009';
    const first = await pay(phone);
    await sendPricingCheckoutCode(db.database, {
      sessionId: first.id,
      now: NOW,
      sender: first.sender,
    });
    const other = await pay(phone);
    await expect(
      sendPricingCheckoutCode(db.database, {
        sessionId: other.id,
        now: later(1_000),
        sender: other.sender,
      }),
    ).resolves.toMatchObject({ status: 'cooldown' });

    let at = NOW;
    for (let n = 1; n < PRICING_CODE_SEND_CAP; n += 1) {
      at = new Date(at.getTime() + 61_000);
      const sent = await sendPricingCheckoutCode(db.database, {
        sessionId: first.id,
        now: at,
        sender: first.sender,
        resend: true,
      });
      expect(sent.status).toBe('sent');
    }
    await expect(
      sendPricingCheckoutCode(db.database, {
        sessionId: other.id,
        now: new Date(at.getTime() + 61_000),
        sender: other.sender,
      }),
    ).resolves.toMatchObject({ status: 'send_limited' });
    expect(other.sender.sent).toHaveLength(0);

    const burnedPhone = '+14165552010';
    const burned = await pay(burnedPhone);
    await sendPricingCheckoutCode(db.database, {
      sessionId: burned.id,
      now: NOW,
      sender: burned.sender,
    });
    for (const code of ['000000', '000000', '000000']) {
      await verifyPricingCheckoutCode(db.database, { sessionId: burned.id, code, now: NOW });
    }
    const secondAt = later(61_000);
    const second = new FakeOtpSender();
    await sendPricingCheckoutCode(db.database, {
      sessionId: burned.id,
      now: secondAt,
      sender: second,
      resend: true,
    });
    for (const code of ['111111', '111111', '111111']) {
      await verifyPricingCheckoutCode(db.database, { sessionId: burned.id, code, now: secondAt });
    }
    const thirdAt = later(122_000);
    const third = new FakeOtpSender();
    await sendPricingCheckoutCode(db.database, {
      sessionId: burned.id,
      now: thirdAt,
      sender: third,
      resend: true,
    });
    await verifyPricingCheckoutCode(db.database, {
      sessionId: burned.id,
      code: '222222',
      now: thirdAt,
    });
    await verifyPricingCheckoutCode(db.database, {
      sessionId: burned.id,
      code: '222222',
      now: thirdAt,
    });

    const fresh = await pay(burnedPhone);
    const freshAt = later(183_000);
    const sent = await sendPricingCheckoutCode(db.database, {
      sessionId: fresh.id,
      now: freshAt,
      sender: fresh.sender,
    });
    expect(sent.status).toBe('sent');
    await expect(
      verifyPricingCheckoutCode(db.database, {
        sessionId: fresh.id,
        code: fresh.sender.sent[0]?.code ?? '',
        now: freshAt,
      }),
    ).resolves.toMatchObject({ status: 'attempts_limited' });
    expect((await payment(fresh.id))?.boundAt).toBeNull();
  });

  it('binds the corrected number only after that number’s code verifies', async () => {
    const original = '+14165552004';
    const corrected = '+14165552005';
    const { id, sender } = await pay(original);
    await sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender });
    const oldCode = sender.sent[0]?.code ?? '';
    const moved = await sendPricingCheckoutCode(db.database, {
      sessionId: id,
      phone: corrected,
      resend: true,
      now: later(61_000),
      sender,
    });
    expect(moved.status).toBe('sent');
    expect(sender.sent[1]?.phoneE164).toBe(corrected);
    const before = await familyCount();
    await expect(
      verifyPricingCheckoutCode(db.database, { sessionId: id, code: oldCode, now: later(61_000) }),
    ).resolves.toMatchObject({ status: 'wrong_code' });
    expect((await payment(id))?.boundAt).toBeNull();
    expect(await familyCount()).toBe(before);
    const verified = await verifyPricingCheckoutCode(db.database, {
      sessionId: id,
      code: sender.sent[1]?.code ?? '',
      now: later(61_000),
    });
    expect(verified.status).toBe('verified');
    const row = await payment(id);
    expect(row?.boundPhoneE164Hash).toBe(phoneBlindIndex(corrected));
    expect(row?.boundPhoneE164Hash).not.toBe(phoneBlindIndex(original));
    const channels = await db.database
      .select({ id: schema.parentChannels.id })
      .from(schema.parentChannels)
      .where(eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(corrected)));
    expect(channels).toHaveLength(0);
    const [audit] = await db.database
      .select({ after: schema.auditLog.after, actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, row?.boundFamilyId ?? ''));
    expect(audit?.actionTaken).toBe('pricing_checkout_bound');
    expect(audit?.after).toMatchObject({ phone: maskPhoneE164(corrected), tier: 'plus' });
  });

  it('does not keep a code when the send fails', async () => {
    const { id } = await pay('+14165552006');
    const sender: OtpSender = {
      async sendCode() {
        throw new Error('down');
      },
    };
    await expect(
      sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender }),
    ).resolves.toMatchObject({ status: 'send_failed' });
    const codes = await db.database
      .select({ id: schema.pricingCheckoutCodes.id })
      .from(schema.pricingCheckoutCodes)
      .where(eq(schema.pricingCheckoutCodes.stripeSessionId, id));
    expect(codes).toHaveLength(0);
  });

  it('upgrades an active channel’s family and does not open a second one', async () => {
    const phone = '+14165552007';
    const seeded = await seedFamily(db.database, 'Already texting');
    await db.database
      .update(schema.families)
      .set({ planTier: 'family' })
      .where(eq(schema.families.id, seeded.familyId));
    await db.database.insert(schema.parentChannels).values({
      userId: seeded.parentUserId,
      familyId: seeded.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: NOW,
    });
    const { id, sender } = await pay(phone, 'plus');
    await sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender });
    const before = await familyCount();
    const verified = await verifyPricingCheckoutCode(db.database, {
      sessionId: id,
      code: sender.sent[0]?.code ?? '',
      now: NOW,
    });
    expect(verified.status).toBe('verified');
    expect(verified.familyId).toBe(seeded.familyId);
    expect(await familyCount()).toBe(before);
    const [family] = await db.database
      .select({ planTier: schema.families.planTier })
      .from(schema.families)
      .where(eq(schema.families.id, seeded.familyId));
    expect(family?.planTier).toBe('family');
  });

  it('sends the corrected number again when resend omits the phone', async () => {
    const stripePhone = '+14165552013';
    const corrected = '+14165552014';
    const { id, sender } = await pay(stripePhone);
    await sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender });
    await sendPricingCheckoutCode(db.database, {
      sessionId: id,
      phone: corrected,
      resend: true,
      now: later(61_000),
      sender,
    });
    await sendPricingCheckoutCode(db.database, {
      sessionId: id,
      resend: true,
      now: later(122_000),
      sender,
    });
    expect(sender.sent.map((row) => row.phoneE164)).toEqual([stripePhone, corrected, corrected]);
  });

  it('does not bind a code that was already replaced', async () => {
    const phone = '+14165552015';
    const before = await familyCount();
    const { id, sender } = await pay(phone);
    await sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender });
    const code = sender.sent[0]?.code ?? '';
    await db.database
      .update(schema.pricingCheckoutCodes)
      .set({ consumedAt: NOW })
      .where(eq(schema.pricingCheckoutCodes.stripeSessionId, id));
    const verified = await verifyPricingCheckoutCode(db.database, {
      sessionId: id,
      code,
      now: NOW,
    });
    expect(verified.status).toBe('no_pending');
    expect(await familyCount()).toBe(before);
    expect((await payment(id))?.boundAt).toBeNull();
  });

  it('does not bind a checkout whose subscription has ended', async () => {
    const phone = '+14165552016';
    const before = await familyCount();
    const { id, sender } = await pay(phone);
    await sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender });
    const ended = await recordPricingSubscriptionEnded(db.database, {
      type: 'customer.subscription.deleted',
      data: { object: { id: `sub_${id}` } },
    });
    expect(ended).toBe('ended');
    const verified = await verifyPricingCheckoutCode(db.database, {
      sessionId: id,
      code: sender.sent[0]?.code ?? '',
      now: NOW,
    });
    expect(verified.status).toBe('payment_ended');
    expect(await familyCount()).toBe(before);
    expect((await payment(id))?.boundAt).toBeNull();
  });

  it('does not open a second subscription for a family that already has one', async () => {
    const phone = '+14165552017';
    const seeded = await seedFamily(db.database, 'Already paying');
    await db.database
      .update(schema.families)
      .set({ planTier: 'plus', stripeSubscriptionId: 'sub_already_live' })
      .where(eq(schema.families.id, seeded.familyId));
    await db.database.insert(schema.parentChannels).values({
      userId: seeded.parentUserId,
      familyId: seeded.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: NOW,
    });
    const before = await familyCount();
    const { id, sender } = await pay(phone, 'family');
    await sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender });
    const verified = await verifyPricingCheckoutCode(db.database, {
      sessionId: id,
      code: sender.sent[0]?.code ?? '',
      now: NOW,
    });
    expect(verified.status).toBe('already_subscribed');
    expect(verified.subscriptionId).toBe(`sub_${id}`);
    expect(await familyCount()).toBe(before);
    const [family] = await db.database
      .select({
        planTier: schema.families.planTier,
        stripeSubscriptionId: schema.families.stripeSubscriptionId,
      })
      .from(schema.families)
      .where(eq(schema.families.id, seeded.familyId));
    expect(family?.planTier).toBe('plus');
    expect(family?.stripeSubscriptionId).toBe('sub_already_live');
    expect((await payment(id))?.boundAt).not.toBeNull();
  });

  it('names a missing sender and stores no code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { id } = await pay('+14165552018');
    const sender: OtpSender = {
      async sendCode() {
        return { status: 'not_configured' };
      },
    };
    await expect(
      sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender }),
    ).resolves.toMatchObject({ status: 'not_configured', direct: true });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'pricing_checkout_code_not_configured' }),
      'pricing checkout',
    );
    const codes = await db.database
      .select({ id: schema.pricingCheckoutCodes.id })
      .from(schema.pricingCheckoutCodes)
      .where(eq(schema.pricingCheckoutCodes.stripeSessionId, id));
    expect(codes).toHaveLength(0);
    warn.mockRestore();
  });

  it('drops the stored phone when that family is erased', async () => {
    const phone = '+14165552019';
    const { id } = await pay(phone);
    const seeded = await seedFamily(db.database, 'Leaving');
    await db.database.insert(schema.parentChannels).values({
      userId: seeded.parentUserId,
      familyId: seeded.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: NOW,
    });
    await db.database
      .update(schema.pricingCheckoutPayments)
      .set({
        boundFamilyId: seeded.familyId,
        boundAt: NOW,
        boundPhoneE164Hash: phoneBlindIndex(phone),
      })
      .where(eq(schema.pricingCheckoutPayments.stripeSessionId, id));
    await erasePricingCheckoutRows(db.database, [seeded.familyId]);
    expect(await payment(id)).toBeNull();
  });

  it('starts onboarding when the verified number texts back, and stays one paid family', async () => {
    const phone = '+14165552008';
    const { id, sender } = await pay(phone, 'plus');
    await sendPricingCheckoutCode(db.database, { sessionId: id, now: NOW, sender });
    const verified = await verifyPricingCheckoutCode(db.database, {
      sessionId: id,
      code: sender.sent[0]?.code ?? '',
      now: NOW,
    });
    expect(verified.status).toBe('verified');
    const before = await familyCount();
    const transport = new FakeTransport();
    const result = await handleInboundSms(
      db.database,
      transport.inbound(phone, 'hi'),
      intakeDeps(transport),
    );
    expect(result.status).toBe('first_touch');
    expect(await loadOpenSession(db.database, phone)).not.toBeNull();
    expect(transport.bodies().length).toBeGreaterThan(0);
    expect(await familyCount()).toBe(before);
    const [family] = await db.database
      .select({ planTier: schema.families.planTier })
      .from(schema.families)
      .where(eq(schema.families.id, verified.familyId ?? ''));
    expect(family?.planTier).toBe('plus');
  });
});

function intakeDeps(transport: FakeTransport): IntakeDeps {
  return {
    transport,
    threadMessage: async () => 'conv-1',
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([{ intent: 'assent', verbatim: 'x', interpretation: 'x' }]),
    radar: fakeRadar,
    answerComposer: fakeSilentAnswerComposer,
    openQuestions: fakeNoOpenQuestions,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOON.getTime()),
    consent: yesNoReader(),
    consentAsk: askWriter(),
    friendVoice: scriptedFriendVoice,
    optOutReader: {
      async read(input) {
        return { intent: 'none', verbatim: input.text, confirmation: '', language: 'en' };
      },
    },
    now: NOON,
  };
}
