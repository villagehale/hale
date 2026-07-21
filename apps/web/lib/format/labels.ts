import type { ActionType } from '@hale/types';

/**
 * The label layer. HARD rule: a stored token (a village `kind`/category, an
 * action_type enum, a reviewer verdict) is NEVER rendered raw. Every renderer
 * that surfaces one of these values runs it through here first, so an internal
 * token like `add_to_digest_only` or `community_event` never reaches a user —
 * least of all on the PUBLIC share pages, where an un-humanized token is an
 * internal leak on a URL a stranger can open.
 *
 * These are CURATED maps, not de-underscoring: an unknown value falls back to
 * neutral human copy (or hides), it is never surfaced with its underscores
 * swapped for spaces — that would still expose an internal token verbatim.
 */

/**
 * Village category → human copy. Source of truth: the discovery prompt's
 * category enum (apps/worker/prompts/discovery.md): class | program | drop_in |
 * outdoor | library | community_event | other. Plus `activity`, the generic
 * constant stamped on every discovered candidate (village-discovery.ts).
 *
 * `activity`, `other`, and any unmapped/internal token resolve to null so the
 * caller HIDES the eyebrow rather than showing a meaningless or internal
 * category — a category chip only earns its place when it says something.
 */
const VILLAGE_KIND_LABELS: Record<string, string> = {
  class: 'class',
  program: 'program',
  drop_in: 'drop-in',
  outdoor: 'outdoors',
  library: 'library',
  community_event: 'community event',
};

/** Human label for a village candidate/routine-item category, or null to hide
 * the eyebrow (generic `activity`, catch-all `other`, unknown, or absent). */
export function villageKindLabel(kind: string | null): string | null {
  if (kind === null) {
    return null;
  }
  return VILLAGE_KIND_LABELS[kind] ?? null;
}

/**
 * Action type → human verb phrase. Source of truth: ActionType
 * (packages/types/src/action.ts). An unknown value degrades to neutral copy,
 * never the de-underscored token.
 */
const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  send_email: 'Send email',
  reply_to_email: 'Reply to email',
  create_calendar_event: 'Add to calendar',
  update_calendar_event: 'Update calendar',
  place_supply_order: 'Order supplies',
  cancel_supply_order: 'Cancel supply order',
  fill_pdf_form: 'Fill a form',
  submit_government_form: 'Submit a government form',
  book_clinic_portal: 'Book a clinic appointment',
  cancel_clinic_appointment: 'Cancel a clinic appointment',
  share_photos_with_family: 'Share photos with family',
  add_to_digest_only: 'Note in your digest',
  add_to_routine: 'Pin to your routine',
  calendar_add: 'Add to your calendar',
  calendar_move: 'Reschedule on your calendar',
  calendar_cancel: 'Remove from your calendar',
};

const ACTION_TYPE_FALLBACK = 'an action';

export function actionTypeLabel(actionType: string): string {
  return ACTION_TYPE_LABELS[actionType as ActionType] ?? ACTION_TYPE_FALLBACK;
}

/**
 * Reviewer verdict → human copy. Source of truth: the reviewer_verdict enum
 * (packages/db/src/schema/enums.ts). An unknown value degrades to neutral copy.
 */
const VERDICT_LABELS: Record<string, string> = {
  pending: 'awaiting review',
  approved: 'verified by the reviewer',
  rejected: 'the reviewer raised a concern',
  flagged: 'flagged for your review',
  superseded: 'replaced by a newer draft',
};

const VERDICT_FALLBACK = 'awaiting your approval';

export function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict] ?? VERDICT_FALLBACK;
}

/**
 * Village candidate price band → human copy. Source of truth: the discovery tool's
 * priceBand enum (village discover.ts: free | low | moderate | high). An unknown /
 * absent value resolves to null so the card HIDES the chip rather than showing an
 * internal or meaningless token — a price chip only earns its place when honest.
 */
const PRICE_BAND_LABELS: Record<string, string> = {
  free: 'free',
  low: '$',
  moderate: '$$',
  high: '$$$',
};

export function priceBandLabel(band: string | null): string | null {
  if (band === null) return null;
  return PRICE_BAND_LABELS[band] ?? null;
}

/**
 * Village candidate indoor/outdoor → human copy. Source of truth: the discovery
 * tool's indoorOutdoor enum (indoor | outdoor | both). Unknown / absent → null (the
 * card hides the chip).
 */
const INDOOR_OUTDOOR_LABELS: Record<string, string> = {
  indoor: 'indoor',
  outdoor: 'outdoor',
  both: 'indoor & outdoor',
};

export function indoorOutdoorLabel(value: string | null): string | null {
  if (value === null) return null;
  return INDOOR_OUTDOOR_LABELS[value] ?? null;
}
