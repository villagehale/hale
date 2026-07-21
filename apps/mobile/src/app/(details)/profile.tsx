import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import type { FamilyLocationView, MobileFamilyResponse } from '@/lib/api-types';
import { useApi } from '@/lib/use-api';

/** The signed-in parent's initial for the avatar disc — Hale has no uploaded photos,
 * so an initial stands in (mirrors the More profile card). */
function avatarInitial(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || '';
  return source.charAt(0).toUpperCase() || '?';
}

/** The family's coarse home area (city / province) — never a precise address (rule #1). */
function coarseArea(location: FamilyLocationView): string {
  const parts = [location.city, location.province].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Not set';
}

/** One label/value row in the info card. `value` is real account data; a row is only
 * rendered when Hale actually has the value (no fabricated phone number, rule #1). */
function InfoRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View className={`flex-row items-center justify-between gap-3 px-4 py-3.5 ${last ? '' : 'border-b border-hairline'}`}>
      <AppText className="text-[13.5px] text-ink-3" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        {label}
      </AppText>
      <AppText className="flex-1 text-right text-[13.5px] text-ink" numberOfLines={1} style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
        {value}
      </AppText>
    </View>
  );
}

function ProfileBody({ data }: { data: MobileFamilyResponse }) {
  const accentText = useMeadowColor('onAccent');
  const chevron = useMeadowColor('ink3');
  const { viewer, basics } = data;
  const name = viewer.name?.trim() || viewer.email?.trim() || 'You';

  return (
    <>
      <View className="items-center gap-2.5 py-2">
        <View className="h-[76px] w-[76px] items-center justify-center overflow-hidden rounded-full bg-accent">
          <AppText className="text-[28px]" style={{ color: accentText, fontFamily: 'SourceSerif4_600SemiBold' }}>
            {avatarInitial(viewer.name, viewer.email)}
          </AppText>
          {viewer.image ? (
            <Image
              source={{ uri: viewer.image }}
              accessibilityIgnoresInvertColors
              contentFit="cover"
              style={{ position: 'absolute', width: 76, height: 76 }}
            />
          ) : null}
        </View>
        <View className="items-center">
          <AppText variant="title">{name}</AppText>
          <AppText variant="meta" className="text-caption">
            Primary parent
          </AppText>
        </View>
      </View>

      {/* Real account data only — Email + the coarse Home area. No Phone row: Hale has
          no phone number on file, and a fabricated one would be dishonest (rule #1). */}
      <Card className="gap-0 p-0">
        {viewer.email ? <InfoRow label="Email" value={viewer.email} /> : null}
        <InfoRow label="Home area" value={coarseArea(basics.location)} last />
      </Card>

      <Card className="gap-0 p-0">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Family — parents, children and area"
          onPress={() => router.push('/family')}
          className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-80"
        >
          <TintChip icon="users" tone="blue" />
          <View className="flex-1">
            <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
              Family
            </AppText>
            <AppText variant="meta" className="text-caption">
              Parents, children &amp; area
            </AppText>
          </View>
          <Icon name="chevron-right" size={15} color={chevron} />
        </Pressable>
      </Card>

      {/* Editing lives in Family (the parent-name form persists there); "Edit profile"
          routes to it rather than shipping a dead button. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Edit profile"
        onPress={() => router.push('/family')}
        className="min-h-12 items-center justify-center rounded-[15px] border border-rule bg-card active:opacity-80"
      >
        <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          Edit profile
        </AppText>
      </Pressable>
    </>
  );
}

/**
 * Profile (handoff), reached from the More profile card. Photo slot (an initial disc —
 * no uploaded photos exist), the parent's serif name, and a real info card (Email +
 * coarse Home area from /api/mobile/family; Phone is omitted — Hale has no such field).
 * A Family row and Edit-profile both route to Family, where the parent-name edit lives.
 */
export default function ProfileScreen() {
  const { status, data, error, reload } = useApi<MobileFamilyResponse>('/api/mobile/family');

  return (
    <Screen scroll className="gap-4">
      <DetailHeader title="Profile" />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <ProfileBody data={data} /> : null}
    </Screen>
  );
}
