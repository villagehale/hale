/**
 * Rec-morning facts — reviewed constants, the SMS twin of the city guides.
 *
 * Dated city lines are derived from the verified registration dataset
 * (apps/web/lib/registration/registration-windows-data.ts) in city-line.ts.
 * This file is what a parent who TEXTS Hale this morning is owed: clock and
 * portal, not a feature list. Hale is unofficial — if a city or YMCA page has
 * moved, that page wins.
 *
 * NOTHING HERE IS A GUESS. Jack of Sports is named as a backup and pointed at its
 * own page; hours and a login are not invented.
 *
 * GSM-7: these tokens ride in outbound copy (copy.ts). No em dash, no curly quote.
 */

export const TORONTO_REC_PORTAL = 'toronto.ca/OnlineReg';
export const YMCA_PORTAL = 'MyY.YMCAGTA.ORG';
export const JACK_OF_SPORTS_PAGE = 'jackofsports.com';

/**
 * The morning YMCA GTA opened fall swim registration (#548): the Y's own published date
 * and local clock. A dated fact, so copy.ts hands it out only until that day has passed.
 */
export const YMCA_SWIM_OPENS = { date: '2026-08-27', clock: '9:00 a.m.' } as const;

export const TORONTO_WAITLIST_HOURS = 36;
export const BRAMPTON_WAITLIST_HOURS = 24;

export const UNOFFICIAL = 'Hale is unofficial.';
