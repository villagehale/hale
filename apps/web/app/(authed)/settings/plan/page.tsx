import type { Metadata } from 'next';
import { PortalHeading } from '~/components/portal/heading';
import { FoundingPlan } from '~/components/portal/plan-cards';
import styles from '~/components/portal/portal.module.css';

export const metadata: Metadata = { title: 'Plan' };

export default function SettingsPlanPage() {
  return (
    <>
      <PortalHeading back title="Plan" lede="What your family is on." />
      <div className={styles.one}>
        <FoundingPlan />
      </div>
    </>
  );
}
