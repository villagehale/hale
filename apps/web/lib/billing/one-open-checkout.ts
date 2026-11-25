import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { OpsPage, OpsPagerOutcome } from '~/lib/monitoring/failure-page';
import { LIVE_SUBSCRIPTION } from '~/lib/webhooks/stripe-billing';
import { familyAlreadySubscribed } from './already-subscribed.js';
import type { CheckoutSessionParams, StripeCheckoutClient } from './stripe-client.js';

/**
 * VIL-729 · behind ONE_OPEN_CHECKOUT_ENABLED. A family holds at most one Checkout Session
 * it could still pay, so a double tap, two tabs, or Plus then Max before the first
 * checkout.session.completed webhook lands can never end in two subscriptions.
 *
 * The family row is locked for the whole decision, Stripe calls included, so two requests
 * for one family take turns. The family's last session is the newest `billing_checkout_started`
 * audit row that names one (`after.sessionId`, written only on this path); its actor is the
 * adult who opened it. Rows are stamped with the database clock at the write, under the
 * lock, so the newest row is the last session made. Under the lock that session is read
 * from Stripe:
 *   - open, same adult, same price: that session is returned, and nothing new is made;
 *   - open otherwise: it is expired in Stripe first. Another adult gets their own session,
 *     because the payer is read from who opened it. If Stripe will not expire it, nothing
 *     is made, #ops is paged, and the request fails;
 *   - paid, with a subscription that keeps or may yet start a paid plan: already_paid, as
 *     if the webhook had landed;
 *   - expired, gone from Stripe, or paid with a subscription that leaves the family on
 *     Free: a new session is made.
 * The create sends no Idempotency-Key. The lock already makes two requests take turns, and
 * Stripe returns a key's first response, a 500 included, to every later request with that
 * key for at least a day, so a key built from the request would turn one failed create
 * into a day of failed checkouts.
 */

export class OpenCheckoutNotExpired extends Error {
  override name = 'OpenCheckoutNotExpired';
}

export type OneOpenCheckoutResult =
  | { status: 'created'; url: string }
  | { status: 'not_found' }
  | { status: 'already_paid' };

interface StripeSession {
  id: string;
  status: string;
  url: string | null;
  metadata: { priceId?: string } | null;
  subscription: { status?: string } | string | null;
}

type Decision =
  | { kind: 'done'; result: OneOpenCheckoutResult }
  | { kind: 'unexpired' }
  | { kind: 'create_failed'; err: unknown };

export async function createOneOpenCheckout(input: {
  database: Database;
  client: StripeCheckoutClient;
  familyId: string;
  userId: string;
  params: CheckoutSessionParams;
  audit: Record<string, unknown>;
  page: (database: Database, page: OpsPage) => Promise<OpsPagerOutcome>;
}): Promise<OneOpenCheckoutResult> {
  const { database, client, familyId, userId, params } = input;
  const retrieve = client.retrieveCheckoutSession?.bind(client);
  const expire = client.expireCheckoutSession?.bind(client);
  if (!retrieve || !expire) {
    throw new Error('one open checkout: the Stripe client cannot read or expire a session');
  }

  const started = (sessionId: string) =>
    ({
      familyId,
      actor: userId,
      actionTaken: 'billing_checkout_started',
      targetTable: 'families',
      targetId: familyId,
      after: { ...input.audit, sessionId },
      occurredAt: sql`clock_timestamp()`,
    }) as const;

  const decision = await database.transaction(async (rawTx): Promise<Decision> => {
    const tx = rawTx as unknown as Database;
    const [family] = await tx
      .select({ planTier: schema.families.planTier })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1)
      .for('update');
    if (!family) return { kind: 'done', result: { status: 'not_found' } };
    if (familyAlreadySubscribed(family))
      return { kind: 'done', result: { status: 'already_paid' } };

    const { auditLog } = schema;
    const [last] = await tx
      .select({ actor: auditLog.actor, sessionId: sql<string>`${auditLog.after} ->> 'sessionId'` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.familyId, familyId),
          eq(auditLog.actionTaken, 'billing_checkout_started'),
          isNotNull(sql`${auditLog.after} ->> 'sessionId'`),
        ),
      )
      .orderBy(desc(auditLog.occurredAt))
      .limit(1);
    const priorSessionId = last?.sessionId ?? null;
    const prior = priorSessionId
      ? ((await retrieve(priorSessionId, { expand: ['subscription'] })) as StripeSession | null)
      : null;

    if (prior?.status === 'complete' && !subscriptionEnded(prior.subscription)) {
      return { kind: 'done', result: { status: 'already_paid' } };
    }
    if (prior?.status === 'open') {
      if (prior.url && last?.actor === userId && prior.metadata?.priceId === params.priceId) {
        await tx.insert(auditLog).values(started(prior.id));
        return { kind: 'done', result: { status: 'created', url: prior.url } };
      }
      try {
        await expire(prior.id);
      } catch {
        return { kind: 'unexpired' };
      }
      await tx.insert(auditLog).values({
        familyId,
        actor: userId,
        actionTaken: 'billing_checkout_expired',
        targetTable: 'families',
        targetId: familyId,
        before: { sessionId: prior.id },
        occurredAt: sql`clock_timestamp()`,
      });
    }

    let created: { url: string; id?: string };
    try {
      created = await client.createCheckoutSession(params);
    } catch (err) {
      return { kind: 'create_failed', err };
    }
    if (!created.id) {
      return {
        kind: 'create_failed',
        err: new Error('stripe checkout session response missing id'),
      };
    }
    await tx.insert(auditLog).values(started(created.id));
    return { kind: 'done', result: { status: 'created', url: created.url } };
  });

  // Outside the transaction: the expire's audit row is kept when the create after it
  // fails, and the page's claim row is not rolled back.
  switch (decision.kind) {
    case 'done':
      return decision.result;
    case 'create_failed':
      throw decision.err;
    case 'unexpired':
      await input.page(database, { site: 'checkout_session_unexpired', facts: {}, ref: familyId });
      throw new OpenCheckoutNotExpired('the open checkout session was not expired');
  }
}

/**
 * Ended means the webhook would leave the family on Free: any status but the webhook's
 * live ones and `incomplete`, whose first payment may yet go through. A subscription
 * whose status cannot be read counts as live.
 */
function subscriptionEnded(subscription: StripeSession['subscription']): boolean {
  return (
    typeof subscription === 'object' &&
    subscription !== null &&
    typeof subscription.status === 'string' &&
    subscription.status !== 'incomplete' &&
    !LIVE_SUBSCRIPTION.has(subscription.status)
  );
}
