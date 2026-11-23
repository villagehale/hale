import type { Metadata } from 'next';
import { currencyFromIpCountry, promoPhaseAt } from '@hale/types';
import { FoundingCheckout } from '~/components/billing/founding-checkout';
import styles from '~/components/portal/portal.module.css';

export const metadata: Metadata = { title: 'Checkout' };

/**
 * Design-only. /demo's layout is 404 in production. reviewOnly means the button
 * never calls an API or creates a Stripe session, even if preview has keys.
 */
export default async function DemoFoundingCheckout({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const phase =
    q.promo_phase === 'holiday'
      ? 'holiday'
      : q.promo_phase === 'black_friday'
        ? 'black_friday'
        : promoPhaseAt(new Date());
  const currency = currencyFromIpCountry(typeof q.promo_cc === 'string' ? q.promo_cc : null);
  return (
    <div className={styles.one}>
      <FoundingCheckout
        currency={currency}
        phase={phase}
        ready={q.checkout !== 'unavailable'}
        attribution={{}}
        reviewOnly
        cancelled={q.checkout === 'cancelled'}
      />
    </div>
  );
}
