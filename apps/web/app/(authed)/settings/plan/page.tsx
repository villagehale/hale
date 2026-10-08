import { redirect } from 'next/navigation';
import { PortalHeading } from '~/components/portal/heading';
import { PlanCards } from '~/components/portal/plan-cards';
import styles from '~/components/portal/portal.module.css';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';

export default async function SettingsPlanPage() {
  if (!receiptsIaEnabled()) redirect('/settings#plan');

  const basics = await loadFamilyBasics();
  return (
    <>
      <PortalHeading back title="Plan" lede="What your family is on." />
      <div className={styles.one}>
        <PlanCards tier={basics.planTier} />
      </div>
    </>
  );
}
