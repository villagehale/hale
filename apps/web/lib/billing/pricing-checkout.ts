import { type Database, schema } from '@hale/db';
import {
  type Attribution,
  analyticsDistinctId,
  attributionIsEmpty,
  parseAttribution,
  serializeAttribution,
} from '@hale/types';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { familyAlreadySubscribed } from '~/lib/billing/already-subscribed';
import { smsExternalAuthId } from '~/lib/billing/new-visitor-join';
import {
  type PricingBindInput,
  recordPricingBindAnalytics,
} from '~/lib/billing/pricing-bind-analytics';
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
 * touch, and this module has to leave it alone. The one other query is a
 * subscription that has ended: that stamps `ended_at` on an unbound row.
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
  attribution: Attribution;
  analyticsDistinctId: string | null;
};

export type PricingSendStatus =
  | 'sent'
  | 'cooldown'
  | 'send_limited'
  | 'not_configured'
  | 'send_failed'
  | 'invalid_phone'
  | 'already_bound'
  | 'payment_ended'
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
  | 'already_subscribed'
  | 'attempts_limited'
  | 'payment_ended'
  | 'no_payment';

export type PricingVerifyResult = {
  status: PricingVerifyStatus;
  attemptsRemaining?: number;
  familyId?: string;
  customerId?: string | null;
  subscriptionId?: string | null;
};

type VerifyOutcome = PricingVerifyResult & { bind?: PricingBindInput };

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
    attribution: parseAttribution(metadata),
    analyticsDistinctId: analyticsDistinctId(metadata.ph_distinct_id),
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

function storedAttribution(attribution: Attribution): string | null {
  if (attributionIsEmpty(attribution)) return null;
  return serializeAttribution(attribution).slice(0, 2000);
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
      attribution: storedAttribution(snapshot.attribution),
      analyticsDistinctId: snapshot.analyticsDistinctId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.pricingCheckoutPayments.id });
  const outcome = inserted.length > 0 ? 'stored' : 'replay';
  console.info({ event: 'pricing_checkout_stored', outcome }, 'pricing checkout');
  return outcome;
}

const ENDED_SUBSCRIPTION_STATUS = new Set(['canceled', 'unpaid', 'incomplete_expired']);

/**
 * Subscription id when this event ends an unbound pricing checkout. Null for
 * every other event, and that null returns before any query.
 */
function endedSubscriptionId(event: unknown): string | null {
  if (!isRecord(event)) return null;
  const data = isRecord(event.data) ? event.data : null;
  const object = data && isRecord(data.object) ? data.object : null;
  const id = object ? readString(object.id) : null;
  if (!id?.startsWith('sub_')) return null;
  if (event.type === 'customer.subscription.deleted') return id;
  if (event.type !== 'customer.subscription.updated') return null;
  const status = readString(object?.status);
  return status && ENDED_SUBSCRIPTION_STATUS.has(status) ? id : null;
}

/**
 * An ended subscription must not still unlock a plan. Only an unbound row is
 * stamped; a bind that already happened stays for the billing webhook.
 */
