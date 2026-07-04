import type { schema } from '@hale/db';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';

export type VillageCandidate = typeof schema.villageCandidates.$inferSelect;
export type RoutineProposal = typeof schema.routineProposals.$inferSelect;

/**
 * Pure row → view-shape mappers for the read-only village page. Like the
 * dashboard mappers they're I/O-free so they're unit-testable; the query layer
 * does the joining and passes `teenAttributed` in explicitly.
 */

export interface VillageCandidateView {
  id: string;
  /** The child this candidate was discovered for, or null for a family-wide pick.
   * An opaque id (never a name), kept on teen-attributed cards too so the scope
   * filter can narrow to that child — the teen's name is withheld at the chip. */
  childId: string | null;
  title: string;
  kind: string;
  /** How the activity recurs — "seasonal" | "one-time" | "ongoing" — or null when
   * the discovery run didn't classify it (no chip). Null on a teen-redacted card. */
  cadence: string | null;
  /** Which seasons a seasonal activity runs — passed through for the client-side
   * cadence filter; the server already applied the in-season gate. Null on a
   * teen-redacted card (same treatment as cadence) and on non-seasonal rows. */
  seasons: string[] | null;
  /** When this candidate was discovered (ISO) — rendered as a "found N ago"
   * freshness stamp so the family reads how current the run is. */
  discoveredAt: string;
  summary: string;
  coverageNote: string | null;
  sourceUrl: string | null;
  /** The accept action POSTs here. */
  acceptHref: string;
  /** The endorse action POSTs here (the trusted-parent half of hybrid trust). */
  endorseHref: string;
  /** The per-activity public-share mint POSTs here. */
  shareHref: string;
  /** Aggregate distinct-family endorsements (a count, never an identity — rule #1). */
  endorsementCount: number;
  /** Whether THIS family has already endorsed — drives the button's state. */
  endorsedByFamily: boolean;
  /** Whether THIS family already accepted this candidate into a LIVE draft — drives
   * the accept button's "sent for your approval" state from SERVER data so it
   * survives the streamed feed remounting the button (it would otherwise reset its
   * optimistic local state on every re-render). */
  accepted: boolean;
  /** PUBLIC venue coordinates for the map pin (a YMCA, a library) — null for an
   * online / no-venue activity or an unresolved geocode (list-only, no pin). These
   * are a public place, never the family's location (rule #1). Always null on a
   * teen-redacted card so a teen's activity is never plotted. */
  lat: number | null;
  lng: number | null;
  /** Public venue name for the marker tooltip; null when there is no pin. */
  venueName: string | null;
  /**
   * True when the candidate is attributed to a 13+ child (rule #1): the renderer
   * shows the locked treatment and a parent cannot accept content they can't
   * preview. The raw fields are already redacted when this is set.
   */
  teenAttributed: boolean;
}

/** The per-family signals the query layer resolves and the mapper folds in. */
export interface CandidateEngagement {
  endorsementCount: number;
  endorsedByFamily: boolean;
  /** True when this family already accepted (added to their week) this candidate. */
  accepted: boolean;
}

export interface RoutineItemView {
  title: string;
  kind: string;
  stageNote: string;
  /** The weekday the agent placed this item on ("monday"–"sunday"), or null for a
   * row written before the day was persisted. A weekday is a placement label, not
   * PII, so it survives teen redaction — the week-strip can still show where a
   * redacted item sits. */
  day: string | null;
  teenAttributed: boolean;
}

export interface RoutineProposalView {
  id: string;
  weekOf: string;
  items: RoutineItemView[];
}

/**
 * Hard rule #1 (teen privacy): a candidate attributed to a 13+ child surfaces
 * only its category (`kind`) — its title is the shared placeholder and every
 * other raw field drops to null/empty, never the raw discovered text. The
 * renderer reads `teenAttributed` to show the locked treatment once (no repeated
 * sentence) and to block accept on content a parent can't preview.
 * `teenAttributed` is an EXPLICIT input (derived by the query layer from the
 * child's live stage), so a caller that forgets to resolve the child still
 * cannot leak raw teen-attributed text — the raw fields never reach the view
 * shape once the flag is true.
 */
/** Default when a caller doesn't resolve endorsements (e.g. the coach/digest
 * read paths that only need the redacted title/kind/summary). Keeps those call
 * sites unchanged while the village page passes the real signals. */
const NO_ENGAGEMENT: CandidateEngagement = {
  endorsementCount: 0,
  endorsedByFamily: false,
  accepted: false,
};

