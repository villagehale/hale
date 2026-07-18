import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon } from '@/components/ui/icon';
import { LogoMark } from '@/components/ui/logo-mark';
import { type MeadowColor, useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { ChildCompanionView, MobileCompanionResponse } from '@/lib/api-types';
import type { QuickLogMatch } from '@/lib/quick-log-detect';
import { FEED_AMOUNT, type FeedAmountValue } from '@/lib/quick-log-payload';
import { useApi } from '@/lib/use-api';

/**
 * The in-thread quick-log DRAFT card (mockup chat flow #6, "Draft log — needs your
 * approval"). When a parent's message reads as a report of their OWN household event
 * (a feed / nap / diaper / milestone) the card shows the drafted row and offers a
 * one-tap Approve. It's the parent's own factual data, so there's NO autonomy
 * approval gate (Regime A) — but it is NEVER auto-written: the parent taps to
 * approve. On success it shows "Logged — added to {child}'s day"; on failure a
 * retryable message (never silent — CLAUDE.md #8). Rule #1: family scoping and audit
 * are enforced server-side by POST /api/mobile/companion/log (the exact web write path).
 *
 * HONEST AMOUNT (the binding fix): a feed writes the parent's ACTUAL amount — a numeric
 * amountMl when the words gave one, else the qualitative feedAmount the words implied
 * ("ate all his lunch" → all). When the words imply NO amount, the card shows the
 * "How much" chips and Approve stays disabled until the parent picks — the server
 * accepts either an amount or a feedAmount, and never a fabricated millilitre figure.
 *
 * The card lazily loads the family's children (only mounts when a log is detected)
 * since the write needs a childId; with more than one child it shows a compact picker,
 * defaulting to the first.
 */

type Status = 'idle' | 'saving' | 'logged' | 'error' | 'rejected';

const KIND_LABEL: Record<QuickLogMatch['kind'], string> = {
  feed: 'Feed',
  nap: 'Nap',
  diaper: 'Diaper',
  milestone: 'Milestone',
};

/** The tagged-row treatment per kind — the prototype's coloured letter square (N/F/D/M)
 * over its tint. Meaning is carried by the letter + the kind label beside it, never
 * colour alone (rule #1 / DESIGN.md). */
const KIND_TAG: Record<QuickLogMatch['kind'], { tag: string; bg: string; fg: MeadowColor }> = {
  feed: { tag: 'F', bg: 'bg-chip-green', fg: 'chipGreenIcon' },
  nap: { tag: 'N', bg: 'bg-chip-blue', fg: 'chipBlueIcon' },
  diaper: { tag: 'D', bg: 'bg-chip-yellow', fg: 'chipYellowIcon' },
  milestone: { tag: 'M', bg: 'bg-chip-red', fg: 'chipRedIcon' },
};

/** value → human phrase for a qualitative feed amount, reusing the sheet's chip labels
 * so the draft and the picker read the same ("All of it", "A little"). */
function feedAmountPhrase(value: FeedAmountValue): string {
  return FEED_AMOUNT.find((a) => a.value === value)?.label ?? value;
}

/** The sub-line under the tagged kind — only what the parser actually lifted, suffixed
 * "from your message" like the prototype. A feed with no amount yet reads honestly as
 * "amount not set" (the chips below resolve it); no field is ever invented. */
function draftSub(match: QuickLogMatch, pickedAmount: FeedAmountValue | null): string {
  const from = 'from your message';
  if (match.kind === 'feed') {
    if (match.amountMl !== undefined) return `${match.amountMl} ml · ${from}`;
    const amount = match.feedAmount ?? pickedAmount ?? undefined;
    return amount ? `${feedAmountPhrase(amount)} · ${from}` : 'How much? Pick below';
  }
  if (match.kind === 'nap') {
    return match.durationMin !== undefined ? `${match.durationMin} min · ${from}` : from;
  }
  if (match.kind === 'diaper') {
    const kind = match.diaperKind;
    return kind ? `${kind[0].toUpperCase()}${kind.slice(1)} · ${from}` : from;
  }
  return match.milestone ? `${match.milestone} · ${from}` : from;
}

/**
 * Build the POST body from the drafted match. A feed carries its numeric amountMl when
 * the words gave one, else the qualitative feedAmount (detected or picked) — NEVER a
 * fabricated default (the binding fix; the server's resolveFeed requires one or the
 * other, and Approve is blocked until it exists). Nap / diaper / milestone fall back to
 * a small sensible default the parent can refine from the Companion timeline.
 */
function buildBody(
  match: QuickLogMatch,
  childId: string,
  occurredAt: string,
  pickedAmount: FeedAmountValue | null,
): Record<string, unknown> {
  if (match.kind === 'feed') {
    if (match.amountMl !== undefined) return { kind: 'feed', childId, amountMl: match.amountMl, occurredAt };
    const feedAmount = match.feedAmount ?? pickedAmount ?? undefined;
    return { kind: 'feed', childId, occurredAt, ...(feedAmount ? { feedAmount } : {}) };
  }
  if (match.kind === 'nap') {
    return { kind: 'nap', childId, durationMin: match.durationMin ?? 30, occurredAt };
  }
  if (match.kind === 'diaper') {
    return { kind: 'diaper', childId, diaperKind: match.diaperKind ?? 'wet', occurredAt };
  }
  return { kind: 'milestone', childId, milestone: match.milestone ?? 'Milestone', occurredAt };
}

/** True when a feed draft has no amount at all (neither numeric nor qualitative,
 * detected or picked) — Approve is withheld and the chips are shown until it's set. */
function feedNeedsAmount(match: QuickLogMatch, pickedAmount: FeedAmountValue | null): boolean {
  return (
    match.kind === 'feed' &&
    match.amountMl === undefined &&
    match.feedAmount === undefined &&
    pickedAmount === null
  );
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
            <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
              {kid.name ?? 'This child'}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The qualitative "How much" chips — shown only when a feed draft carries no amount.
 * Picking one resolves the honest amount so Approve can write a valid feed. */
function AmountChips({
  picked,
  onPick,
}: {
  picked: FeedAmountValue | null;
  onPick: (v: FeedAmountValue) => void;
}) {
  return (
    <View className="mt-2 gap-1.5">
      <AppText variant="eyebrow">How much?</AppText>
      <View className="flex-row flex-wrap gap-2">
        {FEED_AMOUNT.map((a) => {
          const active = picked === a.value;
          return (
            <Pressable
              key={a.value}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              accessibilityState={active ? { selected: true } : {}}
              onPress={() => onPick(a.value)}
              className={`rounded-full border px-3 py-1.5 active:opacity-80 ${
                active ? 'border-ink bg-ink' : 'border-rule bg-card'
              }`}
            >
              <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                {a.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function QuickLogCard({ match }: { match: QuickLogMatch }) {
  const { data } = useApi<MobileCompanionResponse>('/api/mobile/companion');
  const kids = useMemo(() => data?.children ?? [], [data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickedAmount, setPickedAmount] = useState<FeedAmountValue | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const tag = KIND_TAG[match.kind];
  const tagColor = useMeadowColor(tag.fg);
  const brandColor = useMeadowColor('brand');
  const successIcon = useMeadowColor('chipGreenIcon');
  const approveCheck = useMeadowColor('onAccent');

  const childId = selectedId ?? kids[0]?.id ?? null;
  const childName = kids.find((k) => k.id === childId)?.name ?? null;
  const needsAmount = feedNeedsAmount(match, pickedAmount);

  const approve = async () => {
    if (!childId) {
      setStatus('error');
      setError('Add a child in Family first, then log this.');
      return;
    }
    if (needsAmount) return;
    setStatus('saving');
    setError(null);
    const occurredAt = new Date().toISOString();
    try {
      await api('/api/mobile/companion/log', {
        method: 'POST',
        body: JSON.stringify(buildBody(match, childId, occurredAt, pickedAmount)),
      });
      setStatus('logged');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setStatus('error');
      setError((e as Error).message);
    }
  };

  return (
    <View className="mb-3 max-w-[92%] self-start flex-row gap-2.5">
      <LogoMark size={24} />
      <View className="flex-1 rounded-[20px] border border-rule bg-card px-4 py-3.5">
        <View className="mb-2.5 flex-row items-center gap-2">
          <Icon name="sparkle-filled" size={13} color={brandColor} />
          <AppText variant="eyebrow">Draft log — needs your approval</AppText>
        </View>

        <View className="flex-row items-center gap-3">
          <View className={`h-9 w-9 items-center justify-center rounded-[11px] ${tag.bg}`}>
            <AppText
              className="text-[13px]"
              style={{ color: tagColor, fontFamily: 'InstrumentSans_700Bold' }}
            >
              {tag.tag}
            </AppText>
          </View>
          <View className="flex-1">
            <AppText
              className="text-[14px] text-ink"
              style={{ fontFamily: 'InstrumentSans_700Bold' }}
            >
              {KIND_LABEL[match.kind]}
            </AppText>
            <AppText variant="meta" className="text-caption">
              {draftSub(match, pickedAmount)}
            </AppText>
          </View>
        </View>

        {kids.length > 1 && status !== 'logged' && status !== 'rejected' ? (
          <View className="mt-3">
            <ChildPicker kids={kids} selectedId={childId ?? ''} onSelect={setSelectedId} />
          </View>
        ) : null}

        {needsAmount && status !== 'logged' && status !== 'rejected' ? (
          <AmountChips picked={pickedAmount} onPick={setPickedAmount} />
        ) : null}

        {status === 'error' && error ? (
          <AppText variant="meta" className="mt-2 text-berry" accessibilityLiveRegion="polite">
            {error}
          </AppText>
        ) : null}

        {status === 'logged' ? (
          <View className="mt-3.5 flex-row items-center gap-2 rounded-[12px] bg-sage-tint px-3 py-2.5">
            <Icon name="check" size={14} color={successIcon} />
            <AppText variant="meta" className="text-sage">
              Logged — added to {childName ?? 'your child'}&rsquo;s day
            </AppText>
          </View>
        ) : status === 'rejected' ? (
          <View className="mt-3.5 rounded-[12px] bg-raised px-3 py-2.5">
            <AppText variant="meta" className="text-ink-3">
              No problem — nothing was logged.
            </AppText>
          </View>
        ) : (
          <View className="mt-3.5 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reject this draft log"
              onPress={() => setStatus('rejected')}
              className="flex-1 items-center justify-center rounded-[12px] border border-rule bg-card py-3 active:opacity-80"
            >
              <AppText variant="meta" className="text-berry">
                Reject
              </AppText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={needsAmount ? 'Pick how much first, then approve' : 'Approve and log this'}
              accessibilityState={{ disabled: needsAmount || status === 'saving' }}
              disabled={needsAmount || status === 'saving'}
              onPress={approve}
              className={`flex-[1.3] flex-row items-center justify-center gap-1.5 rounded-[12px] bg-brand py-3 ${
                needsAmount ? 'opacity-50' : 'active:opacity-90'
              }`}
            >
              <AppText variant="meta" className="text-on-ink">
                {status === 'saving' ? 'Logging…' : status === 'error' ? 'Try again' : 'Approve'}
              </AppText>
              {status !== 'saving' && status !== 'error' ? (
                <Icon name="check" size={13} color={approveCheck} />
              ) : null}
            </Pressable>
          </View>
        )}

        {status === 'logged' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="View recent logs in Companion"
            onPress={() => router.push('/companion')}
            className="mt-2.5 self-start active:opacity-80"
          >
            <AppText variant="meta" className="text-accent underline">
              View recent logs
            </AppText>
          </Pressable>
        ) : status !== 'rejected' ? (
          <AppText variant="meta" className="mt-2 text-center text-caption">
            Hale never logs without your approval.
          </AppText>
        ) : null}
      </View>
    </View>
  );
}
