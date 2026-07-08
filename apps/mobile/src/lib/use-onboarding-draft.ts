import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type OnboardingDraft, emptyDraft } from './onboarding-draft';
import { onboardingDraftStore } from './onboarding-draft-store';

/**
 * A patch is either a partial draft or an updater that receives the LATEST
 * persisted draft. Screens editing arrays (children) must use the updater form —
 * a plain object built from a screen's own stale snapshot would persist that
 * snapshot over siblings added on later screens.
 */
export type DraftPatch =
  | Partial<OnboardingDraft>
  | ((latest: OnboardingDraft) => Partial<OnboardingDraft>);

/**
 * The shared draft state for the split onboarding steps (SecureStore, rule #1).
 *
 * Correctness posture (expo-router keeps backed-into screens MOUNTED, so every
 * screen's snapshot can be stale):
 * - `update` is read-modify-write: it loads the latest persisted draft, applies
 *   the patch to THAT, saves, then reflects the result locally. All writes are
 *   serialized through one promise chain so two screens can't interleave.
 * - The screen REHYDRATES on focus, so backing into a screen shows the latest
 *   draft, not the snapshot from when it first mounted.
 * - Patches arriving before first hydration are applied optimistically to the
 *   visible state and BUFFERED, then re-applied against the loaded draft — a
 *   consent tap or first keystrokes in the load window are never dropped.
 */
export function useOnboardingDraft(initial: () => OnboardingDraft = emptyDraft) {
  const [draft, setDraft] = useState<OnboardingDraft>(initial);
  const hydrated = useRef(false);
  const pending = useRef<DraftPatch[]>([]);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());

  const applyPatch = useCallback((patch: DraftPatch) => {
    writeQueue.current = writeQueue.current.then(async () => {
      const latest = (await onboardingDraftStore.load()) ?? emptyDraft();
      const resolved = typeof patch === 'function' ? patch(latest) : patch;
      const next = { ...latest, ...resolved };
      await onboardingDraftStore.save(next);
      setDraft(next);
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    onboardingDraftStore.load().then((saved) => {
      if (!mounted) return;
      if (saved) setDraft(saved);
      hydrated.current = true;
      for (const patch of pending.current) applyPatch(patch);
      pending.current = [];
    });
    return () => {
      mounted = false;
    };
  }, [applyPatch]);

  // Backed-into screens stay mounted — refresh their view of the draft whenever
  // they regain focus, after any in-flight writes settle.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      writeQueue.current
        .then(() => onboardingDraftStore.load())
        .then((saved) => {
          if (live && saved && hydrated.current) setDraft(saved);
        });
      return () => {
        live = false;
      };
    }, []),
  );

  const update = useCallback(
    (patch: DraftPatch) => {
      // Optimistic local echo so pre-hydration keystrokes/toggles are visible.
      setDraft((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }));
      if (hydrated.current) applyPatch(patch);
      else pending.current.push(patch);
    },
    [applyPatch],
  );

  return { draft, update };
}
