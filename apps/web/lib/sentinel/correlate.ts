import type { CorrelatedEventRef, ExtractionKind } from './types';

/**
 * Deterministic correlation — matches an extraction against the family's KNOWN
 * occasions (B1's family_events calendar + B3's week_plans items) so a
 * cancellation/reschedule can point at the row it changes, and a `new_event`
 * that actually duplicates something already tracked isn't proposed twice. This
 * is plain code, not the LLM (per the ticket: "testable without model") — title
 * and time proximity are computed with fixed, documented rules, so a fixture
 * calendar's expected match is provable without a live call.
 *
 * An unmatched extraction (no candidate clears the threshold) returns null —
 * the caller treats that as a genuinely new occasion, never a forced match.
 */

export interface CorrelationCandidate {
  ref: CorrelatedEventRef;
  title: string;
  /** ISO instant, or null for a day-coarse week_plan item with no time-of-day
   * (health due-windows). A null-time candidate never matches (no time to
   * compare against) — title alone is too weak a signal on its own. */
  startsAt: string | null;
}

export interface CorrelationInput {
  kind: ExtractionKind;
  title: string;
  originalTime: string | null;
  newTime: string | null;
}

/** Candidates within this many hours of the extraction's target time are
 * considered. Wide enough to absorb a day-coarse week_plan item (stored at
 * family-local midnight) being compared against an extraction with a stated
 * time-of-day, and minor timezone slack — narrow enough that a same-week but
 * different-day occasion never matches. */
const TIME_WINDOW_HOURS = 30;

/** Minimum title similarity (Dice coefficient over word tokens) for a candidate
 * to be considered a match, once it's already within the time window. Tuned so
 * one strong shared word ("swim", "recital") out of a short title clears it,
 * while two unrelated short titles don't. */
const TITLE_MATCH_THRESHOLD = 0.34;

const STOPWORDS = new Set(['the', 'a', 'an', 'for', 'at', 'on', 'with', 'to', 'and', 'of']);

function tokenize(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Dice coefficient: 2·|A∩B| / (|A|+|B|). 0 when either title tokenizes empty. */
function titleSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared += 1;
  return (2 * shared) / (setA.size + setB.size);
}

function hoursBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60);
}

/**
 * The extraction's relevant time to correlate against: cancellation/reschedule
 * match the EXISTING occasion's original time (that's the row being changed);
 * new_event tries its stated time (catching an invite that duplicates a
 * placement already tracked); reminder_only/unclear have nothing concrete
 * enough to correlate and are never attempted.
 */
function targetTime(input: CorrelationInput): string | null {
  if (input.kind === 'new_event') return input.newTime;
  if (input.kind === 'cancellation' || input.kind === 'reschedule') return input.originalTime;
  return null;
}

/**
 * Best matching known occasion for `input`, or null when none clears both the
 * time window and the title-similarity threshold. Ties (equal similarity)
 * resolve to the candidate with the smaller time delta.
 */
export function correlateExtraction(
  input: CorrelationInput,
  candidates: readonly CorrelationCandidate[],
): CorrelatedEventRef | null {
  const target = targetTime(input);
  if (!target) return null;

  let best: { ref: CorrelatedEventRef; score: number; deltaHours: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.startsAt) continue;
    const deltaHours = hoursBetween(target, candidate.startsAt);
    if (deltaHours > TIME_WINDOW_HOURS) continue;
    const score = titleSimilarity(input.title, candidate.title);
    if (score < TITLE_MATCH_THRESHOLD) continue;
    if (!best || score > best.score || (score === best.score && deltaHours < best.deltaHours)) {
      best = { ref: candidate.ref, score, deltaHours };
    }
  }
  return best?.ref ?? null;
}
