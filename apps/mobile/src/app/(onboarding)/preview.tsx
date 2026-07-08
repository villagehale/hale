import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';
import { API_BASE } from '@/lib/api-client';
import { youngestChildStage } from '@/lib/family-stage';
import { onboardingDraftStore } from '@/lib/onboarding-draft-store';
import {
  type PreviewActivity,
  areaCoarseFromLocation,
  fetchPreview,
} from '@/lib/preview-api';
import { useReducedMotion } from '@/lib/use-reduced-motion';

/**
 * Screen 9 — "Getting things ready." This runs the REAL anonymous preview: it
 * derives a coarse stage from the youngest child's birthday and a coarse area from
 * the draft location, then POSTs the identity-free body to /api/preview (rule #1 —
 * no DOB, no precise address, no name leaves the device). Staged progress lines
 * play while the request runs; then it shows a REAL teaser built from the first
 * returned activity, or skips gracefully.
 *
 * Honesty rules it must never break:
 *   - It NEVER fabricates results. A timeout, failure, or empty response shows the
 *     "your village will be ready when you are" line — not invented activities.
 *   - Teen-only families get [] from the API by design (rule #1: a teenager's stage
 *     is never queried). That surfaces the honest privacy-first teen line, not a
 *     fake activity.
 *   - It NEVER blocks the flow: the button to continue is always reachable.
 *
 * SEAM: the mockup's screen 10 is a CONNECT step (Gmail/Calendar/Drive). Those
 * connectors are an unmerged PR — NOT built here. The flow deliberately goes 9 → 11
 * (the consent closer). When connect lands, insert its route between this screen's
 * "Continue" target and consent.
 */

const PROGRESS_LINES = [
  'Looking around your neighbourhood…',
  'Finding what fits your family…',
  'Gathering a few good options…',
];

type Phase =
  | { kind: 'loading' }
  | { kind: 'teaser'; first: PreviewActivity; area: string; others: number }
  | { kind: 'teen' }
  | { kind: 'skip' };

export default function PreviewScreen() {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [lineIndex, setLineIndex] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    (async () => {
      const draft = await onboardingDraftStore.load();
      const stage = draft ? youngestChildStage(draft.children) : null;
      const area = draft ? areaCoarseFromLocation(draft.location) : null;

      // No dated child at all — nothing coarse to ask for. Skip honestly.
      if (!stage) {
        setPhase({ kind: 'skip' });
        return;
      }

      // Teen-only families get an empty list by design (rule #1). Short-circuit
      // BEFORE the fetch — the server answers [] for a teen anyway, so querying
      // burns a rate-limit slot and stalls the flow behind a request that can't
      // return anything. The distinct teen line is the honest, privacy-first message.
      if (stage === 'teenager') {
        setPhase({ kind: 'teen' });
        return;
      }

      // No coarse area given — there's no honest place to search. Skip rather than
      // ask the model to invent candidates for a placeholder area (the web funnel
      // refuses to search without an area for the same reason).
      if (!area) {
        setPhase({ kind: 'skip' });
        return;
      }

      const activities = await fetchPreview(
        { stage, areaCoarse: area, interests: draft?.intents ?? [] },
        API_BASE,
      );

      const [first] = activities;
      if (!first) {
        setPhase({ kind: 'skip' });
        return;
      }
      setPhase({ kind: 'teaser', first, area, others: activities.length - 1 });
    })();
  }, []);

  // Cycle the progress lines while loading (skipped under reduce-motion — the first
  // line stays put rather than shuffling).
  useEffect(() => {
    if (phase.kind !== 'loading' || reduced) return;
    const timer = setInterval(() => {
      setLineIndex((i) => (i + 1) % PROGRESS_LINES.length);
    }, 1400);
    return () => clearInterval(timer);
  }, [phase.kind, reduced]);

  const toConsent = () => router.push('/(onboarding)/consent');

  return (
    <Screen scroll className="gap-8">
      <View className="gap-2 pt-6">
        <AppText variant="display">Getting things ready</AppText>
        <AppText variant="body">
          A first look at what Hale can find near you — a taste, before you're even signed in.
        </AppText>
      </View>

      {phase.kind === 'loading' ? <LoadingLines index={lineIndex} /> : null}
      {phase.kind === 'teaser' ? (
        <Teaser first={phase.first} area={phase.area} others={phase.others} />
      ) : null}
      {phase.kind === 'teen' ? <TeenLine /> : null}
      {phase.kind === 'skip' ? <SkipLine /> : null}

      {phase.kind !== 'loading' ? (
        <Button label="Continue" onPress={toConsent} className="mt-2" />
      ) : null}
    </Screen>
  );
}

function LoadingLines({ index }: { index: number }) {
  const accent = useMeadowColor('accentFill');
  return (
    <View className="gap-4 py-4" accessibilityLiveRegion="polite">
      <View className="h-12 w-12 items-center justify-center rounded-full bg-accent-tint">
        <Icon name="sparkles" size={22} color={accent} />
      </View>
      <AppText variant="title" className="text-ink-2">
        {PROGRESS_LINES[index]}
      </AppText>
    </View>
  );
}

function Teaser({ first, area, others }: { first: PreviewActivity; area: string; others: number }) {
  const accent = useMeadowColor('accentFill');
  return (
    <View className="gap-4" accessibilityLiveRegion="polite">
      <View className="gap-3 rounded-lg border border-rule bg-card p-4">
        <View className="flex-row items-center gap-3">
          <View className="h-9 w-9 items-center justify-center rounded-full bg-accent-tint">
            <Icon name="mappin.and.ellipse" size={17} color={accent} />
          </View>
          <AppText variant="meta" className="text-ink-3">
            Near {area}
          </AppText>
        </View>
        <AppText variant="section">{first.title}</AppText>
        <AppText variant="body" className="text-ink-2">
          {first.summary}
        </AppText>
        {first.coverageNote ? (
          <AppText variant="meta" className="text-ink-3">
            {first.coverageNote}
          </AppText>
        ) : null}
      </View>
      {others > 0 ? (
        <AppText variant="body">
          …and {others} more waiting for you. Finish setting up to see them all.
        </AppText>
      ) : (
        <AppText variant="body">More like this is waiting once your family is set up.</AppText>
      )}
    </View>
  );
}

function TeenLine() {
  const sky = useMeadowColor('ink2');
  return (
    <View className="gap-3 rounded-lg border border-rule bg-card p-4">
      <View className="h-9 w-9 items-center justify-center rounded-full bg-sky-tint">
        <Icon name="lock.shield.fill" size={17} color={sky} />
      </View>
      <AppText variant="section">Your teen's privacy comes first</AppText>
      <AppText variant="body" className="text-ink-2">
        For children 13 and older, Hale holds back a public activity feed — it supports you quietly
        instead, and never surfaces their world without their say-so.
      </AppText>
    </View>
  );
}

function SkipLine() {
  const accent = useMeadowColor('accentFill');
  return (
    <View className="gap-3 rounded-lg border border-rule bg-card p-4">
      <View className="h-9 w-9 items-center justify-center rounded-full bg-accent-tint">
        <Icon name="sparkles" size={17} color={accent} />
      </View>
      <AppText variant="section">Your village will be ready when you are</AppText>
      <AppText variant="body" className="text-ink-2">
        Finish setting up and Hale will start gathering what's nearby for your family.
      </AppText>
    </View>
  );
}
