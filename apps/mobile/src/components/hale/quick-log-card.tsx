import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon } from '@/components/ui/icon';
import { LogoMark } from '@/components/ui/logo-mark';
import { type MeadowColor, useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { ChildCompanionView, MobileCompanionResponse } from '@/lib/api-types';
import type { QuickLogMatch } from '@/lib/quick-log-detect';
import { type DraftPicks, EMPTY_PICKS, buildDraftBody, draftNeedsInput } from '@/lib/quick-log-draft';
import { DIAPER_KIND, FEED_AMOUNT, type FeedAmountValue } from '@/lib/quick-log-payload';
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
 * NO FABRICATION: the card writes only what the parent actually gave. Each kind has one
 * datum the server requires — feed amount, nap duration, diaper kind, milestone text —
 * and when the detector didn't lift it the card shows the picker (chips / a text field)
 * and holds Approve disabled until it's set (see quick-log-draft.ts, which mirrors the
 * server resolvers). No 120 ml, no 30 min, no default "wet", no literal "Milestone".
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

/** The nap-duration chips (card presentation; each maps to a durationMin the server
 * accepts). Common toddler nap lengths — the parent taps the closest, or refines later
 * from the Companion timeline. */
const NAP_DURATIONS: readonly { label: string; min: number }[] = [
  { label: '30m', min: 30 },
  { label: '45m', min: 45 },
  { label: '1h', min: 60 },
  { label: '1h 30m', min: 90 },
  { label: '2h', min: 120 },
];

const cap = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;

/** value → human phrase for a qualitative feed amount, reusing the sheet's chip labels
 * so the draft and the picker read the same ("All of it", "A little"). */
function feedAmountPhrase(value: FeedAmountValue): string {
  return FEED_AMOUNT.find((a) => a.value === value)?.label ?? value;
}

/**
 * The sub-line under the tagged kind. A DETECTED value reads "<value> · from your
 * message"; a value the parent PICKED in the card reads as just the value (no false
 * "from your message" attribution); an unresolved field reads as a "pick below" prompt.
 * No field is ever invented.
 */
