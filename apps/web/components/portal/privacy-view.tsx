import { ChevronRight, Download, Link2, ScrollText, ShieldCheck, ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { ConsentRecordsList } from '~/components/hale/consent-records-list';
import {
  DeleteAccountButton,
  type DeleteAccountRole,
} from '~/components/hale/delete-account-button';
import { ExportDataButton } from '~/components/hale/export-data-button';
import { SharedLinks } from '~/components/hale/shared-links';
import type { ViewerConsentRecord } from '~/lib/consent-records';
import { PRIVACY_URL } from '~/lib/legal-links';
import { PortalHeading } from './heading';
import styles from './portal.module.css';

export function PrivacyView({
  records,
  role,
}: {
  records: ViewerConsentRecord[];
  role: DeleteAccountRole;
}) {
  return (
    <>
      <PortalHeading back title="Privacy & data" lede="What Hale keeps, and how to take it back." />
      <div className={styles.one}>
        <section className={`${styles.card} ${styles.span}`}>
          <span className={styles.tag}>Our promise</span>
          <PromiseRow
            icon={<ShieldCheck aria-hidden="true" />}
            title="Never sold"
            meta="Not for ads, not to anyone."
          />
          <PromiseRow
            icon={<ShieldOff aria-hidden="true" />}
            title="Never used to train AI"
            meta="Not by Hale."
          />
          <p className={styles.text}>
            <a href={PRIVACY_URL}>Read the privacy policy</a>
          </p>
        </section>
        <section className={`${styles.card} ${styles.span}`}>
          <span className={styles.tag}>Your controls</span>
          <div className={styles.row}>
            <span className={styles.tile}>
              <Download aria-hidden="true" />
            </span>
            <span>
              <h3>Export your data</h3>
              <p className={styles.meta}>A copy of everything Hale holds.</p>
            </span>
            <span className={styles.end}>
              <ExportDataButton idleLabel="Export" />
            </span>
          </div>
          <details className={styles.disclosure}>
            <summary className={styles.row}>
              <span className={styles.tile}>
                <ScrollText aria-hidden="true" />
              </span>
              <span>
                <h3>Your yes and no</h3>
                <p className={styles.meta}>Every permission you’ve given.</p>
              </span>
              <span className={styles.end}>
                <ChevronRight className={styles.go} aria-hidden="true" />
              </span>
            </summary>
            <div className={styles.reveal}>
              <ConsentRecordsList records={records} />
            </div>
          </details>
          <details className={styles.disclosure}>
            <summary className={styles.row}>
              <span className={styles.tile}>
                <Link2 aria-hidden="true" />
              </span>
              <span>
                <h3>Shared links</h3>
                <p className={styles.meta}>Links you shared. Turn any off.</p>
              </span>
              <span className={styles.end}>
                <ChevronRight className={styles.go} aria-hidden="true" />
              </span>
            </summary>
            <div className={styles.reveal}>
              <SharedLinks />
            </div>
          </details>
        </section>
        <Danger role={role} />
      </div>
    </>
  );
}

function PromiseRow({ icon, title, meta }: { icon: ReactNode; title: string; meta: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.tile}>{icon}</span>
      <span>
        <h3>{title}</h3>
        <p className={styles.meta}>{meta}</p>
      </span>
    </div>
  );
}

function Danger({ role }: { role: DeleteAccountRole }) {
  if (role === 'co_parent') {
    return (
      <section className={`${styles.card} ${styles.span} ${styles.danger}`}>
        <h2>Leave this family</h2>
        <p className={styles.text}>
          You can leave this family at any time. Hale stops texting you about them straight away and
          disconnects everything you connected. The family’s own record — the children, the history
          — belongs to the household and stays with it. To ask what Hale still holds for you, email{' '}
          <a href="mailto:privacy@villagehale.com">privacy@villagehale.com</a>.
        </p>
        <DeleteAccountButton role={role} />
      </section>
    );
  }
  if (role === 'scoped' || role === 'ambiguous') {
    return (
      <section className={`${styles.card} ${styles.span}`}>
        <h2>Your data</h2>
      </section>
    );
  }
  return (
    <section className={`${styles.card} ${styles.span} ${styles.danger}`}>
      <h2>Delete everything</h2>
      <p className={styles.text}>
        This removes your kids, your history and every connection. It starts after 7 days. To stop
        it, reply to any Hale text or email{' '}
        <a href="mailto:privacy@villagehale.com">privacy@villagehale.com</a>.
      </p>
      <DeleteAccountButton role={role} idleLabel="Delete everything" />
    </section>
  );
}
