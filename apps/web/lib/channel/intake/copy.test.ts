import { describe, expect, it } from 'vitest';
import { MAX_TAIL_ASK_CHARS } from '~/lib/channel/identity/ask-voice';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { replyLanguage } from '~/lib/channel/language';
import { smsSegments } from '~/lib/channel/sms-segments';
import { PRIVACY_URL } from '~/lib/legal-links';
import {
  AMBIGUOUS_CLARIFY,
  AMBIGUOUS_CLARIFY_BY_LANGUAGE,
  ASSENT_ACK,
  ASSENT_ACK_BY_LANGUAGE,
  COLD_START_ASK,
  COLD_START_ASK_BY_LANGUAGE,
  CO_PARENT_ASK,
  CO_PARENT_ASK_BY_LANGUAGE,
  DECLINE_ACK,
  DECLINE_ACK_BY_LANGUAGE,
  HALE_GREETING_EN,
  HELP_REPLY,
  HELP_REPLY_BY_LANGUAGE,
  IDENTITY_ACCOUNTABILITY_LINE,
  IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE,
  PARENT_CALL_NAME_ASK,
  REGION_UNAVAILABLE_REPLY,
  REGION_UNAVAILABLE_REPLY_BY_LANGUAGE,
  SITTING_SESSION_REMINDER,
  START_ACK,
  START_ACK_BY_LANGUAGE,
  STOP_ACK,
  STOP_ACK_BY_LANGUAGE,
  UNREADABLE_INTAKE_REPLY,
  UNREADABLE_INTAKE_REPLY_BY_LANGUAGE,
  WATCH_OFFER,
  WATCH_OFFER_BY_LANGUAGE,
  detailsBlocked,
  followUp,
  greeting,
  greetingWithArea,
  intakeCalendarCard,
  intakeGmailCard,
  isBareFirstHello,
  looksLikeIntakeDetails,
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
describe('the /text prefill and the bare-hello classifier agree', () => {
  it('treats the locked warm prefill as a hello, and the retired activity question as a question', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../../../site/lib/text-entry.ts', import.meta.url)),
      'utf8',
    );
    const prefill = /INTAKE_PREFILL = (["'])(.*?)\1;/.exec(src)?.[2];
    expect(
      prefill,
      'INTAKE_PREFILL must be a single literal in apps/site/lib/text-entry.ts',
    ).toBeTruthy();
    expect(prefill).toBe("Hey Hale, what's going on?");
    expect(isBareFirstHello(prefill as string)).toBe(true);
    expect(isBareFirstHello(`${prefill} (via earlyon-richmondhill)`)).toBe(true);
    expect(looksLikeIntakeDetails(prefill as string)).toBe(false);
    const retired = 'What is worth doing with the kids near us?';
    expect(src).not.toContain(retired);
    expect(isBareFirstHello(retired)).toBe(false);
    expect(looksLikeIntakeDetails(retired)).toBe(false);
  });
});

describe('SITTING_SESSION_REMINDER', () => {
  it('is the Designer-locked next-morning line, verbatim', () => {
    expect(SITTING_SESSION_REMINDER).toBe(
      "Still here if you want me watching. Reply with your kids' names, ages, and postal code and I'll send what's coming.",
    );
  });
});

describe('greeting', () => {
  it('is the verbatim no-context spec line when there is no venue', () => {
    expect(greeting(null, 'en')).toBe(HALE_GREETING_EN);
    expect(HALE_GREETING_EN).toBe(
      'Hi — I’m Hale. I help plan your kids’ year — what’s on near them, sign-up mornings, and how it went. Names, ages, and postal code and I’ll look up what’s coming.',
    );
    expect(greeting(null, 'en')).not.toContain('parenting chaos');
    expect(greeting(null, 'en')).not.toContain('little one');
  });

  it('is the verbatim venue line, naming the venue, and does NOT ask for a postal code', () => {
    // The QR venue already tells us the area, so asking for the postal code would be
    // asking for data we don't need — the whole point of the venue variant.
    expect(greeting('library', 'en')).toBe(
      "Hi, I'm Hale. I help plan your kids' year - what's on near them, sign-up mornings, and how it went. You found me at the library, so I already know the area. Kids' names and ages, and I'll look up what's coming.",
    );
    expect(greeting('library', 'en')).not.toContain('postal');
  });

  it("never says I'm an AI, and never uses the dropped family-week tagline", () => {
    expect(greeting(null, 'en')).not.toMatch(/I'm an AI/i);
    expect(greeting('library', 'en')).not.toMatch(/I'm an AI/i);
    expect(greeting(null, 'en')).not.toContain('an AI that quietly runs the family week');
    expect(greeting('library', 'en')).not.toContain('an AI that quietly runs the family week');
  });

  it('is the verbatim area line when the first text was only a postal code', () => {
    expect(greetingWithArea('M5V')).toBe(
      "Hi, I'm Hale. I help plan your kids' year - what's on near them, sign-up mornings, and how it went. Got M5V, so I already know the area. Kids' names and ages, and I'll look up what's coming.",
    );
    expect(greetingWithArea('M5V')).not.toContain('parenting chaos');
    expect(greetingWithArea('M5V')).not.toContain('little one');
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

  it('treats a bare hi, empty body, and QR / HALE tag as the locked greeting', () => {
    expect(isBareFirstHello('hi')).toBe(true);
    expect(isBareFirstHello('Hi!')).toBe(true);
    expect(isBareFirstHello('Bonjour')).toBe(true);
    expect(isBareFirstHello('')).toBe(true);
    expect(isBareFirstHello('   ')).toBe(true);
    expect(isBareFirstHello('HALE LIBRARY')).toBe(true);
    expect(isBareFirstHello('Hi (via earlyon-richmondhill)')).toBe(true);
  });

  it('treats a greeting addressed to Hale by name as still bare (the /text page prefill)', () => {
    expect(isBareFirstHello('Hi Hale')).toBe(true);
    expect(isBareFirstHello('Hi Hale 👋 ready to get started')).toBe(true);
    expect(isBareFirstHello("Hi Hale 👋 let's get started")).toBe(true);
    expect(isBareFirstHello('Hi Hale 👋 let’s get started (via earlyon-richmondhill)')).toBe(true);
    expect(isBareFirstHello('Salut Hale 👋 on commence')).toBe(true);
    // A greeting that carries a real question is NOT bare — the words go to the answerer.
    expect(isBareFirstHello('Hi Hale, when does swim registration open?')).toBe(false);
    expect(isBareFirstHello('hi, hale!')).toBe(true);
    expect(isBareFirstHello('Bonjour Hale')).toBe(true);
    expect(isBareFirstHello('Hi Hale (via markham)')).toBe(true);
    expect(isBareFirstHello('hi')).toBe(true);
    expect(isBareFirstHello('Hi Hale can you help with sleep')).toBe(false);
    const warm = "Hey Hale, what's going on?";
    const warmCurly = 'Hey Hale, what\u2019s going on?';
    expect(isBareFirstHello(warm)).toBe(true);
    expect(isBareFirstHello(`${warm} (via earlyon-richmondhill)`)).toBe(true);
    expect(isBareFirstHello(warmCurly)).toBe(true);
    expect(isBareFirstHello(`${warmCurly} (via markham)`)).toBe(true);
    expect(isBareFirstHello("Hey Hale, what's going on with swim registration?")).toBe(false);
  });

  it('does not treat a first-text question as a bare hello', () => {
    expect(isBareFirstHello('When does swim registration open near me?')).toBe(false);
    expect(isBareFirstHello('When do winter-break camps open?')).toBe(false);
    expect(isBareFirstHello("she's not breathing")).toBe(false);
    expect(isBareFirstHello('who is this exactly?')).toBe(false);
  });

  it('treats the site Text Hale prefill as details, not a question or a hello', () => {
    const prefill = 'Maya is 4, Theo is 18 months, L3R';
    expect(isBareFirstHello(prefill)).toBe(false);
    expect(looksLikeIntakeDetails(prefill)).toBe(true);
    expect(looksLikeIntakeDetails('When does swim registration open near me?')).toBe(false);
    expect(looksLikeIntakeDetails("she's not breathing")).toBe(false);
    expect(looksLikeIntakeDetails('hi')).toBe(false);
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

  it('resolves a referral tag to NO venue, so nothing about a place is claimed or inferred', () => {
    // The consequence that matters: `venueForCode` null means the generic greeting and
    // no coarse area, so the friend is still asked for their postal code. A friend of a
    // Toronto family may live in Calgary.
    expect(venueForCode('friend-0123456789ab')).toBeNull();
    // Positive control through the same reader — a real venue still resolves.
    expect(venueForCode('LIBRARY')?.name).toBe('library');
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

  it('confirms coverage and names the STOP escape, asking nothing itself', () => {
    expect(ASSENT_ACK).toBe(
      "Done - you're covered. I only text when something actually matters, and STOP always works.",
    );
  });

  /**
   * The receipt asks nothing. The call-name is its own later text. Two questions in
   * one SMS is a parent choosing which to answer.
   */
  it('ends without a question, so the call-name can be its own text', () => {
    expect(ASSENT_ACK).not.toContain('?');
    expect(ASSENT_ACK).not.toContain(PARENT_CALL_NAME_ASK);
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

describe('the identity-challenge accountability line (doctrine G15/L3)', () => {
  it('concedes, states what is true, names where the operator lives, and never closes', () => {
    expect(IDENTITY_ACCOUNTABILITY_LINE).toBe(
      `Fair to ask. I'm an AI assistant, and Hale is a Canadian service - who runs it and how to reach them: ${PRIVACY_URL}. STOP ends my texts for good.`,
    );
    // A distrust turn may never end in a close (R9): no question, no ask.
    expect(IDENTITY_ACCOUNTABILITY_LINE).not.toContain('?');
    // The CONSTANT, never a second copy of the URL — same rule as the consent ask.
    expect(IDENTITY_ACCOUNTABILITY_LINE).toContain(PRIVACY_URL);
  });
});

describe('the unparseable-intake door (doctrine G7/L2)', () => {
  it('owns its own words instead of the frozen CASL capability line', () => {
    expect(UNREADABLE_INTAKE_REPLY).toBe(
      "I couldn't read that one. I keep the family week and kids' rec sign-ups - text me like 'Maya is 4, Theo is 1, M5V 2T6' and I'll take it from there. Reply STOP to unsubscribe.",
    );
    // The whole point of the seam split: the compliance reply and the conversational
    // moment no longer share a string, so restyling one can never touch the other.
    expect(UNREADABLE_INTAKE_REPLY).not.toBe(HELP_REPLY);
    // CASL: an intake-stage message still names the way out.
    expect(UNREADABLE_INTAKE_REPLY).toContain('STOP');
    expect(UNREADABLE_INTAKE_REPLY).not.toContain('!');
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
  it('asks a French parent for the same two facts, in the same order', () => {
    expect(COLD_START_ASK_BY_LANGUAGE.fr).toBe(
      "Le nom et l'age de vos enfants, et votre code postal - et je verrai ce qui arrive.",
    );
    // The ask is the whole point of the turn: names, ages, postal code, nothing else.
    expect(COLD_START_ASK_BY_LANGUAGE.fr).toContain('nom');
    expect(COLD_START_ASK_BY_LANGUAGE.fr).toContain("l'age");
    expect(COLD_START_ASK_BY_LANGUAGE.fr).toContain('code postal');
  });

  it('names the same three jobs in French too, and closes on the same ask', () => {
    expect(greeting(null, 'fr')).toBe(
      "Bonjour, je suis Hale. J'aide a planifier l'annee de vos enfants - ce qui se passe près d'eux, les matins d'inscription, et comment ca s'est passé. Le nom et l'age de vos enfants, et votre code postal - et je verrai ce qui arrive.",
    );
    expect(greeting(null, 'fr')).not.toContain('chaos');
    expect(greeting(null, 'fr')).not.toContain('tout-petit');
    expect(greeting(null, 'fr')).not.toContain('une IA');
    expect(greeting(null, 'fr')).toContain(COLD_START_ASK_BY_LANGUAGE.fr);
    expect(greeting(null, 'fr').toLowerCase()).not.toContain('activity finder');
  });

  it('asks what to call the parent in its own line, the words PR #689 locked', () => {
    expect(PARENT_CALL_NAME_ASK).toBe('What should I call you?');
    expect(PARENT_CALL_NAME_ASK).not.toContain('activity finder');
    expect(PARENT_CALL_NAME_ASK).not.toContain('excited');
  });

  it('says the calendar is how the year stays together, and names the trust', () => {
    const url = 'https://app.villagehale.com/connect?t=token&to=gcal';
    expect(intakeCalendarCard('en', url)).toBe(
      `Your calendar is how I keep the year together - what's on, and when it moves. I only read the calendar you connect. Calendar: ${url} Good for 15 minutes.`,
    );
    expect(intakeCalendarCard('fr', url)).toBe(
      `Votre agenda, c'est comment je garde l'annee au meme endroit - ce qui se passe, et quand ca bouge. Je ne lis que l'agenda que vous connectez. Agenda : ${url} Bon pour 15 minutes.`,
    );
    for (const body of [intakeCalendarCard('en', url), intakeCalendarCard('fr', url)]) {
      expect(body.toLowerCase()).not.toContain('ollie');
      expect(body.toLowerCase()).not.toContain('activity finder');
      expect(body).not.toContain('Gmail');
    }
  });

  it('says Gmail is how notices get into the year, and that ignoring it skips', () => {
    const url = 'https://app.villagehale.com/connect?t=token&to=gmail';
    expect(intakeGmailCard('en', url)).toBe(
      `Gmail is how daycare and school notices get into the year. Gmail: ${url} Good for 15 minutes - ignore this to skip.`,
    );
    expect(intakeGmailCard('fr', url)).toBe(
      `Gmail, c'est comment les avis de la garderie et de l'ecole entrent dans l'annee. Gmail : ${url} Bon pour 15 minutes - ignorez pour passer.`,
    );
    for (const body of [intakeGmailCard('en', url), intakeGmailCard('fr', url)]) {
      expect(body.toLowerCase()).not.toContain('ollie');
      expect(body.toLowerCase()).not.toContain('activity finder');
      expect(body).toContain(url);
    }
  });

  it('asks for a co-parent last, by the phrase the join route already reads', () => {
    expect(CO_PARENT_ASK).toBe(
      'Want their other parent on this thread too? Text me a number and I’ll invite them.',
    );
    expect(CO_PARENT_ASK_BY_LANGUAGE.fr).toBe(
      "Vous voulez l'autre parent sur ce fil aussi? Envoyez-moi un numero et je les invite.",
    );
    expect(CO_PARENT_ASK).not.toContain('add my partner');
    expect(CO_PARENT_ASK.toLowerCase()).not.toContain('activity finder');
  });

  /**
   * The venue arrival stays English, and this pins it as a decision rather than an
   * oversight. A parent who scanned a QR code sends the PREFILLED body — "HALE LIBRARY",
   * or "Hi (via earlyon-georgetown)" — which is machine-authored English carrying no
   * evidence about the person holding the phone, so per-message detection can never
   * route this branch to French anyway. On top of that the venue names in SOURCE_VENUES
   * are English nouns ("library", "rec centre") that no French sentence can carry
   * without an article that would have to be picked per venue.
   */
  it('leaves the venue greeting in English, because its trigger is a machine-authored tag', () => {
    expect(greeting('library', 'fr')).toBe(greeting('library', 'en'));
  });

  it('asks the watch question in French and carries the SAME privacy link constant', () => {
    expect(WATCH_OFFER_BY_LANGUAGE.fr).toBe(
      `Voulez-vous que je garde un oeil sur tout cela pour vous? (comment je traite les infos de votre famille : ${PRIVACY_URL})`,
    );
    // The constant, never a second copy of the URL — a policy move must not leave a
    // stale address inside a French consent record's own question.
    expect(WATCH_OFFER_BY_LANGUAGE.fr).toContain(PRIVACY_URL);
  });

  it('confirms coverage in French, names the STOP escape, and asks nothing itself', () => {
    expect(ASSENT_ACK_BY_LANGUAGE.fr).toBe(
      "C'est fait - tout est couvert. Je texte juste quand il le faut, et STOP marche toujours.",
    );
    // CASL: the unsubscribe instruction survives translation, and it survives as the
    // LITERAL token, because that is the only word `matchKeyword` acts on today.
    expect(ASSENT_ACK_BY_LANGUAGE.fr).toContain('STOP');
    // Same reason as the English twin: the turn's one question is the composed identity
    // ask the machine appends, so this half must carry none of its own.
    expect(ASSENT_ACK_BY_LANGUAGE.fr).not.toContain('?');
  });

  /**
   * The identity ask's tail budget is DERIVED from the English acknowledgment
   * (`MAX_TAIL_ASK_CHARS = MAX_ASK_CHARS - ASSENT_ACK.length - 1`), so a French twin
   * longer than its English original would push the consent turn — the one message that
   * both confirms consent and asks a parent their name — into two segments without
   * anything failing. The budget is not language-aware; the copy is what has to fit.
   */
  it('keeps the French acknowledgment inside the tail budget the English one sized', () => {
    expect(smsSegments(`${ASSENT_ACK_BY_LANGUAGE.fr} ${'a'.repeat(MAX_TAIL_ASK_CHARS)}`)).toBe(1);
  });

  it('takes a no without friction in French and leaves the door open', () => {
    expect(DECLINE_ACK_BY_LANGUAGE.fr).toBe(
      'Pas de problème - textez-moi quand vous voulez. Les dates et les trouvailles sont là quand vous en aurez besoin.',
    );
  });

  it('offers the one narrow watch in French when the answer was a wobble', () => {
    expect(AMBIGUOUS_CLARIFY_BY_LANGUAGE.fr).toBe(
      "Comme vous voulez - je surveille au moins les dates d'inscription? Celles-là sont faciles à manquer.",
    );
  });

  it('answers HELP in French with the same capability line and the French keywords', () => {
    expect(HELP_REPLY_BY_LANGUAGE.fr).toBe(
      "Je suis Hale. Écrivez-moi l'age de vos enfants et votre code postal pour commencer, ou par exemple 'bouge la natation de jeudi à 16h30' n'importe quand. Si cela touche la semaine de la famille, c'est pour moi. Répondez ARRET pour vous désabonner, AIDE pour de l'aide.",
    );
    // Both, because both are now real. #491 named STOP alone and said why: `matchKeyword`
    // read the English list only, so naming AIDE would have promised a word that did
    // nothing. This is the follow-up that note asked for.
    expect(HELP_REPLY_BY_LANGUAGE.fr).toContain('ARRET');
    expect(HELP_REPLY_BY_LANGUAGE.fr).toContain('AIDE');
  });

  /**
   * The rule HELP is being fixed to obey (docs/voice.md rules 1 and 3, and the failure
   * coach-channel-sms.md quotes by name): "the same question answered with a feature
   * inventory — nothing in it is a thing a parent can type". SHOW, DON'T LIST.
   *
   * Asserted as a property rather than a second byte pin of the same string: a quoted
   * example is the mechanical shape of showing, and the ban is on the words that make a
   * line an inventory of what Hale IS.
   */
  it('shows a parent something they could type rather than listing what Hale is', () => {
    // A quoted span whose quotes are OUTSIDE a word — the possessives and contractions
    // this copy is full of use the same mark, and only the example is space-delimited.
    const QUOTED_EXAMPLE = /(?:^|\s)'[^']{8,}'(?:[\s.,!?]|$)/;
    for (const [language, line] of Object.entries(HELP_REPLY_BY_LANGUAGE)) {
      expect(line, language).toMatch(QUOTED_EXAMPLE);
      expect(line, language).not.toMatch(/assistant|AI-powered|the app|your account/i);
    }
    // The mutation control: the inventory the old line was, which carries no example and
    // must not pass the shape above.
    expect(
      "I'm Hale - I keep track of your family's week and text you when something needs doing.",
    ).not.toMatch(QUOTED_EXAMPLE);
    expect(HELP_REPLY).toContain("'move Thursday swim to 4:30'");
    // Both halves of the frozen tail survive the rewrite (CASL, and the CTA policy's
    // identification clause).
    expect(HELP_REPLY).toContain("I'm Hale");
    expect(HELP_REPLY).toContain('Reply STOP to unsubscribe.');
  });

  it('answers an identity challenge in French without gendering Hale and without a close', () => {
    expect(IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE.fr).toBe(
      `Bonne question. Je suis une IA - c'est Village Hale, un service canadien, qui me gère: ${PRIVACY_URL}. Répondez ARRET et je ne vous texte plus.`,
    );
    expect(IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE.fr).not.toContain('?');
    expect(IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE.fr).toContain(PRIVACY_URL);
  });

  it('answers an unreadable intake reply in French with its own door, not the HELP line', () => {
    expect(UNREADABLE_INTAKE_REPLY_BY_LANGUAGE.fr).toBe(
      "Je n'ai pas compris ce message. Je garde la semaine et les inscriptions rec - écrivez par exemple 'Maya a 4 ans, Theo a 1 an, H2X 1Y6' et je m'occupe du reste. Répondez ARRET pour vous désabonner, AIDE pour de l'aide.",
    );
    expect(UNREADABLE_INTAKE_REPLY_BY_LANGUAGE.fr).not.toBe(HELP_REPLY_BY_LANGUAGE.fr);
  });

  /**
   * The rule #491's note was keeping by hand, kept structurally from here on: a fixed
   * line may not name a keyword the machine does not honour.
   *
   * ALL-CAPS is the convention every one of these lines uses to name a keyword, so the
   * tokens are read OFF the copy rather than listed beside it — a new line naming a new
   * word is covered the day it is written, which a hand-kept list never is.
   */
  it('names no keyword the machine does not honour', () => {
    const LINES: Record<string, string> = {
      'HELP_REPLY.en': HELP_REPLY_BY_LANGUAGE.en,
      'HELP_REPLY.fr': HELP_REPLY_BY_LANGUAGE.fr,
      'UNREADABLE_INTAKE_REPLY.en': UNREADABLE_INTAKE_REPLY_BY_LANGUAGE.en,
      'UNREADABLE_INTAKE_REPLY.fr': UNREADABLE_INTAKE_REPLY_BY_LANGUAGE.fr,
      'IDENTITY_ACCOUNTABILITY_LINE.en': IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE.en,
      'IDENTITY_ACCOUNTABILITY_LINE.fr': IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE.fr,
      'STOP_ACK.en': STOP_ACK_BY_LANGUAGE.en,
      'STOP_ACK.fr': STOP_ACK_BY_LANGUAGE.fr,
      'ASSENT_ACK.en': ASSENT_ACK_BY_LANGUAGE.en,
      'ASSENT_ACK.fr': ASSENT_ACK_BY_LANGUAGE.fr,
    };
    const named = Object.entries(LINES).flatMap(([name, body]) =>
      (body.match(/\b[A-Z]{3,}\b/g) ?? []).map((token) => ({ name, token })),
    );
    const dead = named
      .filter((entry) => matchKeyword(entry.token) === null)
      .map((entry) => `${entry.name}: ${entry.token}`);

    expect(dead).toEqual([]);
    // The positive control: the scan really does find words, so an empty `dead` is a
    // pass and not a regex that quietly stopped matching anything.
    expect(named.map((entry) => `${entry.name}: ${entry.token}`)).toEqual(
      expect.arrayContaining([
        'HELP_REPLY.fr: ARRET',
        'HELP_REPLY.fr: AIDE',
        'STOP_ACK.en: START',
        'STOP_ACK.fr: DEBUT',
      ]),
    );
  });

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

  it('closes honestly in French when the postal code is outside the region', () => {
    expect(REGION_UNAVAILABLE_REPLY_BY_LANGUAGE.fr).toBe(
      "Je fonctionne seulement pour les familles au Canada pour l'instant, donc je ne peux pas encore vous aider - je n'ai rien mis en place.",
    );
    // The honest half: nothing was provisioned, and the reply says so.
    expect(REGION_UNAVAILABLE_REPLY_BY_LANGUAGE.fr).toContain('Canada');
    expect(REGION_UNAVAILABLE_REPLY_BY_LANGUAGE.fr).toContain("je n'ai rien mis en place");
  });

  /**
   * The English half of every table IS the exported constant, not a copy of it. That is
   * what makes an English copy edit impossible to half-apply: there is one string, and
   * the table points at it.
   */
  it('holds the English constant itself, so the two can never drift apart', () => {
    expect(COLD_START_ASK_BY_LANGUAGE.en).toBe(COLD_START_ASK);
    expect(WATCH_OFFER_BY_LANGUAGE.en).toBe(WATCH_OFFER);
    expect(ASSENT_ACK_BY_LANGUAGE.en).toBe(ASSENT_ACK);
    expect(DECLINE_ACK_BY_LANGUAGE.en).toBe(DECLINE_ACK);
    expect(AMBIGUOUS_CLARIFY_BY_LANGUAGE.en).toBe(AMBIGUOUS_CLARIFY);
    expect(HELP_REPLY_BY_LANGUAGE.en).toBe(HELP_REPLY);
    expect(UNREADABLE_INTAKE_REPLY_BY_LANGUAGE.en).toBe(UNREADABLE_INTAKE_REPLY);
    expect(IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE.en).toBe(IDENTITY_ACCOUNTABILITY_LINE);
    expect(START_ACK_BY_LANGUAGE.en).toBe(START_ACK);
    expect(STOP_ACK_BY_LANGUAGE.en).toBe(STOP_ACK);
    expect(REGION_UNAVAILABLE_REPLY_BY_LANGUAGE.en).toBe(REGION_UNAVAILABLE_REPLY);
  });

  /**
   * The routing itself, end to end at the copy layer: a body goes in, the words a parent
   * actually receives come out. Both directions, because a table that always returned
   * French would pass the French half of this file on its own.
   */
  it('sends the French line to a parent who wrote French and the English one to everyone else', () => {
    const frenchReply = 'Oui, avec plaisir';
    const englishReply = 'yes please';

    expect(ASSENT_ACK_BY_LANGUAGE[replyLanguage(frenchReply)]).toBe(ASSENT_ACK_BY_LANGUAGE.fr);
    expect(ASSENT_ACK_BY_LANGUAGE[replyLanguage(englishReply)]).toBe(ASSENT_ACK);
    expect(DECLINE_ACK_BY_LANGUAGE[replyLanguage('Non merci')]).toBe(DECLINE_ACK_BY_LANGUAGE.fr);
    expect(DECLINE_ACK_BY_LANGUAGE[replyLanguage('no thanks')]).toBe(DECLINE_ACK);
  });
});
