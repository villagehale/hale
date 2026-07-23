import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';

/**
 * CASL compliance for Hale's non-transactional email (the daily brief today).
 * Every such message must: identify the sender, carry the business mailing
 * address, and offer a working one-click unsubscribe. The send path additionally
 * checks consent — here, the absence of an opt-out — before sending, and is held
 * behind a deliberate flag so no real user is emailed until the sending domain is
 * verified and the flag is flipped on purpose.
 */

// CASL requires a postal mailing address in every commercial electronic message.
export const BUSINESS_ADDRESS =
  'Village Hale Technologies Inc., 13394 10 Line, Georgetown, ON L7G 4S8';
export const SENDER_NAME = 'Hale';

export type EmailType = schema.NewEmailSend['emailType'];

/** Stable handle an unsubscribe link carries: who, and which email stream. */
interface UnsubscribePayload {
  userId: string;
  emailType: EmailType;
}

function tokenBody(payload: UnsubscribePayload): string {
  return `${payload.userId}:${payload.emailType}`;
}

/**
 * A stateless, signed unsubscribe token: HMAC-SHA256 over `userId:emailType`,
 * keyed by UNSUBSCRIBE_SECRET. Stateless (no per-send token row) and tamper-proof
 * — a recipient can only opt themselves out of the stream the link names. Returns
 * null when the secret is unset, so a link is never minted unsigned.
 */
export function signUnsubscribeToken(payload: UnsubscribePayload): string | null {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!secret) {
    return null;
  }
  return createHmac('sha256', secret).update(tokenBody(payload)).digest('hex');
}

/**
 * Verifies a token against the claimed (userId, emailType) in constant time.
 * Returns false when the secret is unset (fail closed) or the signature does not
 * match — so a forged or stale link can never opt anyone out.
 */
export function verifyUnsubscribeToken(payload: UnsubscribePayload, token: string): boolean {
  const expected = signUnsubscribeToken(payload);
  if (!expected) {
    return false;
  }
  const expectedBuf = Buffer.from(expected, 'hex');
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(token, 'hex');
  } catch {
    return false;
  }
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

/** True when the recipient has opted out of this email stream — the send path
 * must NOT send when this is true (CASL consent). */
export async function hasOptedOut(
  database: Database,
  userId: string,
  emailType: EmailType,
): Promise<boolean> {
  const rows = await database
    .select({ id: schema.emailOptOuts.id })
    .from(schema.emailOptOuts)
    .where(
      and(
        eq(schema.emailOptOuts.userId, userId),
        eq(schema.emailOptOuts.emailType, emailType),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Records a recipient's opt-out. Idempotent: the unique (user_id, email_type)
 * index folds a repeated unsubscribe click into the existing row rather than
 * erroring, so the link works every time it is clicked. Returns whether THIS call
 * inserted the row (true) or the recipient was already opted out (false, the
 * conflict branch) — the atomic `RETURNING` on an `ON CONFLICT DO NOTHING` is the
 * race-safe way to know "first time" without a separate SELECT (X1 · VIL-227's
 * STOP alert must fire once per unsubscribe, not once per click).
 */
export async function recordOptOut(
  database: Database,
  userId: string,
  emailType: EmailType,
): Promise<boolean> {
  const inserted = await database
    .insert(schema.emailOptOuts)
    .values({ userId, emailType })
    .onConflictDoNothing({
      target: [schema.emailOptOuts.userId, schema.emailOptOuts.emailType],
    })
    .returning({ id: schema.emailOptOuts.id });
  return inserted.length > 0;
}

/**
 * Clears a recipient's opt-out (re-subscribe): the counterpart to recordOptOut,
 * used by the in-app notification settings where a parent can turn a stream back
 * on. Idempotent — deleting a row that isn't there is a no-op, so toggling on
 * when already on never errors.
 */
export async function recordOptIn(
  database: Database,
  userId: string,
  emailType: EmailType,
): Promise<void> {
  await database
    .delete(schema.emailOptOuts)
    .where(
      and(
        eq(schema.emailOptOuts.userId, userId),
        eq(schema.emailOptOuts.emailType, emailType),
      ),
    );
}

/** Records one accepted send in the ledger (CASL: who + when). Written only
 * after the provider accepts the send. */
export async function recordEmailSend(
  database: Database,
  input: {
    userId: string;
    familyId: string | null;
    emailType: EmailType;
    recipient: string;
    providerMessageId?: string | null;
  },
): Promise<void> {
  await database.insert(schema.emailSends).values({
    userId: input.userId,
    familyId: input.familyId,
    emailType: input.emailType,
    recipient: input.recipient,
    providerMessageId: input.providerMessageId ?? null,
  });
}

export type UnsubscribeResult =
  | { status: 'unsubscribed'; emailType: EmailType; firstTime: boolean }
  | { status: 'invalid' };

/** F11 loop email streams (VIL-213): the loop composer mints a per-category
 * unsubscribe link for each of these (send.ts, reminders/run.ts) — a working
 * one-click unsubscribe is CASL-required on every one, same as daily_digest. X1
 * (VIL-227) treats landing on one of these (not daily_digest/welcome) as the STOP
 * guardrail. */
export const LOOP_EMAIL_TYPES: readonly EmailType[] = ['weekly_plan', 'reminder', 'approval', 'alert'];

const EMAIL_TYPES: readonly EmailType[] = ['daily_digest', 'welcome', ...LOOP_EMAIL_TYPES];

function isEmailType(value: string): value is EmailType {
  return (EMAIL_TYPES as readonly string[]).includes(value);
}

/** Whether an email stream is one of the loop taxonomy's categories (as opposed to
 * the legacy daily_digest/welcome streams) — the STOP guardrail's classifier. */
export function isLoopEmailType(emailType: EmailType): boolean {
  return (LOOP_EMAIL_TYPES as readonly string[]).includes(emailType);
}

/**
 * Verifies an unsubscribe link's signature and, if valid, records the opt-out.
 * Fails closed: a missing/garbage param, an unknown stream, or a signature that
 * doesn't verify returns 'invalid' and writes NOTHING — a forged link can never
 * opt anyone out. Idempotent: clicking a valid link twice is a no-op the second
 * time (the opt-out unique index folds it).
 */
export async function processUnsubscribe(
  database: Database,
  params: { u?: string | null; t?: string | null; sig?: string | null },
): Promise<UnsubscribeResult> {
  const { u: userId, t: emailType, sig } = params;
  if (!userId || !emailType || !sig || !isEmailType(emailType)) {
    return { status: 'invalid' };
  }
  if (!verifyUnsubscribeToken({ userId, emailType }, sig)) {
    return { status: 'invalid' };
  }
  const firstTime = await recordOptOut(database, userId, emailType);
  return { status: 'unsubscribed', emailType, firstTime };
}

/** The base URL the unsubscribe link points at. */
export function appBaseUrl(): string {
  return process.env.APP_URL ?? 'https://app.villagehale.com';
}

/** The absolute one-click unsubscribe URL for a (user, stream). */
export function unsubscribeUrl(payload: UnsubscribePayload): string | null {
  const token = signUnsubscribeToken(payload);
  if (!token) {
    return null;
  }
  const params = new URLSearchParams({
    u: payload.userId,
    t: payload.emailType,
    sig: token,
  });
  return `${appBaseUrl()}/unsubscribe?${params.toString()}`;
}
