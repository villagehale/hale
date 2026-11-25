import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { smsExternalAuthId } from '~/lib/billing/new-visitor-join';
import { PreviewCaptureRefused } from '~/lib/channel/preview-capture-transport';
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  generateOtpCode,
  hashOtpCode,
  isOtpExpired,
  isOtpLockedOut,
  verifyOtpCode,
} from '~/lib/channels/otp';
import type { OtpSender } from '~/lib/channels/otp-sender';
import { maskPhoneE164, normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';

/**
 * Paid /pricing checkout, before a family exists.
 *
 * The webhook stores the tier and the Stripe phone. The success page sends a
 * Linq code and only then binds that number. A normal billing event never
 * reaches a query — the dark-notice test installs a database that throws on
 * touch, and this module has to leave it alone.
 */

const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;

/** Sends of a new code, per session and per number. A failed send is deleted and does not count. */
export const PRICING_CODE_SEND_CAP = 5;
/** Wrong guesses across every code for one session, and across every session for one number. */
export const PRICING_ATTEMPT_CAP = 8;

export type PaidTier = 'plus' | 'family';

export type DirectCheckoutSnapshot = {
  sessionId: string;
  paid: boolean;
  source: string | null;
  tier: PaidTier | null;
  sku: string | null;
  currency: 'CAD' | 'USD' | null;
  phoneE164: string | null;
  customerId: string | null;
  subscriptionId: string | null;
};

export type PricingSendStatus =
  | 'sent'
  | 'cooldown'
  | 'send_limited'
  | 'not_configured'
  | 'send_failed'
  | 'invalid_phone'
  | 'already_bound'
  | 'no_payment';

export type PricingCheckoutView = {
  direct: boolean;
  bound: boolean;
  phone: string | null;
  tier: PaidTier | null;
  status: PricingSendStatus;
  retryAfterMs?: number;
};

export type PricingVerifyStatus =
  | 'verified'
  | 'wrong_code'
  | 'locked'
  | 'expired'
  | 'no_pending'
  | 'already_bound'
  | 'attempts_limited'
  | 'no_payment';

export type PricingVerifyResult = {
  status: PricingVerifyStatus;
  attemptsRemaining?: number;
  familyId?: string;
  customerId?: string | null;
  subscriptionId?: string | null;
};

type PaymentRow = typeof schema.pricingCheckoutPayments.$inferSelect;
type CodeRow = typeof schema.pricingCheckoutCodes.$inferSelect;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stripeId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (isRecord(value)) return readString(value.id);
  return null;
}

export function pricingCheckoutSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return SESSION_ID.test(id) ? id : null;
}

function paidTier(value: unknown): PaidTier | null {
  const token = readString(value)?.toLowerCase();
  if (token === 'plus') return 'plus';
  if (token === 'family' || token === 'max') return 'family';
  return null;
}

function currencyOf(value: unknown): 'CAD' | 'USD' | null {
  const token = readString(value)?.toUpperCase();
  if (token === 'CAD' || token === 'USD') return token;
  return null;
}

/** A Checkout Session object, or null when it is not an object with a session id. */
export function snapshotFromStripeSession(payload: unknown): DirectCheckoutSnapshot | null {
  if (!isRecord(payload)) return null;
  const sessionId = pricingCheckoutSessionId(payload.id);
  if (!sessionId) return null;
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const details = isRecord(payload.customer_details) ? payload.customer_details : {};
  const phone = readString(details.phone);
  return {
    sessionId,
    paid: readString(payload.payment_status) === 'paid',
    source: readString(metadata.source),
    tier: paidTier(metadata.tier),
    sku: readString(metadata.sku)?.slice(0, 80) ?? null,
    currency: currencyOf(metadata.currency) ?? currencyOf(payload.currency),
    phoneE164: phone ? normalizePhoneE164(phone) : null,
    customerId: stripeId(payload.customer),
    subscriptionId: stripeId(payload.subscription),
  };
}

function snapshotFromEvent(event: unknown): DirectCheckoutSnapshot | null {
  if (!isRecord(event) || event.type !== 'checkout.session.completed') return null;
  const data = isRecord(event.data) ? event.data : null;
  const object = data && isRecord(data.object) ? data.object : null;
  return object ? snapshotFromStripeSession(object) : null;
}

