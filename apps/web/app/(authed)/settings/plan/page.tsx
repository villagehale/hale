import {
  CHECKOUT_REGION_UNSUPPORTED_MESSAGE,
  currencyFromIpCountry,
  resolveBlackFridayNow,
  serverCheckoutCurrency,
} from '@hale/types';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { PortalHeading } from '~/components/portal/heading';
import { FoundingPlan, PaidPlan, PlanOffer } from '~/components/portal/plan-cards';
import styles from '~/components/portal/portal.module.css';
import { checkoutServerCurrencyEnabled } from '~/lib/billing/flags';
import { chargedAnnualLabel } from '~/lib/billing/prices';
import { unpaidPlanSurface } from '~/lib/billing/promo-access';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { currentFamilyId } from '~/lib/family';

export const metadata: Metadata = { title: 'Plan' };

export default async function SettingsPlanPage() {
  const basics = await loadFamilyBasics();
  const familyId = await currentFamilyId();
  const country = (await headers()).get('x-vercel-ip-country');
  const currency = checkoutServerCurrencyEnabled()
    ? serverCheckoutCurrency(country)
    : currencyFromIpCountry(country);
  const now = resolveBlackFridayNow({ now: new Date(), env: process.env });
  const surface = unpaidPlanSurface(familyId, now);

  const card =
    basics.planTier === 'plus' || basics.planTier === 'family' ? (
      <PaidPlan tier={basics.planTier} />
    ) : currency && (surface === 'founding' || surface === 'list') ? (
      <PlanOffer
        currency={currency}
        surface={surface}
        plusLabel={chargedAnnualLabel({ tier: 'plus', currency, now })}
        maxLabel={chargedAnnualLabel({ tier: 'family', currency, now })}
      />
    ) : !currency && (surface === 'founding' || surface === 'list') ? (
      <section className={styles.card}>
        <p className={styles.text}>{CHECKOUT_REGION_UNSUPPORTED_MESSAGE}</p>
      </section>
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
