import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { OpsPage, OpsPagerOutcome } from '~/lib/monitoring/failure-page';
import { familyAlreadySubscribed } from './already-subscribed.js';
import type { CheckoutSessionParams, StripeCheckoutClient } from './stripe-client.js';

/**
 * VIL-729 · behind ONE_OPEN_CHECKOUT_ENABLED. A family holds at most one Checkout Session
 * it could still pay, so a double tap, two tabs, or Plus then Max before the first
 * checkout.session.completed webhook lands can never end in two subscriptions.
 *
 * The family row is locked for the whole decision, Stripe calls included, so two requests
 * for one family take turns. Under the lock the family's last session is read from Stripe:
 *   - open, same adult, same price: that session is returned, and nothing new is made;
 *   - open otherwise: it is expired in Stripe first. Another adult gets their own session,
 *     because the payer is read from who opened it. If Stripe will not expire it, nothing
 *     is made, #ops is paged, and the request fails;
 *   - paid, with its subscription not ended: already_paid, as if the webhook had landed;
 *   - expired, gone from Stripe, or its subscription ended: a new session is made.
 * The create carries an Idempotency-Key from the family, the session it follows, and the
 * whole request, so a retry of one request makes one session and a different request is
 * never refused as a reused key.
 */

const SUBSCRIPTION_ENDED: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

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

  const started = {
    familyId,
    actor: userId,
    actionTaken: 'billing_checkout_started',
    targetTable: 'families',
    targetId: familyId,
    after: input.audit,
  } as const;

  const decision = await database.transaction(async (rawTx): Promise<Decision> => {
    const tx = rawTx as unknown as Database;
    const [family] = await tx
      .select({
        planTier: schema.families.planTier,
        sessionId: schema.families.stripeCheckoutSessionId,
        openedBy: schema.families.stripeCheckoutOpenedBy,
      })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1)
      .for('update');
    if (!family) return { kind: 'done', result: { status: 'not_found' } };
    if (familyAlreadySubscribed(family))
      return { kind: 'done', result: { status: 'already_paid' } };

    const prior = family.sessionId
      ? ((await retrieve(family.sessionId, { expand: ['subscription'] })) as StripeSession | null)
      : null;

    if (prior?.status === 'complete' && !subscriptionEnded(prior.subscription)) {
      return { kind: 'done', result: { status: 'already_paid' } };
    }
    if (prior?.status === 'open') {
      if (prior.url && family.openedBy === userId && prior.metadata?.priceId === params.priceId) {
        await tx.insert(schema.auditLog).values(started);
        return { kind: 'done', result: { status: 'created', url: prior.url } };
      }
      try {
        await expire(prior.id);
      } catch {
        return { kind: 'unexpired' };
      }
      await tx.insert(schema.auditLog).values({
        familyId,
        actor: userId,
        actionTaken: 'billing_checkout_expired',
        targetTable: 'families',
        targetId: familyId,
        before: { sessionId: prior.id },
      });
    }

    let created: { url: string; id?: string };
    try {
      created = await client.createCheckoutSession({
        ...params,
        idempotencyKey: idempotencyKey(familyId, family.sessionId, params),
      });
    } catch (err) {
      return { kind: 'create_failed', err };
    }
    if (!created.id) {
      return {
        kind: 'create_failed',
        err: new Error('stripe checkout session response missing id'),
      };
    }
    await tx
      .update(schema.families)
      .set({ stripeCheckoutSessionId: created.id, stripeCheckoutOpenedBy: userId })
      .where(eq(schema.families.id, familyId));
    await tx.insert(schema.auditLog).values(started);
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

/** A subscription read back as anything but an ended one counts as live. */
function subscriptionEnded(subscription: StripeSession['subscription']): boolean {
  return (
    typeof subscription === 'object' &&
    subscription !== null &&
    typeof subscription.status === 'string' &&
    SUBSCRIPTION_ENDED.has(subscription.status)
  );
}

function idempotencyKey(
  familyId: string,
  priorSessionId: string | null,
  params: CheckoutSessionParams,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ familyId, priorSessionId, params }))
    .digest('hex');
}
