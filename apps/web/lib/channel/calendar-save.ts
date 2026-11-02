import { calendarInstantsClose, calendarTitlesEqual } from './calendar-ask';

/**
 * Where a saved entry actually went.
 *
 * `hale_family_calendar` is Hale's own family calendar (`family_events`). `ics` is a
 * calendar file delivered to the parent. A connected Google calendar is a separate
 * fact: connection is not a destination, and a destination is not a sentence.
 */
export const CALENDAR_SAVE_PLACES = ['hale_family_calendar', 'ics'] as const;
export type CalendarSavePlace = (typeof CALENDAR_SAVE_PLACES)[number];

/** The place the save wrote. An ICS delivery is that place; otherwise the row is Hale's. */
export function calendarSavePlace(input: { icsDelivered: boolean }): CalendarSavePlace {
  return input.icsDelivered ? 'ics' : 'hale_family_calendar';
}

export interface SaveConfirmation {
  title: string;
  startsAt: string;
}

/**
 * One confirmation per save.
 *
 * The first open confirmation for this title and a close clock stands. A later ask
 * for the same save is a duplicate: the flag is the open confirmation, not a phrase.
 */
export function claimSaveConfirmation(
  open: readonly SaveConfirmation[],
  next: SaveConfirmation,
): 'first' | 'duplicate' {
  const hit = open.some(
    (row) =>
      calendarTitlesEqual(row.title, next.title) &&
      calendarInstantsClose(row.startsAt, next.startsAt),
  );
  return hit ? 'duplicate' : 'first';
}

/**
 * A turn that only re-asks a save already confirming sends nothing. A turn that
 * also drafted a different save still speaks: that draft has not been confirmed.
 */
export function suppressDuplicateSaveConfirmation(input: {
  alreadyConfirming: boolean;
  newDrafts: number;
}): boolean {
  return input.alreadyConfirming && input.newDrafts === 0;
}
