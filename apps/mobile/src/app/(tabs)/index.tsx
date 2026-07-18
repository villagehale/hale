import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon, type IconName } from '@/components/ui/icon';
import { LogoMark } from '@/components/ui/logo-mark';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { type LogKind, QuickLogModal } from '@/components/ui/quick-log-modal';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import type {
  ChildCompanionView,
  MobileHomeResponse,
  UpcomingHealthItem,
  VillageCandidateView,
} from '@/lib/api-types';
import { agePhrase, duePhrase } from '@/lib/format';
import { timeGreeting } from '@/lib/greeting';
import { homeStatCells, type StatCell } from '@/lib/home-stats';
import { useHasUnreadNotifs } from '@/lib/notif-dot';
import { useApi } from '@/lib/use-api';
import { rememberViewerFirstName } from '@/lib/viewer-name';

/** A calm forward line for the highlight card — the child's soonest checkup, else an
 * in-window milestone worth watching, else the stage's "what's next". */
function nextForChild(child: ChildCompanionView): string {
  const health = child.nextHealth[0];
  if (health) return health.dueInWeeks <= 0 ? `${health.what} — due now` : health.what;
  const milestone = child.milestones.find((m) => m.timing === 'in_window') ?? child.milestones[0];
  if (milestone) return `${milestone.what} — worth watching`;
  return child.whatsNext;
}

function firstVillageRec(candidates: VillageCandidateView[]): VillageCandidateView | null {
  return candidates.find((c) => !c.teenAttributed) ?? null;
}

/** The lead child's single most relevant upcoming health item for the Up-next row —
 * the soonest not-done item the companion "today" surface leads with, else the first
 * scheduled one. Null when nothing is upcoming (the row then hides). */
function leadHealth(child: ChildCompanionView): UpcomingHealthItem | null {
  return child.todayHealth ?? child.nextHealth[0] ?? null;
}

/** "Good evening, Alex" — the time-of-day phrase warmed with the SIGNED-IN parent's
 * first name (the viewer, so a co-parent sees their own). Falls back to the bare
 * phrase for a name-less account. */
function homeGreeting(viewer: MobileHomeResponse['viewer']): string {
  const firstName = viewer.name?.trim().split(/\s+/)[0];
  return firstName ? `${timeGreeting()}, ${firstName}` : timeGreeting();
}

/** A concise, honest one-liner under a Village row — its category, warmed with the
 * family-endorsement count when there is one. The prototype's date/time/distance line
 * has no home-payload source, so this surfaces only what the candidate carries. */
function villageLine(rec: VillageCandidateView): string {
  return rec.endorsementCount > 0
    ? `${rec.kind} · endorsed by ${rec.endorsementCount} families`
    : rec.kind;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <AppText variant="eyebrow">
      {children}
    </AppText>
  );
}

/** The greeting-row bell: navigates to Notifications, with a client-side unread dot
 * that persists until the Notifications page marks all read (Task 12). */
function NotifBell() {
  const hasUnread = useHasUnreadNotifs();
  const iconColor = useMeadowColor('ink');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hasUnread ? 'Notifications, unread' : 'Notifications'}
      onPress={() => router.push('/notifications')}
      className="relative p-1 active:opacity-70"
    >
      <Icon name="bell" size={22} color={iconColor} />
      {hasUnread ? (
        <View className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive" />
      ) : null}
    </Pressable>
  );
}

/** A Quick-actions tile: a bordered white square with a centered outline icon over a
 * label. The Milestone star earns the scarce apricot tint (matching the quick-log
 * Pill); every other glyph is ink. */
