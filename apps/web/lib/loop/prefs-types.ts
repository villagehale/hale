/**
 * Loop preference shapes and the child-name strings. No database import: the
 * texts editor is a client component and must not pull the Postgres driver
 * into the browser bundle.
 */

export type LoopChannel = 'email' | 'sms';
export type ChildNameLevel = 'first_name' | 'relation' | 'generic';
export type LoopCategory = 'reminder' | 'approval' | 'alert';

export interface LoopPrefsView {
  loopChannel: LoopChannel;
  catReminder: boolean;
  catApproval: boolean;
  catAlert: boolean;
  /** Wall-clock local 'HH:MM:SS', interpreted in the parent's users.timezone. */
  quietHoursStart: string;
  quietHoursEnd: string;
  urgentBypassQuietHours: boolean;
  childNameLevel: ChildNameLevel;
}

/**
 * The documented default for a parent with no loop_prefs row (mirrors the table's
 * column defaults). Row absence is a valid state, not an error. Exported as a
 * frozen constant so the defaults live in exactly one place (no magic strings).
 */
export const DEFAULT_LOOP_PREFS: LoopPrefsView = Object.freeze({
  // The column default is still 'email' (no migration); the dispatch sends SMS
  // whatever this says, so the view reports the channel that is actually used.
  loopChannel: 'sms',
  catReminder: true,
  catApproval: true,
  catAlert: true,
  quietHoursStart: '21:30:00',
  quietHoursEnd: '07:30:00',
  urgentBypassQuietHours: true,
  childNameLevel: 'generic',
});

/** The rendered child-identifier strings for each name level (no magic strings). */
export const CHILD_NAME_GENERIC = 'your kid';
export const CHILD_NAME_RELATION = Object.freeze({
  boy: 'your son',
  girl: 'your daughter',
  fallback: 'your child',
});
