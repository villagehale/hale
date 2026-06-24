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
  title: string;
  kind: string;
  summary: string;
  coverageNote: string | null;
  sourceUrl: string | null;
  /** The accept action POSTs here — the route lands in the next phase. */
  acceptHref: string;
  /**
   * True when the candidate is attributed to a 13+ child (rule #1): the renderer
   * shows the locked treatment and a parent cannot accept content they can't
   * preview. The raw fields are already redacted when this is set.
   */
  teenAttributed: boolean;
}

export interface RoutineItemView {
  title: string;
  kind: string;
  stageNote: string;
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
export function toVillageCandidateView(
  candidate: VillageCandidate,
  teenAttributed: boolean,
): VillageCandidateView {
  const acceptHref = `/api/village/${candidate.id}/accept`;
  if (teenAttributed) {
    return {
      id: candidate.id,
      title: TEEN_REDACTED_PLACEHOLDER,
      kind: candidate.kind,
      summary: '',
      coverageNote: null,
      sourceUrl: null,
      acceptHref,
      teenAttributed: true,
    };
  }
  return {
    id: candidate.id,
    title: candidate.title,
    kind: candidate.kind,
    summary: candidate.summary,
    coverageNote: candidate.coverageNote,
    sourceUrl: candidate.sourceUrl,
    acceptHref,
    teenAttributed: false,
  };
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
        teenAttributed,
      };
    }),
  };
}
