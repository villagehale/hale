import { describe, expect, it } from 'vitest';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import {
  START_ACK_BY_LANGUAGE,
  STOP_ACK_BY_LANGUAGE,
  posterLocation,
  sourceCodeFromBody,
  venueForCode,
} from './copy';
import { LIFETIME_FAMILY_SOURCE_CODES } from './promo';

/**
 * The /text page's prefilled first message lives in apps/site; the greeting path lives
 * here. A prefill the classifier does not treat as a hello skips greeting() and calls
 * the answerer, so the site's constant is read from disk and pushed through the
 * classifier, with and without the venue tag the page appends.
 */

describe('sourceCodeFromBody / venueForCode', () => {
  it('reads a known venue code from the prefilled body, case-insensitively', () => {
    expect(sourceCodeFromBody('HALE LIBRARY')).toBe('LIBRARY');
    expect(sourceCodeFromBody('hale rec')).toBe('REC');
    expect(sourceCodeFromBody('Hale: Clinic')).toBe('CLINIC');
    expect(venueForCode('LIBRARY')?.name).toBe('library');
  });

  it('refuses an unknown code (never claim to know a place we do not)', () => {
    expect(sourceCodeFromBody('HALE ATLANTIS')).toBeNull();
    expect(venueForCode('ATLANTIS')).toBeNull();
    expect(venueForCode(null)).toBeNull();
  });

  it('is null for an ordinary first message', () => {
    expect(sourceCodeFromBody('hi, my kids are 4 and 1')).toBeNull();
    expect(sourceCodeFromBody('')).toBeNull();
  });

  it('reads the "(via <code>)" suffix the /text entry page prefills (VIL-240 convention)', () => {
    expect(sourceCodeFromBody('Hi (via earlyon-richmondhill)')).toBe('earlyon-richmondhill');
    expect(sourceCodeFromBody('Hi (VIA Earlyon-Richmondhill)')).toBe('earlyon-richmondhill');
    // "EarlyON" is trademarked: the code survives on printed QRs, the spoken name must not.
    expect(venueForCode('earlyon-richmondhill')?.name).toBe('family centre');
  });

  it('reads the Georgetown venue from both prefilled-body forms (the free-Family comp poster)', () => {
    // The comp poster's QR prefills one of these two bodies; both must resolve to the code
    // the lifetime-Family grant is keyed on (LIFETIME_FAMILY_SOURCE_CODES).
    expect(sourceCodeFromBody('HALE earlyon-georgetown')).toBe('earlyon-georgetown');
    expect(sourceCodeFromBody('Hi (via earlyon-georgetown)')).toBe('earlyon-georgetown');
    expect(venueForCode('earlyon-georgetown')?.name).toBe('family centre');
    expect(sourceCodeFromBody('Hi (via earlyon-acton)')).toBe('earlyon-acton');
    expect(venueForCode('earlyon-acton')?.name).toBe('family centre');
    expect(sourceCodeFromBody('Hi (via investor-deck)')).toBe('investor-deck');
    expect(LIFETIME_FAMILY_SOURCE_CODES.has('investor-deck')).toBe(false);
    // both Halton Hills poster codes carry the lifetime Family comp
    expect(LIFETIME_FAMILY_SOURCE_CODES.has('earlyon-georgetown')).toBe(true);
    expect(LIFETIME_FAMILY_SOURCE_CODES.has('earlyon-acton')).toBe(true);
  });

  it('reads the Ossington venue from both forms, and it carries the comp', () => {
    // Indoor board at West Neighbourhood House — a venue plate like Richmond Hill.
    expect(sourceCodeFromBody('Hi (via ossington)')).toBe('ossington');
    expect(sourceCodeFromBody('HALE ossington')).toBe('ossington');
    expect(venueForCode('ossington')?.name).toBe('family centre');
    expect(posterLocation('ossington')).toBe('Ossington');
    // Founder-granted 2026-08-27, alongside Markham — the first GTA boards.
    expect(LIFETIME_FAMILY_SOURCE_CODES.has('ossington')).toBe(true);
  });

  it('reads the Markham venue and grants the first-GTA-board comp', () => {
    expect(sourceCodeFromBody('Hi (via markham)')).toBe('markham');
    expect(venueForCode('markham')?.name).toBe('family centre');
    expect(posterLocation('markham')).toBe('Markham');
    expect(LIFETIME_FAMILY_SOURCE_CODES.has('markham')).toBe(true);
  });

  it('keeps the legacy earlyon-markham code live: that QR is printed and hanging', () => {
    // First scanned 2026-08-28 (the partner venue's own board). Same venue, same comp,
    // until the reprint replaces the copy — then the alias goes.
    expect(sourceCodeFromBody('Hi (via earlyon-markham)')).toBe('earlyon-markham');
    expect(venueForCode('earlyon-markham')?.name).toBe('family centre');
    expect(posterLocation('earlyon-markham')).toBe('Markham');
    expect(LIFETIME_FAMILY_SOURCE_CODES.has('earlyon-markham')).toBe(true);
  });

  it('refuses an unknown suffix code and ignores a mid-message "(via …)"', () => {
    expect(sourceCodeFromBody('Hi (via atlantis-nowhere)')).toBeNull();
    expect(sourceCodeFromBody('we went (via the highway) to the park')).toBeNull();
  });

  it('reads a REFERRAL tag by its shape — a parent forwarded the link, there is no venue', () => {
    // The registry cannot list these: there is one per family and they are derived, not
    // enrolled. Recognising the shape is what lets a referred friend be attributed at
    // all — before this, `friend-…` fell through to null and the referral was lost.
    expect(sourceCodeFromBody('Hi (via friend-0123456789ab)')).toBe('friend-0123456789ab');
    expect(sourceCodeFromBody('HALE friend-0123456789AB')).toBe('friend-0123456789ab');
  });

  it('still refuses a tag that is neither a venue nor a referral shape', () => {
    expect(sourceCodeFromBody('Hi (via friend-nothex123456)')).toBeNull();
    expect(sourceCodeFromBody('Hi (via friend-0123456789)')).toBeNull();
  });

  it('carries a coarse area per venue — never a precise address (rule #1)', () => {
    const venue = venueForCode('LIBRARY');
    expect(venue?.areaCoarse).toMatch(/^[A-Z]\d[A-Z]$/); // an FSA, not a full postal code
  });
});

