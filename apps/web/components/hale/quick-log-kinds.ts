import type { FamilyStage } from '@hale/types';
import {
  DIAPER_EPISODE,
  type DiaperKind,
  FEED_EPISODE,
  type FeedAmount,
  type FeedKind,
  MILESTONE_EPISODE,
  NAP_EPISODE,
  type QuickLogInput,
} from '~/lib/companion/log-types';

/**
 * Stage→kind gating and submit-payload construction for the quick-log row, kept
 * free of React and the 'use server' log action so it can be imported by the
 * client component and unit-tested directly (mirrors how log-types is split out
 * from log).
 */

export interface QuickLogChild {
  id: string;
  name: string | null;
  stage: FamilyStage;
}

export type Kind =
  | typeof FEED_EPISODE
  | typeof NAP_EPISODE
  | typeof DIAPER_EPISODE
  | typeof MILESTONE_EPISODE;

/**
 * Feed, nap and diaper only make sense for the youngest stages; milestones apply
 * at every age. A teen's parent is never offered a feed/nap/diaper log: a kind is
 * shown only when some child supports it, and its child selector lists only
 * eligible kids.
 */
export const STAGE_KINDS: Record<FamilyStage, Kind[]> = {
  newborn: [FEED_EPISODE, NAP_EPISODE, DIAPER_EPISODE, MILESTONE_EPISODE],
  toddler: [FEED_EPISODE, NAP_EPISODE, DIAPER_EPISODE, MILESTONE_EPISODE],
  child: [MILESTONE_EPISODE],
  teenager: [MILESTONE_EPISODE],
};

const KIND_ORDER: Kind[] = [FEED_EPISODE, NAP_EPISODE, DIAPER_EPISODE, MILESTONE_EPISODE];

/** The kind buttons to show: a kind appears when at least one child supports it. */
export function visibleKindsFor(kids: QuickLogChild[]): Kind[] {
  return KIND_ORDER.filter((kind) => kids.some((c) => STAGE_KINDS[c.stage].includes(kind)));
}

/** The children eligible to log a given kind (by stage). */
export function eligibleKidsFor(kids: QuickLogChild[], kind: Kind): QuickLogChild[] {
  return kids.filter((c) => STAGE_KINDS[c.stage].includes(kind));
}

/** The raw form values a submit reads — each a string (or the empty union member)
 * as the inputs hold them, coerced/validated in buildInput. */
export interface QuickLogFormValues {
  amountMl: string;
  /** The qualitative "how much" chip, or '' when none is picked (the numeric ml
   * path is used instead). Mutually exclusive with amountMl in the UI. */
  feedAmount: FeedAmount | '';
  feedKind: FeedKind | '';
  durationMin: string;
  /** The picked diaper kind — always set (the form defaults to 'wet'), so a diaper
   * log is never empty and always builds a valid input. */
  diaperKind: DiaperKind;
  diaperNote: string;
  milestone: string;
  milestoneNote: string;
  when: string;
}

/** Converts the datetime-local field (local wall-clock, no zone) to an ISO string
 * with offset for the schema, or undefined when blank (server defaults to now). A
 * blank/invalid string yields undefined rather than a bad date. */
export function toOccurredAt(when: string): string | undefined {
  if (!when) return undefined;
  const date = new Date(when);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Builds the typed server-action input for the open form, or null when the
 * required field is empty / non-numeric. Numeric coercion + bounds are enforced
 * server-side too (zod); this is the client-side guard so we never POST a blank.
 */
export function buildInput(
  kind: Kind,
  childId: string,
  values: QuickLogFormValues,
): QuickLogInput | null {
  if (!childId) return null;
  const occurredAt = toOccurredAt(values.when);
  switch (kind) {
    case FEED_EPISODE: {
      const feedKind = values.feedKind ? { feedKind: values.feedKind } : {};
      // A qualitative chip is the explicit pick and wins over a stray ml value; the
      // two are mutually exclusive in the UI (picking one clears the other).
      if (values.feedAmount) {
        return { kind: FEED_EPISODE, childId, feedAmount: values.feedAmount, ...feedKind, occurredAt };
      }
      const amountMl = Number(values.amountMl);
      if (!values.amountMl || Number.isNaN(amountMl)) return null;
      return { kind: FEED_EPISODE, childId, amountMl, ...feedKind, occurredAt };
    }
    case NAP_EPISODE: {
      const durationMin = Number(values.durationMin);
      if (!values.durationMin || Number.isNaN(durationMin)) return null;
      return { kind: NAP_EPISODE, childId, durationMin, occurredAt };
    }
    case DIAPER_EPISODE: {
      // The kind always carries a value (the form defaults to 'wet'), so a diaper
      // needs no empty-guard beyond the childId check above.
      const note = values.diaperNote.trim();
      return {
        kind: DIAPER_EPISODE,
        childId,
        diaperKind: values.diaperKind,
        ...(note ? { note } : {}),
        occurredAt,
      };
    }
    case MILESTONE_EPISODE: {
      const milestone = values.milestone.trim();
      if (!milestone) return null;
      const note = values.milestoneNote.trim();
      return {
        kind: MILESTONE_EPISODE,
        childId,
        milestone,
        ...(note ? { note } : {}),
        occurredAt,
      };
    }
  }
}
