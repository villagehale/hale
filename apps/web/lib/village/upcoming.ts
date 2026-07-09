import type { VillageCandidateView } from './mappers';

/**
 * The dated events for the board's "Upcoming" rail: the candidates that carry an
 * `eventDate`, soonest-first. Pure over the already-loaded, already-teen-redacted
 * feed views — a teen-attributed candidate arrives with `eventDate` nulled at the
 * mapper (rule #1), so it can never surface here. No request, no new signal.
 *
 * The feed's own visibility gate has already dropped past events, so this only
 * orders what remains; ties keep their incoming (ranked) order via a stable sort.
 */
export function upcomingDatedCandidates(
  candidates: VillageCandidateView[],
): Array<VillageCandidateView & { eventDate: string }> {
  return candidates
    .filter((c): c is VillageCandidateView & { eventDate: string } => c.eventDate !== null)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
}
