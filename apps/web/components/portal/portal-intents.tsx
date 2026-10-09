import type { OnboardingIntent } from '@hale/types';
import { ONBOARDING_INTENTS } from '@hale/types';
import styles from './portal.module.css';

/**
 * The intents the family already chose, as quiet wash chips. Hale changes
 * these from a text — the portal does not edit them.
 */
export function PortalIntents({ intents }: { intents: OnboardingIntent[] }) {
  const chips = ONBOARDING_INTENTS.filter((item) => intents.includes(item.value));
  if (chips.length === 0) return null;
  return (
    <div className={styles.chipset}>
      {chips.map(({ value, label }) => (
        <span key={value} className={styles.chipStatic}>
          {label}
        </span>
      ))}
    </div>
  );
}
