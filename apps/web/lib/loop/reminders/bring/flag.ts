import { isEnabled } from '@hale/flags';

/**
 * VIL-720 · bring-items in the reminder. Exactly `true` turns it on; anything else is off
 * (a trailing newline, `TRUE`, `on`, `1`, unset).
 *
 * Off is today's product, byte for byte: no email or flyer is read for what to bring,
 * nothing is stored, and every reminder request is the one it was.
 *
 * On:
 *   - an email about an event already on the calendar, or one Hale offers to add, is read
 *     once by the model for what it asks the family to bring (bring/read.ts);
 *   - a flyer or screenshot a parent sends 1:1 is read the same way when the coach offers
 *     to put its event on the calendar;
 *   - the items are stored against the event for THAT parent only (bring/store.ts), and
 *     that parent's own night-before and hour-before reminders carry them;
 *   - a reminder that carried items and could not be written pages #ops. Nothing is sent.
 *
 * Never a group chat, a co-parent or a caregiver: the items are one parent's mail or
 * thread (group privacy, CLAUDE.md rule #1).
 */
export const BRING_ITEMS_REMINDER_ENV = 'BRING_ITEMS_REMINDER_ENABLED';

export function bringItemsReminderEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('bring-items-reminder', undefined, env);
}