function isStorable(snapshot: DirectCheckoutSnapshot): snapshot is DirectCheckoutSnapshot & {
  tier: PaidTier;
} {
  return snapshot.paid && snapshot.source === 'pricing_direct' && snapshot.tier !== null;
}

/**
 * First write wins. A replay does not change the tier, the phone, or a bind
 * that has already happened. Returns without a query when the event is not a
 * paid pricing_direct checkout.
 */
export async function recordPricingDirectCheckout(
  database: Database,
  event: unknown,
): Promise<'stored' | 'replay' | 'ignored'> {
  const snapshot = snapshotFromEvent(event);
  if (!snapshot || !isStorable(snapshot)) return 'ignored';
  return storePricingSnapshot(database, snapshot);
}

export async function storePricingSnapshot(
  database: Database,
  snapshot: DirectCheckoutSnapshot,
): Promise<'stored' | 'replay' | 'ignored'> {
  if (!isStorable(snapshot)) return 'ignored';
  const phone = snapshot.phoneE164;
  const inserted = await database
    .insert(schema.pricingCheckoutPayments)
    .values({
      stripeSessionId: snapshot.sessionId,
      tier: snapshot.tier,
      sku: snapshot.sku,
      currency: snapshot.currency,
      phoneE164Encrypted: phone ? encryptString(phone) : null,
      phoneE164Hash: phone ? phoneBlindIndex(phone) : null,
      stripeCustomerId: snapshot.customerId,
      stripeSubscriptionId: snapshot.subscriptionId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.pricingCheckoutPayments.id });
  const outcome = inserted.length > 0 ? 'stored' : 'replay';
  console.info({ event: 'pricing_checkout_stored', outcome }, 'pricing checkout');
  return outcome;
}

async function loadPayment(database: Database, sessionId: string): Promise<PaymentRow | null> {
  const [row] = await database
    .select()
    .from(schema.pricingCheckoutPayments)
    .where(eq(schema.pricingCheckoutPayments.stripeSessionId, sessionId))
    .limit(1);
  return row ?? null;
}

async function ensurePayment(
  database: Database,
  sessionId: string,
  retrieve?: (sessionId: string) => Promise<DirectCheckoutSnapshot | null>,
): Promise<PaymentRow | null> {
  const existing = await loadPayment(database, sessionId);
  if (existing) return existing;
  if (!retrieve) return null;
  const snapshot = await retrieve(sessionId);
  if (!snapshot) return null;
  await storePricingSnapshot(database, snapshot);
  return loadPayment(database, sessionId);
}

function storedPhone(row: PaymentRow): string | null {
  if (!row.phoneE164Encrypted) return null;
  try {
    const phone = decryptString(row.phoneE164Encrypted);
    return normalizePhoneE164(phone);
  } catch {
    return null;
  }
}