function QuickActionTile({
  icon,
  label,
  accent = false,
  onPress,
}: {
  icon: IconName;
  label: string;
  accent?: boolean;
  onPress: () => void;
}) {
  const inkIcon = useMeadowColor('ink');
  const accentIcon = useMeadowColor('accentFill');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="flex-1 items-center gap-2 rounded-[16px] border border-rule bg-card px-1 py-3.5 active:opacity-80"
    >
      <Icon name={icon} size={18} color={accent ? accentIcon : inkIcon} />
      <AppText
        variant="meta"
        numberOfLines={1}
        className="text-[12px] text-ink"
        style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

/** The child's initial in a filled navy circle — the app's avatar idiom (no uploaded
 * photos), matching the companion child chip. */
function ChildAvatar({ name }: { name: string | null }) {
  const initial = (name ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <View className="h-11 w-11 items-center justify-center rounded-full bg-ink">
      <AppText variant="title" className="text-on-ink">
        {initial}
      </AppText>
    </View>
  );
}

/** One honest snapshot stat: a bold count over its label, or — when there's no data
 * yet — the calm zero phrase alone (never a fake "0"). */
function SnapshotStat({ cell }: { cell: StatCell }) {
  return (
    <View className="flex-1 items-center gap-1">
      {cell.count !== null ? (
        <AppText
          className="text-[17px] leading-[22px] text-ink"
          style={{ fontFamily: 'InstrumentSans_700Bold' }}
        >
          {cell.count}
        </AppText>
      ) : null}
      <AppText
        variant="meta"
        numberOfLines={2}
        className="text-center text-[11px] leading-[14px] text-ink-3"
      >
        {cell.label}
      </AppText>
    </View>
  );
}

function HomeBody({
  data,
  onLogged,
}: {
  data: MobileHomeResponse;
  onLogged: () => void;
}) {
  const rec = firstVillageRec(data.village.candidates);
  const [logKind, setLogKind] = useState<LogKind | null>(null);
  const leadChild = data.children[0] ?? null;
  const upNext = leadChild ? leadHealth(leadChild) : null;
  const greeting = homeGreeting(data.viewer);
  const askIcon = useMeadowColor('brand');
  const micIcon = useMeadowColor('ink3');
  const chevron = useMeadowColor('ink3');
  const creamChevron = useMeadowColor('ink');
  rememberViewerFirstName(data.viewer.name);

  return (
    <>
      <View className="gap-1 pt-2">
        <View className="flex-row items-start justify-between">
          <AppText variant="display" className="flex-1 pr-3">
            {greeting}
          </AppText>
          <NotifBell />
        </View>
        <AppText variant="meta" className="text-ink-3">
          Here&rsquo;s what&rsquo;s happening today.
        </AppText>
      </View>

      {leadChild ? (
        <Card variant="cream" className="flex-row items-center gap-3">
          <View className="flex-1 gap-1.5">
            <AppText variant="eyebrow" className="text-cream-accent">
              {leadChild.name ? `For ${leadChild.name}` : 'Today'}
            </AppText>
            <AppText
              className="text-[15px] leading-[21px] text-ink"
              style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
            >
              {leadChild.whatsNow[0] ?? nextForChild(leadChild)}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="View details in Companion"
              onPress={() => router.push('/companion')}
              className="mt-0.5 flex-row items-center gap-1.5 active:opacity-70"
            >
              <AppText
                variant="meta"
                className="text-ink"
                style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
              >
                View details
              </AppText>
              <Icon name="chevron-right" size={13} color={creamChevron} />
            </Pressable>
          </View>
          <LogoMark size={72} />
        </Card>
      ) : (
        <Card className="gap-3">
          <AppText variant="title">Add your first child</AppText>
          <AppText variant="meta">
            Add a child and Hale unlocks one-tap logging for feeds and naps, their milestones and
            checkups, and a companion guide tuned to their stage.
          </AppText>
          <Button label="Add a child" onPress={() => router.push('/family')} />
        </Card>
      )}

      {leadChild ? (
        <View className="gap-2.5">
          <SectionLabel>Quick actions</SectionLabel>
          <View className="flex-row gap-2">
            <QuickActionTile icon="droplet" label="Log feed" onPress={() => setLogKind('feed')} />
            <QuickActionTile icon="moon" label="Log nap" onPress={() => setLogKind('nap')} />
            <QuickActionTile icon="baby" label="Diaper" onPress={() => setLogKind('diaper')} />
            <QuickActionTile
              icon="star"
              label="Milestone"
              accent
              onPress={() => setLogKind('milestone')}
            />
          </View>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ask Hale anything"
        onPress={() => router.push('/ask')}
        className="h-12 flex-row items-center gap-2.5 rounded-[18px] border border-rule bg-card px-4 active:opacity-80"
      >
        <Icon name="sparkles" size={16} color={askIcon} />
        <AppText variant="body" className="flex-1 text-ink-3">
          Ask Hale anything&hellip;
        </AppText>
        <Icon name="mic" size={18} color={micIcon} />
      </Pressable>

      {leadChild ? (
        <View className="gap-2.5">
          <SectionLabel>Today&rsquo;s snapshot</SectionLabel>
          <Card onPress={() => router.push('/companion')} className="gap-4">
            <View className="flex-row items-center gap-3">
              <ChildAvatar name={leadChild.name} />
              <View className="flex-1">
                <AppText
                  numberOfLines={1}
                  className="text-[15px] text-ink"
                  style={{ fontFamily: 'InstrumentSans_700Bold' }}
                >
                  {leadChild.name ?? 'Your child'}
                </AppText>
                <AppText variant="meta" className="text-ink-3">
                  {agePhrase(leadChild.ageMonths)}
                </AppText>
              </View>
              <Icon name="chevron-right" size={15} color={chevron} />
            </View>
            <View className="flex-row gap-2">
              {homeStatCells(data.stats).map((cell) => (
                <SnapshotStat key={cell.label} cell={cell} />
              ))}
            </View>
          </Card>
        </View>
      ) : null}

      {upNext ? (
        <View className="gap-2.5">
          <SectionLabel>Up next</SectionLabel>
          <Card
            onPress={() =>
              leadChild
                ? router.push(`/appointment/${upNext.key}?child=${leadChild.id}`)
                : undefined
            }
            className="flex-row items-center gap-3"
          >
            <TintChip icon="calendar" tone="blue" size={38} />
            <View className="flex-1">
              <AppText
                numberOfLines={1}
                className="text-[14px] text-ink"
                style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
              >
                {upNext.what}
              </AppText>
              <AppText variant="meta" className="text-ink-3">
                {duePhrase(upNext.dueInWeeks)}
              </AppText>
            </View>
            <Icon name="chevron-right" size={15} color={chevron} />
          </Card>
        </View>
      ) : null}

      {rec ? (
        <View className="gap-2.5">
          <SectionLabel>From your village</SectionLabel>
          <Card
            onPress={() => router.push(`/activity/${rec.id}`)}
            className="flex-row items-center gap-3"
          >
            <TintChip icon="map-pin" tone="yellow" size={38} />
            <View className="flex-1">
              <AppText
                numberOfLines={1}
                className="text-[14px] text-ink"
                style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
              >
                {rec.title}
              </AppText>
              <AppText variant="meta" numberOfLines={1} className="text-ink-3">
                {villageLine(rec)}
              </AppText>
            </View>
            <Icon name="chevron-right" size={15} color={chevron} />
          </Card>
        </View>
      ) : null}

      <QuickLogModal
        visible={logKind !== null}
        kind={logKind}
        kids={data.children.map((c) => ({
          id: c.id,
          name: c.name,
          milestoneSuggestions: c.milestones.map((m) => m.what),
        }))}
        onClose={() => setLogKind(null)}
        onLogged={onLogged}
      />
    </>
  );
}

export default function HomeScreen() {
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileHomeResponse>('/api/mobile/home');

  return (
    <Screen scroll className="gap-5" refreshControl={useTintedRefresh(refreshing, refresh)}>
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <HomeBody data={data} onLogged={refresh} /> : null}
    </Screen>
  );
}
