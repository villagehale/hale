import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import styles from './portal.module.css';

export function PortalHeading({
  title,
  lede,
  back,
}: {
  title: string;
  lede?: string;
  back?: boolean;
}) {
  return (
    <>
      {back ? (
        <Link href="/settings" className={styles.crumb}>
          <ChevronLeft aria-hidden="true" />
          Settings
        </Link>
      ) : null}
      <h1 className={styles.h1}>{title}</h1>
      {lede ? <p className={styles.lede}>{lede}</p> : null}
    </>
  );
}
