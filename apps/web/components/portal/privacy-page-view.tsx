import { Calendar, Download, FolderOpen, Mail } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DeleteAccountRole } from '~/components/hale/delete-account-button';
import { ExportDataButton } from '~/components/hale/export-data-button';
import type { CalendarTarget, WhatHaleDidItem } from '~/lib/dashboard/what-hale-did';
import type { ConnectionState } from '~/lib/integrations/connection-state';
import { PRIVACY_URL } from '~/lib/legal-links';
import { PortalHeading } from './heading';
import styles from './portal.module.css';
import { Danger } from './privacy-view';

const CALENDAR_LABEL: Record<CalendarTarget, string> = {
  hale_calendar: 'Family calendar',
  google_calendar: 'Google Calendar',
};

export interface PrivacyHousehold {
  activity: readonly WhatHaleDidItem[];
  connections: { gmail: ConnectionState; gcal: ConnectionState; gdrive: ConnectionState };
}

/**
 * A parent's data rights on one read-only page: what Hale did for them, what it can
 * still reach, a copy of their data, and deletion. A receipt, so nothing here decides
 * anything; changes go through the thread. Each activity row is family PII, so it sits
 * under `data-hale-pii` for session replay (rule #1).
 */
export function PrivacyPageView({
  household,
  role,
}: {
  /** A parent's view of the household; null for every other seat, which sees neither. */
  household: PrivacyHousehold | null;
  role: DeleteAccountRole;
}) {
  return (
    <>
      <PortalHeading
        title="Privacy & data"
        lede="What Hale did for you, what it can reach, and how to take it back."
      />
      <div className={styles.one}>
        {household ? <Household household={household} /> : null}
        <section className={`${styles.card} ${styles.span}`}>
          <div className={styles.row}>
            <span className={styles.tile}>
              <Download aria-hidden="true" />
            </span>
            <span>
              <h3>Export your data</h3>
              <p className={styles.meta}>A copy of everything Hale holds.</p>
            </span>
            <span className={styles.end}>
              <ExportDataButton idleLabel="Export" className={styles.secondary} />
            </span>
          </div>
        </section>
        <Danger role={role} />
        <p className={styles.text}>
          <a href={PRIVACY_URL}>Read the privacy policy</a>
        </p>
      </div>
    </>
  );
}

function Household({ household }: { household: PrivacyHousehold }) {
  return (
    <>
      <section className={`${styles.card} ${styles.span}`}>
        <span className={styles.tag}>What Hale did</span>
        {household.activity.length === 0 ? (
          <p className={styles.text}>Nothing yet.</p>
        ) : (
          household.activity.map((item) => <ActivityRow key={item.id} item={item} />)
        )}
      </section>
      <section className={`${styles.card} ${styles.span}`}>
        <span className={styles.tag}>Your connections</span>
        <ConnectionRow
          icon={<Mail aria-hidden="true" />}
          title="Gmail"
          state={household.connections.gmail}
        />
        <ConnectionRow
          icon={<Calendar aria-hidden="true" />}
          title="Google Calendar"
          state={household.connections.gcal}
        />
        {household.connections.gdrive === 'connected' ? (
          <ConnectionRow
            icon={<FolderOpen aria-hidden="true" />}
            title="Google Drive"
            state={household.connections.gdrive}
          />
        ) : null}
        <p className={styles.text}>To change anything here, text Hale.</p>
      </section>
    </>
  );
}

function ActivityRow({ item }: { item: WhatHaleDidItem }) {
  return (
    <div className={styles.row}>
      <span className={styles.tile}>
        {item.kind === 'email' ? <Mail aria-hidden="true" /> : <Calendar aria-hidden="true" />}
      </span>
      <span data-hale-pii>
        <h3>{item.what}</h3>
        <p className={styles.meta}>{item.when}</p>
        {item.calendars.length > 0 ? (
          <span className={styles.chips}>
            {item.calendars.map((calendar) => (
              <span key={calendar}>{CALENDAR_LABEL[calendar]}</span>
            ))}
          </span>
        ) : null}
      </span>
      <span />
    </div>
  );
}

function ConnectionRow({
  icon,
  title,
  state,
}: {
  icon: ReactNode;
  title: string;
  state: ConnectionState;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.tile}>{icon}</span>
      <span>
        <h3>{title}</h3>
      </span>
      <span className={styles.end}>
        {state === 'connected' ? (
          <span className={`${styles.state} ${styles.ok}`}>Connected</span>
        ) : (
          <span className={styles.state}>Not connected</span>
        )}
      </span>
    </div>
  );
}
