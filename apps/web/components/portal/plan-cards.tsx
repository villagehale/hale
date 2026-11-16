import type { BillingCurrency, PlanTier } from '@hale/types';
import { Bell, Star } from 'lucide-react';
import { PriceWithCurrency } from '~/components/billing/price-with-currency';
import { foundingPriceLabel, plusListPriceLabels } from '~/lib/billing/price-display';
import { PlanCheckoutButton } from './plan-checkout-button';
import styles from './portal.module.css';

/**
 * Free card. Badge stays "Founding family" when this is the only plan; pass
 * "Free" when it sits next to the founding offer so the two cards don't share
 * a founding label.
 */
export function FoundingPlan({ badge = 'Founding family' }: { badge?: string }) {
  return (
    <section className={`${styles.card} ${styles['fp-card']}`}>
      <div className={styles['fp-head']}>
        <span className={styles['fp-seal']} aria-hidden="true">
          <Star
            className={styles['fp-star']}
            aria-hidden="true"
            fill="currentColor"
            strokeWidth={0}
          />
        </span>
        <span className={styles['fp-badge']}>{badge}</span>
      </div>
      <h2 className={styles['fp-title']}>Everything Hale does is free for you.</h2>
      <p className={styles['fp-body']}>
        Every feature, including new ones as they ship. There’s no plan to pick and nothing to pay.
      </p>
      <div className={styles['fp-rule']} />
      <div className={styles['fp-note']}>
        <span className={styles['fp-bell']} aria-hidden="true">
          <Bell strokeWidth={1.75} />
        </span>
        <p>If that ever changes, you’ll hear from Hale well before it does.</p>
      </div>
    </section>
  );
}

export function PaidPlan({ tier }: { tier: Exclude<PlanTier, 'free'> }) {
  const label = tier === 'family' ? 'Family' : 'Plus';
  return (
    <section className={`${styles.card} ${styles['fp-card']}`}>
      <div className={styles['fp-head']}>
        <span className={styles['fp-seal']} aria-hidden="true">
          <Star
            className={styles['fp-star']}
            aria-hidden="true"
            fill="currentColor"
            strokeWidth={0}
          />
        </span>
        <span className={styles['fp-badge']}>{label}</span>
      </div>
      <h2 className={styles['fp-title']}>Your family is on {label}.</h2>
      <p className={styles['fp-body']}>
        The subscription for this household is active. Hale will not open a second one.
      </p>
    </section>
  );
}

export function PromoOfferPlan({ currency }: { currency: BillingCurrency }) {
  return (
    <section className={`${styles.card} ${styles['fp-card']}`}>
      <div className={styles['fp-head']}>
        <span className={styles['fp-seal']} aria-hidden="true">
          <Star
            className={styles['fp-star']}
            aria-hidden="true"
            fill="currentColor"
            strokeWidth={0}
          />
        </span>
        <span className={styles['fp-badge']}>Founding offer</span>
      </div>
      <h2 className={styles['fp-title']}>
        <PriceWithCurrency
          amount={foundingPriceLabel(currency)}
          currency={currency}
          noteClassName={styles['fp-currency']}
          after=", locked for life."
        />
      </h2>
      <p className={styles['fp-body']}>
        Yearly, at this price, for as long as you keep it. Full refund anytime.
      </p>
      <div className={styles['fp-rule']} />
      <PlanCheckoutButton />
    </section>
  );
}

export function ListPlan({ currency }: { currency: BillingCurrency }) {
  const list = plusListPriceLabels(currency);
  return (
    <section className={`${styles.card} ${styles['fp-card']}`}>
      <div className={styles['fp-head']}>
        <span className={styles['fp-seal']} aria-hidden="true">
          <Star
            className={styles['fp-star']}
            aria-hidden="true"
            fill="currentColor"
            strokeWidth={0}
          />
        </span>
        <span className={styles['fp-badge']}>Plus</span>
      </div>
      <h2 className={styles['fp-title']}>
        {list.monthly} or {list.annual}. <span className={styles['fp-currency']}>{currency}</span>
      </h2>
      <p className={styles['fp-body']}>Continue to checkout when you are ready.</p>
      <div className={styles['fp-rule']} />
      <PlanCheckoutButton period="monthly" label={`Continue · ${list.monthly}`} />
      <PlanCheckoutButton period="annual" label={`Continue · ${list.annual}`} />
    </section>
  );
}