export async function recordPricingSubscriptionEnded(
  database: Database,
  event: unknown,
): Promise<'ended' | 'ignored'> {
  const subscriptionId = endedSubscriptionId(event);
  if (!subscriptionId) return 'ignored';
  const updated = await database
    .update(schema.pricingCheckoutPayments)
    .set({ endedAt: new Date() })
    .where(
      and(
        eq(schema.pricingCheckoutPayments.stripeSubscriptionId, subscriptionId),
        isNull(schema.pricingCheckoutPayments.boundAt),
        isNull(schema.pricingCheckoutPayments.endedAt),
      ),
    )
    .returning({ id: schema.pricingCheckoutPayments.id });
  if (updated.length > 0) {
    console.info({ event: 'pricing_checkout_ended' }, 'pricing checkout');
  }
  return updated.length > 0 ? 'ended' : 'ignored';
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

function phoneOnCode(row: CodeRow): string | null {
  try {
    return normalizePhoneE164(decryptString(row.phoneE164Encrypted));
  } catch {
    return null;
  }
}

/** Session first, then the number, so a send and a verify cannot deadlock. */
async function lockCheckout(tx: Database, sessionId: string, phoneHash: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pricing-session:${sessionId}`}))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pricing-phone:${phoneHash}`}))`);
}

function logCheckout(event: string, err?: unknown): void {
  console.warn(
    {
      event,
      ...(err !== undefined ? { name: err instanceof Error ? err.name : 'unknown' } : {}),
    },
    'pricing checkout',
  );
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
  try {
    return await deliverPricingCode(database, payment, sessionId, input, now);
  } catch (err) {
    logCheckout('pricing_checkout_code_send_failed', err);
    return view(payment, 'send_failed', storedPhone(payment));
  }
}

async function deliverPricingCode(
  database: Database,
  payment: PaymentRow,
  sessionId: string,
  input: {
    phone?: string | null;
    resend?: boolean;
    sender: OtpSender;
  },
  now: Date,
): Promise<PricingCheckoutView> {
  if (payment.endedAt) return view(payment, 'payment_ended', storedPhone(payment));
  if (payment.boundAt) return view(payment, 'already_bound', storedPhone(payment));

  const codes = await sessionCodes(database, sessionId);
  let phone: string | null = null;
  if (input.phone != null && input.phone.trim() !== '') {
    phone = normalizePhoneE164(input.phone);
    if (!phone) return view(payment, 'invalid_phone', null);
  } else {
    const latest = codes[0];
    phone = (latest ? phoneOnCode(latest) : null) ?? storedPhone(payment);
  }
  if (!phone) return view(payment, 'invalid_phone', null);
  const destination = phone;
  const phoneHash = phoneBlindIndex(destination);

  const live = latestLive(codes, now);
  const replacing = input.resend === true || (live !== null && live.phoneE164Hash !== phoneHash);
  if (live && !replacing) return view(payment, 'sent', destination);

  const code = generateOtpCode();
  const gated = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await lockCheckout(tx, sessionId, phoneHash);
    const lockedCodes = await sessionCodes(tx, sessionId);
    const lockedPhone = await phoneCodes(tx, phoneHash);
    const lockedLive = latestLive(lockedCodes, now);
    const lockedReplacing =
      input.resend === true || (lockedLive !== null && lockedLive.phoneE164Hash !== phoneHash);
    if (lockedLive && !lockedReplacing) return { kind: 'sent' as const };
    if (
      lockedCodes.length >= PRICING_CODE_SEND_CAP ||
      lockedPhone.length >= PRICING_CODE_SEND_CAP
    ) {
      return { kind: 'send_limited' as const };
    }
    const elapsed = now.getTime() - Math.max(lastSentAt(lockedCodes), lastSentAt(lockedPhone));
    if (elapsed < OTP_RESEND_COOLDOWN_MS && (lockedCodes.length > 0 || lockedPhone.length > 0)) {
      return { kind: 'cooldown' as const, retryAfterMs: OTP_RESEND_COOLDOWN_MS - elapsed };
    }
    if (lockedReplacing || lockedCodes.some((row) => row.consumedAt === null)) {
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
        phoneE164Encrypted: encryptString(destination),
        phoneE164Hash: phoneHash,
        codeHash: hashOtpCode(code),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.pricingCheckoutCodes.id });
    const id = inserted[0]?.id;
    return id ? { kind: 'inserted' as const, id } : { kind: 'sent' as const };
  });
  if (gated.kind === 'send_limited') return view(payment, 'send_limited', destination);
  if (gated.kind === 'cooldown') {
    return view(payment, 'cooldown', destination, gated.retryAfterMs);
  }
  if (gated.kind !== 'inserted') return view(payment, 'sent', destination);

  try {
    const sent = await input.sender.sendCode({ phoneE164: destination, code });
    if (sent.status !== 'sent') {
      await database
        .delete(schema.pricingCheckoutCodes)
        .where(eq(schema.pricingCheckoutCodes.id, gated.id));
      logCheckout('pricing_checkout_code_not_configured');
      return view(payment, 'not_configured', destination);
    }
  } catch (err) {
    await database
      .delete(schema.pricingCheckoutCodes)
      .where(eq(schema.pricingCheckoutCodes.id, gated.id));
    const refused = err instanceof PreviewCaptureRefused;
    logCheckout(
      refused ? 'pricing_checkout_code_not_configured' : 'pricing_checkout_code_send_failed',
      err,
    );
    return view(payment, refused ? 'not_configured' : 'send_failed', destination);
  }
  return view(payment, 'sent', destination);
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
    duplicate: boolean;
  },
): Promise<void> {
  const row = {
    familyId: input.familyId,
    actor: input.actor,
    targetTable: 'families',
    targetId: input.familyId,
    after: { tier: input.tier, phone: maskPhoneE164(input.phoneE164), sessionId: input.sessionId },
    occurredAt: input.now,
  };
  if (input.duplicate) {
    await tx.insert(schema.auditLog).values({
      ...row,
      actionTaken: 'pricing_checkout_duplicate',
    });
    return;
  }
  await tx.insert(schema.auditLog).values({
    ...row,
    actionTaken: 'pricing_checkout_bound',
  });
}

async function existingSubscriptionDiffers(
  tx: Database,
  familyId: string,
  incomingSubscriptionId: string | null,
): Promise<boolean> {
  if (!incomingSubscriptionId) return false;
  const [family] = await tx
    .select({
      planTier: schema.families.planTier,
      stripeSubscriptionId: schema.families.stripeSubscriptionId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  if (!family?.stripeSubscriptionId) return false;
  if (family.stripeSubscriptionId === incomingSubscriptionId) return false;
  return familyAlreadySubscribed(family);
}

async function onboardPaidFamily(
  tx: Database,
  input: {
    phoneE164: string;
    phoneHash: string;
    tier: PaidTier;
    currency: string | null;
    sessionId: string;
    subscriptionId: string | null;
    now: Date;
  },
): Promise<{ familyId: string; duplicate: boolean; created: boolean }> {
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
    const duplicate = await existingSubscriptionDiffers(tx, channel.familyId, input.subscriptionId);
    if (!duplicate) await raisePlan(tx, channel.familyId, input.tier, input.now);
    await writeBindAudit(tx, {
      ...input,
      familyId: channel.familyId,
      actor: channel.userId,
      duplicate,
    });
    return { familyId: channel.familyId, duplicate, created: false };
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
    const duplicate = await existingSubscriptionDiffers(
      tx,
      membership.familyId,
      input.subscriptionId,
    );
    if (!duplicate) await raisePlan(tx, membership.familyId, input.tier, input.now);
    await writeBindAudit(tx, {
      ...input,
      familyId: membership.familyId,
      actor: userId,
      duplicate,
    });
    return { familyId: membership.familyId, duplicate, created: false };
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
  await writeBindAudit(tx, { ...input, familyId: family.id, actor: userId, duplicate: false });
  return { familyId: family.id, duplicate: false, created: true };
}

async function attemptTotal(
  database: Database,
  sessionId: string,
  phoneHash: string,
): Promise<number> {
  const forSession = await sessionCodes(database, sessionId);
  const forPhone = await phoneCodes(database, phoneHash);
  const sum = (rows: readonly CodeRow[]) =>
    rows.reduce((total, row) => total + row.attemptCount, 0);
  return Math.max(sum(forSession), sum(forPhone));
}

function attemptsLeft(attemptCount: number, spent: number): number {
  return Math.max(0, Math.min(OTP_MAX_ATTEMPTS - attemptCount, PRICING_ATTEMPT_CAP - spent));
}

/**
 * The bound number is the number on the code row, never a phone the browser
 * sends beside the code. One session binds once (`bound_at` is still null).
 * The code is claimed with `consumed_at is null` inside the same transaction
 * as the bind, so a correction that landed first cannot still bind.
 */
export async function verifyPricingCheckoutCode(
  database: Database,
  input: { sessionId: string; code: string; now?: Date },
  deps: { onBound?: (bound: PricingBindInput) => Promise<void> } = {},
): Promise<PricingVerifyResult> {
  const now = input.now ?? new Date();
  const sessionId = pricingCheckoutSessionId(input.sessionId);
  if (!sessionId) return { status: 'no_payment' };
  const payment = await loadPayment(database, sessionId);
  if (!payment) return { status: 'no_payment' };
  if (payment.endedAt) return { status: 'payment_ended' };
  if (payment.boundAt) return { status: 'already_bound' };

  const code = input.code.trim();
  const outcome: VerifyOutcome = await database.transaction(
    async (rawTx): Promise<VerifyOutcome> => {
      const tx = rawTx as unknown as Database;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`pricing-session:${sessionId}`}))`,
      );
      const [fresh] = await tx
        .select()
        .from(schema.pricingCheckoutPayments)
        .where(eq(schema.pricingCheckoutPayments.id, payment.id))
        .limit(1);
      if (!fresh) return { status: 'no_payment' };
      if (fresh.endedAt) return { status: 'payment_ended' };
      if (fresh.boundAt) return { status: 'already_bound' };

      const codes = await sessionCodes(tx, sessionId);
      const live = codes.find((row) => row.consumedAt === null) ?? null;
      if (!live) return { status: 'no_pending' };
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`pricing-phone:${live.phoneE164Hash}`}))`,
      );

      if (isOtpExpired(live.expiresAt, now)) {
        await tx
          .update(schema.pricingCheckoutCodes)
          .set({ consumedAt: now })
          .where(
            and(
              eq(schema.pricingCheckoutCodes.id, live.id),
              isNull(schema.pricingCheckoutCodes.consumedAt),
            ),
          );
        return { status: 'expired' };
      }

      const spent = await attemptTotal(tx, sessionId, live.phoneE164Hash);
      if (spent >= PRICING_ATTEMPT_CAP || isOtpLockedOut(live.attemptCount)) {
        return {
          status: spent >= PRICING_ATTEMPT_CAP ? 'attempts_limited' : 'locked',
          attemptsRemaining: 0,
        };
      }

      if (
        codes.some(
          (row) =>
            row.id !== live.id && row.consumedAt !== null && verifyOtpCode(code, row.codeHash),
        )
      ) {
        return { status: 'wrong_code', attemptsRemaining: attemptsLeft(live.attemptCount, spent) };
      }

      if (!verifyOtpCode(code, live.codeHash)) {
        const nextCount = live.attemptCount + 1;
        const bumped = await tx
          .update(schema.pricingCheckoutCodes)
          .set({ attemptCount: nextCount })
          .where(
            and(
              eq(schema.pricingCheckoutCodes.id, live.id),
              isNull(schema.pricingCheckoutCodes.consumedAt),
              eq(schema.pricingCheckoutCodes.attemptCount, live.attemptCount),
            ),
          )
          .returning({ attemptCount: schema.pricingCheckoutCodes.attemptCount });
        if (bumped.length === 0) return { status: 'locked', attemptsRemaining: 0 };
        const total = spent + 1;
        if (total >= PRICING_ATTEMPT_CAP)
          return { status: 'attempts_limited', attemptsRemaining: 0 };
        if (isOtpLockedOut(nextCount)) return { status: 'locked', attemptsRemaining: 0 };
        return { status: 'wrong_code', attemptsRemaining: attemptsLeft(nextCount, total) };
      }

      let phone = '';
      try {
        phone = decryptString(live.phoneE164Encrypted);
      } catch {
        return { status: 'no_pending' };
      }
      const phoneHash = phoneBlindIndex(phone);
      const [stillLive] = await tx
        .update(schema.pricingCheckoutCodes)
        .set({ consumedAt: now })
        .where(
          and(
            eq(schema.pricingCheckoutCodes.id, live.id),
            isNull(schema.pricingCheckoutCodes.consumedAt),
          ),
        )
        .returning({ id: schema.pricingCheckoutCodes.id });
      if (!stillLive) return { status: 'no_pending' };

      const [claimed] = await tx
        .update(schema.pricingCheckoutPayments)
        .set({ boundAt: now, boundPhoneE164Hash: phoneHash })
        .where(
          and(
            eq(schema.pricingCheckoutPayments.id, fresh.id),
            isNull(schema.pricingCheckoutPayments.boundAt),
            isNull(schema.pricingCheckoutPayments.endedAt),
          ),
        )
        .returning({ id: schema.pricingCheckoutPayments.id });
      if (!claimed) return { status: 'already_bound' };

      const onboarded = await onboardPaidFamily(tx, {
        phoneE164: phone,
        phoneHash,
        tier: fresh.tier,
        currency: fresh.currency,
        sessionId,
        subscriptionId: fresh.stripeSubscriptionId,
        now,
      });
      await tx
        .update(schema.pricingCheckoutPayments)
        .set({ boundFamilyId: onboarded.familyId })
        .where(eq(schema.pricingCheckoutPayments.id, fresh.id));
      return {
        status: onboarded.duplicate ? 'already_subscribed' : 'verified',
        familyId: onboarded.familyId,
        customerId: fresh.stripeCustomerId,
        subscriptionId: fresh.stripeSubscriptionId,
        bind: {
          sessionId,
          familyId: onboarded.familyId,
          tier: fresh.tier,
          attribution: parseAttribution(fresh.attribution ?? undefined),
          analyticsDistinctId: analyticsDistinctId(fresh.analyticsDistinctId),
          signup: onboarded.created,
          now,
        },
      };
    },
  );
  if (outcome.bind) {
    const notify = deps.onBound ?? recordPricingBindAnalytics;
    try {
      await notify(outcome.bind);
    } catch (err) {
      console.warn(
        {
          event: 'pricing_checkout_bind_analytics_failed',
          name: err instanceof Error ? err.name : 'unknown',
        },
        'pricing checkout',
      );
    }
  }
  const { bind: _bound, ...result } = outcome;
  return result;
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

/**
 * Right-to-erasure. The checkout foreign key only clears `bound_family_id`,
 * so the sweep deletes the payment (and its codes) while the family and its
 * channel hashes are still there.
 */
export async function erasePricingCheckoutRows(
  database: Database,
  familyIds: readonly string[],
): Promise<void> {
  if (familyIds.length === 0) return;
  const channels = await database
    .select({ hash: schema.parentChannels.phoneE164Hash })
    .from(schema.parentChannels)
    .where(inArray(schema.parentChannels.familyId, [...familyIds]));
  const hashes = [...new Set(channels.map((row) => row.hash))];
  const byFamily = inArray(schema.pricingCheckoutPayments.boundFamilyId, [...familyIds]);
  await database
    .delete(schema.pricingCheckoutPayments)
    .where(
      hashes.length === 0
        ? byFamily
        : or(
            byFamily,
            inArray(schema.pricingCheckoutPayments.phoneE164Hash, hashes),
            inArray(schema.pricingCheckoutPayments.boundPhoneE164Hash, hashes),
          ),
    );
}