function view(
  payment: PaymentRow | null,
  status: PricingSendStatus,
  phone: string | null,
  retryAfterMs?: number,
): PricingCheckoutView {
  return {
    direct: payment !== null,
    bound: payment?.boundAt != null,
    phone,
    tier: payment?.tier ?? null,
    status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

async function sessionCodes(database: Database, sessionId: string): Promise<CodeRow[]> {
  return database
    .select()
    .from(schema.pricingCheckoutCodes)
    .where(eq(schema.pricingCheckoutCodes.stripeSessionId, sessionId))
    .orderBy(desc(schema.pricingCheckoutCodes.createdAt));
}

async function phoneCodes(database: Database, phoneHash: string): Promise<CodeRow[]> {
  return database
    .select()
    .from(schema.pricingCheckoutCodes)
    .where(eq(schema.pricingCheckoutCodes.phoneE164Hash, phoneHash));
}

function latestLive(codes: readonly CodeRow[], now: Date): CodeRow | null {
  return (
    codes.find((code) => code.consumedAt === null && !isOtpExpired(code.expiresAt, now)) ?? null
  );
}

function lastSentAt(codes: readonly CodeRow[]): number {
  return codes.reduce((max, code) => Math.max(max, code.createdAt.getTime()), 0);
}

/**
 * Send a code, or report the one already in flight. `resend` replaces it.
 * A different phone replaces it too. The sender runs only after the row
 * exists; a refusal deletes that row so the page does not claim a code is out.
 */
export async function sendPricingCheckoutCode(
  database: Database,
  input: {
    sessionId: string;
    phone?: string | null;
    resend?: boolean;
    now?: Date;
    sender: OtpSender;
    retrieve?: (sessionId: string) => Promise<DirectCheckoutSnapshot | null>;
  },
): Promise<PricingCheckoutView> {
  const now = input.now ?? new Date();
  const sessionId = pricingCheckoutSessionId(input.sessionId);
  if (!sessionId) return view(null, 'no_payment', null);
  const payment = await ensurePayment(database, sessionId, input.retrieve);
  if (!payment) return view(null, 'no_payment', null);
  if (payment.boundAt) return view(payment, 'already_bound', storedPhone(payment));

  let phone: string | null = null;
  if (input.phone != null && input.phone.trim() !== '') {
    phone = normalizePhoneE164(input.phone);
    if (!phone) return view(payment, 'invalid_phone', null);
  } else {
    phone = storedPhone(payment);
  }
  if (!phone) return view(payment, 'invalid_phone', null);
  const phoneHash = phoneBlindIndex(phone);

  const codes = await sessionCodes(database, sessionId);
  const live = latestLive(codes, now);
  const replacing = input.resend === true || (live !== null && live.phoneE164Hash !== phoneHash);
  if (live && !replacing) return view(payment, 'sent', phone);

  const forPhone = await phoneCodes(database, phoneHash);
  if (codes.length >= PRICING_CODE_SEND_CAP || forPhone.length >= PRICING_CODE_SEND_CAP) {
    return view(payment, 'send_limited', phone);
  }
  const elapsed = now.getTime() - Math.max(lastSentAt(codes), lastSentAt(forPhone));
  if (elapsed < OTP_RESEND_COOLDOWN_MS && (codes.length > 0 || forPhone.length > 0)) {
    return view(payment, 'cooldown', phone, OTP_RESEND_COOLDOWN_MS - elapsed);
  }

  const code = generateOtpCode();
  const codeId = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    if (replacing || codes.some((row) => row.consumedAt === null)) {
      await tx
        .update(schema.pricingCheckoutCodes)
        .set({ consumedAt: now })
        .where(
          and(
            eq(schema.pricingCheckoutCodes.stripeSessionId, sessionId),
            isNull(schema.pricingCheckoutCodes.consumedAt),
          ),
        );
    }
    const inserted = await tx
      .insert(schema.pricingCheckoutCodes)
      .values({
        stripeSessionId: sessionId,
        phoneE164Encrypted: encryptString(phone),
        phoneE164Hash: phoneHash,
        codeHash: hashOtpCode(code),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.pricingCheckoutCodes.id });
    return inserted[0]?.id ?? null;
  });
  if (!codeId) return view(payment, 'sent', phone);

  try {
    const sent = await input.sender.sendCode({ phoneE164: phone, code });
    if (sent.status !== 'sent') {
      await database
        .delete(schema.pricingCheckoutCodes)
        .where(eq(schema.pricingCheckoutCodes.id, codeId));
      return view(payment, 'not_configured', phone);
    }
  } catch (err) {
    await database
      .delete(schema.pricingCheckoutCodes)
      .where(eq(schema.pricingCheckoutCodes.id, codeId));
    return view(
      payment,
      err instanceof PreviewCaptureRefused ? 'not_configured' : 'send_failed',
      phone,
    );
  }
  return view(payment, 'sent', phone);
}

function higherPlan(
  current: 'free' | 'plus' | 'family',
  incoming: PaidTier,
): 'free' | 'plus' | 'family' {
  const rank = { free: 0, plus: 1, family: 2 } as const;
  return rank[current] >= rank[incoming] ? current : incoming;
}

async function raisePlan(tx: Database, familyId: string, tier: PaidTier, now: Date): Promise<void> {
  const [family] = await tx
    .select({ planTier: schema.families.planTier })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  if (!family) throw new Error('pricing checkout: bound family is missing');
  const next = higherPlan(family.planTier, tier);
  if (next === family.planTier) return;
  await tx
    .update(schema.families)
    .set({ planTier: next, updatedAt: now })
    .where(eq(schema.families.id, familyId));
}