function draftSub(match: QuickLogMatch, picks: DraftPicks): string {
  const from = 'from your message';
  if (match.kind === 'feed') {
    if (match.amountMl !== undefined) return `${match.amountMl} ml · ${from}`;
    if (match.feedAmount) return `${feedAmountPhrase(match.feedAmount)} · ${from}`;
    if (picks.feedAmount) return feedAmountPhrase(picks.feedAmount);
    return 'How much? Pick below';
  }
  if (match.kind === 'nap') {
    if (match.durationMin !== undefined) return `${match.durationMin} min · ${from}`;
    if (picks.durationMin !== null) return `${picks.durationMin} min`;
    return 'How long? Pick below';
  }
  if (match.kind === 'diaper') {
    if (match.diaperKind) return `${cap(match.diaperKind)} · ${from}`;
    if (picks.diaperKind) return cap(picks.diaperKind);
    return 'Which kind? Pick below';
  }
  if (match.milestone) return `${match.milestone} · ${from}`;
  const typed = picks.milestone.trim();
  return typed ? typed : 'Add a note to log it';
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

/** The picker chip row — shown for the datum a draft still needs (feed amount / nap
 * duration / diaper kind). Picking one resolves the honest value so Approve unlocks. */
function PickerChips({
  label,
  chips,
}: {
  label: string;
  chips: { key: string; label: string; active: boolean; onPress: () => void }[];
}) {
  return (
    <View className="mt-3 gap-1.5">
      <AppText variant="eyebrow">{label}</AppText>
      <View className="flex-row flex-wrap gap-2">
        {chips.map((c) => (
          <Pressable
            key={c.key}
            accessibilityRole="button"
            accessibilityLabel={c.label}
            accessibilityState={c.active ? { selected: true } : {}}
            onPress={c.onPress}
            className={`rounded-full border px-3 py-1.5 active:opacity-80 ${
              c.active ? 'border-ink bg-ink' : 'border-rule bg-card'
            }`}
          >
            <AppText variant="meta" className={c.active ? 'text-on-ink' : 'text-ink-2'}>
              {c.label}
            </AppText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** The milestone note field — a draft with no lifted text prefills EMPTY and Approve
 * stays disabled until the parent types something (never the literal "Milestone"). */
function MilestoneInput({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');
  return (
    <View className="mt-3 gap-1.5">
      <AppText variant="eyebrow">What did they do?</AppText>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="e.g. first steps"
        placeholderTextColor={placeholderColor}
        accessibilityLabel="Milestone description"
        style={{ color: inputColor, fontFamily: 'InstrumentSans_400Regular' }}
        className="min-h-10 rounded-[12px] border border-rule bg-canvas px-3 py-2 text-[15px]"
      />
    </View>
  );
}

/** The picker for whatever datum the draft still needs, by kind. */
function DraftInput({
  match,
  picks,
  setPicks,
}: {
  match: QuickLogMatch;
  picks: DraftPicks;
  setPicks: (fn: (p: DraftPicks) => DraftPicks) => void;
}) {
  if (match.kind === 'feed') {
    return (
      <PickerChips
        label="How much?"
        chips={FEED_AMOUNT.map((a) => ({
          key: a.value,
          label: a.label,
          active: picks.feedAmount === a.value,
          onPress: () => setPicks((p) => ({ ...p, feedAmount: a.value })),
        }))}
      />
    );
  }
  if (match.kind === 'nap') {
    return (
      <PickerChips
        label="How long?"
        chips={NAP_DURATIONS.map((d) => ({
          key: String(d.min),
          label: d.label,
          active: picks.durationMin === d.min,
          onPress: () => setPicks((p) => ({ ...p, durationMin: d.min })),
        }))}
      />
    );
  }
  if (match.kind === 'diaper') {
    return (
      <PickerChips
        label="Which kind?"
        chips={DIAPER_KIND.map((d) => ({
          key: d.value,
          label: d.label,
          active: picks.diaperKind === d.value,
          onPress: () => setPicks((p) => ({ ...p, diaperKind: d.value })),
        }))}
      />
    );
  }
  return (
    <MilestoneInput
      value={picks.milestone}
      onChange={(t) => setPicks((p) => ({ ...p, milestone: t }))}
    />
  );
}

export function QuickLogCard({ match }: { match: QuickLogMatch }) {
  const { data } = useApi<MobileCompanionResponse>('/api/mobile/companion');
  const kids = useMemo(() => data?.children ?? [], [data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picks, setPicks] = useState<DraftPicks>(EMPTY_PICKS);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const tag = KIND_TAG[match.kind];
  const tagColor = useMeadowColor(tag.fg);
  const brandColor = useMeadowColor('brand');
  const successIcon = useMeadowColor('chipGreenIcon');
  const approveCheck = useMeadowColor('onAccent');

  const childId = selectedId ?? kids[0]?.id ?? null;
  const childName = kids.find((k) => k.id === childId)?.name ?? null;
  const needsInput = draftNeedsInput(match, picks);
  const editable = status !== 'logged' && status !== 'rejected';

  const approve = async () => {
    if (!childId) {
      setStatus('error');
      setError('Add a child in Family first, then log this.');
      return;
    }
    if (needsInput) return;
    setStatus('saving');
    setError(null);
    const occurredAt = new Date().toISOString();
    try {
      await api('/api/mobile/companion/log', {
        method: 'POST',
        body: JSON.stringify(buildDraftBody(match, childId, occurredAt, picks)),
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
              {draftSub(match, picks)}
            </AppText>
          </View>
        </View>

        {kids.length > 1 && editable ? (
          <View className="mt-3">
            <ChildPicker kids={kids} selectedId={childId ?? ''} onSelect={setSelectedId} />
          </View>
        ) : null}

        {needsInput && editable ? (
          <DraftInput match={match} picks={picks} setPicks={setPicks} />
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
              accessibilityLabel={needsInput ? 'Add the missing detail first, then approve' : 'Approve and log this'}
              accessibilityState={{ disabled: needsInput || status === 'saving' }}
              disabled={needsInput || status === 'saving'}
              onPress={approve}
              className={`flex-[1.3] flex-row items-center justify-center gap-1.5 rounded-[12px] bg-brand py-3 ${
                needsInput ? 'opacity-50' : 'active:opacity-90'
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
