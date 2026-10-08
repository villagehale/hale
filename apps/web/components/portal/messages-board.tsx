'use client';

import { useState } from 'react';
import { previewIdFor } from '~/components/hale/approval-card';
import { ApproveButton } from '~/components/hale/approve-button';
import { DismissButton } from '~/components/hale/dismiss-button';
import { ExportDataButton } from '~/components/hale/export-data-button';
import type { PendingApprovalView } from '~/lib/dashboard/approvals';
import styles from './portal.module.css';

export interface ThreadItem {
  id: string;
  day: string;
  time: string;
  kind: 'in' | 'out' | 'did';
  text: string;
  /** Hale did this. Waiting rows are approvals, not thread items. */
  hale: boolean;
}

type Filter = 'all' | 'hale' | 'waiting';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'hale', label: 'Hale did' },
  { id: 'waiting', label: 'Waiting' },
];

export function MessagesBoard({
  items,
  approvals,
}: {
  items: ThreadItem[];
  approvals: PendingApprovalView[];
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const shown = items.filter((item) => (filter === 'hale' ? item.hale : filter !== 'waiting'));
  const showWaiting = filter === 'all' || filter === 'waiting';
  const empty = shown.length === 0 && (!showWaiting || approvals.length === 0);

  const days: { day: string; rows: ThreadItem[] }[] = [];
  for (const item of shown) {
    const last = days[days.length - 1];
    if (!last || last.day !== item.day) days.push({ day: item.day, rows: [item] });
    else last.rows.push(item);
  }
  for (const group of days) group.rows.reverse();

  return (
    <>
      <div className={styles.filter}>
        <div className={styles.seg} role="tablist" aria-label="Filter">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={filter === entry.id}
              className={filter === entry.id ? styles.segOn : undefined}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <ExportDataButton idleLabel="Export" />
      </div>
      <div className={styles.one}>
        <section className={`${styles.card} ${styles.span}`}>
          {empty ? (
            <p className={styles.text}>Nothing here yet. Text Hale and it shows up here.</p>
          ) : (
            <>
              {showWaiting
                ? approvals.map((approval) => <WaitingRow key={approval.id} approval={approval} />)
                : null}
              {days.map((group) => (
                <div key={group.day}>
                  <p className={styles.day}>{group.day}</p>
                  <div className={styles.thread}>
                    {group.rows.map((row) =>
                      row.kind === 'did' ? (
                        <span key={row.id} className={styles.did}>
                          <Spark />
                          <span data-hale-pii>{row.text}</span>
                        </span>
                      ) : (
                        <div key={row.id} className={styles.thread}>
                          {row.time ? <span className={styles.time}>{row.time}</span> : null}
                          <div
                            className={`${styles.bubble} ${row.kind === 'out' ? styles.out : styles.in}`}
                            data-hale-pii
                          >
                            {row.text}
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </>
  );
}

function WaitingRow({ approval }: { approval: PendingApprovalView }) {
  const previewId = previewIdFor(approval.id);
  const canApprove =
    approval.verdict === 'approved' && !approval.teenRedacted && !approval.teenUnlockable;
  return (
    <div className={styles.ask} style={{ marginBottom: 16 }}>
      <div id={previewId} className={`${styles.bubble} ${styles.in}`} data-hale-pii>
        {approval.preview}
      </div>
      <div className={styles.acts}>
        {canApprove ? (
          <ApproveButton
            actionId={approval.id}
            labelledBy={previewId}
            idleLabel="Add it"
            className={styles.primary}
          />
        ) : null}
        <DismissButton
          actionId={approval.id}
          label={approval.preview}
          labelledBy={previewId}
          idleLabel="Not now"
          className={styles.secondary}
        />
      </div>
    </div>
  );
}

function Spark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path
        d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3z"
        strokeLinejoin="round"
      />
    </svg>
  );
}
