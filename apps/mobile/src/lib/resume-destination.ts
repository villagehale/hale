/**
 * The pure routing decision the root layout's resume effect makes after an authed
 * load, factored out of the effect so the 13-step order's post-auth entry point is
 * unit-testable (the effect itself needs React + expo-router + async I/O).
 *
 * A-prime order: create-account is the consent+auth step; the moment provisioning
 * lands the just-onboarded parent enters the POST-auth tail at step 11 — the
 * getting-ready screen (/preview) → connect → the "your village is ready" closer.
 * `null` means "make no navigation" (leave the gate to act); '/(tabs)' is only for
 * the held paths where there's nothing to submit or the submit failed, so the gate's
 * suppressed tabs-bounce is completed here instead.
 */
export type ResumeOutcome =
  | { kind: 'submitted' }
  | { kind: 'no-draft'; held: boolean }
  | { kind: 'failed'; held: boolean };

export function resumeDestination(outcome: ResumeOutcome): '/preview' | '/(tabs)' | null {
  if (outcome.kind === 'submitted') return '/preview';
  return outcome.held ? '/(tabs)' : null;
}
