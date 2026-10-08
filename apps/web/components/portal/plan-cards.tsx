'use client';

import type { PlanTier } from '@hale/types';
import { useState } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { planName } from './format';
import styles from './portal.module.css';

const PLANS: {
  tier: PlanTier;
  price: string;
  body: string;
}[] = [
  {
    tier: 'free',
    price: '$0',
    body: 'Everything to get started, free for every family.',
  },
  {
    tier: 'plus',
    price: '$19 CAD/mo',
    body: 'More of the year in view, as each part ships.',
  },
  {
    tier: 'family',
    price: '$39 CAD/mo',
    body: 'The most help Hale offers, as each part ships.',
  },
];

/** The stored tier is "Your plan". Plus and Max are not offered for purchase. */
export function PlanCards({ tier }: { tier: PlanTier }) {
  const capture = useAnalytics();
  const [noted, setNoted] = useState(false);

  function tell() {
    capture('plan_notify_requested', { tier: tier === 'free' ? 'plus' : 'family' });
    setNoted(true);
  }

  return (
    <section className={`${styles.card} ${styles.span}`}>
      <div className={styles.plans}>
        {PLANS.map((plan) => {
          const current = plan.tier === tier;
          const comingSoon = plan.tier !== 'free' && !current;
          return (
            <div
              key={plan.tier}
              className={current ? `${styles.plan} ${styles.current}` : styles.plan}
            >
              <h3>
                {planName(plan.tier)} <span className={styles.price}>{plan.price}</span>
              </h3>
              {current ? (
                <span className={`${styles.state} ${styles.ok}`}>Your plan</span>
              ) : comingSoon ? (
                <span className={styles.state}>Coming soon</span>
              ) : null}
              <p className={styles.text}>{plan.body}</p>
            </div>
          );
        })}
      </div>
      <p className={styles.meta}>Only Free is available today.</p>
      <button
        type="button"
        className={`${styles.primary} ${styles.block}`}
        aria-pressed={noted}
        onClick={tell}
      >
        Tell me when they open
      </button>
    </section>
  );
}
