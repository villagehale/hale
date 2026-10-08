import type { PlanTier } from '@hale/types';
import { ChevronRight, Mail, MessageCircle, Shield, Sparkles } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOutAction } from '~/lib/auth-actions';
import { planName } from './format';
import { PortalHeading } from './heading';
import { NameEditor } from './name-editor';
import styles from './portal.module.css';
import { SettingsHashRedirect } from './settings-hash';

export function SettingsIndex({
  gmailOn,
  calendarOn,
  planTier,
  name,
  maskedPhone,
  canSignOut,
}: {
  gmailOn: boolean;
  calendarOn: boolean;
  planTier: PlanTier;
  name: string | null;
  maskedPhone: string | null;
  canSignOut: boolean;
}) {
  const phoneMeta = maskedPhone ? `${maskedPhone} · how you sign in` : 'how you sign in';
  return (
    <>
      <SettingsHashRedirect />
      <PortalHeading title="Settings" />
      <div className={styles.one}>
        <section className={`${styles.card} ${styles.span}`}>
          <Row
            href="/settings/connections"
            icon={<Mail aria-hidden="true" />}
            title="Connections"
            meta={`Gmail ${gmailOn ? 'on' : 'off'} · Calendar ${calendarOn ? 'on' : 'off'}`}
          />
          <Row
            href="/settings/texts"
            icon={<MessageCircle aria-hidden="true" />}
            title="Texts from Hale"
            meta="What Hale sends and when"
          />
          <Row
            href="/settings/plan"
            icon={<Sparkles aria-hidden="true" />}
            title="Plan"
            meta={planName(planTier)}
          />
          <Row
            href="/settings/privacy"
            icon={<Shield aria-hidden="true" />}
            title="Privacy & data"
            meta="Export, consents, delete"
          />
        </section>
        <section className={`${styles.card} ${styles.span}`}>
          <span className={styles.tag}>You</span>
          <NameEditor name={name} />
          <div className={styles.row}>
            <span className={styles.tile}>
              <MessageCircle aria-hidden="true" />
            </span>
            <span>
              <h3>Mobile number</h3>
              <p className={styles.meta} data-hale-pii>
                {phoneMeta}
              </p>
            </span>
          </div>
        </section>
        {canSignOut ? (
          <form action={signOutAction} className={styles.mobileOut}>
            <button type="submit" className={styles.secondary}>
              Sign out
            </button>
          </form>
        ) : null}
      </div>
    </>
  );
}

function Row({
  href,
  icon,
  title,
  meta,
}: {
  href: '/settings/connections' | '/settings/texts' | '/settings/plan' | '/settings/privacy';
  icon: ReactNode;
  title: string;
  meta: string;
}) {
  return (
    <Link href={href} className={styles.row}>
      <span className={styles.tile}>{icon}</span>
      <span>
        <h3>{title}</h3>
        <p className={styles.meta}>{meta}</p>
      </span>
      <span className={styles.end}>
        <ChevronRight className={styles.go} aria-hidden="true" />
      </span>
    </Link>
  );
}
