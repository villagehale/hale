import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { currencyFromIpCountry } from '@hale/types';
import { PortalHeading } from '~/components/portal/heading';
import {
  FoundingPlan,
  ListPlan,
  PaidPlan,
  PromoOfferPlan,
} from '~/components/portal/plan-cards';
import styles from '~/components/portal/portal.module.css';
import { foundingPromoOpen } from '~/lib/billing/prices';
import { holidayPromoEnabled } from '~/lib/billing/flags';
import { loadFamilyBasics } from '~/lib/dashboard/queries';

export const metadata: Metadata = { title: 'Plan' };

export default async function SettingsPlanPage() {
  const basics = await loadFamilyBasics();
  const currency = currencyFromIpCountry((await headers()).get('x-vercel-ip-country'));
  const promo = holidayPromoEnabled();
  const windowOpen = foundingPromoOpen(new Date());

  const card =
    basics.planTier === 'plus' || basics.planTier === 'family' ? (
      <PaidPlan tier={basics.planTier} />
    ) : !promo ? (
      <FoundingPlan />
    ) : windowOpen ? (
      <PromoOfferPlan currency={currency} />
    ) : (
      <ListPlan currency={currency} />
    );

  return (
    <>
      <PortalHeading back title="Plan" lede="What your family is on." />
      <div className={styles.one}>{card}</div>
    </>
  );
}
