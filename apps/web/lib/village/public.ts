import { type Database, schema } from '@hale/db';
import { desc, eq, sql } from 'drizzle-orm';

/**
 * The PUBLIC, unauthenticated share view of a family's week plan (rule #1). This
 * module is the security-critical seam: the page and the OG image both render
 * ONLY what `toPublicWeekPlan` returns, and `loadSharedWeekPlan` selects ONLY
 * the columns below — it deliberately never joins `children`, so a child's name,
 * date_of_birth, precise age, or any teen content is structurally unreachable
 * from this path.
 *
 * Privacy is enforced by CONSTRUCTION, not by a teen check:
 *   - A candidate carries a nullable childId. Any child-attributed candidate
 *     (childId !== null) is DROPPED entirely — only family-wide rows are public.
 *     This makes a teen leak impossible without ever deriving a stage or joining
 *     children: there is no child linkage to leak, and no per-child text to
 *     surface.
 *   - The output allow-list is closed: weekOf, areaCoarse (coarse FSA/city), and
 *     activities of {title, kind, summary, sourceUrl, coverageNote}. No id,
 *     childId, familyId, or proposal item text ever reaches the view.
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

/** A proposal row as queried for the public view — its jsonb items carry a
 * childId we never echo; only weekOf is surfaced. */
export interface PublicProposalRow {
  weekOf: string;
  items: schema.RoutineProposal['items'];
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

/** The public week plan — the only shape that crosses to the public page/OG. */
export interface PublicWeekPlan {
  weekOf: string;
  /** Coarse area (FSA / city) or null when the family opted out. Never precise. */
  areaCoarse: string | null;
  activities: PublicActivity[];
}

export interface PublicWeekPlanInput {
  proposal: PublicProposalRow;
  areaCoarse: string | null;
  candidates: PublicCandidateRow[];
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

/**
 * Privacy mapper (rule #1). Drops every child-attributed candidate and projects
 * the survivors onto the closed activity allow-list. Untrusted (LLM/web-sourced)
 * text is length-capped and the sourceUrl is validated to an absolute http(s)
 * URL before it crosses to the public page. The proposal's own items are NOT
 * surfaced (they carry per-child stage notes); only its weekOf is used.
 */
export function toPublicWeekPlan(input: PublicWeekPlanInput): PublicWeekPlan {
  const activities = input.candidates
    .filter((candidate) => candidate.childId === null)
    .map(toPublicActivity);

  return {
    weekOf: input.proposal.weekOf,
    areaCoarse: input.areaCoarse,
    activities,
  };
}

/** A share link surfaces at most this many (most-recent) candidates, so it can
 * never return the family's entire all-time candidate history. */
const PUBLIC_CANDIDATE_LIMIT = 24;

/** A correlated subquery yielding the distinct-family endorsement count for the
 * outer candidate row, cast to int. COUNT only — never any family identity. */
function endorsementCountSubquery() {
  return sql<number>`(
    select count(*)::int from ${schema.villageEndorsements}
    where ${schema.villageEndorsements.candidateId} = ${schema.villageCandidates.id}
  )`;
}

/**
 * Resolves a share token to its public week plan, or null for an unknown token.
 * Selects ONLY privacy-safe columns and NEVER joins `children` (rule #1). The
 * proposal lookup joins `families` solely for the coarse area; the candidate
 * lookup pulls family-wide-filterable rows, newest first and bounded
 * (PUBLIC_CANDIDATE_LIMIT). The mapper does the redaction.
 */
export async function loadSharedWeekPlan(
  token: string,
  database: Database,
): Promise<PublicWeekPlan | null> {
  const proposalRows = await database
    .select({
      proposalFamilyId: schema.routineProposals.familyId,
      weekOf: schema.routineProposals.weekOf,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.routineProposals)
    .innerJoin(schema.families, eq(schema.families.id, schema.routineProposals.familyId))
    .where(eq(schema.routineProposals.shareToken, token))
    .limit(1);

  const proposal = proposalRows[0];
  if (!proposal) {
    return null;
  }

  const candidates = await database
    .select({
      childId: schema.villageCandidates.childId,
      title: schema.villageCandidates.title,
      kind: schema.villageCandidates.kind,
      summary: schema.villageCandidates.summary,
      sourceUrl: schema.villageCandidates.sourceUrl,
      coverageNote: schema.villageCandidates.coverageNote,
      // Aggregate endorsement count via a correlated subquery — a COUNT only, no
      // join to families/users, so no identity is reachable (rule #1).
      endorsementCount: endorsementCountSubquery(),
    })
    .from(schema.villageCandidates)
    .where(eq(schema.villageCandidates.familyId, proposal.proposalFamilyId))
    .orderBy(desc(schema.villageCandidates.discoveredAt))
    .limit(PUBLIC_CANDIDATE_LIMIT);

  return toPublicWeekPlan({
    // Proposal jsonb items are never fetched on the public path — they carry
    // per-child stage notes (rule #1). The mapper surfaces only weekOf.
    proposal: { weekOf: proposal.weekOf, items: [] },
    areaCoarse: proposal.areaCoarse,
    candidates,
  });
}
