import { currencyFromIpCountry } from '@hale/types';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { PortalHeading } from '~/components/portal/heading';
import { FoundingPlan, PaidPlan, PlanOffer } from '~/components/portal/plan-cards';
import styles from '~/components/portal/portal.module.css';
import { unpaidPlanSurface } from '~/lib/billing/promo-access';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { currentFamilyId } from '~/lib/family';

export const metadata: Metadata = { title: 'Plan' };

export default async function SettingsPlanPage() {
  const basics = await loadFamilyBasics();
  const familyId = await currentFamilyId();
  const currency = currencyFromIpCountry((await headers()).get('x-vercel-ip-country'));
  const surface = unpaidPlanSurface(familyId, new Date());

  const card =
    basics.planTier === 'plus' || basics.planTier === 'family' ? (
      <PaidPlan tier={basics.planTier} />
    ) : surface === 'founding' || surface === 'list' ? (
      <PlanOffer currency={currency} surface={surface} />
    ) : (
      <FoundingPlan />
    );

  return (
    <>
      <PortalHeading back title="Plan" lede="What your family is on." />
      <div className={styles.one}>{card}</div>
    </>
  );
}
