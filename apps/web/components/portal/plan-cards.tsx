import type { BillingCurrency, PlanTier } from '@hale/types';
import { Bell, Star } from 'lucide-react';
import {
  maxListPriceLabel,
  plusListPriceLabels,
  promoPriceLabel,
} from '~/lib/billing/price-display';
import { PlanCheckoutButton } from './plan-checkout-button';
import styles from './portal.module.css';

/** Text card. The price-word is not used. */
export function FoundingPlan({ badge = 'Text' }: { badge?: string }) {
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
      <h2 className={styles['fp-title']}>$0/mo</h2>
      <p className={styles['fp-body']}>No card needed.</p>
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
  const label = tier === 'family' ? 'Max' : 'Plus';
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

export function PromoOfferPlan({
  currency,
  tier,
}: {
  currency: BillingCurrency;
  tier: 'plus' | 'family';
}) {
  const label = tier === 'family' ? 'Max' : 'Plus';
  const amount = promoPriceLabel(tier, currency);
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
      <h2 className={styles['fp-title']}>{amount}, locked for life.</h2>
      <p className={styles['fp-body']}>
        Yearly, at this price, for as long as you keep it. Full refund anytime.
      </p>
      <div className={styles['fp-rule']} />
      <PlanCheckoutButton tier={tier} />
    </section>
  );
}

/**
 * Unpaid Plan cards. `founding` is Free + Plus annual promo + Max annual promo
 * — no monthly toggle, no regular annual, no disabled list option. `list` is
 * monthly + annual after the cutoff.
 */
export function PlanOffer({
  currency,
  surface,
}: {
  currency: BillingCurrency;
  surface: 'founding' | 'list';
}) {
  if (surface === 'list') {
    return (
      <>
        <ListPlan currency={currency} />
        <MaxListPlan currency={currency} />
      </>
    );
  }
  return (
    <>
      <FoundingPlan badge="Text" />
      <PromoOfferPlan currency={currency} tier="plus" />
      <PromoOfferPlan currency={currency} tier="family" />
    </>
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

/** Max list annual after the cutoff. Not shown during the promo window. */
export function MaxListPlan({ currency }: { currency: BillingCurrency }) {
  const annual = maxListPriceLabel(currency);
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
        <span className={styles['fp-badge']}>Max</span>
      </div>
      <h2 className={styles['fp-title']}>
        {annual}. <span className={styles['fp-currency']}>{currency}</span>
      </h2>
      <p className={styles['fp-body']}>Continue to checkout when you are ready.</p>
      <div className={styles['fp-rule']} />
      <PlanCheckoutButton tier="family" period="annual" label={`Continue · ${annual}`} />
    </section>
  );
}
