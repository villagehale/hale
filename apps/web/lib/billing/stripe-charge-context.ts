/**
 * Stripe charge → customer, subscription, and family.
 *
 * A charge.refunded payload carries an invoice id. A dispute payload carries a
 * charge id. Neither includes the subscription object unless Stripe expanded it,
 * so the webhook looks the charge up before it decides whether to drop a tier.
 */

export interface StripeChargeContext {
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  familyId: string | null;
}

export interface StripeChargeLookup {
  lookupCharge(chargeId: string): Promise<StripeChargeContext>;
}

export function stripeChargeLookupFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): StripeChargeLookup | null {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  if (!secret) return null;
  return {
    async lookupCharge(chargeId) {
      const charge = await stripeGet(
        secret,
        `/v1/charges/${encodeURIComponent(chargeId)}`,
        fetchImpl,
      );
      const invoiceId = readId(charge.invoice);
      const invoice = invoiceId
        ? await stripeGet(secret, `/v1/invoices/${encodeURIComponent(invoiceId)}`, fetchImpl)
        : null;
      const subscriptionId = invoice ? subscriptionIdFromInvoice(invoice) : null;
      const subscription = subscriptionId
        ? await stripeGet(
            secret,
            `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
            fetchImpl,
          )
        : null;
      const status = readString(subscription?.status)?.toLowerCase() ?? null;
      return {
        customerId: readId(charge.customer) ?? (invoice ? readId(invoice.customer) : null),
        subscriptionId,
        subscriptionStatus: status,
        familyId:
          familyFromMetadata(charge) ??
          (invoice ? familyFromMetadata(invoice) : null) ??
          (invoice ? familyFromSubscriptionDetails(invoice) : null) ??
          (subscription ? familyFromMetadata(subscription) : null),
      };
    },
  };
}

export async function stripeGet(
  secret: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`https://api.stripe.com${path}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw new Error(`stripe lookup failed: ${res.status}`);
  const json = (await res.json()) as unknown;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('stripe lookup returned a non-object');
  }
  return json as Record<string, unknown>;
}

function subscriptionIdFromInvoice(invoice: Record<string, unknown>): string | null {
  const direct = readId(invoice.subscription);
  if (direct) return direct;
  const parent = isRecord(invoice.parent) ? invoice.parent : null;
  const details =
    parent && isRecord(parent.subscription_details) ? parent.subscription_details : null;
  return details ? readId(details.subscription) : null;
}

function familyFromSubscriptionDetails(invoice: Record<string, unknown>): string | null {
  const parent = isRecord(invoice.parent) ? invoice.parent : null;
  const details =
    parent && isRecord(parent.subscription_details) ? parent.subscription_details : null;
  return details ? familyFromMetadata(details) : null;
}

function familyFromMetadata(value: Record<string, unknown>): string | null {
  const metadata = isRecord(value.metadata) ? value.metadata : null;
  return metadata ? readString(metadata.familyId) : null;
}

function readId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecord(value)) return readString(value.id);
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
