import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PortalHeading } from '~/components/portal/heading';
import { FoundingPlan } from '~/components/portal/plan-cards';
import styles from '~/components/portal/portal.module.css';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';

export const metadata: Metadata = { title: 'Plan' };

export default function SettingsPlanPage() {
  if (!receiptsIaEnabled()) redirect('/settings#plan');

  return (
    <>
      <PortalHeading back title="Plan" lede="What your family is on." />
      <div className={styles.one}>
        <FoundingPlan />
      </div>
    </>
  );
}
