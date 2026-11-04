import { PRIVATE_EVENT_WHAT } from '~/lib/channel/coach/tools';
import { isPrivateEvent } from '~/lib/loop/templates/reminder/core';

/**
 * VIL-581 · the ONLY constructor of the label the claim reader sees for a row.
 *
 * `ClaimCandidateRow.what` is this brand, so a raw string cannot reach the model: a
 * calendar title passes through the repo's one teen/sensitive predicate
 * (`isPrivateEvent`) and comes out as "A private calendar item" for a 13+ child's row
 * or a sensitive one, exactly as the coach's own schedule reader projects it
 * (`toScheduleEvent`). An adult, non-sensitive title is the title.
 *
 * Every other source is named for the one column it may carry. There is no generic
 * "any string" source, so a call site reads as what it labels, and a `family_events`
 * title has no way in except `calendar` (claim-label.test.ts pins the call sites).
 */

declare const LABEL: unique symbol;
export type ClaimRowLabel = string & { readonly [LABEL]: true };

export type ClaimLabelSource =
  | {
      from: 'calendar';
      title: string;
      childId: string | null;
      childDateOfBirth: string | null;
      sensitive: boolean;
    }
  /** commitments.summary (the ladder's rule: no child's name). */
  | { from: 'commitment'; summary: string }
  /** watched_spots.label: what the parent reads back, never a household member's name. */
  | { from: 'watched_page'; label: string }
  | { from: 'program'; town: string | null; domain: string | null; cycle: string | null }
  /** A booking the parent stated (a 13+ child's is excluded upstream). */
  | { from: 'stated_booking'; text: string }
  /** This turn's activityPromise.subject or spotWatch.label. */
  | { from: 'pending'; text: string };

function brand(text: string): ClaimRowLabel {
  return text as ClaimRowLabel;
}

export function claimRowLabel(source: ClaimLabelSource, now: Date): ClaimRowLabel {
  switch (source.from) {
    case 'calendar': {
      const child =
        source.childId && source.childDateOfBirth
          ? [{ id: source.childId, dateOfBirth: source.childDateOfBirth }]
          : [];
      const redacted = isPrivateEvent(
        { childId: source.childId, sensitive: source.sensitive },
        child,
        now,
      );
      return brand(redacted ? PRIVATE_EVENT_WHAT : source.title);
    }
    case 'commitment':
      return brand(source.summary);
    case 'watched_page':
      return brand(source.label);
    case 'program':
      return brand(
        [source.town, source.domain?.replaceAll('_', ' ') ?? null, source.cycle, 'registration']
          .filter((part): part is string => part !== null)
          .join(' '),
      );
    case 'stated_booking':
    case 'pending':
      return brand(source.text);
  }
}
