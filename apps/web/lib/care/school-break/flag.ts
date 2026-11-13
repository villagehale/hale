import { isEnabled } from '@hale/flags';

export const SCHOOL_BREAK_ENABLED_ENV = 'SCHOOL_BREAK_ENABLED';

/**
 * VIL-685 · the school winter-break lane: the board-page lookup, the one ask when no page
 * or school email has the dates, the reply that answers it, and the break question that
 * reads the dates. A kill switch that defaults ON (`trimmed-not-false`): only `false`
 * turns it off.
 */
export function schoolBreakEnabled(): boolean {
  return isEnabled('school-break');
}