async function writeBindAudit(
  tx: Database,
  input: {
    familyId: string;
    actor: string;
    tier: PaidTier;
    phoneE164: string;
    sessionId: string;
    now: Date;
  },
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.actor,
    actionTaken: 'pricing_checkout_bound',
    targetTable: 'families',
    targetId: input.familyId,
    after: { tier: input.tier, phone: maskPhoneE164(input.phoneE164), sessionId: input.sessionId },
    occurredAt: input.now,
  });
}

async function onboardPaidFamily(
  tx: Database,
  input: {
    phoneE164: string;
    phoneHash: string;
    tier: PaidTier;
    currency: string | null;
    sessionId: string;
    now: Date;
  },
): Promise<string> {
  const [channel] = await tx
    .select({
      familyId: schema.parentChannels.familyId,
      userId: schema.parentChannels.userId,
    })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.phoneE164Hash, input.phoneHash),
        isNull(schema.parentChannels.revokedAt),
        isNotNull(schema.parentChannels.verifiedAt),
      ),
    )
    .limit(1);
  if (channel) {
    await raisePlan(tx, channel.familyId, input.tier, input.now);
    await writeBindAudit(tx, { ...input, familyId: channel.familyId, actor: channel.userId });
    return channel.familyId;
  }

  const externalAuthId = smsExternalAuthId(input.phoneHash);
  const [existingUser] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.externalAuthId, externalAuthId))
    .limit(1);
  let userId = existingUser?.id;
  if (!userId) {
    const [created] = await tx
      .insert(schema.users)
      .values({ externalAuthId, email: null, name: null })
      .returning({ id: schema.users.id });
    if (!created) throw new Error('pricing checkout: user insert returned no row');
    userId = created.id;
  }

  const [membership] = await tx
    .select({ familyId: schema.familyMembers.familyId })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, userId))
    .limit(1);
  if (membership) {
    await raisePlan(tx, membership.familyId, input.tier, input.now);
    await writeBindAudit(tx, { ...input, familyId: membership.familyId, actor: userId });
    return membership.familyId;
  }

  const [family] = await tx
    .insert(schema.families)
    .values({
      displayName: 'Family',
      onboardingStage: 'pending_invite',
      planTier: input.tier,
      countryCode: input.currency === 'USD' ? 'US' : 'CA',
    })
    .returning({ id: schema.families.id });
  if (!family) throw new Error('pricing checkout: family insert returned no row');
  await tx.insert(schema.familyMembers).values({
    familyId: family.id,
    userId,
    role: 'primary_parent',
  });
  await writeBindAudit(tx, { ...input, familyId: family.id, actor: userId });
  return family.id;
}

async function attemptTotal(
  database: Database,
  sessionId: string,
  phoneHash: string,
): Promise<number> {
  const [forSession, forPhone] = await Promise.all([
    sessionCodes(database, sessionId),
    phoneCodes(database, phoneHash),
  ]);
  const sum = (rows: readonly CodeRow[]) =>
    rows.reduce((total, row) => total + row.attemptCount, 0);
  return Math.max(sum(forSession), sum(forPhone));
}

/**
 * The bound number is the number on the code row, never a phone the browser
 * sends beside the code. One session binds once (`bound_at` is still null).
 */
