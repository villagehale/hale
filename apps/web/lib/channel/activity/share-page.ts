/**
 * How many options the follow-up text itself carries.
 *
 * Two, because the text leads with the best find and one alternative is the most a
 * person reads on a phone. Anything past this stays in the chat until the parent asks,
 * and every link in the text is the venue's own page.
 *
 * Travel and the deep job import this constant. It stays in this module so those
 * callers do not grow a second copy.
 */
export const SLOTS_IN_TEXT = 2;
