/**
 * Rec-morning facts — reviewed constants, the SMS twin of the city guides.
 *
 * Source of truth for the marketing pages is apps/site/lib/registration/guides.ts
 * (reconfirmed Aug 26, 2026). This file is what a parent who TEXTS Hale this morning
 * is owed: clock and portal, not a feature list. Hale is unofficial — if a city or
 * YMCA page has moved, that page wins.
 *
 * NOTHING HERE IS A GUESS. Jack of Sports is named as a backup and pointed at its
 * own page; hours and a login are not invented.
 *
 * GSM-7: these tokens ride in outbound copy (copy.ts). No em dash, no curly quote.
 */

export const TORONTO_REC_PORTAL = 'toronto.ca/OnlineReg';
export const YMCA_PORTAL = 'MyY.YMCAGTA.ORG';
export const JACK_OF_SPORTS_PAGE = 'jackofsports.com';

export const TORONTO_WAITLIST_HOURS = 36;
export const BRAMPTON_WAITLIST_HOURS = 24;

/** YMCA Greater Toronto Learn to Swim open — members and non-residents, same clock. */
export const YMCA_SWIM_OPEN = {
  isoDate: '2026-08-27',
  weekday: 'Thursday',
  time: '9:00 a.m.',
  timeZone: 'America/Toronto',
} as const;

export const UNOFFICIAL = 'Hale is unofficial.';
