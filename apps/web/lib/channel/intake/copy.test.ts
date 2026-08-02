import { describe, expect, it } from 'vitest';
import { assistantDisclosure, greeting, followUp, sourceCodeFromBody, venueForCode } from './copy';

describe('greeting', () => {
  it('is the verbatim no-context spec line when there is no venue', () => {
    expect(greeting(null)).toBe(
      "Hi, I'm Hale — I keep family weeks on track for GTA parents. What are your kids' names and ages — and what's your postal code?",
    );
  });

  it('is the verbatim venue line, naming the venue, and does NOT ask for a postal code', () => {
    // The QR venue already tells us the area, so asking for the postal code would be
    // asking for data we don't need — the whole point of the venue variant.
    expect(greeting('library')).toBe(
      "Hi, I'm Hale — I keep family weeks on track around here. You found me at the library, so I know the area. What are your kids' names and ages?",
    );
    expect(greeting('library')).not.toContain('postal');
  });
});

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
    expect(venueForCode('earlyon-richmondhill')?.name).toBe('EarlyON centre');
  });

  it('refuses an unknown suffix code and ignores a mid-message "(via …)"', () => {
    expect(sourceCodeFromBody('Hi (via atlantis-nowhere)')).toBeNull();
    expect(sourceCodeFromBody('we went (via the highway) to the park')).toBeNull();
  });

  it('carries a coarse area per venue — never a precise address (rule #1)', () => {
    const venue = venueForCode('LIBRARY');
    expect(venue?.areaCoarse).toMatch(/^[A-Z]\d[A-Z]$/); // an FSA, not a full postal code
  });
});

describe('followUp', () => {
  it('echoes the summary back before asking the one missing field', () => {
    expect(followUp('Maya (4) and Leo (1)')).toBe(
      "Got it — Maya (4) and Leo (1). What's your postal code?",
    );
  });
});

describe('assistantDisclosure', () => {
  // D20 moved the policies to the marketing site; the app's /terms is a 308 to it.
  // A stranger's first message must not spend its one link on a redirect hop.
  it('names the terms URL on the marketing site, not the redirecting app path', () => {
    expect(assistantDisclosure()).toBe(
      "(I'm an assistant, not a person — details & privacy: https://www.villagehale.com/terms)",
    );
  });
});
