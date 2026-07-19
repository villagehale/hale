import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import type { MobilePlanTiersResponse, PlanCatalogView, PlanTierView } from '@/lib/api-types';
import { useApi } from '@/lib/use-api';

/**
 * Compare plans (handoff), reached from Plan & benefits. The family's CURRENT tier +
 * what every tier includes, from the server plan catalog (derived from @hale/types —
 * never hardcoded). Honest posture: billing isn't wired, so there is NO upgrade /
 * checkout button — the paid tiers are shown for context with a calm "coming soon"
 * note, matching the actual entitlement posture (Free drafts for approval; autonomous
 * execution is a paid entitlement, not unlocked on Free).
 */
function TierCard({
  view,
  isCurrent,
  billingConfigured,
}: {
  view: PlanTierView;
  isCurrent: boolean;
  billingConfigured: boolean;
}) {
  const check = useMeadowColor('ink2');
  // Paid tiers read "Coming soon" only while billing is dormant. Once it's live
  // the honest tag is "On the web" (checkout is web-only — Apple IAP policy), never
  // a native purchase affordance.
  const paidTag = billingConfigured ? 'On the web' : 'Coming soon';
  return (
    <Card raised={isCurrent} className="gap-2">
      <View className="flex-row items-center justify-between gap-3">
        <AppText variant="title">{view.name}</AppText>
        {isCurrent ? (
          <Tag label="Your plan" tone="done" />
        ) : view.isFree ? null : (
          <Tag label={paidTag} tone="neutral" />
        )}
      </View>
      <AppText variant="mono" className="text-ink-3">
        {view.isFree ? view.monthlyPrice : `${view.monthlyPrice} · ${view.annualPrice}`}
      </AppText>
      <AppText variant="meta">{view.tagline}</AppText>
      <View className="mt-1 gap-1.5">
        {view.features.map((feature) => (
          <View key={feature} className="flex-row items-start gap-2">
            <View className="mt-0.5">
              <Icon name="circle-check" size={15} color={check} />
            </View>
            <AppText variant="body" className="flex-1 text-ink-2">
              {feature}
            </AppText>
          </View>
        ))}
      </View>
    </Card>
  );
}

function introCopy(catalog: PlanCatalogView): string {
  const onFree = catalog.currentTier === 'free';
  // Checkout is WEB-ONLY (Apple IAP forbids a native app opening a Stripe web
  // checkout for digital goods) — so even when billing is live we point to the web,
  // never a purchase link here.
  if (catalog.billingConfigured) {
    return onFree
      ? "You're on Free — Hale drafts and you approve. To move to a paid plan, manage your plan on the web."
      : "Here's your plan and what each tier includes. Manage your plan on the web.";
  }
  return onFree
    ? "You're on Free — Hale drafts and you approve. Paid plans are coming soon; there's nothing to buy yet."
    : "Here's your plan and what each tier includes.";
}

function CompareBody({ catalog }: { catalog: PlanCatalogView }) {
  return (
    <>
      <AppText variant="meta">{introCopy(catalog)}</AppText>
      {catalog.tiers.map((view) => (
        <TierCard
          key={view.tier}
          view={view}
          isCurrent={view.tier === catalog.currentTier}
          billingConfigured={catalog.billingConfigured}
        />
      ))}
    </>
  );
}

export default function PlanCompareScreen() {
  const { status, data, error, refreshing, reload, refresh } = useApi<MobilePlanTiersResponse>(
    '/api/mobile/plan-tiers',
  );

  return (
    <Screen scroll className="gap-4" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <DetailHeader title="Compare plans" />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <CompareBody catalog={data.catalog} /> : null}
    </Screen>
  );
}
