/**
 * The shared PUBLIC-projection primitives for unauthenticated share artifacts
 * (rule #1): the closed activity allow-list every public loader projects through.
 *
 * Privacy is enforced by CONSTRUCTION, not by a teen check:
 *   - A candidate carries a nullable childId. Any child-attributed candidate
 *     (childId !== null) is DROPPED entirely — only family-wide rows are public.
 *   - The output allow-list is closed: activities of {title, kind, summary,
 *     sourceUrl, coverageNote} plus an aggregate endorsement count. No id,
 *     childId, or familyId ever reaches the view.
 */

/** A candidate row as queried for the public view — safe columns only. */
export interface PublicCandidateRow {
  /** Drives the family-wide filter; never surfaced. Null = family-wide. */
  childId: string | null;
  title: string;
  kind: string;
  summary: string;
  sourceUrl: string | null;
  coverageNote: string | null;
  /** Aggregate distinct-family endorsements for this candidate (rule #1: a
   * count only, never an identity). Optional: a loader that does not resolve
   * counts omits it and the activity surfaces 0. */
  endorsementCount?: number;
}

/** A single public activity card — the closed allow-list (rule #1). */
export interface PublicActivity {
  title: string;
  kind: string;
  summary: string;
  sourceUrl: string | null;
  coverageNote: string | null;
  /** Aggregate distinct-family endorsement count — drives "loved by N families"
   * social proof on the artifact. A count, never an identity (rule #1). */
  endorsementCount: number;
}

/** Public-text caps: LLM/web-sourced strings are truncated before they render. */
const TITLE_MAX = 200;
const SUMMARY_MAX = 600;
const COVERAGE_MAX = 300;

/** Keep a sourceUrl only if it is an absolute http(s) URL; else drop it. This
 * fails closed on javascript:/data: schemes and relative paths (rule #1). */
function safeSourceUrl(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : null;
}

/**
 * Projects ONE family-wide candidate onto the closed public activity allow-list
 * (rule #1). Shared by every public artifact (week plan, picks, single activity)
 * so the redaction — text caps, sourceUrl scheme validation, count-only social
 * proof — lives in exactly one place. The caller is responsible for having
 * already dropped child-attributed rows; this never reads childId.
 */
export function toPublicActivity(candidate: PublicCandidateRow): PublicActivity {
  return {
    title: candidate.title.slice(0, TITLE_MAX),
    kind: candidate.kind,
    summary: candidate.summary.slice(0, SUMMARY_MAX),
    sourceUrl: safeSourceUrl(candidate.sourceUrl),
    coverageNote:
      candidate.coverageNote === null ? null : candidate.coverageNote.slice(0, COVERAGE_MAX),
    endorsementCount: candidate.endorsementCount ?? 0,
  };
}