export function toVillageCandidateView(
  candidate: VillageCandidate,
  teenAttributed: boolean,
  engagement: CandidateEngagement = NO_ENGAGEMENT,
): VillageCandidateView {
  const acceptHref = `/api/village/${candidate.id}/accept`;
  const endorseHref = `/api/village/${candidate.id}/endorse`;
  const shareHref = `/api/village/${candidate.id}/share`;
  // The aggregate count is identity-free, so it is safe even on a teen row; the
  // renderer still blocks endorse/share on teen-attributed cards (rule #1).
  const { endorsementCount, endorsedByFamily, accepted } = engagement;
  if (teenAttributed) {
    return {
      id: candidate.id,
      childId: candidate.childId,
      title: TEEN_REDACTED_PLACEHOLDER,
      kind: candidate.kind,
      cadence: null,
      seasons: null,
      discoveredAt: candidate.discoveredAt.toISOString(),
      summary: '',
      coverageNote: null,
      sourceUrl: null,
      acceptHref,
      endorseHref,
      shareHref,
      endorsementCount,
      endorsedByFamily,
      accepted,
      // Never plot a teen-redacted card — its location stays list-only (rule #1).
      lat: null,
      lng: null,
      venueName: null,
      teenAttributed: true,
    };
  }
  return {
    id: candidate.id,
    childId: candidate.childId,
    title: candidate.title,
    kind: candidate.kind,
    cadence: candidate.cadence,
    seasons: candidate.seasons,
    discoveredAt: candidate.discoveredAt.toISOString(),
    summary: candidate.summary,
    coverageNote: candidate.coverageNote,
    sourceUrl: candidate.sourceUrl,
    acceptHref,
    endorseHref,
    shareHref,
    endorsementCount,
    endorsedByFamily,
    accepted,
    lat: candidate.lat,
    lng: candidate.lng,
    venueName: candidate.venueName,
    teenAttributed: false,
  };
}

/**
 * Narrow the feed to a chosen scope: whole family (`null`) shows every candidate;
 * a child id shows that child's candidates AND the family-wide ones (childId null),
 * since a family-wide pick applies to everyone. Pure over the already-loaded views
 * — the scope filter never issues a request (rule #1: no new location signal).
 */
export function filterCandidatesByScope(
  candidates: VillageCandidateView[],
  scope: string | null,
): VillageCandidateView[] {
  if (scope === null) return candidates;
  return candidates.filter((c) => c.childId === scope || c.childId === null);
}

/** The cadence-filter selections the /village feed offers. "all" narrows nothing;
 * "year-round" is the human label for the stored `ongoing` cadence — the UI never
 * shows the raw token (rule #1: a stored value never renders raw). */
export type CadenceFilter = 'all' | 'one-time' | 'seasonal' | 'year-round';

const CADENCE_FILTER_MATCH: Record<Exclude<CadenceFilter, 'all'>, string> = {
  'one-time': 'one-time',
  seasonal: 'seasonal',
  'year-round': 'ongoing',
};

/**
 * Narrow the feed to one cadence — a display-only selector over the rows the
 * server already visibility-filtered (no request, no new signal). "all" returns
 * every candidate; any other selection keeps only rows whose stored cadence maps
 * to it (so an unclassified null-cadence row is hidden under a specific filter,
 * shown under "all").
 */
export function filterCandidatesByCadence(
  candidates: VillageCandidateView[],
  filter: CadenceFilter,
): VillageCandidateView[] {
  if (filter === 'all') return candidates;
  const wanted = CADENCE_FILTER_MATCH[filter];
  return candidates.filter((c) => c.cadence === wanted);
}

/**
 * Maps a routine proposal to its view shape. A routine item carries a nullable
 * childId; the query layer passes the set of teen child ids so per-item teen
 * attribution (rule #1) redacts the item's title/stage-note to the placeholder
 * while keeping its category visible.
 */
export function toRoutineProposalView(
  proposal: RoutineProposal,
  teenChildIds: ReadonlySet<string>,
): RoutineProposalView {
  return {
    id: proposal.id,
    weekOf: proposal.weekOf,
    items: proposal.items.map((item) => {
      const teenAttributed = item.childId !== null && teenChildIds.has(item.childId);
      return {
        title: teenAttributed ? TEEN_REDACTED_PLACEHOLDER : item.title,
        kind: item.kind,
        stageNote: teenAttributed ? TEEN_REDACTED_PLACEHOLDER : item.stageNote,
        day: item.day ?? null,
        teenAttributed,
      };
    }),
  };
}