/**
 * THE FRENCH SCRIPT.
 *
 * Every assertion here is a copy review written down. These are the same promises the
 * English lines above make — the rec-morning first hello, the restraint, the STOP escape, the
 * region boundary — and a translation that drops one of them is a promise nobody made,
 * so the properties are asserted separately from the verbatim strings rather than being
 * assumed to have survived the trip.
 *
 * ALL OF IT IS PENDING FOUNDER REVIEW. The verbatim expectations are what make that
 * review possible: a reworded line is a diff in this file, not a silent drift.
 */
describe('the French script', () => {
  it('has no fixed call-name line any more — the onboarding model writes that ask (VIL-417)', async () => {
    const copy = await import('./copy');
    expect(Object.keys(copy).some((key) => /CALL_NAME/.test(key))).toBe(false);
    for (const value of Object.values(copy)) {
      if (typeof value === 'string') expect(value).not.toMatch(/What should I call you/i);
    }
  });

  /**
   * The rule #491's note was keeping by hand, kept structurally from here on: a fixed
   * line may not name a keyword the machine does not honour.
   *
   * ALL-CAPS is the convention every one of these lines uses to name a keyword, so the
   * tokens are read OFF the copy rather than listed beside it — a new line naming a new
   * word is covered the day it is written, which a hand-kept list never is.
   */

  it('confirms the unsubscribe in French and offers the French way back', () => {
    expect(STOP_ACK_BY_LANGUAGE.fr).toBe(
      'Terminé - je ne vous texte plus. Répondez DEBUT si vous voulez que je revienne.',
    );
    // The way back has to BE a way back: the English twin offers START, so the French one
    // offers the word a French parent can actually send.
    expect(matchKeyword('DEBUT')).toEqual({ keyword: 'start', language: 'fr' });
  });

  it('welcomes a re-subscribing parent back in French', () => {
    expect(START_ACK_BY_LANGUAGE.fr).toBe(
      'Vous voilà de retour - je reprends le fil de votre semaine.',
    );
  });
});
