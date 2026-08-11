import { describe, expect, it } from 'vitest';
import { PRIVACY_URL } from '~/lib/legal-links';
import {
  ASSENT_ACK,
  DECLINE_ACK,
  WATCH_OFFER,
  detailsBlocked,
  greeting,
  followUp,
  sourceCodeFromBody,
  venueForCode,
} from './copy';

describe('greeting', () => {
  it('is the verbatim no-context spec line when there is no venue', () => {
    expect(greeting(null)).toBe(
      "Hi, I'm Hale - an AI that quietly runs the family week. Registration dates, weekend plans, the stuff that slips. Tell me your kids' names and ages, plus your postal code - and I'll get to work.",
    );
  });

  it('is the verbatim venue line, naming the venue, and does NOT ask for a postal code', () => {
    // The QR venue already tells us the area, so asking for the postal code would be
    // asking for data we don't need — the whole point of the venue variant.
    expect(greeting('library')).toBe(
      "Hi, I'm Hale - an AI that quietly runs the family week for parents around here. You found me at the library, so I already know the area. Kids' names and ages, and I'll get to work.",
    );
    expect(greeting('library')).not.toContain('postal');
  });

  // v2 folded the AI disclosure INTO the first sentence rather than trailing it as a
  // parenthetical. It is the same promise made better: a stranger reads "an AI" in the
  // words Hale introduces itself with, not in a footnote after the ask.
  it('discloses that Hale is an AI in the greeting itself, in BOTH variants', () => {
    expect(greeting(null)).toContain("I'm Hale - an AI");
    expect(greeting('library')).toContain("I'm Hale - an AI");
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
    expect(followUp('Maya (4) and Leo (1)', ['location'])).toBe(
      "Got it - Maya (4) and Leo (1). Last thing: what's your postal code?",
    );
  });

  it('asks for the ages when those are what is missing — never invents one', () => {
    expect(followUp('Nora and Ben', ['ages'])).toBe(
      'Got it - Nora and Ben. Last thing: how old are they?',
    );
  });

  it('asks for both in ONE message, because there is only ever one follow-up', () => {
    expect(followUp('Nora and Ben', ['ages', 'location'])).toBe(
      "Got it - Nora and Ben. Last thing: how old are they, and what's your postal code?",
    );
  });
});

describe('the consent moment', () => {
  // The privacy link moved here from the greeting's disclosure parenthetical (v2): the
  // one place a parent is actually asked to say yes is the one place the link earns its
  // characters. It is the CONSTANT, never a copy of the string — a policy move that
  // edits legal-links.ts must not leave a stale URL in the consent ask.
  it('asks the watch question and names where the privacy policy lives', () => {
    expect(WATCH_OFFER).toBe(
      `Want me to keep an eye on all of this for you? (how I handle your family's info: ${PRIVACY_URL})`,
    );
    expect(WATCH_OFFER).toContain('https://www.villagehale.com/privacy');
  });

  it('confirms coverage, names the STOP escape, and opens the first real question', () => {
    expect(ASSENT_ACK).toBe(
      "Done - you're covered. I only text when something actually matters, and STOP always works. While I dig in: what part of the week wears you out the most?",
    );
  });

  it('takes a no without friction and leaves the door open', () => {
    expect(DECLINE_ACK).toBe(
      'No problem - text me whenever you like. The dates and finds are here when you want them.',
    );
  });

  // CASL: the unsubscribe instruction must survive any copy revision. It is the one
  // sentence in the consent turn that is not ours to soften.
  it('keeps STOP visible in the acknowledgment a consenting parent reads', () => {
    expect(ASSENT_ACK).toContain('STOP');
  });
});

describe('detailsBlocked', () => {
  it('names the missing piece plainly, once, and asks nothing again', () => {
    expect(detailsBlocked(['location'])).toBe(
      "I can't set your family up until I know your postal code - send it whenever you're ready.",
    );
    expect(detailsBlocked(['ages'])).toBe(
      "I can't set your family up until I know how old your kids are - send their ages whenever you're ready.",
    );
    expect(detailsBlocked(['ages', 'location'])).toBe(
      "I can't set your family up until I know your kids' ages and your postal code - send them whenever you're ready.",
    );
  });
});
