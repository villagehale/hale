import { FOUNDING_PROMO_STARTS_AT, currencyFromIpCountry, promoPhaseAt } from '@hale/types';
import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { FoundingCheckout } from '~/components/billing/founding-checkout';
import { PortalHeading } from '~/components/portal/heading';
import styles from '~/components/portal/portal.module.css';
import { attributionFromRequest } from '~/lib/billing/attribution';
import { holidayPromoEnabled } from '~/lib/billing/flags';
import { foundingWindowOpen, isPromoAnnualSku, resolveCheckoutPrice } from '~/lib/billing/prices';
import { familyMayUseFoundingCheckout } from '~/lib/billing/promo-access';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { currentFamilyId } from '~/lib/family';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

export const metadata: Metadata = { title: 'Founding family checkout' };

/**
 * The price confirmation before Stripe, for a family that already texts Hale.
 * The authed layout + Edge middleware keep it behind the phone sign-in door.
 * This is only a review surface: opening it never creates a Checkout Session.
 */
export default async function FoundingCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const h = await headers();
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') query.set(key, value);
  }
  const attribution = attributionFromRequest({
    cookieHeader: (await cookies()).toString(),
    search: query,
  });
  const now = new Date();
  const currency = currencyFromIpCountry(h.get('x-vercel-ip-country'));
  const familyId = await currentFamilyId();
  const basics = await loadFamilyBasics();
  if (basics.planTier !== 'free') {
    return (
      <>
        <PortalHeading
          back
          title="Your family has a paid plan"
          lede="There’s no need to subscribe twice."
        />
        <div className={styles.one}>
          <section className={styles.card}>
            <h2>You’re already covered.</h2>
            <p className={styles.text}>
              For a billing question, email{' '}
              <a href="mailto:aloha@villagehale.com">aloha@villagehale.com</a>.
            </p>
          </section>
        </div>
      </>
    );
  }
  const open =
    now.getTime() >= new Date(FOUNDING_PROMO_STARTS_AT).getTime() && foundingWindowOpen(now);
  if (!open) {
    return (
      <>
        <PortalHeading back title="The founding offer has ended" lede="You haven’t been charged." />
        <div className={styles.one}>
          <section className={styles.card}>
            <h2>You can still use Hale.</h2>
            <p className={styles.text}>
              See the current plans at <a href={`${MARKETING_SITE_URL}/pricing`}>Hale pricing</a>.
            </p>
          </section>
        </div>
      </>
    );
  }
  if (!familyMayUseFoundingCheckout(familyId, now)) {
    notFound();
  }
  const stripeReady = Boolean(process.env.STRIPE_SECRET_KEY && process.env.APP_URL);
  const plus = resolveCheckoutPrice({
    currency,
    period: 'annual',
    now,
    preview: !holidayPromoEnabled(),
    tier: 'plus',
  });
  const max = resolveCheckoutPrice({
    currency,
    period: 'annual',
    now,
    preview: !holidayPromoEnabled(),
    tier: 'family',
  });
  const plusReady =
    stripeReady &&
    plus.status === 'selected' &&
    isPromoAnnualSku(plus.price.sku) &&
    plus.price.currency === currency;
  const maxReady =
    stripeReady &&
    max.status === 'selected' &&
    isPromoAnnualSku(max.price.sku) &&
    max.price.currency === currency;
  return (
    <div className={styles.one}>
      <FoundingCheckout
        currency={currency}
        phase={promoPhaseAt(now)}
        ready={plusReady}
        attribution={attribution}
        cancelled={params.checkout === 'cancelled'}
        tier="plus"
      />
      <FoundingCheckout
        currency={currency}
        phase={promoPhaseAt(now)}
        ready={maxReady}
        attribution={attribution}
        cancelled={params.checkout === 'cancelled'}
        tier="family"
      />
    </div>
  );
}
