/**
 * Request header the middleware stamps with the raw query string.
 * `not-found` metadata never receives `searchParams`, so the share card
 * reads the phase from this header instead.
 */
export const SHARE_SEARCH_HEADER = 'x-hale-search';
