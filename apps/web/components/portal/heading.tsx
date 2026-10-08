import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { portalHref } from './portal-href';
import styles from './portal.module.css';

export function PortalHeading({
  title,
  lede,
  back,
  basePath = '',
}: {
  title: string;
  lede?: string;
  back?: boolean;
  /** Prefix so a back crumb stays inside the seeded demo. */
  basePath?: string;
}) {
  return (
    <>
      {back ? (
        <Link href={portalHref(basePath, '/settings')} className={styles.crumb}>
          <ChevronLeft aria-hidden="true" />
          Settings
        </Link>
      ) : null}
      <h1 className={styles.h1}>{title}</h1>
      {lede ? <p className={styles.lede}>{lede}</p> : null}
    </>
  );
}