export async function verifyPricingCheckoutCode(
  database: Database,
  input: { sessionId: string; code: string; now?: Date },
): Promise<PricingVerifyResult> {
  const now = input.now ?? new Date();
  const sessionId = pricingCheckoutSessionId(input.sessionId);
  if (!sessionId) return { status: 'no_payment' };
  const payment = await loadPayment(database, sessionId);
  if (!payment) return { status: 'no_payment' };
  if (payment.boundAt) return { status: 'already_bound' };

  const codes = await sessionCodes(database, sessionId);
  const live = codes.find((code) => code.consumedAt === null) ?? null;
  if (!live) return { status: 'no_pending' };
  if (isOtpExpired(live.expiresAt, now)) {
    await database
      .update(schema.pricingCheckoutCodes)
      .set({ consumedAt: now })
      .where(eq(schema.pricingCheckoutCodes.id, live.id));
    return { status: 'expired' };
  }

  const spent = await attemptTotal(database, sessionId, live.phoneE164Hash);
  if (spent >= PRICING_ATTEMPT_CAP || isOtpLockedOut(live.attemptCount)) {
    return { status: spent >= PRICING_ATTEMPT_CAP ? 'attempts_limited' : 'locked' };
  }

  const code = input.code.trim();
  if (
    codes.some(
      (row) => row.id !== live.id && row.consumedAt !== null && verifyOtpCode(code, row.codeHash),
    )
  ) {
    return {
      status: 'wrong_code',
      attemptsRemaining: Math.min(
        OTP_MAX_ATTEMPTS - live.attemptCount,
        PRICING_ATTEMPT_CAP - spent,
      ),
    };
  }
  if (!verifyOtpCode(code, live.codeHash)) {
    const attemptCount = live.attemptCount + 1;
    await database
      .update(schema.pricingCheckoutCodes)
      .set({ attemptCount })
      .where(eq(schema.pricingCheckoutCodes.id, live.id));
    const total = spent + 1;
    if (total >= PRICING_ATTEMPT_CAP) return { status: 'attempts_limited', attemptsRemaining: 0 };
    if (isOtpLockedOut(attemptCount)) return { status: 'locked', attemptsRemaining: 0 };
    return {
      status: 'wrong_code',
      attemptsRemaining: Math.min(OTP_MAX_ATTEMPTS - attemptCount, PRICING_ATTEMPT_CAP - total),
    };
  }

  let phone = '';
  try {
    phone = decryptString(live.phoneE164Encrypted);
  } catch {
    return { status: 'no_pending' };
  }
  const phoneHash = phoneBlindIndex(phone);
  const bound = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const [claimed] = await tx
      .update(schema.pricingCheckoutPayments)
      .set({ boundAt: now, boundPhoneE164Hash: phoneHash })
      .where(
        and(
          eq(schema.pricingCheckoutPayments.id, payment.id),
          isNull(schema.pricingCheckoutPayments.boundAt),
        ),
      )
      .returning({ id: schema.pricingCheckoutPayments.id });
    if (!claimed) return null;
    const familyId = await onboardPaidFamily(tx, {
      phoneE164: phone,
      phoneHash,
      tier: payment.tier,
      currency: payment.currency,
      sessionId,
      now,
    });
    await tx
      .update(schema.pricingCheckoutPayments)
      .set({ boundFamilyId: familyId })
      .where(eq(schema.pricingCheckoutPayments.id, payment.id));
    await tx
      .update(schema.pricingCheckoutCodes)
      .set({ consumedAt: now })
      .where(eq(schema.pricingCheckoutCodes.id, live.id));
    return familyId;
  });
  if (!bound) return { status: 'already_bound' };
  return {
    status: 'verified',
    familyId: bound,
    customerId: payment.stripeCustomerId,
    subscriptionId: payment.stripeSubscriptionId,
  };
}

/** Best-effort. A unique customer already on another family must not undo the bind. */
export async function rememberStripeCustomer(
  database: Database,
  familyId: string,
  customerId: string | null | undefined,
  subscriptionId: string | null | undefined,
): Promise<void> {
  if (!customerId && !subscriptionId) return;
  const [family] = await database
    .select({
      stripeCustomerId: schema.families.stripeCustomerId,
      stripeSubscriptionId: schema.families.stripeSubscriptionId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  if (!family) return;
  const patch: { stripeCustomerId?: string; stripeSubscriptionId?: string; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (!family.stripeCustomerId && customerId) patch.stripeCustomerId = customerId;
  if (!family.stripeSubscriptionId && subscriptionId) patch.stripeSubscriptionId = subscriptionId;
  if (!patch.stripeCustomerId && !patch.stripeSubscriptionId) return;
  try {
    await database.update(schema.families).set(patch).where(eq(schema.families.id, familyId));
  } catch (err) {
    console.warn(
      {
        event: 'pricing_checkout_stripe_ids_unrecorded',
        name: err instanceof Error ? err.name : 'unknown',
      },
      'pricing checkout',
    );
  }
}
