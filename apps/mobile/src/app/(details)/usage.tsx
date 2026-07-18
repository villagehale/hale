import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Screen } from '@/components/ui/screen';
import { TintChip } from '@/components/ui/tint-chip';
import type { MobileFamilyResponse } from '@/lib/api-types';
import { STUB_USAGE_ACTIVITY, STUB_USAGE_STORAGE } from '@/lib/stub-data';
import { useApi } from '@/lib/use-api';

/** The real number of people in the family: both parents (when present) + every
 * child. This is the ONE genuinely-real figure on the Usage page — everything else is
 * a disclosed sample. */
function memberCount(data: MobileFamilyResponse): number {
  const parents = (data.members.primary ? 1 : 0) + (data.members.coParent ? 1 : 0);
  return parents + data.basics.children.length;
}

/** The sample "this month" activity card (Actions / Emails / Events). Disclosed as a
 * sample in its eyebrow — Hale has no usage metering, so these counts are illustrative. */
function ActivitySample() {
  return (
    <View className="gap-2.5">
      <AppText variant="eyebrow">This month · sample</AppText>
      <Card className="gap-0 p-0">
        {STUB_USAGE_ACTIVITY.map((row, i) => (
          <View
            key={row.label}
            className={`flex-row items-center gap-3 px-4 py-3.5 ${
              i === 0 ? '' : 'border-t border-hairline'
            }`}
          >
            <TintChip icon={row.icon} tone={row.tone} />
            <AppText className="flex-1 text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
              {row.label}
            </AppText>
            <View className="items-end">
              <AppText className="text-[15px] text-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
                {row.count}
              </AppText>
              {row.cap ? (
                <AppText variant="meta" className="text-caption">
                  {row.cap}
                </AppText>
              ) : null}
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}

/** The real family-members row — a live count from /api/mobile/family, with no
 * fabricated cap (there is no enforced member limit, so no progress bar that would
 * imply one). Renders quietly until the read lands. */
function FamilyReal() {
  const { status, data } = useApi<MobileFamilyResponse>('/api/mobile/family');
  if (status !== 'ready' || !data) return null;
  const count = memberCount(data);
  return (
    <View className="gap-2.5">
      <AppText variant="eyebrow">Your family</AppText>
      <Card className="flex-row items-center gap-3">
        <TintChip icon="users" tone="green" />
        <AppText className="flex-1 text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {count === 1 ? 'Person in your family' : 'People in your family'}
        </AppText>
        <AppText className="text-[15px] text-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
          {count}
        </AppText>
      </Card>
    </View>
  );
}

/** The sample document-storage meter (illustrative — no real storage cap is enforced). */
function StorageSample() {
  return (
    <View className="gap-2.5">
      <AppText variant="eyebrow">Storage · sample</AppText>
      <Card className="gap-2">
        <View className="flex-row items-center justify-between">
          <AppText className="text-[13.5px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            Document storage
          </AppText>
          <AppText variant="meta" className="text-caption">
            {STUB_USAGE_STORAGE.usedLabel} of {STUB_USAGE_STORAGE.limitLabel}
          </AppText>
        </View>
        <View className="h-2 overflow-hidden rounded-full bg-hairline">
          <View
            className="h-full rounded-full bg-brand"
            style={{ width: `${Math.round(STUB_USAGE_STORAGE.fraction * 100)}%` }}
          />
        </View>
      </Card>
    </View>
  );
}

/**
 * Usage (handoff), reached from Plan & benefits. HONESTY SPLIT:
 *  - "This month" activity (actions / emails / events) and "Storage" are DISCLOSED
 *    SAMPLES (STUB_USAGE_*) — Hale has no usage-metering backend and enforces no plan
 *    limit, so these figures are illustrative and labelled "sample".
 *  - "Your family" is REAL — a live member count from /api/mobile/family.
 * The footnote states Hale's approval-first invariant as a general product truth (not
 * a claim that the sample counts are real actions), keeping the sample honest.
 */
export default function UsageScreen() {
  return (
    <Screen scroll className="gap-4">
      <DetailHeader title="Usage" />

      <ActivitySample />
      <FamilyReal />
      <StorageSample />

      <AppText variant="meta" className="mt-1 text-center text-caption">
        The activity and storage figures above are a sample — Hale doesn&rsquo;t meter your usage yet.
        Whatever Hale does do, it asks you first: it never acts on its own.
      </AppText>
    </Screen>
  );
}
