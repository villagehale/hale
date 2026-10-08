import { Bell, Star } from 'lucide-react';
import styles from './portal.module.css';

/**
 * Every family sees this until Hale starts charging. No tiers, prices, or
 * founding ordinal — `families.founding_number` is not read here.
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
