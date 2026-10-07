import type { ReactNode } from 'react';
import {
  FOOTER_LEAD,
  FOOTER_PRIVACY,
  PRONUNCIATION,
} from '~/lib/channel/connect/connect-page-copy';
import { PRIVACY_URL } from '~/lib/legal-links';
import styles from './connect.module.css';
import { Wordmark } from './wordmark';

/**
 * Shore stage for /connect and /connected. The glass pill is the mark only:
 * this page has nowhere to navigate. The footer is the same on every state.
 */
export function ConnectStage({ children }: { children: ReactNode }) {
  return (
    <div className={styles.stage}>
      <img
        className={styles.shoreArt}
        src="/connect/hale-shore-hero.webp"
        alt=""
        aria-hidden="true"
      />
      <span className={`${styles.drift} ${styles.sky}`} aria-hidden="true" />
      <span className={`${styles.drift} ${styles.sea}`} aria-hidden="true" />
      <span className={styles.scrim} aria-hidden="true" />
      <header className={styles.header}>
        <div className={styles.pill} role="img" aria-label="Hale">
          <span className={styles.brand}>
            <img className={styles.logo} src="/connect/hale-logo.jpeg" alt="" />
            <Wordmark className={styles.wordmark} />
          </span>
        </div>
      </header>
      <main className={styles.main}>
        {children}
        <footer className={styles.foot}>
          <p>
            {FOOTER_LEAD} <a href={PRIVACY_URL}>{FOOTER_PRIVACY}</a>
          </p>
          <p className={styles.say}>{PRONUNCIATION}</p>
        </footer>
      </main>
    </div>
  );
}
