import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { AppointmentDetailSheet } from '@/components/hale/appointment-detail-sheet';
import { DocsSection } from '@/components/hale/docs-section';
import { GrowthAddSheet } from '@/components/hale/growth-add-sheet';
import { LogEditSheet } from '@/components/hale/log-edit-sheet';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { type LogKind, QuickLogModal } from '@/components/ui/quick-log-modal';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import { api } from '@/lib/api-client';
import type {
  ChildCompanionView,
  LogView,
  MobileCompanionResponse,
  MobileLogsResponse,
  MobileVillageResponse,
  RecentLogView,
  RoutineProposalView,
  UpcomingHealthItem,
} from '@/lib/api-types';
import { MILESTONE_TIMING_LABEL, STAGE_LABEL, agePhrase, duePhrase, whenPhrase } from '@/lib/format';
import { groupLogsByDay } from '@/lib/logs-group';
import { buildMeasureSeries, type MeasureKind } from '@/lib/measurement-series';
import { useApi } from '@/lib/use-api';

const LOG_KINDS: { kind: LogKind; label: string }[] = [
  { kind: 'feed', label: 'Log feed' },
  { kind: 'nap', label: 'Log nap' },
  { kind: 'milestone', label: 'Milestone' },
];

/** The six sections of the Companion tab (mockup interaction map), in order. Local
 * useState drives which is active — no router restructure; the tab stays "Companion",
 * one child in focus, one section in view. */
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

/**
 * Header initial-chips (the mockup's circular child chip, made plural): every kid is
 * a small circle; the selected one is filled Prussian, the rest outlined.
 */
