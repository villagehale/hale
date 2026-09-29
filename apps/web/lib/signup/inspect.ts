import { planBookingStep } from './forms/plan';
import type { PageSnapshot, SignupIdentity } from './types';

export type { FillInstruction, Inspection } from './forms/plan';

/**
 * One step on a provider's own booking page.
 *
 * Field names come from the form adapters (tickets, classes, reservations,
 * appointments). This wrapper is what the runner calls.
 */
export function inspectRegistrationPage(input: {
  snapshot: PageSnapshot;
  identity: SignupIdentity;
  sessionId: string;
  approvedPriceCents: number | null;
  expectedOrigin: string;
  sessionStartsAt?: string | null;
  partySize?: number | null;
  seatingNote?: string | null;
  sessionSelected?: boolean;
}) {
  return planBookingStep({
    snapshot: input.snapshot,
    identity: input.identity,
    sessionId: input.sessionId,
    sessionStartsAt: input.sessionStartsAt ?? null,
    partySize: input.partySize ?? null,
    seatingNote: input.seatingNote ?? null,
    approvedPriceCents: input.approvedPriceCents,
    expectedOrigin: input.expectedOrigin,
    sessionSelected: input.sessionSelected ?? false,
  });
}
