import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api-client';
import type { ChildCompanionView, MobileCompanionResponse } from '@/lib/api-types';
import { whenPhrase } from '@/lib/format';
import type { QuickLogMatch } from '@/lib/quick-log-detect';
import { useApi } from '@/lib/use-api';

/**
 * The in-thread quick-log confirm card. When a parent's message reads as a report
 * of their OWN household event (a feed / nap / milestone) the card offers a
 * one-tap "Log it". It's the parent's own factual data, so there's NO approval
 * gate (Regime A) — but it is NEVER auto-written: the parent taps to confirm.
 * On success it shows an honest "✓ Logged"; on failure a retryable message
 * (never silent — CLAUDE.md #8). Rule #1: family scoping and audit are enforced
 * server-side by POST /api/mobile/companion/log (the exact web write path).
 *
 * The card lazily loads the family's children (only mounts when a log is
 * detected) since the write needs a childId; with more than one child it shows a
 * compact picker, defaulting to the first.
 */

type Status = 'idle' | 'saving' | 'logged' | 'error' | 'dismissed';

function summarise(match: QuickLogMatch): string {
  if (match.kind === 'feed') {
    return match.amountMl !== undefined ? `${match.amountMl}ml feed` : 'a feed';
  }
  if (match.kind === 'nap') {
    return match.durationMin !== undefined ? `${match.durationMin}min nap` : 'a nap';
  }
  return match.milestone ? `milestone: ${match.milestone}` : 'a milestone';
}

/** Build the POST body from the parsed match. Values the parser couldn't lift
 * (an amountless feed, a durationless nap, a bare milestone) fall back to a small
 * sensible default so a one-tap log always writes a valid row; the parent can
 * refine it later from the Companion timeline. */
function buildBody(match: QuickLogMatch, childId: string, occurredAt: string): Record<string, unknown> {
  if (match.kind === 'feed') {
    return { kind: 'feed', childId, amountMl: match.amountMl ?? 120, occurredAt };
  }
  if (match.kind === 'nap') {
    return { kind: 'nap', childId, durationMin: match.durationMin ?? 30, occurredAt };
  }
  return { kind: 'milestone', childId, milestone: match.milestone ?? 'Milestone', occurredAt };
}

const KIND_LABEL: Record<QuickLogMatch['kind'], string> = {
  feed: 'Feed',
  nap: 'Nap',
  milestone: 'Milestone',
};

/** One `{ label, value }` line per field the log ACTUALLY captured — the kind and
 * the real logged time always, plus a detail ONLY when the parser lifted it from
 * the parent's words (an amount, a duration, a milestone). A field the parser
 * missed (and the write defaulted) is deliberately NOT shown, so the card never
 * claims the parent said something they didn't. */
function loggedRows(match: QuickLogMatch, occurredAt: string): { label: string; value: string }[] {
  const rows = [
    { label: 'Kind', value: KIND_LABEL[match.kind] },
    { label: 'Time', value: whenPhrase(occurredAt) },
  ];
  if (match.kind === 'feed' && match.amountMl !== undefined) {
    rows.push({ label: 'Amount', value: `${match.amountMl}ml` });
  } else if (match.kind === 'nap' && match.durationMin !== undefined) {
    rows.push({ label: 'Duration', value: `${match.durationMin}min` });
  } else if (match.kind === 'milestone' && match.milestone) {
    rows.push({ label: 'Detail', value: match.milestone });
  }
  return rows;
}

function ChildPicker({
  kids,
  selectedId,
  onSelect,
}: {
  kids: ChildCompanionView[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {kids.map((kid) => {
        const active = kid.id === selectedId;
        return (
          <Pressable
            key={kid.id}
            accessibilityRole="button"
            accessibilityLabel={kid.name ?? 'this child'}
            accessibilityState={active ? { selected: true } : {}}
            onPress={() => onSelect(kid.id)}
            className={`rounded-full border px-3 py-1.5 active:opacity-80 ${
              active ? 'border-ink bg-ink' : 'border-rule bg-card'
            }`}
          >
            <AppText variant="meta" className={active ? 'text-canvas' : 'text-ink-2'}>
              {kid.name ?? 'This child'}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function QuickLogCard({ match }: { match: QuickLogMatch }) {
  const { data } = useApi<MobileCompanionResponse>('/api/mobile/companion');
  const kids = useMemo(() => data?.children ?? [], [data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [loggedAt, setLoggedAt] = useState<string | null>(null);

  const childId = selectedId ?? kids[0]?.id ?? null;
  const label = summarise(match);

  const confirm = async () => {
    if (!childId) {
      setStatus('error');
      setError('Add a child in Family first, then log this.');
      return;
    }
    setStatus('saving');
    setError(null);
    // The same instant is written AND displayed — the logged card shows the real
    // occurredAt, never a re-derived "now" that would drift from the row.
    const occurredAt = new Date().toISOString();
    try {
      await api('/api/mobile/companion/log', {
        method: 'POST',
        body: JSON.stringify(buildBody(match, childId, occurredAt)),
      });
      setLoggedAt(occurredAt);
      setStatus('logged');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setStatus('error');
      setError((e as Error).message);
    }
  };

  if (status === 'dismissed') return null;

  if (status === 'logged' && loggedAt) {
    // The structured confirm (mockup screen 2): the rows the log actually captured
    // + a link to the Companion timeline where the row now lives. No fabricated
    // fields — loggedRows shows only what the parser lifted.
    const rows = loggedRows(match, loggedAt);
    return (
      <View className="mb-3 max-w-[92%] self-end gap-2 rounded-lg border border-rule bg-sage-tint px-4 py-3.5">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-sage">
          ✓ Logged
        </AppText>
        <View className="gap-1.5">
          {rows.map((row) => (
            <View key={row.label} className="flex-row items-baseline justify-between gap-3">
              <AppText variant="meta" className="text-ink-3">
                {row.label}
              </AppText>
              <AppText variant="body" className="flex-1 text-right text-ink">
                {row.value}
              </AppText>
            </View>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="View recent logs in Companion"
          onPress={() => router.push('/companion')}
          className="mt-0.5 self-start active:opacity-80"
        >
          <AppText variant="meta" className="text-accent underline">
            View recent logs
          </AppText>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="mb-3 max-w-[92%] self-end rounded-lg rounded-tr-sm border border-rule bg-card px-4 py-3">
      <AppText variant="body" className="text-ink">
        Log {label} now?
      </AppText>

      {kids.length > 1 ? (
        <View className="mt-2">
          <ChildPicker kids={kids} selectedId={childId ?? ''} onSelect={setSelectedId} />
        </View>
      ) : null}

      {status === 'error' && error ? (
        <AppText variant="meta" className="mt-2 text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <View className="mt-3 flex-row gap-2">
        <Button
          label={status === 'saving' ? 'Logging…' : status === 'error' ? 'Try again' : 'Log it'}
          onPress={confirm}
          className="h-11 flex-1"
        />
        <Button
          label="Dismiss"
          variant="secondary"
          onPress={() => setStatus('dismissed')}
          className="h-11"
        />
      </View>
    </View>
  );
}
