import { ChevronRight, Mail, MessageCircle, Phone, Shield, Sparkles } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOutAction } from '~/lib/auth-actions';
import { AppearanceCard } from './appearance';
import { PortalHeading } from './heading';
import { NameEditor } from './name-editor';
import { portalHref } from './portal-href';
import styles from './portal.module.css';
import { SettingsHashRedirect } from './settings-hash';

export function SettingsIndex({
  gmailOn,
  calendarOn,
  name,
  maskedPhone,
  canSignOut,
  basePath = '',
  signOutTo,
}: {
  gmailOn: boolean;
  calendarOn: boolean;
  name: string | null;
  maskedPhone: string | null;
  canSignOut: boolean;
  basePath?: string;
  /** Demo sign-out target. The real portal uses the session action instead. */
  signOutTo?: string;
}) {
  const phoneMeta = maskedPhone ? `${maskedPhone} · how you sign in` : 'how you sign in';
  return (
    <>
      <SettingsHashRedirect />
      <PortalHeading title="Settings" />
      <div className={styles.one}>
        <section className={styles.card}>
          <Row
            basePath={basePath}
            href="/settings/connections"
            icon={<Mail aria-hidden="true" />}
            title="Connections"
            meta={`Gmail ${gmailOn ? 'on' : 'off'} · Calendar ${calendarOn ? 'on' : 'off'}`}
          />
          <Row
            basePath={basePath}
            href="/settings/texts"
            icon={<MessageCircle aria-hidden="true" />}
            title="Texts from Hale"
            meta="What Hale sends and when"
          />
          <Row
            basePath={basePath}
            href="/settings/plan"
            icon={<Sparkles aria-hidden="true" />}
            title="Plan"
            meta="Founding family"
          />
          <Row
            basePath={basePath}
            href="/settings/privacy"
            icon={<Shield aria-hidden="true" />}
            title="Privacy & data"
            meta="Export, consents, delete"
          />
        </section>
        <section className={styles.card}>
          <span className={styles.tag}>You</span>
          <NameEditor name={name} />
          <div className={styles.row}>
            <span className={styles.tile}>
              <Phone aria-hidden="true" />
            </span>
            <span>
              <h3>Mobile number</h3>
              <p className={styles.meta} data-hale-pii>
                {phoneMeta}
              </p>
            </span>
          </div>
        </section>
        <AppearanceCard />
        {signOutTo ? (
          <div className={styles.mobileOut}>
            <Link href={portalHref('', signOutTo)} className={styles.secondary}>
              Sign out
            </Link>
          </div>
        ) : canSignOut ? (
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
  basePath = '',
}: {
  href: '/settings/connections' | '/settings/texts' | '/settings/plan' | '/settings/privacy';
  icon: ReactNode;
  title: string;
  meta: string;
  basePath?: string;
}) {
  return (
    <Link href={portalHref(basePath, href)} className={styles.row}>
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
