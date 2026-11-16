import { Bell, Star } from 'lucide-react';
import type { BillingCurrency, PlanTier } from '@hale/types';
import {
  FOUNDING_PRICE_DISPLAY,
  PLUS_LIST_PRICE_DISPLAY,
} from '@hale/types';
import styles from './portal.module.css';
import { PlanCheckoutButton } from './plan-checkout-button';

/**
 * Every family sees this until Hale starts charging. No tiers, prices, or
 * founding ordinal — that families column is not read here.
 */
export function FoundingPlan() {
  return (
    <section className={`${styles.card} ${styles.span} ${styles['fp-card']}`}>
      <div className={styles['fp-head']}>
        <span className={styles['fp-seal']} aria-hidden="true">
          <Star
            className={styles['fp-star']}
            aria-hidden="true"
            fill="currentColor"
            strokeWidth={0}
          />
        </span>
        <span className={styles['fp-badge']}>Founding family</span>
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
    <section className={`${styles.card} ${styles.span} ${styles['fp-card']}`}>
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
  const price = FOUNDING_PRICE_DISPLAY[currency].perYear;
  return (
    <section className={`${styles.card} ${styles.span} ${styles['fp-card']}`}>
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
      <h2 className={styles['fp-title']}>{price}, locked for life.</h2>
      <p className={styles['fp-body']}>
        Yearly, at this price, for as long as you keep it. You can cancel or ask for a
        refund anytime.
      </p>
      <div className={styles['fp-rule']} />
      <PlanCheckoutButton />
    </section>
  );
}

export function ListPlan({ currency }: { currency: BillingCurrency }) {
  const list = PLUS_LIST_PRICE_DISPLAY[currency];
  return (
    <section className={`${styles.card} ${styles.span} ${styles['fp-card']}`}>
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
        {list.monthlyLabel} or {list.annualLabel}.
      </h2>
      <p className={styles['fp-body']}>Continue to checkout when you are ready.</p>
      <div className={styles['fp-rule']} />
      <PlanCheckoutButton period="monthly" label={`Continue · ${list.monthlyLabel}`} />
      <PlanCheckoutButton period="annual" label={`Continue · ${list.annualLabel}`} />
    </section>
  );
}
