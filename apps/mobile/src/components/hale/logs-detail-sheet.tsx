import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Sheet } from '@/components/ui/sheet';
import type { LogView, MobileLogsResponse } from '@/lib/api-types';
import { whenPhrase } from '@/lib/format';
import { groupLogsByDay } from '@/lib/logs-group';
import { computeNapsTrend, MIN_DAYS_WITH_DATA, type NapsTrend } from '@/lib/naps-trend';
import { useApi } from '@/lib/use-api';

/** The tallest a trend bar draws (px). Heights scale off the peak day so the
 * chart reads relatively; the codebase idiom is inline pixel heights (no chart
 * dependency exists). */
const MAX_BAR_H = 88;
const MIN_BAR_H = 4;

function napHours(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** The nap-total bars, drawn as plain Views (no chart lib). Below MIN_DAYS_WITH_DATA
 * days with data, the caller shows the calm empty copy instead — a one-bar "trend"
 * would mislead. The axis is labelled honestly: a day beyond the fetched page's
 * coverage reads "not loaded" (a hollow tick), never "no naps", and the header
 * shrinks the window to the loaded span so it never claims 7 days it didn't read. */
function NapsTrendChart({ trend }: { trend: NapsTrend }) {
  const loadedCount = trend.days.filter((day) => day.loaded).length;
  return (
    <View className="gap-2">
      <View className="flex-row items-baseline justify-between">
        <AppText variant="eyebrow">
          {trend.partial ? `Naps · last ${loadedCount} days` : 'Naps · last 7 days'}
        </AppText>
        <AppText variant="meta" className="text-ink-3">
          peak {napHours(trend.peakMin)}
        </AppText>
      </View>
      <View className="h-[104px] flex-row items-end justify-between gap-1.5">
        {trend.days.map((day) => {
          const ratio = trend.peakMin > 0 ? day.totalMin / trend.peakMin : 0;
          const height = day.totalMin > 0 ? Math.max(MIN_BAR_H, Math.round(ratio * MAX_BAR_H)) : 0;
          const state = !day.loaded ? 'not loaded' : day.hasData ? napHours(day.totalMin) : 'no naps';
          return (
            <View key={day.dayKey} className="flex-1 items-center gap-1.5">
              <View
                accessibilityLabel={`${day.label}: ${state}`}
                className={`w-full rounded-md ${
                  !day.loaded ? 'border border-rule border-dashed' : day.hasData ? 'bg-accent' : 'bg-rule'
                }`}
                style={{ height: Math.max(height, day.hasData ? MIN_BAR_H : 2) }}
              />
              <AppText variant="meta" className="text-[10px] leading-none text-ink-3">
                {day.label}
              </AppText>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** One extra numeric line under a log's summary, lifted from the widened view
 * (numbers only — never raw payload / notes). Absent when the row carries none. */
function LogMetrics({ log }: { log: LogView }) {
  const parts: string[] = [];
  if (typeof log.durationMin === 'number') parts.push(napHours(log.durationMin));
  if (typeof log.amountMl === 'number') parts.push(`${log.amountMl} ml`);
  if (log.feedKind) parts.push(log.feedKind);
  if (parts.length === 0) return null;
  return (
    <AppText variant="meta" className="text-ink-3">
      {parts.join(' · ')}
    </AppText>
  );
}

function LogsDetailBody({ childId }: { childId: string }) {
  const { status, data, error, reload } = useApi<MobileLogsResponse>(
    `/api/mobile/companion/logs?child=${childId}`,
  );

  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <ErrorState message={error ?? ''} onRetry={reload} />;
  if (!data) return null;

  const logs = data.logs;
  if (logs.length === 0) {
    return (
      <AppText variant="body" className="py-6">
        Nothing logged yet — note a feed, a nap, or a milestone with quick log and it will show here.
      </AppText>
    );
  }

  // When more pages remain (nextCursor set), this page only covers back to its
  // oldest row (last, newest-first) — days older than that are "not loaded", not
  // "no naps". A null cursor means the whole history was read, so coverage is full.
  const oldest = logs[logs.length - 1]?.occurredAt;
  const coveredSince =
    data.nextCursor !== null && oldest ? new Date(oldest) : undefined;
  const trend = computeNapsTrend(logs, new Date(), coveredSince);
  const groups = groupLogsByDay(logs);

  return (
    <View className="gap-5">
      {trend.enough ? (
        <NapsTrendChart trend={trend} />
      ) : (
        <View className="gap-1.5">
          <AppText variant="eyebrow">
            Naps · last 7 days
          </AppText>
          <AppText variant="body" className="text-ink-3">
            A naps trend needs at least {MIN_DAYS_WITH_DATA} days of naps logged. Keep logging and a
            pattern will appear here.
          </AppText>
        </View>
      )}

      <View className="gap-4">
        {groups.map((group) => (
          <View key={group.dayKey} className="gap-2">
            <AppText variant="eyebrow">
              {group.label}
            </AppText>
            <View className="gap-3">
              {group.logs.map((log, i) => (
                <View
                  key={log.id}
                  className={`gap-0.5 ${i === 0 ? '' : 'border-t border-rule pt-3'}`}
                >
                  <View className="flex-row items-baseline gap-3">
                    <AppText variant="body" className="flex-1">
                      {log.summary}
                    </AppText>
                    <AppText variant="mono" className="text-ink-3">
                      {whenPhrase(log.occurredAt)}
                    </AppText>
                  </View>
                  <LogMetrics log={log} />
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * The glance-detail sheet opened by tapping a child's Home glance card: a
 * day-grouped list of that child's recent logs plus a last-7-days naps trend,
 * computed client-side from the widened logs (durationMin lifted from payload). All
 * data comes from the shared, teen-redacted /api/mobile/companion/logs read (rule
 * #1) — the body only mounts (and fetches) while the sheet is open.
 */
export function LogsDetailSheet({
  childId,
  childName,
  visible,
  onClose,
}: {
  childId: string | null;
  childName: string | null;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      <AppText variant="title" className="mb-4">
        {childName ?? 'Your child'} · recent
      </AppText>
      {visible && childId ? <LogsDetailBody childId={childId} /> : null}
    </Sheet>
  );
}
