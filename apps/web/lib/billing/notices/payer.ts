import { type BillingNotice, type Database, schema } from '@hale/db';
import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { isParentRole } from '~/lib/channel/role-scope';

export type NoticePayer =
  | { status: 'resolved'; parentUserId: string }
  | { status: 'payer_unresolved' }
  | { status: 'recipient_gone' };

/** The audit row is written right after Stripe returns the session. */
const SESSION_BIND_BEFORE_MS = 10_000;
const SESSION_BIND_AFTER_MS = 60_000;

/**
 * VIL-735 · the one parent a billing text may go to. Nothing stores who paid, so it is
 * read from the `billing_checkout_started` audit row, whose actor is the signed-in user.
 *
 * A payment binds to the session's own time, because parent A can start a checkout, B
 * open and abandon one an hour later, and A then pay: the newest row names the wrong
 * adult. A cancel or refund follows the subscription it is about, because a rebuy reuses
 * the Stripe customer. Anything short of exactly one parent is `payer_unresolved`: this
 * never falls back to the primary parent, which could tell one adult about another's
 * payment.
 */
export async function resolveNoticePayer(
  database: Database,
  notice: Pick<BillingNotice, 'familyId' | 'lane' | 'facts'>,
): Promise<NoticePayer> {
  const parentUserId =
    notice.lane === 'payment'
      ? await paymentPayer(database, notice)
      : await planChangePayer(database, notice);
  if (parentUserId === null) return { status: 'payer_unresolved' };
  return confirmPayerSeat(database, notice.familyId, parentUserId);
}

/** The payer must still hold a parent's seat in this family. */
export async function confirmPayerSeat(
  database: Database,
  familyId: string,
  parentUserId: string,
): Promise<NoticePayer> {
  const [seat] = await database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.userId, parentUserId),
      ),
    )
    .limit(1);
  if (!seat || !isParentRole(seat.role)) return { status: 'recipient_gone' };
  return { status: 'resolved', parentUserId };
}

async function checkoutActors(
  database: Database,
  familyId: string,
  window?: { from: Date; to: Date },
): Promise<string[]> {
  const rows = await database
    .selectDistinct({ actor: schema.auditLog.actor })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'billing_checkout_started'),
        window ? gte(schema.auditLog.occurredAt, window.from) : undefined,
        window ? lte(schema.auditLog.occurredAt, window.to) : undefined,
      ),
    );
  return rows.map((row) => row.actor);
}

async function singleCheckoutActor(database: Database, familyId: string): Promise<string | null> {
  const actors = await checkoutActors(database, familyId);
  return actors.length === 1 ? (actors[0] as string) : null;
}

async function paymentPayer(
  database: Database,
  notice: Pick<BillingNotice, 'familyId' | 'facts'>,
): Promise<string | null> {
  const created = notice.facts.sessionCreatedAt;
  if (created) {
    const at = new Date(created).getTime();
    const bound = await checkoutActors(database, notice.familyId, {
      from: new Date(at - SESSION_BIND_BEFORE_MS),
      to: new Date(at + SESSION_BIND_AFTER_MS),
    });
    if (bound.length === 1) return bound[0] as string;
    if (bound.length > 1) return null;
  }
  return singleCheckoutActor(database, notice.familyId);
}

async function planChangePayer(
  database: Database,
  notice: Pick<BillingNotice, 'familyId' | 'facts'>,
): Promise<string | null> {
  const subjects = new Set<string>();
  let needsSingleActor = false;
  if (notice.facts.ended) subjects.add(notice.facts.ended.subscriptionId);
  for (const refund of notice.facts.refunds ?? []) {
    if (refund.subscriptionId) subjects.add(refund.subscriptionId);
    else needsSingleActor = true;
  }
  if (subjects.size === 0) needsSingleActor = true;

  const parents = new Set<string>();
  for (const subscriptionId of subjects) {
    const payer = await subscriptionPayer(database, notice.familyId, subscriptionId);
    if (payer) parents.add(payer);
    else needsSingleActor = true;
  }
  if (needsSingleActor) {
    const actor = await singleCheckoutActor(database, notice.familyId);
    if (actor === null) return null;
    parents.add(actor);
  }
  return parents.size === 1 ? ([...parents][0] as string) : null;
}

/** The parent a payment notice resolved for exactly this subscription. */
async function subscriptionPayer(
  database: Database,
  familyId: string,
  subscriptionId: string,
): Promise<string | null> {
  const rows = await database
    .selectDistinct({ parentUserId: schema.billingNotices.parentUserId })
    .from(schema.billingNotices)
    .where(
      and(
        eq(schema.billingNotices.familyId, familyId),
        eq(schema.billingNotices.lane, 'payment'),
        isNotNull(schema.billingNotices.parentUserId),
        sql`${schema.billingNotices.facts}->>'subscriptionId' = ${subscriptionId}`,
      ),
    );
  return rows.length === 1 ? (rows[0]?.parentUserId ?? null) : null;
}
