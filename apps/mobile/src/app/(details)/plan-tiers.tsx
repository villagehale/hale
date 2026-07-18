import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { LogoMark } from '@/components/ui/logo-mark';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { useMeadowColor } from '@/constants/meadow';
import type { MobilePlanTiersResponse, PlanCatalogView, PlanTierView } from '@/lib/api-types';
import { useApi } from '@/lib/use-api';

/**
 * Plan & benefits (More → Plan & billing): the family's CURRENT tier as a navy card,
 * what that tier includes, and rows through to Billing, Usage, and a Compare-plans
 * page. Names / prices / features come from the server plan catalog (derived from the
 * @hale/types source of truth — never hardcoded). Honest posture: billing isn't wired
 * (launch is free-first), so there is NO "Manage plan" button and NO renewal date —
 * the prototype's "$12.99 · Renews …" is fiction. Real catalog wins on values; the
 * prototype wins on layout.
 */

/** The navy current-plan card — real tier name + price, with the brand mark. For the
 * free tier the sub-line is the tagline (a bare "Free" under "Free" reads oddly); a
 * paid tier shows its real monthly price. No renewal date is invented (no billing). */
function CurrentPlanCard({ view }: { view: PlanTierView }) {
  return (
    <View className="gap-3 rounded-[20px] bg-brand p-[18px]">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <AppText className="text-[17px] text-on-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
            {view.name}
          </AppText>
          <AppText className="mt-0.5 text-[12.5px] text-on-ink opacity-80" style={{ fontFamily: 'InstrumentSans_500Medium' }}>
            {view.isFree ? view.tagline : view.monthlyPrice}
          </AppText>
        </View>
        <LogoMark size={34} />
      </View>
    </View>
  );
}

/** One "Included in your plan" feature row — the current tier's real feature line. */
function IncludedList({ features }: { features: string[] }) {
  const check = useMeadowColor('ink2');
  return (
    <View className="gap-2.5">
      <AppText variant="eyebrow">Included in your plan</AppText>
      <Card className="gap-0 p-0">
        {features.map((feature, i) => (
          <View
            key={feature}
            className={`flex-row items-start gap-3 px-4 py-3 ${i === 0 ? '' : 'border-t border-hairline'}`}
          >
            <View className="mt-0.5">
              <Icon name="circle-check" size={15} color={check} />
            </View>
            <AppText className="flex-1 text-[13.5px] text-ink" style={{ fontFamily: 'InstrumentSans_500Medium' }}>
              {feature}
            </AppText>
          </View>
        ))}
      </Card>
    </View>
  );
}

/** A chevron navigation row inside the account-rows card (Billing / Usage). */
function NavRow({ label, onPress, last }: { label: string; onPress: () => void; last?: boolean }) {
  const chevron = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${last ? '' : 'border-b border-hairline'}`}
    >
      <AppText className="flex-1 text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        {label}
      </AppText>
      <Icon name="chevron-right" size={15} color={chevron} />
    </Pressable>
  );
}

function PlanBody({ catalog }: { catalog: PlanCatalogView }) {
  const current = catalog.tiers.find((t) => t.tier === catalog.currentTier) ?? catalog.tiers[0];
  if (!current) return null;
  return (
    <>
      <CurrentPlanCard view={current} />
      <IncludedList features={current.features} />

      <Card className="gap-0 p-0">
        <NavRow label="Billing & payments" onPress={() => router.push('/billing')} />
        <NavRow label="Usage" onPress={() => router.push('/usage')} last />
      </Card>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Compare plans"
        onPress={() => router.push('/plan-compare')}
        className="min-h-12 items-center justify-center rounded-[15px] border border-rule bg-card active:opacity-80"
      >
        <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          Compare plans
        </AppText>
      </Pressable>
    </>
  );
}

export default function PlanScreen() {
  const { status, data, error, refreshing, reload, refresh } = useApi<MobilePlanTiersResponse>(
    '/api/mobile/plan-tiers',
  );

  return (
    <Screen scroll className="gap-4" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <DetailHeader title="Plan & benefits" />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <PlanBody catalog={data.catalog} /> : null}
    </Screen>
  );
}
