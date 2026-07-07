/**
 * First-run activation: the four steps that walk a new family through the core
 * loop, each marked done from real family data (never a "visited?" flag). Pure so
 * the derivation is unit-testable without a DOM, and so the home server component
 * stays a thin caller. Step ① has no cheap server-side "visited village" signal,
 * so it reads as done the moment the family has done anything else — taking any
 * other step means they've already seen the village.
 */

export interface ActivationSignals {
  /** How many village candidates this family has accepted into their week. */
  acceptedCandidateCount: number;
  /** Whether the one Concierge thread holds any message the parent sent. */
  hasUserCoachMessage: boolean;
  /** Whether a co-parent has joined the household. */
  hasCoParent: boolean;
}

export type ActivationStepId = 'village' | 'plan' | 'coach' | 'invite';

export interface ActivationStep {
  id: ActivationStepId;
  label: string;
  href: string;
  done: boolean;
}

export function deriveActivationSteps(signals: ActivationSignals): ActivationStep[] {
  const planDone = signals.acceptedCandidateCount > 0;
  const coachDone = signals.hasUserCoachMessage;
  const inviteDone = signals.hasCoParent;
  const villageDone = planDone || coachDone || inviteDone;

  return [
    {
      id: 'village',
      label: 'see what your village recommends',
      href: '/village',
      done: villageDone,
    },
    { id: 'plan', label: 'add your first activity to your week', href: '/village', done: planDone },
    { id: 'coach', label: 'ask Concierge a question', href: '/coach', done: coachDone },
    { id: 'invite', label: 'invite a parent you trust', href: '/family', done: inviteDone },
  ];
}

export function allStepsDone(signals: ActivationSignals): boolean {
  return deriveActivationSteps(signals).every((step) => step.done);
}
