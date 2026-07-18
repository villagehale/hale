import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { AppointmentDetailSheet } from '@/components/hale/appointment-detail-sheet';
import { DocsAddSheet } from '@/components/hale/docs-add-sheet';
import { DocsSection } from '@/components/hale/docs-section';
import { GrowthAddSheet } from '@/components/hale/growth-add-sheet';
import { GrowthChart } from '@/components/hale/growth-chart';
import { LogEditSheet } from '@/components/hale/log-edit-sheet';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon, type IconName } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { QuickLogModal } from '@/components/ui/quick-log-modal';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { type ChipTone, TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import { api } from '@/lib/api-client';
import type {
  ChildCompanionView,
  LogView,
  MobileCompanionResponse,
  MobileLogsResponse,
  MobilePreferencesResponse,
  MobileVillageResponse,
  RecentLogView,
  RoutineProposalView,
  UpcomingHealthItem,
} from '@/lib/api-types';
import { MILESTONE_TIMING_LABEL, STAGE_LABEL, agePhrase, duePhrase, whenPhrase } from '@/lib/format';
import { groupLogsByDay } from '@/lib/logs-group';
import { buildMeasureSeries, MEASURE_KINDS, type MeasureKind } from '@/lib/measurement-series';
import { displayMeasurement, type UnitSystem } from '@/lib/measurement-units';
import { GROWTH_DATA_SOURCE, GROWTH_VERDICT, SUGGESTED_DAILY_ROUTINE } from '@/lib/stub-data';
import { useApi } from '@/lib/use-api';

/** The seven sections of the Companion tab, in order. Diary is app-only (not in the
 * design handoff); its teen-redaction-aware paging survives the restyle (rule #1). */
const SECTIONS = [
  { key: 'overview', label: 'Overview' },
  { key: 'health', label: 'Health' },
  { key: 'growth', label: 'Growth' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'routines', label: 'Routines' },
  { key: 'diary', label: 'Diary' },
  { key: 'docs', label: 'Docs' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

const PROVIDER_LINE = 'Timing is the standard Canadian schedule — confirm with your provider.';

/** The child's initial in a filled navy circle — the app's avatar idiom (no uploaded
 * photos), shared with Home and the switcher rows. */
function ChildAvatar({ name, size = 46 }: { name: string | null; size?: number }) {
  const initial = (name ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <View
      className="items-center justify-center rounded-full bg-ink"
      style={{ width: size, height: size }}
    >
      <AppText variant="title" className="text-on-ink">
        {initial}
      </AppText>
    </View>
  );
}

/** The header child-switcher: an initial pill toggling an inline dropdown of the
 * family's children plus "Add another child" (the Family add-child flow). */
function ChildSwitcher({
  kids,
  selectedId,
  open,
  onToggle,
}: {
  kids: ChildCompanionView[];
  selectedId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const chevron = useMeadowColor('brand');
  const selected = kids.find((c) => c.id === selectedId);
  const initial = (selected?.name ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Switch child"
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      className="h-[34px] flex-row items-center gap-1.5 rounded-full border border-rule bg-card px-3 active:opacity-80"
    >
      <AppText variant="meta" className="text-brand" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
        {initial}
      </AppText>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} color={chevron} />
    </Pressable>
  );
}

function ChildMenu({
  kids,
  onSelect,
  onAddChild,
}: {
  kids: ChildCompanionView[];
  onSelect: (id: string) => void;
  onAddChild: () => void;
}) {
  const addColor = useMeadowColor('brand');
  return (
    <Card className="gap-0 overflow-hidden p-0">
      {kids.map((child, i) => {
        const initial = (child.name ?? '?').trim().charAt(0).toUpperCase() || '?';
        return (
          <Pressable
            key={child.id}
            accessibilityRole="button"
            accessibilityLabel={`Show ${child.name ?? 'child'}`}
            onPress={() => onSelect(child.id)}
            className={`flex-row items-center gap-2.5 px-4 py-3 active:opacity-80 ${
              i === 0 ? '' : 'border-t border-rule'
            }`}
          >
            <View className="h-[30px] w-[30px] items-center justify-center rounded-full bg-chip-blue">
              <AppText
                variant="meta"
                className="text-chip-blue-icon"
                style={{ fontFamily: 'InstrumentSans_700Bold' }}
              >
                {initial}
              </AppText>
            </View>
            <View className="flex-1">
              <AppText
                numberOfLines={1}
                className="text-[14px] text-ink"
                style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
              >
                {child.name ?? 'Your child'}
              </AppText>
              <AppText variant="meta" className="text-ink-3">
                {agePhrase(child.ageMonths)} · {STAGE_LABEL[child.stage]}
              </AppText>
            </View>
          </Pressable>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add another child"
        onPress={onAddChild}
        className="flex-row items-center gap-2.5 border-t border-rule px-4 py-3 active:opacity-80"
      >
        <Icon name="plus" size={16} color={addColor} />
        <AppText
          variant="meta"
          className="text-brand"
          style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
        >
          Add another child
        </AppText>
      </Pressable>
    </Card>
  );
}

/** The sub-tab bar — a horizontal scroll of labels, the active one carrying the 2px
 * navy underline (prototype). Full-bleed past the screen padding. */
function SubTabBar({ value, onSelect }: { value: SectionKey; onSelect: (s: SectionKey) => void }) {
  return (
    <View className="-mx-5 border-b border-rule">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-[18px] px-5"
      >
        {SECTIONS.map((section) => {
          const active = section.key === value;
          return (
            <Pressable
              key={section.key}
              accessibilityRole="button"
              accessibilityLabel={`Section: ${section.label}`}
              accessibilityState={active ? { selected: true } : {}}
              onPress={() => onSelect(section.key)}
              className={`border-b-2 pb-2.5 ${active ? 'border-brand' : 'border-transparent'}`}
            >
              <AppText
                className={`text-[13.5px] ${active ? 'text-ink' : 'text-ink-3'}`}
                style={{
                  fontFamily: active ? 'InstrumentSans_700Bold' : 'InstrumentSans_500Medium',
                }}
              >
                {section.label}
              </AppText>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** A section eyebrow with an optional right-aligned action link ("See all"). */
function SectionHeader({
  label,
  actionLabel,
  onAction,
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between">
      <AppText variant="eyebrow">{label}</AppText>
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" accessibilityLabel={actionLabel} onPress={onAction}>
          <AppText
            variant="meta"
            className="text-brand"
            style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
          >
            {actionLabel}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A tappable achievement circle — filled sage with a white check when done, an empty
 * outline otherwise. One-way: marking done has an audited route; there is no un-done
 * route, so a done circle is inert. */
function MilestoneCheck({
  done,
  busy,
  onPress,
}: {
  done: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const check = useMeadowColor('onAccent');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={done ? 'Achieved' : 'Mark achieved'}
      accessibilityState={{ checked: done, disabled: done || busy }}
      disabled={done || busy}
      onPress={onPress}
      className={`h-6 w-6 items-center justify-center self-center rounded-full ${
        done ? 'bg-sage' : 'border border-rule-strong bg-card'
      } ${busy ? 'opacity-50' : 'active:opacity-70'}`}
    >
      {done ? <Icon name="check" size={13} color={check} /> : null}
    </Pressable>
  );
}

/** A neutral numbered chip leading a milestone row (prototype's numbered rail). */
function NumberChip({ n }: { n: number }) {
  return (
    <View className="h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-raised">
      <AppText
        className="text-[14px] text-ink-2"
        style={{ fontFamily: 'InstrumentSans_700Bold' }}
      >
        {n}
      </AppText>
    </View>
  );
}

// ── OVERVIEW ──────────────────────────────────────────────────────────────────
//
// A read-only composition of the already-redacted companion payload: today's log
// counters (from the recent-logs list), the companion's now/next narrative, the
// first few milestones (tappable), and the next health items. No re-query.

const TODAY_COUNTERS: { type: string; label: string; icon: IconName; tone: ChipTone }[] = [
  { type: 'nap', label: 'Naps', icon: 'moon', tone: 'blue' },
  { type: 'feed', label: 'Meals', icon: 'droplet', tone: 'green' },
  { type: 'diaper', label: 'Diapers', icon: 'baby', tone: 'yellow' },
];

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function OverviewSection({
  child,
  logs,
  onOpenHealth,
  onMarkMilestone,
  pendingMilestone,
  onNavigate,
}: {
  child: ChildCompanionView;
  logs: RecentLogView[];
  onOpenHealth: (item: UpcomingHealthItem) => void;
  onMarkMilestone: (what: string) => void;
  pendingMilestone: string | null;
  onNavigate: (s: SectionKey) => void;
}) {
  const chevron = useMeadowColor('ink3');
  // Counts of today's episodes by type, from the recent-logs list the payload already
  // carries (teen-redacted at the source). The list is bounded to the newest few, so
  // a very heavy logging day can under-count — an honest snapshot, not an analytic.
  const todayLogs = logs.filter((l) => isToday(l.occurredAt));
  const nowLine = child.whatsNow[0] ?? child.whatsNext;
  const topMilestones = child.milestones.slice(0, 3);
  const nextHealth = child.todayHealth
    ? [child.todayHealth, ...child.nextHealth.filter((h) => h.key !== child.todayHealth?.key)]
    : [...child.nextHealth];
  const healthRows = nextHealth.slice(0, 2);

  return (
    <>
      <Card className="gap-1">
        <View className="flex-row items-baseline justify-between pb-1">
          <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
            Today
          </AppText>
        </View>
        {TODAY_COUNTERS.map((c, i) => (
          <View
            key={c.type}
            className={`flex-row items-center gap-3 py-2.5 ${
              i === 0 ? '' : 'border-t border-rule'
            }`}
          >
            <TintChip icon={c.icon} tone={c.tone} size={30} />
            <AppText
              className="flex-1 text-[14px] text-ink"
              style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
            >
              {c.label}
            </AppText>
            <AppText
              className="text-[15px] text-ink"
              style={{ fontFamily: 'InstrumentSans_700Bold' }}
            >
              {todayLogs.filter((l) => l.episodeType === c.type).length}
            </AppText>
          </View>
        ))}
      </Card>

      <Card className="gap-1.5">
        <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
          Around now
        </AppText>
        <AppText variant="body">{nowLine}</AppText>
      </Card>

      <View className="gap-2.5">
        <SectionHeader label="Milestones" actionLabel="See all" onAction={() => onNavigate('milestones')} />
        {topMilestones.length === 0 ? (
          <Card>
            <AppText variant="body" className="text-ink-3">
              No milestones tracked for this stage yet.
            </AppText>
          </Card>
        ) : (
          <Card className="gap-3">
            {topMilestones.map((m, i) => (
              <View
                key={m.what}
                className={`flex-row items-center gap-3 ${i === 0 ? '' : 'border-t border-rule pt-3'}`}
              >
                <View className="flex-1">
                  <AppText
                    className="text-[14px] text-ink"
                    style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
                  >
                    {m.what}
                  </AppText>
                  <AppText variant="meta" className="text-ink-3">
                    {m.done ? 'Achieved' : MILESTONE_TIMING_LABEL[m.timing]}
                  </AppText>
                </View>
                <MilestoneCheck
                  done={m.done}
                  busy={pendingMilestone === m.what}
                  onPress={() => onMarkMilestone(m.what)}
                />
              </View>
            ))}
          </Card>
        )}
      </View>

      <View className="gap-2.5">
        <SectionHeader label="Health schedule" actionLabel="See all" onAction={() => onNavigate('health')} />
        {healthRows.length === 0 ? (
          <Card>
            <AppText variant="body" className="text-ink-3">
              No routine items left on the standard schedule.
            </AppText>
          </Card>
        ) : (
          <Card className="gap-0 p-0">
            {healthRows.map((item, i) => (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                accessibilityLabel={`${item.what} — details`}
                onPress={() => onOpenHealth(item)}
                className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${
                  i === 0 ? '' : 'border-t border-rule'
                }`}
              >
                <TintChip
                  icon={item.kind === 'immunization' ? 'shield-check' : 'calendar'}
                  tone="blue"
                />
                <View className="flex-1">
                  <AppText
                    className="text-[14px] text-ink"
                    style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
                  >
                    {item.what}
                  </AppText>
                  <AppText variant="meta" className="text-ink-3">
                    {duePhrase(item.dueInWeeks)}
                  </AppText>
                </View>
                <Icon name="chevron-right" size={15} color={chevron} />
              </Pressable>
            ))}
          </Card>
        )}
      </View>
    </>
  );
}

// ── HEALTH ────────────────────────────────────────────────────────────────────

function MeasurementsCard({ childId, units }: { childId: string; units: UnitSystem }) {
  const { status, data } = useApi<MobileLogsResponse>(
    `/api/mobile/companion/logs?child=${childId}&episodeType=measurement`,
  );
  if (status === 'loading' || status === 'error' || !data) {
    return null;
  }
  const series = buildMeasureSeries(data.logs);
  const withData = series.filter((s) => s.readings.length > 0);
  const latestAt = withData
    .map((s) => s.readings[0].occurredAt)
    .sort()
    .at(-1);

  return (
    <Card className="gap-2">
      <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
        Measurements
      </AppText>
      {withData.length === 0 ? (
        <AppText variant="body" className="text-ink-3">
          No measurements logged yet — the Growth section starts a record.
        </AppText>
      ) : (
        <>
          {withData.map((s, i) => {
            const shown = displayMeasurement(s.readings[0].value, s.kind, units);
            return (
              <View
                key={s.kind}
                className={`flex-row justify-between py-1.5 ${
                  i === 0 ? '' : 'border-t border-rule'
                }`}
              >
                <AppText variant="body" className="text-ink-3">
                  {s.label}
                </AppText>
                <AppText
                  className="text-[13.5px] text-ink"
                  style={{ fontFamily: 'InstrumentSans_700Bold' }}
                >
                  {shown.value} {shown.unit}
                </AppText>
              </View>
            );
          })}
          {latestAt ? (
            <AppText variant="meta" className="text-ink-3">
              {whenPhrase(latestAt)}
            </AppText>
          ) : null}
        </>
      )}
    </Card>
  );
}

function HealthSection({
  child,
  units,
  onOpen,
  onNavigate,
}: {
  child: ChildCompanionView;
  units: UnitSystem;
  onOpen: (item: UpcomingHealthItem) => void;
  onNavigate: (s: SectionKey) => void;
}) {
  const [addRecord, setAddRecord] = useState(false);
  const chevron = useMeadowColor('ink3');
  const addIcon = useMeadowColor('ink2');

  const nextUp = child.todayHealth ?? child.nextHealth[0] ?? null;
  const restUpcoming = child.nextHealth.filter((h) => h.key !== nextUp?.key);
  const nextImmunization = child.nextHealth.find((h) => h.kind === 'immunization');
  const passed = child.recentlyPassedHealth;

  return (
    <>
      <View className="gap-2.5">
        <SectionHeader label="Next up" />
        {nextUp ? (
          <Card className="gap-1">
            <AppText
              className="text-[15px] text-ink"
              style={{ fontFamily: 'InstrumentSans_700Bold' }}
            >
              {nextUp.what}
            </AppText>
            <AppText variant="meta" className="text-ink-3">
              {duePhrase(nextUp.dueInWeeks)}
            </AppText>
            {nextUp.note ? (
              <AppText variant="meta" className="mt-0.5 text-ink-3">
                {nextUp.note}
              </AppText>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add to calendar"
              onPress={() => onOpen(nextUp)}
              className="mt-2.5 min-h-11 items-center justify-center rounded-[12px] border border-rule bg-card active:opacity-80"
            >
              <AppText
                variant="meta"
                className="text-ink"
                style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
              >
                Add to calendar
              </AppText>
            </Pressable>
          </Card>
        ) : (
          <Card>
            <AppText variant="body">
              No routine items left on the standard schedule — keep up periodic visits.
            </AppText>
          </Card>
        )}
      </View>

      {nextImmunization ? (
        <Card onPress={() => onOpen(nextImmunization)} className="flex-row items-center gap-3">
          <TintChip icon="shield-check" tone="green" />
          <View className="flex-1">
            <AppText
              className="text-[14px] text-ink"
              style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
            >
              Immunizations
            </AppText>
            <AppText variant="meta" className="text-ink-3">
              {nextImmunization.what} · {duePhrase(nextImmunization.dueInWeeks)}
            </AppText>
          </View>
          <Icon name="chevron-right" size={15} color={chevron} />
        </Card>
      ) : null}

      {restUpcoming.length > 0 ? (
        <Card className="gap-3">
          <SectionHeader label="Upcoming" />
          {restUpcoming.map((item, i) => (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityLabel={`${item.what} — details`}
              onPress={() => onOpen(item)}
              className={`flex-row items-start gap-3 active:opacity-80 ${
                i === 0 ? '' : 'border-t border-rule pt-3'
              }`}
            >
              <View className="w-[110px] shrink-0 pt-0.5">
                <AppText
                  variant="meta"
                  className="text-[11px] uppercase leading-[15px] tracking-eyebrow text-ink-2"
                >
                  {duePhrase(item.dueInWeeks)}
                </AppText>
              </View>
              <AppText variant="body" className="flex-1">
                {item.what}
              </AppText>
              <Icon name="chevron-right" size={13} color={chevron} />
            </Pressable>
          ))}
          <AppText variant="meta">{PROVIDER_LINE}</AppText>
        </Card>
      ) : null}

      {passed.length > 0 ? (
        <Card className="gap-3">
          <SectionHeader label="Recently due" />
          {passed.map((item, i) => (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityLabel={`${item.what} — details`}
              onPress={() => onOpen(item)}
              className={`flex-row items-start gap-3 active:opacity-80 ${
                i === 0 ? '' : 'border-t border-rule pt-3'
              }`}
            >
              <View className="w-[110px] shrink-0 pt-0.5">
                {item.done ? (
                  <Tag label="done" tone="done" />
                ) : (
                  <AppText
                    variant="meta"
                    className="text-[11px] uppercase leading-[15px] tracking-eyebrow text-ink-2"
                  >
                    was due
                  </AppText>
                )}
              </View>
              <AppText variant="body" className={`flex-1 ${item.done ? 'text-ink-3' : ''}`}>
                {item.what}
              </AppText>
              <Icon name="chevron-right" size={13} color={chevron} />
            </Pressable>
          ))}
          <AppText variant="meta" className="text-ink-3">
            Already handled? Open a row to mark it done.
          </AppText>
        </Card>
      ) : null}

      <MeasurementsCard childId={child.id} units={units} />

      <Card onPress={() => onNavigate('docs')} className="flex-row items-center gap-3">
        <TintChip icon="file-text" tone="gray" />
        <View className="flex-1">
          <AppText
            className="text-[14px] text-ink"
            style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
          >
            All medical records
          </AppText>
          <AppText variant="meta" className="text-ink-3">
            Open the document vault
          </AppText>
        </View>
        <Icon name="chevron-right" size={15} color={chevron} />
      </Card>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add a record"
        onPress={() => setAddRecord(true)}
        className="min-h-12 flex-row items-center justify-center gap-2 rounded-[14px] border border-rule bg-card active:opacity-80"
      >
        <Icon name="plus" size={15} color={addIcon} />
        <AppText
          variant="meta"
          className="text-ink"
          style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
        >
          Add record
        </AppText>
      </Pressable>

      <DocsAddSheet
        childId={child.id}
        kids={[{ id: child.id, name: child.name }]}
        visible={addRecord}
        onClose={() => setAddRecord(false)}
        onUploaded={() => setAddRecord(false)}
      />
    </>
  );
}

// ── GROWTH ────────────────────────────────────────────────────────────────────
//
// The one NEW data concept, read via the paginated logs route (episodeType=measurement),
// re-gated client-side in buildMeasureSeries (teen redaction applies by construction —
// the same shared read). A real react-native-svg line chart of the selected measure's
// actual readings, an Add-measurement sheet POSTing the same log route, plus the
// prototype's "On track" verdict + WHO source — which are STUBS (stub-data.ts): the app
// does NOT compute percentiles (no server-side derivation).

const GROWTH_TOGGLE: { kind: MeasureKind; label: string }[] = MEASURE_KINDS.map((kind) => ({
  kind,
  label: kind === 'head' ? 'Head' : kind[0].toUpperCase() + kind.slice(1),
}));

function GrowthSection({ childId }: { childId: string }) {
  const { status, data, error, reload } = useApi<MobileLogsResponse>(
    `/api/mobile/companion/logs?child=${childId}&episodeType=measurement`,
  );
  const prefs = useApi<MobilePreferencesResponse>('/api/mobile/preferences');
  const units: UnitSystem = prefs.data?.units ?? 'metric';
  const [selectedKind, setSelectedKind] = useState<MeasureKind>('weight');
  const [addKind, setAddKind] = useState<MeasureKind | null>(null);
  const onAccent = useMeadowColor('onAccent');
  const addIcon = useMeadowColor('ink2');

  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <ErrorState message={error ?? ''} onRetry={reload} />;
  if (!data) return null;

  const series = buildMeasureSeries(data.logs);
  const selected = series.find((s) => s.kind === selectedKind) ?? series[0];
  const hasAny = series.some((s) => s.readings.length > 0);

  if (!hasAny) {
    return (
      <>
        <Card className="items-center gap-2 py-8">
          <AppText variant="title">No measurements yet</AppText>
          <AppText variant="meta" className="text-center">
            Log a weight, height, or head circumference to start a simple growth record.
          </AppText>
        </Card>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a measurement"
          onPress={() => setAddKind('weight')}
          className="min-h-12 flex-row items-center justify-center gap-2 rounded-full border border-ink bg-ink active:opacity-80"
        >
          <Icon name="plus" size={15} color={onAccent} />
          <AppText variant="meta" className="text-on-ink">
            Add a measurement
          </AppText>
        </Pressable>
        <GrowthAddSheet
          childId={childId}
          visible={addKind !== null}
          initialKind={addKind ?? 'weight'}
          units={units}
          onClose={() => setAddKind(null)}
          onLogged={reload}
        />
      </>
    );
  }

  return (
    <>
      <Card className="gap-3">
        <View className="flex-row items-center justify-between">
          <AppText
            className="text-[14px] text-ink"
            style={{ fontFamily: 'InstrumentSans_700Bold' }}
          >
            Growth overview
          </AppText>
          <Tag label={GROWTH_VERDICT} tone="done" />
        </View>

        <View className="flex-row gap-2">
          {GROWTH_TOGGLE.map((t) => {
            const active = t.kind === selectedKind;
            return (
              <Pressable
                key={t.kind}
                accessibilityRole="button"
                accessibilityLabel={`Show ${t.label}`}
                accessibilityState={active ? { selected: true } : {}}
                onPress={() => setSelectedKind(t.kind)}
                className={`rounded-full px-3.5 py-1.5 ${active ? 'bg-brand' : 'bg-raised'}`}
              >
                <AppText
                  variant="meta"
                  className={active ? 'text-on-ink' : 'text-ink-3'}
                  style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
                >
                  {t.label}
                </AppText>
              </Pressable>
            );
          })}
        </View>

        {selected.readings.length > 0 ? (
          <GrowthChart readings={selected.readings} kind={selected.kind} units={units} />
        ) : (
          <AppText variant="body" className="py-6 text-center text-ink-3">
            Nothing logged for {selected.label.toLowerCase()} yet.
          </AppText>
        )}

        <AppText variant="meta" className="text-ink-3">
          An early read — no percentiles. Confirm any concern with your provider.
        </AppText>
      </Card>

      <Card className="flex-row items-center gap-3">
        <View className="flex-1">
          <AppText variant="meta" className="text-ink-3">
            Data source
          </AppText>
          <AppText
            className="text-[14px] text-ink"
            style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
          >
            {GROWTH_DATA_SOURCE}
          </AppText>
        </View>
      </Card>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add a measurement"
        onPress={() => setAddKind(selectedKind)}
        className="min-h-12 flex-row items-center justify-center gap-2 rounded-[14px] border border-rule bg-card active:opacity-80"
      >
        <Icon name="plus" size={15} color={addIcon} />
        <AppText
          variant="meta"
          className="text-ink"
          style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
        >
          Add measurement
        </AppText>
      </Pressable>

      <GrowthAddSheet
        childId={childId}
        visible={addKind !== null}
        initialKind={addKind ?? selectedKind}
        units={units}
        onClose={() => setAddKind(null)}
        onLogged={reload}
      />
    </>
  );
}

// ── MILESTONES ────────────────────────────────────────────────────────────────

function MilestonesSection({
  child,
  onMarkDone,
  pending,
  onLogged,
}: {
  child: ChildCompanionView;
  onMarkDone: (what: string) => void;
  pending: string | null;
  onLogged: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const accentFill = useMeadowColor('accentFill');
  const addIcon = useMeadowColor('onAccent');

  const done = child.milestones.filter((m) => m.done).length;
  const total = child.milestones.length;
  const lo = total > 0 ? Math.min(...child.milestones.map((m) => m.typicalWindowMonths[0])) : 0;
  const hi = total > 0 ? Math.max(...child.milestones.map((m) => m.typicalWindowMonths[1])) : 0;

  return (
    <>
      <View className="flex-row items-baseline justify-between">
        <AppText className="text-[13px] text-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
          {total > 0 ? `${lo}–${hi} months` : STAGE_LABEL[child.stage]}{' '}
          <AppText variant="meta" className="text-ink-3">
            ({done} / {total})
          </AppText>
        </AppText>
      </View>

      {total === 0 ? (
        <Card>
          <AppText variant="body" className="text-ink-3">
            No milestones tracked for this stage yet.
          </AppText>
        </Card>
      ) : (
        <Card className="gap-0 p-0">
          {child.milestones.map((m, i) => (
            <View
              key={m.what}
              className={`flex-row items-center gap-3 px-4 py-3 ${
                i === 0 ? '' : 'border-t border-rule'
              }`}
            >
              <NumberChip n={i + 1} />
              <View className="flex-1">
                <AppText
                  className={`text-[14px] ${m.done ? 'text-ink-3' : 'text-ink'}`}
                  style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
                >
                  {m.what}
                </AppText>
                <AppText variant="meta" className="text-ink-3">
                  {m.done ? 'Achieved' : MILESTONE_TIMING_LABEL[m.timing]}
                </AppText>
              </View>
              <MilestoneCheck
                done={m.done}
                busy={pending === m.what}
                onPress={() => onMarkDone(m.what)}
              />
            </View>
          ))}
        </Card>
      )}

      <View className="flex-row items-start gap-2.5 rounded-md bg-accent-tint px-3.5 py-3">
        <Icon name="sparkles" size={16} color={accentFill} />
        <AppText variant="meta" className="flex-1 text-ink">
          Every child grows at their own pace — if something&rsquo;s not happening yet, it&rsquo;s
          worth asking, never a verdict.
        </AppText>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create milestone"
        onPress={() => setCreateOpen(true)}
        className="min-h-12 flex-row items-center justify-center gap-2 rounded-[14px] bg-brand active:opacity-90"
      >
        <Icon name="plus" size={15} color={addIcon} />
        <AppText variant="meta" className="text-on-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          Create milestone
        </AppText>
      </Pressable>

      <QuickLogModal
        visible={createOpen}
        kind="milestone"
        kids={[
          {
            id: child.id,
            name: child.name,
            milestoneSuggestions: child.milestones.map((m) => m.what),
          },
        ]}
        onClose={() => setCreateOpen(false)}
        onLogged={onLogged}
      />
    </>
  );
}

// ── ROUTINES ──────────────────────────────────────────────────────────────────
//
// Daily = a stub suggested rhythm (stub-data.ts): there is NO per-child daily routine
// backend, so it is an untracked, illustrative starting point (labelled as such).
// Weekly = the REAL routine proposal from the village payload (RoutineProposalView,
// teen-redacted by its mapper — the `teenAttributed` branch survives). Custom has no
// backend yet.

type RoutineTab = 'daily' | 'weekly' | 'custom';

const ROUTINE_TABS: { key: RoutineTab; label: string }[] = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'custom', label: 'Custom' },
];

function DailyRoutine() {
  return (
    <View className="gap-2.5">
      <AppText variant="eyebrow">Today&rsquo;s routine</AppText>
      <Card className="gap-0 p-0">
        {SUGGESTED_DAILY_ROUTINE.map((r, i) => (
          <View
            key={r.time}
            className={`flex-row items-center gap-3 px-4 py-3 ${
              i === 0 ? '' : 'border-t border-rule'
            }`}
          >
            <AppText
              className="w-16 shrink-0 text-[12.5px] text-ink-3"
              style={{ fontFamily: 'InstrumentSans_700Bold' }}
            >
              {r.time}
            </AppText>
            <AppText
              className="flex-1 text-[14px] text-ink"
              style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
            >
              {r.label}
            </AppText>
            <View className="h-[18px] w-[18px] rounded-full border border-rule-strong" />
          </View>
        ))}
      </Card>
      <AppText variant="meta" className="text-ink-3">
        A gentle rhythm typical for this stage — a starting point Hale doesn&rsquo;t track yet.
      </AppText>
    </View>
  );
}

function WeeklyRoutine({ routine }: { routine: RoutineProposalView }) {
  return (
    <View className="gap-2.5">
      <View className="gap-1">
        <AppText variant="title">Hale&rsquo;s suggested rhythm this week</AppText>
        <AppText variant="meta" className="text-ink-3">
          Proposed by Hale&rsquo;s weekly run · week of {routine.weekOf}
        </AppText>
      </View>
      <View className="gap-3">
        {routine.items.map((item, i) => (
          <Card key={`${item.kind}-${i}`} className="gap-1">
            {item.teenAttributed ? (
              <>
                <Tag label="private" tone="attention" />
                <AppText variant="meta" className="mt-1 text-ink-3">
                  A teen&rsquo;s item — category only, kept private (rule #1).
                </AppText>
              </>
            ) : (
              <>
                <View className="flex-row items-center justify-between">
                  <Tag label={item.kind} tone="neutral" />
                  {item.day ? (
                    <AppText variant="mono" className="capitalize text-ink-3">
                      {item.day}
                    </AppText>
                  ) : null}
                </View>
                <AppText variant="title" className="mt-1">
                  {item.title}
                </AppText>
                {item.stageNote ? <AppText variant="meta">{item.stageNote}</AppText> : null}
              </>
            )}
          </Card>
        ))}
      </View>
    </View>
  );
}

function WeeklyRoutineSection() {
  const { status, data, error, reload } = useApi<MobileVillageResponse>('/api/mobile/village');
  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <ErrorState message={error ?? ''} onRetry={reload} />;
  if (!data) return null;
  if (!data.routine || data.routine.items.length === 0) {
    return (
      <Card className="items-center gap-2 py-10">
        <AppText variant="title">No rhythm yet this week</AppText>
        <AppText variant="meta" className="text-center">
          Hale proposes a gentle weekly routine as your village fills in. Check back soon.
        </AppText>
      </Card>
    );
  }
  return <WeeklyRoutine routine={data.routine} />;
}

function RoutinesSection() {
  const [tab, setTab] = useState<RoutineTab>('daily');
  return (
    <>
      <View className="flex-row gap-2">
        {ROUTINE_TABS.map((t) => {
          const active = t.key === tab;
          return (
            <Pressable
              key={t.key}
              accessibilityRole="button"
              accessibilityLabel={t.label}
              accessibilityState={active ? { selected: true } : {}}
              onPress={() => setTab(t.key)}
              className={`rounded-full px-3.5 py-1.5 ${active ? 'bg-brand' : 'bg-raised'}`}
            >
              <AppText
                variant="meta"
                className={active ? 'text-on-ink' : 'text-ink-3'}
                style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
              >
                {t.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
      {tab === 'daily' ? <DailyRoutine /> : null}
      {tab === 'weekly' ? <WeeklyRoutineSection /> : null}
      {tab === 'custom' ? (
        <Card className="items-center gap-2 py-10">
          <AppText variant="title">Custom routines</AppText>
          <AppText variant="meta" className="text-center">
            Building your own routine is coming soon.
          </AppText>
        </Card>
      ) : null}
    </>
  );
}

// ── DIARY ─────────────────────────────────────────────────────────────────────
//
// Day-grouped reverse-chron list via the paginated logs route, with edit/delete per
// row (the LogEditSheet PATCHes / DELETEs the audited routes). Reuses the shared
// groupLogsByDay grouping. Teen redaction is server-side (the shared read); the
// empty-state branch below keeps the Load-older button reachable when a teen-heavy
// first page is fully redacted (rule #1) — untouched by the restyle.

function DiarySection({ childId }: { childId: string }) {
  const { status, data, error, reload } = useApi<MobileLogsResponse>(
    `/api/mobile/companion/logs?child=${childId}`,
  );
  const [editing, setEditing] = useState<LogView | null>(null);
  // Older pages appended after the first (via before=<nextCursor>). Reset whenever
  // the first page reloads (child switch / edit / delete) so it never shows stale
  // rows from a prior child under a fresh page one.
  const [older, setOlder] = useState<LogView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const iconColor = useMeadowColor('ink3');

  useEffect(() => {
    setOlder([]);
    setCursor(data?.nextCursor ?? null);
  }, [data]);

  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <ErrorState message={error ?? ''} onRetry={reload} />;
  if (!data) return null;

  async function loadOlder() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<MobileLogsResponse>(
        `/api/mobile/companion/logs?child=${childId}&before=${encodeURIComponent(cursor)}`,
      );
      setOlder((prev) => [...prev, ...page.logs]);
      setCursor(page.nextCursor);
    } catch {
      // Leave the cursor set so the button stays tappable for a retry.
    } finally {
      setLoadingMore(false);
    }
  }

  const groups = groupLogsByDay([...data.logs, ...older]);

  return (
    <>
      {groups.length === 0 ? (
        // Empty state must NOT swallow the Load-older button below: a teen-heavy
        // first page can be fully redacted while the parent's own older logs sit
        // on page 2 — they stay reachable.
        <AppText variant="body" className="py-6">
          {cursor !== null
            ? 'Nothing to show in the most recent logs.'
            : 'Nothing logged yet — note a feed, a nap, or a milestone with quick log and it will show here.'}
        </AppText>
      ) : null}
      <View className="gap-4">
        {groups.map((group) => (
          <View key={group.dayKey} className="gap-2">
            <AppText variant="eyebrow">{group.label}</AppText>
            <Card className="gap-3">
              {group.logs.map((log, i) => (
                <Pressable
                  key={log.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit log: ${log.summary}`}
                  onPress={() => setEditing(log)}
                  className={`flex-row items-baseline gap-3 active:opacity-80 ${
                    i === 0 ? '' : 'border-t border-rule pt-3'
                  }`}
                >
                  <AppText variant="body" className="flex-1">
                    {log.summary}
                  </AppText>
                  <AppText variant="mono" className="text-ink-3">
                    {whenPhrase(log.occurredAt)}
                  </AppText>
                  <Icon name="chevron-right" size={13} color={iconColor} />
                </Pressable>
              ))}
            </Card>
          </View>
        ))}
      </View>

      {cursor !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load older logs"
          onPress={loadOlder}
          disabled={loadingMore}
          className="min-h-11 flex-row items-center justify-center gap-2 self-center rounded-full border border-rule bg-raised px-4 py-2.5 active:opacity-80"
        >
          <AppText variant="meta" className="text-ink-2">
            {loadingMore ? 'Loading…' : 'Load older'}
          </AppText>
        </Pressable>
      ) : null}

      <LogEditSheet
        log={editing}
        visible={editing !== null}
        onClose={() => setEditing(null)}
        onChanged={reload}
      />
    </>
  );
}

// ── SHELL ─────────────────────────────────────────────────────────────────────

function CompanionBody({
  data,
  onLogged,
}: {
  data: MobileCompanionResponse;
  onLogged: () => void;
}) {
  const [selectedId, setSelectedId] = useState(data.children[0]?.id ?? '');
  const [section, setSection] = useState<SectionKey>('overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const [healthItem, setHealthItem] = useState<UpcomingHealthItem | null>(null);
  const [pendingMilestone, setPendingMilestone] = useState<string | null>(null);
  const prefs = useApi<MobilePreferencesResponse>('/api/mobile/preferences');
  const units: UnitSystem = prefs.data?.units ?? 'metric';
  const child = data.children.find((c) => c.id === selectedId) ?? data.children[0];

  if (!child) {
    return (
      <Card className="mt-2 items-center gap-2 py-10">
        <AppText variant="title">No children yet</AppText>
        <AppText variant="meta" className="text-center">
          Add a child in Family and their companion guide will appear here.
        </AppText>
      </Card>
    );
  }

  const childLogs = data.recentLogs.filter((l) => l.childId === child.id);

  const markMilestoneDone = async (what: string) => {
    setPendingMilestone(what);
    try {
      await api('/api/mobile/companion/done', {
        method: 'POST',
        body: JSON.stringify({ target: 'milestone', childId: child.id, what }),
      });
      onLogged();
    } catch {
      // A failed mark-done leaves the row unmarked; the parent can retry. The
      // refresh on success is what flips it — no optimistic local flag to desync.
    } finally {
      setPendingMilestone(null);
    }
  };

  const selectChild = (id: string) => {
    setSelectedId(id);
    setMenuOpen(false);
  };

  return (
    <>
      <View className="gap-3 pt-1">
        <View className="flex-row items-center gap-3">
          <ChildAvatar name={child.name} />
          <View className="flex-1">
            <AppText
              variant="title"
              className="text-[23px] leading-[28px]"
              style={{ fontFamily: 'SourceSerif4_600SemiBold' }}
            >
              {child.name ?? 'Your child'}
            </AppText>
            <AppText variant="meta" numberOfLines={1} className="text-ink-3">
              {agePhrase(child.ageMonths)} · {STAGE_LABEL[child.stage]}
            </AppText>
          </View>
          <ChildSwitcher
            kids={data.children}
            selectedId={child.id}
            open={menuOpen}
            onToggle={() => setMenuOpen((v) => !v)}
          />
        </View>
        {menuOpen ? (
          <ChildMenu
            kids={data.children}
            onSelect={selectChild}
            onAddChild={() => {
              setMenuOpen(false);
              router.push('/more/family');
            }}
          />
        ) : null}
      </View>

      <SubTabBar value={section} onSelect={setSection} />

      {section === 'overview' ? (
        <OverviewSection
          child={child}
          logs={childLogs}
          onOpenHealth={setHealthItem}
          onMarkMilestone={markMilestoneDone}
          pendingMilestone={pendingMilestone}
          onNavigate={setSection}
        />
      ) : null}
      {section === 'health' ? (
        <HealthSection child={child} units={units} onOpen={setHealthItem} onNavigate={setSection} />
      ) : null}
      {section === 'growth' ? <GrowthSection childId={child.id} /> : null}
      {section === 'milestones' ? (
        <MilestonesSection
          child={child}
          onMarkDone={markMilestoneDone}
          pending={pendingMilestone}
          onLogged={onLogged}
        />
      ) : null}
      {section === 'routines' ? <RoutinesSection /> : null}
      {section === 'diary' ? <DiarySection childId={child.id} /> : null}
      {section === 'docs' ? (
        <DocsSection
          childId={child.id}
          kids={data.children.map((c) => ({ id: c.id, name: c.name }))}
        />
      ) : null}

      <AppointmentDetailSheet
        item={healthItem}
        childId={child.id}
        childName={child.name}
        visible={healthItem !== null}
        onClose={() => setHealthItem(null)}
        onDone={onLogged}
      />
    </>
  );
}

export default function CompanionScreen() {
  const { status, data, error, refreshing, reload, refresh } = useApi<MobileCompanionResponse>(
    '/api/mobile/companion',
  );

  return (
    <Screen scroll className="gap-5" refreshControl={useTintedRefresh(refreshing, refresh)}>
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <CompanionBody data={data} onLogged={refresh} /> : null}
    </Screen>
  );
}
