import { Linking, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import {
  CHILDCARE_RESOURCE_CATEGORY,
  type CuratedResourceView,
  type MobileVillageResponse,
} from '@/lib/api-types';
import { STUB_CHILDCARE, type StubChildcareProvider } from '@/lib/stub-data';
import { useApi } from '@/lib/use-api';

/** A real childcare row — a curated public program (EarlyON), opening its official
 * page in the browser (mirrors the Resources rail). Curated resources are
 * family-agnostic with a COARSE service area only — never an exact address (rule #1). */
function ChildcareResourceRow({ resource, last }: { resource: CuratedResourceView; last: boolean }) {
  const iconColor = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${resource.name}, opens in your browser`}
      onPress={() => {
        Linking.openURL(resource.url).catch(() => {
          // A failed open is a no-op — the row is a directory link, not an action.
        });
      }}
      className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${
        last ? '' : 'border-b border-hairline'
      }`}
    >
      <TintChip icon="house" tone="blue" />
      <View className="flex-1">
        <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {resource.name}
        </AppText>
        <AppText variant="meta" numberOfLines={1} className="text-caption">
          {resource.area}
        </AppText>
      </View>
      <Icon name="square-arrow-out-up-right" size={17} color={iconColor} />
    </Pressable>
  );
}

/** A childcare capacity badge — the prototype's Accepting / Waitlist stamp (same
 * tones as the Village tab's ChildcareSection). */
function ChildcareBadge({ status }: { status: StubChildcareProvider['status'] }) {
  return status === 'accepting' ? (
    <Tag label="Accepting" tone="done" />
  ) : (
    <Tag label="Waitlist" tone="accent" />
  );
}

/**
 * The Childcare Options page (handoff), reached from the Village tab. Two clearly
 * separated, honestly-sourced sections:
 *  - "Near you": REAL curated childcare programs (EarlyON centres). The read is
 *    narrowed to the childcare category SERVER-SIDE (the ?category= param), so the
 *    page receives only childcare rows — no client-side category filter, no mobile
 *    copy of the category string. These open the official page in the browser.
 *    Curated resources are family-agnostic and carry a coarse area only, so there is
 *    no teen-attributable content to redact (rule #1 is satisfied by construction).
 *  - "Sample availability": the Task-8 stub providers with Accepting/Waitlist badges.
 *    Hale has no live childcare-capacity feed, so these are disclosed as sample —
 *    never presented as real openings, and carrying no fabricated distances/ratings.
 *
 * NOTE (data-source correction): the brief named `village_candidates kind='childcare'`
 * as the row source, but childcare is NOT a candidate kind on the real backend — the
 * web board hides all candidates under "childcare" and models childcare as this
 * curated-resource category. Built against reality; flagged to the lead.
 */
function ChildcareBody({ data }: { data: MobileVillageResponse }) {
  // The server already narrowed the Resources rail to the childcare category.
  const real = data.resources ?? [];

  return (
    <>
      <Card className="gap-3">
        <View className="flex-row items-center gap-3">
          <TintChip icon="house" tone="blue" size={42} />
          <View className="flex-1">
            <AppText className="text-[16px] text-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
              Childcare Options
            </AppText>
            <AppText variant="meta" className="text-caption">
              Licensed centres &amp; home care
            </AppText>
          </View>
        </View>
        <AppText variant="body">
          Verified local childcare programs near you. Live openings and waitlist status aren&rsquo;t connected
          yet — the sample below shows how they&rsquo;ll appear.
        </AppText>
      </Card>

      {real.length > 0 ? (
        <View className="gap-2.5">
          <AppText variant="eyebrow">Near you</AppText>
          <View className="overflow-hidden rounded-[20px] border border-rule bg-card">
            {real.map((resource, i) => (
              <ChildcareResourceRow key={resource.id} resource={resource} last={i === real.length - 1} />
            ))}
          </View>
        </View>
      ) : null}

      <View className="gap-2.5">
        <AppText variant="eyebrow">Sample availability</AppText>
        <View className="overflow-hidden rounded-[20px] border border-rule bg-card">
          {STUB_CHILDCARE.map((provider, i) => (
            <View
              key={provider.name}
              className={`flex-row items-center gap-3 px-4 py-3.5 ${
                i === STUB_CHILDCARE.length - 1 ? '' : 'border-b border-hairline'
              }`}
            >
              <View className="flex-1">
                <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                  {provider.name}
                </AppText>
                <AppText variant="meta" className="text-caption">
                  {provider.kind}
                </AppText>
              </View>
              <ChildcareBadge status={provider.status} />
            </View>
          ))}
        </View>
        <AppText variant="meta" className="text-caption">
          Sample listings — not real openings. Hale&rsquo;s live childcare search &amp; capacity feed is coming.
        </AppText>
      </View>

      <AppText variant="meta" className="mt-1 text-center text-ink-3">
        Recommendations use your coarse area only — never your exact address. Data stays in Canada.
      </AppText>
    </>
  );
}

export default function ChildcareScreen() {
  const { status, data, error, refreshing, reload, refresh } = useApi<MobileVillageResponse>(
    `/api/mobile/village?category=${encodeURIComponent(CHILDCARE_RESOURCE_CATEGORY)}`,
    { refetchOnFocus: true },
  );

  return (
    <Screen scroll className="gap-4" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <DetailHeader title="Childcare Options" />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <ChildcareBody data={data} /> : null}
    </Screen>
  );
}
