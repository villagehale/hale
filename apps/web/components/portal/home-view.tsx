import { ChevronRight, Mail, MessageCircle, Shield, Sparkles, UsersRound } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { previewIdFor } from '~/components/hale/approval-card';
import { ApproveButton } from '~/components/hale/approve-button';
import { DismissButton } from '~/components/hale/dismiss-button';
import type { PendingApprovalView } from '~/lib/dashboard/approvals';
import type { FamilyBasicsView } from '~/lib/dashboard/family-basics';
import type { FamilyConnectorView } from '~/lib/integrations/load';
import type { LoadLoopPrefsResult } from '~/lib/settings/loop-prefs';
import { clockLabel } from './format';
import type { ThreadItem } from './messages-board';
import styles from './portal.module.css';

function connected(connections: FamilyConnectorView[], provider: string): boolean {
  return connections.some(
    (row) => row.provider === provider && row.status !== 'revoked' && row.status !== 'disconnected',
  );
}

/**
 * Portal home. Waiting rows use the same approve and decline routes as
 * Approvals; the labels are the portal's. Example names from the mockups are
 * never filled in — an empty thread stays empty.
 */
export function PortalHome({
  firstName,
  approvals,
  lately,
  basics,
  connections,
  loop,
  smsHref,
}: {
  firstName: string | null;
  approvals: PendingApprovalView[];
  lately: ThreadItem[];
  basics: FamilyBasicsView;
  connections: FamilyConnectorView[];
  loop: LoadLoopPrefsResult;
  smsHref: string | null;
}) {
  const waiting = approvals[0] ?? null;
  const gmail = connected(connections, 'gmail');
  const calendar = connected(connections, 'gcal');
  const quiet =
    loop.status === 'ready'
      ? `Quiet ${clockLabel(loop.prefs.quietHoursStart)}–${clockLabel(loop.prefs.quietHoursEnd)}`
      : 'What Hale sends and when';
  const kids =
    basics.children.length === 0
      ? 'No kids yet.'
      : basics.children
          .map((child) => (child.stageLabel ? `${child.name}, ${child.stageLabel}` : child.name))
          .join(' · ');

  return (
    <>
      <h1 className={styles.h1}>{firstName ? `Hi, ${firstName}` : 'Hi'}</h1>
      <div className={styles.grid}>
        <div className={styles.col}>
          <section className={styles.card}>
            <span className={styles.tag}>Waiting on you</span>
            {waiting ? (
              <WaitingAsk approval={waiting} />
            ) : (
              <p className={styles.text}>All caught up</p>
            )}
          </section>
          <section className={styles.card}>
            <span className={styles.tag}>Lately</span>
            {lately.length > 0 ? (
              <div className={styles.thread}>
                {lately.map((row) =>
                  row.kind === 'did' ? (
                    <span key={row.id} className={styles.did}>
                      <span data-hale-pii>{row.text}</span>
                    </span>
                  ) : (
                    <div key={row.id}>
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
            ) : (
              <p className={styles.text}>Nothing here yet. Text Hale and it shows up here.</p>
            )}
            <Link href="/messages" className={`${styles.primary} ${styles.block}`}>
              See all messages
            </Link>
          </section>
        </div>
        <div className={styles.col}>
          <section className={styles.card}>
            <span className={styles.tag}>Your setup</span>
            <SetupRow
              href="/settings/connections"
              icon={<Mail aria-hidden="true" />}
              title="Connections"
              meta={`Gmail ${gmail ? 'on' : 'off'} · Calendar ${calendar ? 'on' : 'off'}`}
            />
            <SetupRow
              href="/settings/texts"
              icon={<MessageCircle aria-hidden="true" />}
              title="Texts from Hale"
              meta={quiet}
            />
            <SetupRow
              href="/family"
              icon={<UsersRound aria-hidden="true" />}
              title="Family"
              meta={kids}
            />
            <SetupRow
              href="/settings/plan"
              icon={<Sparkles aria-hidden="true" />}
              title="Plan"
              meta="Founding family"
            />
            <SetupRow
              href="/settings/privacy"
              icon={<Shield aria-hidden="true" />}
              title="Privacy & data"
              meta="Export or delete"
            />
          </section>
          <section className={styles.card}>
            <h2>Hale lives in your texts</h2>
            <p className={styles.text}>
              Ask, forward a flyer or change a reminder there. This page is for settings and
              history.
            </p>
            {smsHref ? (
              <a href={smsHref} className={`${styles.primary} ${styles.block}`}>
                <MessageCircle aria-hidden="true" />
                Text Hale
              </a>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}

function WaitingAsk({ approval }: { approval: PendingApprovalView }) {
  const previewId = previewIdFor(approval.id);
  const canApprove =
    approval.verdict === 'approved' && !approval.teenRedacted && !approval.teenUnlockable;
  return (
    <div className={styles.ask}>
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

function SetupRow({
  href,
  icon,
  title,
  meta,
}: {
  href:
    | '/settings/connections'
    | '/settings/texts'
    | '/family'
    | '/settings/plan'
    | '/settings/privacy';
  icon: ReactNode;
  title: string;
  meta: string;
}) {
  return (
    <Link href={href} className={styles.row}>
      <span className={styles.tile}>{icon}</span>
      <span>
        <h3>{title}</h3>
        <p className={styles.meta} data-hale-pii>
          {meta}
        </p>
      </span>
      <span className={styles.end}>
        <ChevronRight className={styles.go} aria-hidden="true" />
      </span>
    </Link>
  );
}
