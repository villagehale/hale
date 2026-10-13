import type { ReactNode } from 'react';
import styles from './portal.module.css';

export function DisabledRow({
  icon,
  title,
  meta,
}: { icon: ReactNode; title: string; meta: string }) {
  return (
    <div aria-disabled="true" className={`${styles.row} ${styles.rowOff}`}>
      <span className={styles.tile}>{icon}</span>
      <span>
        <h3>{title}</h3>
        <p className={styles.meta}>{meta}</p>
      </span>
    </div>
  );
}
