import { Calendar, Download, FolderOpen, LogOut, Mail, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  DeleteAccountButton,
  type DeleteAccountRole,
} from '~/components/hale/delete-account-button';
import { ExportDataButton } from '~/components/hale/export-data-button';
import type { WhatHaleDidItem } from '~/lib/dashboard/what-hale-did';
import type { ConnectionState } from '~/lib/integrations/connection-state';
import { PRIVACY_URL } from '~/lib/legal-links';
import { PortalHeading } from './heading';
import styles from './portal.module.css';

const PARENT_LEDE = 'What Hale did for you, what it can reach, and how to take it back.';
const SCOPED_LEDE = 'You help out with this family. Its parents manage the family’s data.';

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
  canExport,
  holdDays,
}: {
  /** A parent's view of the household; null for every other seat, which sees none of it
   * and no export either: the export is the family's whole record, not the viewer's. */
  household: PrivacyHousehold | null;
  role: DeleteAccountRole;
  /** Whether the export route serves this viewer's seats (exportSeat). */
  canExport: boolean;
  /** How long a family erasure is held before it runs. */
  holdDays: number;
}) {
  return (
    <div className={styles.column}>
      <PortalHeading title="Privacy & data" lede={household ? PARENT_LEDE : SCOPED_LEDE} />
      <div className={styles.one}>
        {household ? <Household household={household} canExport={canExport} /> : null}
        <Deletion role={role} holdDays={holdDays} />
        {household ? null : (
          <p className={`${styles.text} ${styles.span}`}>
            To ask what Hale holds about you, email{' '}
            <a href="mailto:privacy@villagehale.com">privacy@villagehale.com</a>.
          </p>
        )}
        <p className={`${styles.text} ${styles.span}`}>
          <a href={PRIVACY_URL}>Read the privacy policy</a>
        </p>
      </div>
    </div>
  );
}

function Household({ household, canExport }: { household: PrivacyHousehold; canExport: boolean }) {
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
      {canExport ? (
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
      ) : null}
    </>
  );
}

/**
 * Deletion as a sibling of Export: the same card and row, red only on its button. The
 * one line is the hold; the confirm step carries the full explanation. A scoped seat
 * has no erasure of its own, so it gets no card rather than an empty one.
 */
function Deletion({ role, holdDays }: { role: DeleteAccountRole; holdDays: number }) {
  if (role === 'scoped') return null;
  const leaving = role === 'co_parent';
  return (
    <section className={`${styles.card} ${styles.span}`}>
      <div className={`${styles.row} ${styles.rights}`}>
        <span className={styles.tile}>
          {leaving ? <LogOut aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
        </span>
        <span>
          <h3>{leaving ? 'Leave this family' : 'Delete your account'}</h3>
          {role === 'ambiguous' ? null : (
            <p className={styles.meta}>
              {leaving
                ? 'Takes effect right away. The family keeps its own record.'
                : `Starts after a ${holdDays}-day hold you can cancel.`}
            </p>
          )}
        </span>
        <DeleteAccountButton
          role={role}
          idleLabel="Delete account…"
          buttonClassName={`${styles.secondary} ${styles.destructive}`}
          cancelClassName={styles.secondary}
        />
      </div>
    </section>
  );
}

function ActivityRow({ item }: { item: WhatHaleDidItem }) {
  return (
    <div className={`${styles.row} ${styles.top}`}>
      <span className={styles.tile}>
        {item.kind === 'email' ? <Mail aria-hidden="true" /> : <Calendar aria-hidden="true" />}
      </span>
      <span data-hale-pii>
        <h3>{item.what}</h3>
        <p className={styles.meta}>{item.when}</p>
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
