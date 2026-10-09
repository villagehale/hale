import { PortalHeading } from '~/components/portal/heading';
import { FoundingPlan } from '~/components/portal/plan-cards';
import styles from '~/components/portal/portal.module.css';
import { DEMO_BASE } from '~/lib/portal/demo-fixture';

export default function DemoPlanPage() {
  return (
    <>
      <PortalHeading back basePath={DEMO_BASE} title="Plan" lede="What your family is on." />
      <div className={styles.one}>
        <FoundingPlan />
      </div>
    </>
  );
}
