/**
 * The first child's given name, remembered in-process the moment the onboarding
 * draft is submitted (root layout resume effect) so the step-13 "Your village is
 * ready" closer can greet the family by name — the draft is cleared right after the
 * submit, and a celebration is never worth its own network call.
 *
 * Session-scoped by design (a module ref, cleared with the process): the closer is
 * only reached through the same-session resume chain that sets it, and it falls back
 * to neutral copy when absent (a cold start into the tail). A given name only — the
 * sensitive DOB never leaves the draft store (rule #1).
 */
let childName: string | null = null;

export function rememberOnboardingChildName(name: string | null | undefined): void {
  const first = name?.trim();
  childName = first && first.length > 0 ? first : null;
}

export function onboardingChildName(): string | null {
  return childName;
}
