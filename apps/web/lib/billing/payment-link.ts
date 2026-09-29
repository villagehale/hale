/**
 * A pre-built Stripe Payment Link, addressed to one family.
 *
 * Stripe copies `client_reference_id` onto the Checkout Session the link
 * opens. The billing webhook reads that back as the family id. The link
 * itself is created in the Dashboard (sandbox first); this only stamps the
 * family onto the URL. Dashboard metadata.tier must be plus or family, or
 * STRIPE_PAYMENT_LINK_ID + STRIPE_PAYMENT_LINK_TIER must name the same link.
 */
export function paymentLinkUrlForFamily(
  familyId: string,
  paymentLinkUrl: string | undefined,
): string | null {
  const raw = paymentLinkUrl?.trim() ?? '';
  if (!raw || !familyId) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  url.searchParams.set('client_reference_id', familyId);
  return url.toString();
}