function ChildChips({
  kids,
  selectedId,
  onSelect,
}: {
  kids: ChildCompanionView[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <View className="flex-row items-center gap-2">
      {kids.map((child) => {
        const active = child.id === selectedId;
        const initial = (child.name ?? '?').trim().charAt(0).toUpperCase() || '?';
        return (
          <Pressable
            key={child.id}
            accessibilityRole="button"
            accessibilityLabel={`Show ${child.name ?? 'child'}`}
            accessibilityState={active ? { selected: true } : {}}
            onPress={() => onSelect(child.id)}
            className={`h-10 w-10 items-center justify-center rounded-full ${
              active ? 'bg-ink' : 'border border-rule bg-card'
            }`}
          >
            <AppText variant="title" className={active ? 'text-on-ink' : 'text-ink-3'}>
              {initial}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The section switcher: the CadenceRow horizontal-chip idiom (village.tsx) applied to
 * the Companion's six sections. A horizontal scroll of pill chips; the active one is
 * filled Prussian, the rest outlined — one tap moves between Overview / Health /
 * Growth / Milestones / Routines / Diary without a router change.
 */
function SectionRow({
  value,
  onSelect,
}: {
  value: SectionKey;
  onSelect: (s: SectionKey) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 pr-5"
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
            className={`min-h-11 items-center justify-center rounded-full border px-4 py-2.5 ${
              active ? 'border-ink bg-ink' : 'border-rule bg-card'
            }`}
          >
            <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
              {section.label}
            </AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * A health / milestone row. The timing sits in its own column that reads FULLY — only
 * the "now" state (or done) earns a Tag pill; every other timing is plain uppercase
 * eyebrow ink.
 */
function InfoRow({
  when,
  stamp,
  what,
  first,
  done = false,
  onPress,
}: {
  when: string;
  stamp: boolean;
  what: string;
  first: boolean;
  done?: boolean;
  onPress?: () => void;
}) {
  const iconColor = useMeadowColor('ink3');
  const body = (
    <>
      <View className="w-[124px] shrink-0 pt-0.5">
        {done ? (
          <Tag label="done" tone="done" />
        ) : stamp ? (
          <Tag label={when} tone="accent" />
        ) : (
          <AppText
            variant="meta"
            className="text-[11px] uppercase leading-[15px] tracking-eyebrow text-ink-2"
          >
            {when}
          </AppText>
        )}
      </View>
      <AppText variant="body" className={`flex-1 ${done ? 'text-ink-3' : ''}`}>
        {what}
      </AppText>
      {onPress ? <Icon name="chevron.right" size={13} color={iconColor} /> : null}
    </>
  );

  const rowClass = `flex-row items-start gap-3 ${first ? '' : 'border-t border-rule pt-3'}`;
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${what} — details`}
        onPress={onPress}
        className={`${rowClass} active:opacity-80`}
      >
        {body}
      </Pressable>
    );
  }
  return <View className={rowClass}>{body}</View>;
}

function SectionEyebrow({ children }: { children: string }) {
  return (
    <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
      {children}
    </AppText>
  );
}

const PROVIDER_LINE = 'Timing is the standard Canadian schedule — confirm with your provider.';

// ── OVERVIEW ──────────────────────────────────────────────────────────────────
//
// A composition ONLY of the already-redacted companion payload — next health, the
// in-window milestones, the latest logs snippet, and the quick-log. It never
// re-queries: every value here comes from the companion payload the parent already
// loaded (rule #1: no bespoke read to get wrong).

function QuickLogCard({ child, onLogged }: { child: ChildCompanionView; onLogged: () => void }) {
  const [logKind, setLogKind] = useState<LogKind | null>(null);
  return (
    <Card raised className="gap-3">
      <SectionEyebrow>Quick log</SectionEyebrow>
      <View className="flex-row gap-2">
        {LOG_KINDS.map((k) => (
          <Pressable
            key={k.kind}
            accessibilityRole="button"
            accessibilityLabel={k.label}
            onPress={() => setLogKind(k.kind)}
            className="h-11 flex-1 items-center justify-center rounded-full border border-rule bg-card active:opacity-80"
          >
            <AppText variant="meta" className="text-ink-2">
              {k.label}
            </AppText>
          </Pressable>
        ))}
      </View>
      <QuickLogModal
        visible={logKind !== null}
        kind={logKind}
        kids={[
          {
            id: child.id,
            name: child.name,
            milestoneSuggestions: child.milestones.map((m) => m.what),
          },
        ]}
        onClose={() => setLogKind(null)}
        onLogged={onLogged}
      />
    </Card>
  );
}

function OverviewSection({
  child,
  logs,
  onLogged,
  onOpenHealth,
}: {
  child: ChildCompanionView;
  logs: RecentLogView[];
  onLogged: () => void;
  onOpenHealth: (item: UpcomingHealthItem) => void;
}) {
  const inWindowMilestones = child.milestones.filter((m) => m.timing === 'in_window' && !m.done);
  const latestLogs = logs.slice(0, 3);

  return (
    <>
      {child.todayHealth ? (
        <Card className="gap-2">
          <SectionEyebrow>Next up</SectionEyebrow>
          <InfoRow
            when={duePhrase(child.todayHealth.dueInWeeks)}
            stamp={child.todayHealth.dueInWeeks <= 0}
            what={child.todayHealth.what}
            first
            done={child.todayHealth.done}
            onPress={() => child.todayHealth && onOpenHealth(child.todayHealth)}
          />
        </Card>
      ) : null}

      <Card className="gap-3">
        <SectionEyebrow>Around now</SectionEyebrow>
        {inWindowMilestones.length === 0 ? (
          <AppText variant="body" className="text-ink-3">
            Nothing sits squarely in its window today — the Milestones section has the full list.
          </AppText>
        ) : (
          <View className="gap-3">
            {inWindowMilestones.map((m, i) => (
              <InfoRow
                key={m.what}
                when={MILESTONE_TIMING_LABEL[m.timing]}
                stamp
                what={m.what}
                first={i === 0}
              />
            ))}
          </View>
        )}
      </Card>

      <QuickLogCard child={child} onLogged={onLogged} />

      <View className="gap-2">
        <SectionEyebrow>Latest logs</SectionEyebrow>
        <Card className="gap-3">
          {latestLogs.length === 0 ? (
            <AppText variant="body">
              Nothing logged yet — use quick log above to note a feed, a nap, or a milestone.
            </AppText>
          ) : (
            latestLogs.map((log, i) => (
              <View
                key={log.id}
                className={`flex-row items-baseline gap-3 ${i === 0 ? '' : 'border-t border-rule pt-3'}`}
              >
                <AppText variant="body" className="flex-1">
                  {log.summary}
                </AppText>
                <AppText variant="mono" className="text-ink-3">
                  {whenPhrase(log.occurredAt)}
                </AppText>
              </View>
            ))
          )}
        </Card>
      </View>
    </>
  );
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
//
// Past + today + upcoming, from the companion payload's recentlyPassedHealth /
// todayHealth / nextHealth. Each row opens the AppointmentDetailSheet, whose "Mark
// done" POSTs the existing audited done route.

function HealthSection({
  child,
  onOpen,
}: {
  child: ChildCompanionView;
  onOpen: (item: UpcomingHealthItem) => void;
}) {
  const passed = child.recentlyPassedHealth;
  const upcoming = child.nextHealth;

  return (
    <>
      {passed.length > 0 ? (
        <Card className="gap-3">
          <SectionEyebrow>Recently due</SectionEyebrow>
          <View className="gap-3">
            {passed.map((item, i) => (
              <InfoRow
                key={item.key}
                when="was due"
                stamp={false}
                what={item.what}
                first={i === 0}
                done={item.done}
                onPress={() => onOpen(item)}
              />
            ))}
          </View>
          <AppText variant="meta" className="text-ink-3">
            Already handled? Open a row to mark it done.
          </AppText>
        </Card>
      ) : null}

      <Card className="gap-3">
        <SectionEyebrow>Upcoming</SectionEyebrow>
        {upcoming.length === 0 ? (
          <AppText variant="body">
            No routine items left on the standard schedule — keep up periodic visits.
          </AppText>
        ) : (
          <View className="gap-3">
            {upcoming.map((item, i) => (
              <InfoRow
                key={item.key}
                when={duePhrase(item.dueInWeeks)}
                stamp={item.dueInWeeks <= 0}
                what={item.what}
                first={i === 0}
                done={item.done}
                onPress={() => onOpen(item)}
              />
            ))}
          </View>
        )}
        <AppText variant="meta">{PROVIDER_LINE}</AppText>
      </Card>
    </>
  );
}

// ── MILESTONES ────────────────────────────────────────────────────────────────
//
// The full stage list with windows + done state (already in the payload). Each row
// has a one-tap "mark done" via the EXISTING done route (target: 'milestone', which
// the done route's discriminated union covers — no alternate rail needed).

function MilestoneRow({
  what,
  timing,
  done,
  first,
  onMarkDone,
  busy,
}: {
  what: string;
  timing: string;
  done: boolean;
  first: boolean;
  onMarkDone: () => void;
  busy: boolean;
}) {
  return (
    <View className={`flex-row items-start gap-3 ${first ? '' : 'border-t border-rule pt-3'}`}>
      <View className="w-[110px] shrink-0 pt-0.5">
        {done ? (
          <Tag label="done" tone="done" />
        ) : timing === 'around now' ? (
          <Tag label={timing} tone="accent" />
        ) : (
          <AppText
            variant="meta"
            className="text-[11px] uppercase leading-[15px] tracking-eyebrow text-ink-2"
          >
            {timing}
          </AppText>
        )}
      </View>
      <AppText variant="body" className={`flex-1 ${done ? 'text-ink-3' : ''}`}>
        {what}
      </AppText>
      {done ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Mark done: ${what}`}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onMarkDone}
          className={`min-h-8 items-center justify-center self-start rounded-full border border-rule bg-card px-3 py-1.5 ${
            busy ? 'opacity-50' : 'active:opacity-80'
          }`}
        >
          <AppText variant="meta" className="text-ink-2">
            {busy ? '…' : 'Mark done'}
          </AppText>
        </Pressable>
      )}
    </View>
  );
}

function MilestonesSection({
  child,
  onMarkDone,
  pending,
}: {
  child: ChildCompanionView;
  onMarkDone: (what: string) => void;
  pending: string | null;
}) {
  const accentFill = useMeadowColor('accentFill');
  return (
    <Card className="gap-3">
      <SectionEyebrow>Milestones for this stage</SectionEyebrow>
      <View className="gap-3">
        {child.milestones.map((m, i) => (
          <MilestoneRow
            key={m.what}
            what={m.what}
            timing={MILESTONE_TIMING_LABEL[m.timing]}
            done={m.done}
            first={i === 0}
            onMarkDone={() => onMarkDone(m.what)}
            busy={pending === m.what}
          />
        ))}
      </View>
      <View className="mt-1 flex-row items-start gap-2.5 rounded-md bg-accent-tint px-3.5 py-3">
        <Icon name="sparkles" size={16} color={accentFill} />
        <AppText variant="meta" className="flex-1 text-ink">
          Every child grows at their own pace — if something's not happening yet, it's worth asking,
          never a verdict.
        </AppText>
      </View>
    </Card>
  );
}

// ── ROUTINES ──────────────────────────────────────────────────────────────────
//
// HONEST v1, read-only: this week's routine proposal from the village payload
// (RoutineProposalView, already teen-redacted by its mapper). NO editing — an
// editable per-child routine needs a future migration (out of scope). Fetches the
// village payload only while this section is mounted.

function RoutineList({ routine }: { routine: RoutineProposalView }) {
  return (
    <View className="gap-2">
      <View className="gap-1">
        <AppText variant="title">Hale's suggested rhythm this week</AppText>
        <AppText variant="meta" className="text-ink-3">
          Proposed by Hale's weekly run · week of {routine.weekOf}
        </AppText>
      </View>
      <View className="gap-3">
        {routine.items.map((item, i) => (
          <Card key={`${item.kind}-${i}`} className="gap-1">
            {item.teenAttributed ? (
              <>
                <Tag label="private" tone="attention" />
                <AppText variant="meta" className="mt-1 text-ink-3">
                  A teen's item — category only, kept private (rule #1).
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

function RoutinesSection() {
  const { status, data, error, reload } = useApi<MobileVillageResponse>('/api/mobile/village');

  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <ErrorState message={error ?? ''} onRetry={reload} />;
  if (!data) return null;

  if (!data.routine || data.routine.items.length === 0) {
    return (
      <Card className="mt-2 items-center gap-2 py-10">
        <AppText variant="title">No rhythm yet this week</AppText>
        <AppText variant="meta" className="text-center">
          Hale proposes a gentle weekly routine as your village fills in. Check back soon.
        </AppText>
      </Card>
    );
  }

  return <RoutineList routine={data.routine} />;
}

// ── GROWTH ────────────────────────────────────────────────────────────────────
//
// The one NEW data concept, read via the paginated logs route server-filtered with
// the episodeType=measurement param, re-gated client-side in buildMeasureSeries
// (teen redaction applies BY CONSTRUCTION — same shared read).
// A series list per measure kind + a plain View-bar mini-trend, plus an
// Add-measurement sheet POSTing the same log route. NO percentile curves / WHO
// comparisons — raw series only.

const TREND_BAR_MAX_H = 64;
const TREND_BAR_MIN_H = 6;

function MiniTrend({
  readings,
  peak,
}: {
  readings: { id: string; value: number }[];
  peak: number;
}) {
  // A plain View-bar mini-trend of the last few readings (oldest→newest), scaled to
  // the peak. Below two readings a "trend" is a single point — the caller shows the
  // series list alone instead (naps-trend's "don't mislead with one bar" discipline).
  const recent = readings.slice(0, 8).reverse();
  return (
    <View className="h-[72px] flex-row items-end gap-1.5">
      {recent.map((r) => {
        const ratio = peak > 0 ? r.value / peak : 0;
        const height = Math.max(TREND_BAR_MIN_H, Math.round(ratio * TREND_BAR_MAX_H));
        return <View key={r.id} className="flex-1 rounded-md bg-accent" style={{ height }} />;
      })}
    </View>
  );
}

function GrowthSection({ childId }: { childId: string }) {
  const { status, data, error, reload } = useApi<MobileLogsResponse>(
    `/api/mobile/companion/logs?child=${childId}&episodeType=measurement`,
  );
  const [addKind, setAddKind] = useState<MeasureKind | null>(null);
  const ink2 = useMeadowColor('ink2');
  const onAccent = useMeadowColor('onAccent');

  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <ErrorState message={error ?? ''} onRetry={reload} />;
  if (!data) return null;

  const series = buildMeasureSeries(data.logs);
  const hasAny = series.some((s) => s.readings.length > 0);

  return (
    <>
      {!hasAny ? (
        <Card className="items-center gap-2 py-8">
          <AppText variant="title">No measurements yet</AppText>
          <AppText variant="meta" className="text-center">
            Log a weight, height, or head circumference to start a simple growth record.
          </AppText>
        </Card>
      ) : (
        <View className="gap-4">
          {series.map((s) => (
            <Card key={s.kind} className="gap-3">
              <View className="flex-row items-baseline justify-between">
                <SectionEyebrow>{s.label}</SectionEyebrow>
                {s.readings.length > 0 && s.unit ? (
                  <AppText variant="meta" className="text-ink-3">
                    latest {s.readings[0]?.value} {s.unit}
                  </AppText>
                ) : null}
              </View>

              {s.readings.length === 0 ? (
                <AppText variant="body" className="text-ink-3">
                  Nothing logged for {s.label.toLowerCase()} yet.
                </AppText>
              ) : (
                <>
                  {s.readings.length >= 2 ? (
                    <MiniTrend readings={s.readings} peak={s.peak} />
                  ) : null}
                  <View className="gap-3">
                    {s.readings.map((r, i) => (
                      <View
                        key={r.id}
                        className={`flex-row items-baseline gap-3 ${i === 0 ? '' : 'border-t border-rule pt-3'}`}
                      >
                        <AppText variant="body" className="flex-1">
                          {r.value} {r.unit}
                        </AppText>
                        <AppText variant="mono" className="text-ink-3">
                          {whenPhrase(r.occurredAt)}
                        </AppText>
                      </View>
                    ))}
                  </View>
                </>
              )}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add a ${s.label.toLowerCase()} measurement`}
                onPress={() => setAddKind(s.kind)}
                className="min-h-11 flex-row items-center justify-center gap-2 self-start rounded-full border border-rule bg-raised px-4 py-2.5 active:opacity-80"
              >
                <Icon name="plus" size={14} color={ink2} />
                <AppText variant="meta" className="text-ink-2">
                  Add {s.label.toLowerCase()}
                </AppText>
              </Pressable>
            </Card>
          ))}
        </View>
      )}

      {hasAny ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a measurement"
          onPress={() => setAddKind('weight')}
          className="min-h-12 flex-row items-center justify-center gap-2 rounded-full border border-ink bg-ink px-4 active:opacity-80"
        >
          <Icon name="plus" size={15} color={onAccent} />
          <AppText variant="meta" className="text-on-ink">
            Add a measurement
          </AppText>
        </Pressable>
      )}

      <AppText variant="meta" className="text-center text-ink-3">
        {data.nextCursor !== null
          ? 'Showing the most recent measurements — no percentiles or WHO comparisons. Confirm any concern with your provider.'
          : 'A plain record of growth over time — no percentiles or WHO comparisons. Confirm any concern with your provider.'}
      </AppText>

      <GrowthAddSheet
        childId={childId}
        visible={addKind !== null}
        initialKind={addKind ?? 'weight'}
        onClose={() => setAddKind(null)}
        onLogged={reload}
      />
    </>
  );
}

// ── DIARY ─────────────────────────────────────────────────────────────────────
//
// Day-grouped reverse-chron list via the paginated logs route, with edit/delete per
// row (the LogEditSheet PATCHes / DELETEs the audited routes). Reuses the shared
// groupLogsByDay grouping.

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
            <SectionEyebrow>{group.label}</SectionEyebrow>
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
                  <Icon name="chevron.right" size={13} color={iconColor} />
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
  const [healthItem, setHealthItem] = useState<UpcomingHealthItem | null>(null);
  const [pendingMilestone, setPendingMilestone] = useState<string | null>(null);
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

  return (
    <>
      <View className="flex-row items-center justify-between pt-2">
        <View className="flex-1 gap-0.5 pr-3">
          <AppText variant="display">{child.name ?? 'Your child'}</AppText>
          <AppText variant="meta" numberOfLines={1} className="text-ink-3">
            {agePhrase(child.ageMonths)} · {STAGE_LABEL[child.stage]}
          </AppText>
        </View>
        {data.children.length > 1 ? (
          <ChildChips kids={data.children} selectedId={child.id} onSelect={setSelectedId} />
        ) : null}
      </View>

      <SectionRow value={section} onSelect={setSection} />

      {section === 'overview' ? (
        <OverviewSection
          child={child}
          logs={childLogs}
          onLogged={onLogged}
          onOpenHealth={setHealthItem}
        />
      ) : null}
      {section === 'health' ? <HealthSection child={child} onOpen={setHealthItem} /> : null}
      {section === 'growth' ? <GrowthSection childId={child.id} /> : null}
      {section === 'milestones' ? (
        <MilestonesSection
          child={child}
          onMarkDone={markMilestoneDone}
          pending={pendingMilestone}
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
