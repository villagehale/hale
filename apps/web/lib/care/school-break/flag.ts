import { isEnabled } from '@hale/flags';

export const SCHOOL_BREAK_ENABLED_ENV = 'SCHOOL_BREAK_ENABLED';

/**
 * VIL-685 · the school winter-break lane: the board-page lookup, the one ask when no page
 * has the dates (with the school email's days to confirm, when it states them), the reply
 * that answers it, and the break question that reads the dates. Default off: trimmed
 * `true` lights it; unset sends nothing.
 */
export function schoolBreakEnabled(): boolean {
  return isEnabled('school-break');
}
