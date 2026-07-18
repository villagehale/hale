import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import type { ChildCompanionView, MobileCompanionResponse, UpcomingHealthItem } from '@/lib/api-types';
import { duePhrase } from '@/lib/format';
import { immunizationView } from '@/lib/immunizations';
import { STUB_IMMUNIZATION_RECORD } from '@/lib/stub-data';
import { useApi } from '@/lib/use-api';

const PROVIDER_LINE = 'Timing is the standard Canadian schedule — confirm with your provider or local public health.';

/** The green "Up to date — great job!" banner (handoff). Shows ONLY when the
 * age-derived schedule has no overdue immunization — the copy stays honest by
 * saying exactly that (schedule-derived, not a claim the child received any shot). */
function UpToDateBanner({ name }: { name: string | null }) {
  const check = useMeadowColor('onAccent');
  return (
    <View className="flex-row items-center gap-3 rounded-[18px] bg-chip-green px-4 py-3.5">
      <View className="h-[34px] w-[34px] items-center justify-center rounded-full bg-sage">
        <Icon name="check" size={17} color={check} />
      </View>
      <View className="flex-1">
        <AppText className="text-[14px] text-sage" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
          Up to date — great job!
        </AppText>
        <AppText variant="meta" className="text-sage">
          Nothing is overdue on the standard schedule for {name ?? 'your child'}&rsquo;s age.
        </AppText>
      </View>
    </View>
  );
}

/** The not-up-to-date state: an honest attention card listing the immunizations whose
 * scheduled age has passed, each opening the shared appointment route to add-to-calendar
 * or mark done. No green banner while anything is overdue (brief). */
function OverdueCard({ items, childId }: { items: UpcomingHealthItem[]; childId: string }) {
  const chevron = useMeadowColor('ink3');
  return (
    <View className="gap-2.5">
      <View className="flex-row items-center gap-3 rounded-[18px] bg-berry-tint px-4 py-3.5">
        <TintChip icon="shield" tone="red" />
        <View className="flex-1">
          <AppText className="text-[14px] text-berry" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
            {items.length === 1 ? '1 immunization may be overdue' : `${items.length} immunizations may be overdue`}
          </AppText>
          <AppText variant="meta" className="text-berry">
            Open a row to add it to your calendar or mark it done.
          </AppText>
        </View>
      </View>
      <Card className="gap-0 p-0">
        {items.map((item, i) => (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={`${item.what} — was due. Open to act.`}
            onPress={() => router.push(`/appointment/${item.key}?child=${childId}`)}
            className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${
              i === 0 ? '' : 'border-t border-rule'
            }`}
          >
            <View className="flex-1">
              <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                {item.what}
              </AppText>
              <AppText variant="meta" className="text-ink-3">
                was due
              </AppText>
            </View>
            <Icon name="chevron-right" size={15} color={chevron} />
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

function ImmunizationsBody({ child }: { child: ChildCompanionView }) {
  const chevron = useMeadowColor('ink3');
  const { upToDate, overdue, nextDue } = immunizationView(child);

  return (
    <>
      {upToDate ? <UpToDateBanner name={child.name} /> : <OverdueCard items={overdue} childId={child.id} />}

      {/* Next due — real, age-derived. Tappable into the shared appointment route so
          the parent can add-to-calendar / mark done, reusing the shipped path. */}
      {nextDue ? (
        <Card onPress={() => router.push(`/appointment/${nextDue.key}?child=${child.id}`)} className="flex-row items-center gap-3">
          <TintChip icon="shield-check" tone="blue" />
          <View className="flex-1">
            <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
              Next due
            </AppText>
            <AppText variant="meta" className="text-ink-3">
              {nextDue.what} · {duePhrase(nextDue.dueInWeeks)}
            </AppText>
          </View>
          <Icon name="chevron-right" size={15} color={chevron} />
        </Card>
      ) : (
        <Card className="gap-1">
          <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            No immunizations coming up
          </AppText>
          <AppText variant="meta" className="text-ink-3">
            Nothing is left on the routine childhood immunization schedule.
          </AppText>
        </Card>
      )}

      {/* Record — a DISCLOSED SAMPLE. Hale has no per-child immunization record store,
          so this lists the routine vaccines (no fabricated dates) and points to the
          real Documents vault for the child's actual record. */}
      <View className="gap-2.5">
        <AppText variant="eyebrow">Record · sample</AppText>
        <Card className="gap-0 p-0">
          {STUB_IMMUNIZATION_RECORD.map((entry, i) => (
            <View
              key={entry.vaccine}
              className={`flex-row items-center justify-between gap-3 px-4 py-3 ${
                i === 0 ? '' : 'border-t border-hairline'
              }`}
            >
              <AppText className="text-[13.5px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                {entry.vaccine}
              </AppText>
              <AppText variant="meta" className="text-caption">
                {entry.protects}
              </AppText>
            </View>
          ))}
        </Card>
        <AppText variant="meta" className="text-caption">
          Sample list of routine vaccines — not {child.name ?? 'your child'}&rsquo;s record. Hale doesn&rsquo;t store
          immunization records yet; keep the real one in Documents.
        </AppText>
      </View>

      <AppText variant="meta" className="mt-1 text-ink-3">
        {PROVIDER_LINE}
      </AppText>
    </>
  );
}

/**
 * The Immunizations detail page (handoff), reached from the Companion Health tab. The
 * green "Up to date" banner, the Next-due row, and any overdue rows are REAL and
 * age-derived from the SAME companion health schedule the Health tab renders (teen
 * redaction is server-side on that read). The Record card is a clearly-disclosed
 * SAMPLE — there is no per-child immunization-record entity. Reads /api/mobile/companion
 * and selects the child by the `child` param, defaulting to the first child; a missing
 * child renders an honest empty state (deep-link safety).
 */
export default function ImmunizationsScreen() {
  const { child } = useLocalSearchParams<{ child?: string }>();
  const { status, data, error, reload } = useApi<MobileCompanionResponse>('/api/mobile/companion');
  const childView =
    (child ? data?.children.find((c) => c.id === child) : data?.children[0]) ?? data?.children[0] ?? null;

  return (
    <Screen scroll className="gap-4">
      <DetailHeader title="Immunizations" />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && childView ? <ImmunizationsBody child={childView} /> : null}
      {status === 'ready' && !childView ? (
        <Card className="mt-2 items-center gap-2 py-10">
          <AppText variant="title">No children yet</AppText>
          <AppText variant="meta" className="text-center">
            Add a child in Family and their immunization schedule will appear here.
          </AppText>
        </Card>
      ) : null}
    </Screen>
  );
}
