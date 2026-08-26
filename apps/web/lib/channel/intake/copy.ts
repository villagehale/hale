import type { ReplyLanguage } from '~/lib/channel/language';
import { isReferralCode } from '~/lib/channel/referral/code';
import { PRIVACY_URL } from '~/lib/legal-links';

/**
 * VIL-237 · M2 — every word Hale texts during intake, in one file.
 *
 * This is the SPEC, not a template layer: the eval suites and the state-machine
 * tests assert against these exact strings, so a copy change is a deliberate,
 * reviewable diff rather than a silent drift in what a stranger's first contact with
 * Hale sounds like.
 *
 * The split is DECISIONS vs RENDERING (the charisma/intelligence split). What Hale
 * DECIDES — which turn comes next, what it will not invent, what a consent record says —
 * is deterministic here, and so is every compliance string (the keyword replies, the
 * blocked and region lines, the consent ask): those are promises, and a promise a model
 * paraphrased is a promise nobody made. What Hale SOUNDS like on the ACKNOWLEDGMENT
 * turns — the "Got it - …" that echoes a parent's own words back — is model-composed
 * through the `intake-voice` skill, gated on grounding and length, and falling back to
 * the template below whenever the model is unreachable, wrong, or over budget. Every
 * string here is therefore either the message itself or the floor under a composed one.
 *
 * Rule #1: no message ever carries a child's health detail, a precise location, or
 * anything the parent did not just tell us in this conversation.
 *
 * IT NOW HAS A FRENCH HALF. Hale already replied in French wherever a MODEL wrote the
 * words; everything in this file was English, so a francophone parent got the composed
 * turns in their language and every promise — the introduction, the consent ask, the
 * acknowledgment, the region boundary — in someone else's. The French twin of each fixed
 * line sits beside it in a `Record<ReplyLanguage, string>` whose `en` half IS the
 * exported constant, so an English copy edit cannot be half-applied, and `replyLanguage`
 * (lib/channel/language.ts) picks between them from the message that just arrived.
 *
 * THE FRENCH IS GSM-7, which is a constraint on the WORDS and not a fold applied after
 * them. The alphabet carries é è à ù and not â ê î ô û ç, so the copy below is written
 * around the characters it cannot have — and where the language leaves no way around one
 * (`age`, which has no accent-free synonym in this register), the circumflex is dropped
 * to its base letter exactly as `gsmSafe` folds a family's own name. Each such word is
 * named at its constant. The alternative is a UCS-2 message at 70 characters a segment:
 * triple the carrier bill on Hale's first sentence to a stranger, forever.
 */

export interface SourceVenue {
  /** How the venue is named back to the parent. */
  name: string;
  /** The venue's OWN coarse area (FSA). This is a fact about where the poster hangs,
   * not a claim about where the family lives — it seeds discovery when the parent was
   * never asked for a postal code (rule #1: coarse only, never an address). */
  areaCoarse: string;
  /**
   * The PLACE the poster hangs in, named the way a person would say it — "Georgetown",
   * not an FSA and not the venue's type. Present only on the codes that are a physical
   * poster the founder put up himself, which is exactly the set the founder-welcome ping
   * fires for: the location is the whole content of that ping (rule #1 — no parent, no
   * child, no number), so a code with no place name has nothing to say and is not one.
   *
   * The registry IS the trigger, deliberately, rather than a prefix test on the code. A
   * prefix would match a future `earlyon-` poster nobody has named a place for and put an
   * empty blank in a sentence sent to a person.
   */
  poster?: string;
}

/**
 * The QR venue codes a prefilled body may carry. The registry IS the source of truth:
 * an unrecognised code is treated as no context at all rather than echoed, so Hale can
 * never claim to know a place we have never heard of, nor infer an area from one.
 */
export const SOURCE_VENUES: Record<string, SourceVenue> = {
  LIBRARY: { name: 'library', areaCoarse: 'M5V' },
  REC: { name: 'rec centre', areaCoarse: 'M6K' },
  CLINIC: { name: 'clinic', areaCoarse: 'M4K' },
  SCHOOL: { name: 'school', areaCoarse: 'L7G' },
  'earlyon-richmondhill': {
    name: 'EarlyON centre',
    areaCoarse: 'L4C',
    poster: 'Richmond Hill',
  },
  'earlyon-georgetown': { name: 'EarlyON centre', areaCoarse: 'L7G', poster: 'Georgetown' },
  // Per-location Halton Hills posters, so the source code says WHICH centre.
  'earlyon-acton': { name: 'EarlyON centre', areaCoarse: 'L7J', poster: 'Acton' },
  // The pitch deck's QR — so we see which investors actually texted the product.
  'investor-deck': { name: 'the pitch deck', areaCoarse: 'M5V' },
  // Toronto postering-column run (2026-08). One code per column — the posters are
  // visually identical and the code rides the SMS body, so the weekly re-postering
  // pass can prune columns that never text. City surfaces are cleared weekly, so a
  // code going quiet means the spot, not the poster. No lifetime comp on these.
  'poster-bayview-sheppard': {
    name: 'Bayview & Sheppard poster',
    areaCoarse: 'M2K',
    poster: 'Bayview & Sheppard',
  },
  'poster-yonge-sheppard': {
    name: 'Yonge & Sheppard poster',
    areaCoarse: 'M2N',
    poster: 'Yonge & Sheppard',
  },
  'poster-yonge-hollywood': {
    name: 'Yonge & Hollywood poster',
    areaCoarse: 'M2N',
    poster: 'Yonge & Hollywood',
  },
  'poster-north-york-centre': {
    name: 'North York Centre poster',
    areaCoarse: 'M2N',
    poster: 'North York Centre',
  },
  'poster-yonge-ellerslie': {
    name: 'Yonge & Ellerslie poster',
    areaCoarse: 'M2N',
    poster: 'Yonge & Ellerslie',
  },
  'poster-kensington': {
    name: 'Kensington Market poster',
    areaCoarse: 'M5T',
    poster: 'Kensington Market',
  },
  'poster-spadina-dundas': {
    name: 'Spadina & Dundas poster',
    areaCoarse: 'M5T',
    poster: 'Spadina & Dundas',
  },
  'poster-grange-park': {
    name: 'Grange Park poster',
    areaCoarse: 'M5T',
    poster: 'Grange Park',
  },
  'poster-queen-john': {
    name: 'Queen & John poster',
    areaCoarse: 'M5V',
    poster: 'Queen & John',
  },
  'poster-queen-spadina': {
    name: 'Queen & Spadina poster',
    areaCoarse: 'M5V',
    poster: 'Queen & Spadina',
  },
  'poster-queen-bathurst': {
    name: 'Queen & Bathurst poster',
    areaCoarse: 'M5V',
    poster: 'Queen & Bathurst',
  },
  'poster-leslieville-carlaw': {
    name: 'Queen & Carlaw poster',
    areaCoarse: 'M4M',
    poster: 'Leslieville - Queen & Carlaw',
  },
  'poster-leslieville-jones': {
    name: 'Queen & Jones poster',
    areaCoarse: 'M4M',
    poster: 'Leslieville - Queen & Jones',
  },
  'poster-queen-coxwell': {
    name: 'Queen & Coxwell poster',
    areaCoarse: 'M4L',
    poster: 'Queen & Coxwell',
  },
  'poster-beaches-woodbine': {
    name: 'Queen & Woodbine poster',
    areaCoarse: 'M4L',
    poster: 'The Beaches - Queen & Woodbine',
  },
  'poster-beaches-lee': {
    name: 'Queen & Lee poster',
    areaCoarse: 'M4E',
    poster: 'The Beaches - Queen & Lee',
  },
  'poster-high-park-humberside': {
    name: 'High Park & Humberside poster',
    areaCoarse: 'M6P',
    poster: 'High Park & Humberside',
  },
  'poster-high-park-annette': {
    name: 'High Park & Annette poster',
    areaCoarse: 'M6P',
    poster: 'High Park & Annette',
  },
  'poster-junction-pacific': {
    name: 'Dundas & Pacific poster',
    areaCoarse: 'M6P',
    poster: 'The Junction - Dundas & Pacific',
  },
  'poster-junction-clendenan': {
    name: 'Dundas & Clendenan poster',
    areaCoarse: 'M6P',
    poster: 'The Junction - Dundas & Clendenan',
  },
  'poster-leaside-laird': {
    name: 'Eglinton & Laird poster',
    areaCoarse: 'M4G',
    poster: 'Leaside - Eglinton & Laird',
  },
  'poster-leaside-rumsey': {
    name: 'Millwood & Rumsey poster',
    areaCoarse: 'M4G',
    poster: 'Leaside - Millwood & Rumsey',
  },
  'poster-bayview-belsize': {
    name: 'Bayview & Belsize poster',
    areaCoarse: 'M4S',
    poster: 'Bayview & Belsize',
  },
  'poster-bayview-fleming': {
    name: 'Bayview & Fleming poster',
    areaCoarse: 'M4S',
    poster: 'Bayview & Fleming',
  },
  // Expansion wave (2026-08): family corridors from the City structure inventory —
  // Riverdale/Danforth, Roncesvalles, Bloor West Village, midtown Yonge, deeper
  // Beaches and High Park, St Clair West.
  'poster-queen-broadview': {
    name: 'Queen & Broadview poster',
    areaCoarse: 'M4M',
    poster: 'Riverdale - Queen & Broadview',
  },
  'poster-queen-logan': {
    name: 'Queen & Logan poster',
    areaCoarse: 'M4M',
    poster: 'Riverdale - Queen & Logan',
  },
  'poster-danforth-broadview': {
    name: 'Danforth & Broadview poster',
    areaCoarse: 'M4K',
    poster: 'The Danforth - Broadview',
  },
  'poster-danforth-playter': {
    name: 'Danforth & Playter poster',
    areaCoarse: 'M4K',
    poster: 'The Danforth - Playter Estates',
  },
  'poster-danforth-pape': {
    name: 'Danforth Avenue poster',
    areaCoarse: 'M4J',
    poster: 'The Danforth - 975 Danforth Ave',
  },
  'poster-roncesvalles-marion': {
    name: 'Roncesvalles & Marion poster',
    areaCoarse: 'M6R',
    poster: 'Roncesvalles - Marion',
  },
  'poster-roncesvalles-galley': {
    name: 'Roncesvalles & Galley poster',
    areaCoarse: 'M6R',
    poster: 'Roncesvalles - Galley',
  },
  'poster-roncesvalles-fermanagh': {
    name: 'Roncesvalles & Fermanagh poster',
    areaCoarse: 'M6R',
    poster: 'Roncesvalles - Fermanagh',
  },
  'poster-roncesvalles-grenadier': {
    name: 'Roncesvalles & Grenadier poster',
    areaCoarse: 'M6R',
    poster: 'Roncesvalles - Grenadier',
  },
  'poster-roncesvalles-howard-park': {
    name: 'Roncesvalles & Howard Park poster',
    areaCoarse: 'M6R',
    poster: 'Roncesvalles - Howard Park',
  },
  'poster-bloor-parkside': {
    name: 'Bloor & Parkside poster',
    areaCoarse: 'M6P',
    poster: 'High Park - Bloor & Parkside',
  },
  'poster-bloor-west-glendonwynne': {
    name: 'Bloor West Village poster',
    areaCoarse: 'M6S',
    poster: 'Bloor West Village - Glendonwynne',
  },
  'poster-bloor-west-willard': {
    name: 'Bloor & Willard poster',
    areaCoarse: 'M6S',
    poster: 'Bloor West Village - Willard',
  },
  'poster-bloor-west-riverview': {
    name: 'Bloor & Riverview poster',
    areaCoarse: 'M6S',
    poster: 'Bloor West Village - Riverview Gardens',
  },
  'poster-bloor-west-old-mill': {
    name: 'Bloor & Old Mill poster',
    areaCoarse: 'M8X',
    poster: 'Old Mill & Swansea',
  },
  'poster-yonge-davisville': {
    name: 'Yonge & Davisville poster',
    areaCoarse: 'M4S',
    poster: 'Davisville - Yonge & Davisville',
  },
  'poster-yonge-millwood': {
    name: 'Yonge & Millwood poster',
    areaCoarse: 'M4S',
    poster: 'Davisville - Yonge & Millwood',
  },
  'poster-mt-pleasant-manor': {
    name: 'Mount Pleasant & Manor poster',
    areaCoarse: 'M4S',
    poster: 'Mount Pleasant - Manor Rd',
  },
  'poster-yonge-eglinton': {
    name: 'Yonge & Eglinton poster',
    areaCoarse: 'M4R',
    poster: 'Yonge & Eglinton',
  },
  'poster-yonge-lawrence-park': {
    name: 'Lawrence Park poster',
    areaCoarse: 'M4N',
    poster: 'Lawrence Park - 3060 Yonge',
  },
  'poster-yonge-bedford-park': {
    name: 'Yonge & Woburn poster',
    areaCoarse: 'M4N',
    poster: 'Bedford Park - Yonge & Woburn',
  },
  'poster-beaches-kew': {
    name: 'Queen & Brookmount poster',
    areaCoarse: 'M4E',
    poster: 'The Beaches - Kew Gardens',
  },
  'poster-kingston-waverley': {
    name: 'Kingston & Waverley poster',
    areaCoarse: 'M4L',
    poster: 'The Beaches - Kingston & Waverley',
  },
  'poster-upper-beaches': {
    name: 'Kingston & Scarborough Rd poster',
    areaCoarse: 'M4E',
    poster: 'Upper Beaches',
  },
  'poster-high-park-glenlake': {
    name: 'High Park & Glenlake poster',
    areaCoarse: 'M6P',
    poster: 'High Park - Glenlake',
  },
  'poster-high-park-dundas': {
    name: 'High Park & Dundas poster',
    areaCoarse: 'M6P',
    poster: 'High Park - Dundas',
  },
  'poster-st-clair-christie': {
    name: 'St Clair & Christie poster',
    areaCoarse: 'M6C',
    poster: 'St Clair West - Christie',
  },
  'poster-st-clair-rushton': {
    name: 'St Clair & Rushton poster',
    areaCoarse: 'M6C',
    poster: 'St Clair West - Rushton',
  },
  'poster-st-clair-atlas': {
    name: 'St Clair & Atlas poster',
    areaCoarse: 'M6C',
    poster: 'St Clair West - Atlas',
  },
};

/**
 * The prefilled-body conventions. Two forms, both venue-in-the-message (one number,
 * many posters — the venue rides IN the first text rather than in a per-venue phone
 * number or a link the parent would have to open):
 *   1. `HALE <CODE>` — the whole body is the tag (original QR cards).
 *   2. `Hi (via <code>)` — the /text entry page's convention (VIL-240): a human first
 *      message with the tag as a trailing, visibly-disclosed suffix. Suffix-anchored so
 *      an ordinary sentence containing "(via …)" mid-message never matches.
 *
 * A `<code>` is either a QR VENUE (the registry below) or a per-family REFERRAL tag
 * (`friend-…`, lib/channel/referral/code.ts) forwarded by a parent. Both ride the same
 * `?s=` funnel and the same suffix; they differ only in what they resolve to, which is
 * `resolveCode`'s job.
 */
const SOURCE_TAG = /^hale[\s:-]+([a-z0-9-]{2,48})$/i;
const SOURCE_TAG_SUFFIX = /\(via\s+([a-z0-9]+(?:-[a-z0-9]+)*)\)$/i;

/**
 * The canonical registry key for a raw tag, matched case-insensitively.
 *
 * A REFERRAL tag is recognised by its shape rather than by the registry. The registry
 * exists because a venue's NAME is read back to the parent in the greeting, so an
 * unrecognised venue would have Hale claiming to know a place it has never heard of. A
 * referral tag is echoed nowhere and selects nothing — `venueForCode` returns null for
 * it, so the arrival gets the ordinary no-venue greeting and is still asked for a postal
 * code, which is correct: a friend of a Toronto family may live anywhere.
 */
function resolveCode(raw: string): string | null {
  if (isReferralCode(raw)) return raw.toLowerCase();
  if (raw in SOURCE_VENUES) return raw;
  const upper = raw.toUpperCase();
  if (upper in SOURCE_VENUES) return upper;
  const lower = raw.toLowerCase();
  if (lower in SOURCE_VENUES) return lower;
  return null;
}

/** The venue CODE (registry key) for a prefilled first body, or null when the body
 * carries no tag or a tag we don't recognise. */
export function sourceCodeFromBody(body: string): string | null {
  const trimmed = body.trim();
  const full = SOURCE_TAG.exec(trimmed);
  if (full) return resolveCode(full[1] as string);
  const suffix = SOURCE_TAG_SUFFIX.exec(trimmed);
  if (suffix) return resolveCode(suffix[1] as string);
  return null;
}

/** The registry entry for a stored source code, or null. */
export function venueForCode(code: string | null): SourceVenue | null {
  if (!code) return null;
  return SOURCE_VENUES[code] ?? null;
}

/** The PLACE a stored source code's poster hangs in, or null when the code is not one of
 * the founder's own posters. The whole trigger for the founder-welcome ping — see
 * {@link SourceVenue.poster}. */
export function posterLocation(code: string | null): string | null {
  return venueForCode(code)?.poster ?? null;
}

/**
 * The first thing a stranger ever reads from Hale.
 *
 * The AI disclosure is IN the introduction rather than trailing it: "an AI that quietly
 * runs the family week" is both what Hale is and what it does, so honesty costs no extra
 * sentence and cannot be skimmed past the way a closing parenthetical can. The privacy
 * link is deliberately NOT here — it rides on {@link WATCH_OFFER}, the one turn where a
 * parent is actually asked to agree to something.
 *
 * THE VENUE VARIANT HAS NO FRENCH TWIN, and that is a decision rather than a gap. The
 * body that triggers it is the PREFILLED one a QR code wrote — "HALE LIBRARY", or
 * "Hi (via earlyon-georgetown)" — which is machine-authored English carrying no evidence
 * at all about the person holding the phone, so per-message detection can never route
 * this branch to French. The venue names in {@link SOURCE_VENUES} are English nouns on
 * top of that, and a French sentence cannot carry one without an article chosen per
 * venue. A francophone who types their own first message gets the no-venue greeting,
 * which is the one that asks for a postal code anyway.
 */
export function greeting(venue: string | null, language: ReplyLanguage): string {
  if (venue) {
    return `Hi, I'm Hale - an AI that quietly runs the family week for parents around here. You found me at the ${venue}, so I already know the area. Kids' names and ages, and I'll get to work.`;
  }
  if (language === 'fr') {
    return `Bonjour, je suis Hale - une IA qui gère discrètement la semaine familiale. Les dates d'inscription, les sorties de fin de semaine, ce qui risque de vous échapper. ${COLD_START_ASK_BY_LANGUAGE.fr}`;
  }
  return `Hi, I'm Hale - an AI that quietly runs the family week. Registration dates, weekend plans, the stuff that slips. ${COLD_START_ASK}`;
}

/**
 * The ONE thing Hale asks a stranger for, extracted from {@link greeting} because a
 * second door onto intake now exists: somebody who CALLS the number is texted an opener
 * by the voice front door (lib/channel/twilio/voice.ts), and their reply lands in this
 * same machine.
 *
 * Shared rather than re-worded on purpose. Two openers asking for the same two facts in
 * two voices is how a product starts sounding like two products — and the reply parser
 * behind both is one extractor, so an ask that drifts is an ask the machine is no longer
 * tuned for.
 */
export const COLD_START_ASK =
  "Tell me your kids' names and ages, plus your postal code - and I'll get to work.";

/**
 * The same ask, in the language the parent just wrote in.
 *
 * FOLDED WORD: `l'age`. GSM-7 has no â, and French has no accent-free synonym for "âge"
 * in this register — every alternative asks for something else (a birth date is more
 * data than Hale needs, a birth year is a different question, and the extractor is tuned
 * for ages). So the circumflex drops to its base letter, which is what `gsmSafe` already
 * does to a family's own name and what every French phone keyboard does under pressure.
 * FOUNDER REVIEW: this is the one deliberate misspelling in the French script.
 */
export const COLD_START_ASK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: COLD_START_ASK,
  fr: "Dites-moi le nom et l'age de vos enfants, plus votre code postal - et je me mets au travail.",
};

/**
 * What intake still needs before a family can be set up. Both are hard requirements
 * and for the same reason: Hale will not invent either one. A postal code it cannot
 * place is a compliance boundary (rule #1); an age it was never given would be a
 * fabricated date of birth, which every stage, checkpoint and registration band is
 * computed from afterwards.
 */
export type IntakeGap = 'ages' | 'location';

const GAP_ASK: Record<IntakeGap, string> = {
  ages: 'how old are they',
  location: "what's your postal code",
};

/**
 * The single targeted ASK, at most once per intake — so when two things are outstanding
 * it asks for both in the one message it gets.
 *
 * Split out from {@link followUp} because the composed acknowledgment reuses it verbatim:
 * `intake-voice` writes the "Got it - …" half and is forbidden from writing a question,
 * so this exact sentence is what the shell appends after it. One question, authored once,
 * whichever half of the turn the model wrote.
 */
export function followUpQuestion(missing: readonly IntakeGap[]): string {
  return `Last thing: ${missing.map((gap) => GAP_ASK[gap]).join(', and ')}?`;
}

/** The deterministic follow-up: the plain echo plus the ask. This is what goes out when
 * the composed acknowledgment is unavailable or unusable — so an outage costs a parent
 * warmth, never the question Hale actually needs answered. */
export function followUp(summary: string, missing: readonly IntakeGap[]): string {
  return `Got it - ${summary}. ${followUpQuestion(missing)}`;
}

/**
 * The consent question ITSELF, without the link that rides with it.
 *
 * Split out because a second reader now needs it: when a parent answers this with a
 * question of their own, the answering turn is handed the pending ask so it can get
 * back to it in different words (answer.ts). It is handed the QUESTION and not the
 * whole message — a privacy URL inside a model's context is a URL a model can quote,
 * and this stage is forbidden from writing links at all.
 */
export const WATCH_OFFER_ASK = 'Want me to keep an eye on all of this for you?';

/**
 * The consent moment, and the one message in intake that carries a link.
 *
 * The privacy URL lives HERE rather than in the greeting because this is the turn where
 * a parent is asked to agree to ongoing watching — "where does my family's data go" is a
 * question about the thing being consented to, and a link in the greeting would be asked
 * to answer it three messages too early. Built from the {@link PRIVACY_URL} constant so a
 * policy move cannot leave a stale URL inside a consent record's own question.
 */
export const WATCH_OFFER = `${WATCH_OFFER_ASK} (how I handle your family's info: ${PRIVACY_URL})`;

/**
 * The French consent moment, built the same way: the ask, then the SAME privacy
 * constant. A second literal copy of the URL is how one language ends up pointing at a
 * policy that moved.
 *
 * `un oeil` rather than `un œil`: the ligature is not in GSM-7 and the digraph is its
 * standard ASCII spelling, so nothing is lost. `tout cela` rather than `tout ça`: the
 * alphabet has no lowercase ç, and folding it would leave "ca", which is not a word.
 */
export const WATCH_OFFER_ASK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: WATCH_OFFER_ASK,
  fr: 'Voulez-vous que je garde un oeil sur tout cela pour vous?',
};

export const WATCH_OFFER_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: WATCH_OFFER,
  fr: `${WATCH_OFFER_ASK_BY_LANGUAGE.fr} (comment je traite les infos de votre famille : ${PRIVACY_URL})`,
};

/**
 * The yes. Names the restraint (only when it matters) and keeps the CASL escape hatch
 * visible. Fixed, because both of those are promises and a promise a model paraphrased
 * is a promise nobody made.
 *
 * IT NO LONGER ENDS IN A QUESTION, and that is this turn's one question budget being
 * spent somewhere better. It used to close on "what part of the week wears you out the
 * most?" — an opener whose answer went to the coach. The turn now closes on the identity
 * ask instead (machine.ts appends it), because Hale had no other moment to ask a texting
 * family what to call them: intake writes `users.name = null` and, until this changed,
 * nothing in the SMS product ever filled it in. A nameless parent is one the introduction
 * email cannot greet, which is exactly where the intros handoff was stalling.
 *
 * The two cannot stack. One message asks one question, and an ack carrying both is a
 * parent choosing which to answer — so the opener is the one that gave way: a parent who
 * texts their name back has still started the conversation that outlives intake, and it
 * arrives after the session closes and is handed to the coach exactly as before (the
 * `no_open_conversation` seam in machine.ts / twilio/inbound.ts).
 *
 * The appended ask is COMPOSED and may defer, so this sentence has to be whole on its
 * own — which it is. A deferred ask costs the name, never the acknowledgment.
 */
export const ASSENT_ACK =
  "Done - you're covered. I only text when something actually matters, and STOP always works.";
export const DECLINE_ACK =
  'No problem - text me whenever you like. The dates and finds are here when you want them.';
export const AMBIGUOUS_CLARIFY =
  "Happy either way - should I watch the registration dates at least? That one's easy to miss.";

/**
 * The three consent-turn answers in French.
 *
 * ASSENT_ACK_FR IS LENGTH-CONSTRAINED, and it is the only line here that is. The identity
 * ask appended to it is budgeted from the ENGLISH constant
 * (`MAX_TAIL_ASK_CHARS = MAX_ASK_CHARS - ASSENT_ACK.length - 1`, identity/ask-voice.ts),
 * so a longer French twin would push the consent turn into two segments with nothing
 * failing anywhere. The test in copy.test.ts holds it to one segment WITH a full-budget
 * tail; the words below were cut to fit that, not the other way round.
 *
 * `tout est couvert` rather than `vous etes couvert`: GSM-7 has no ê, and the fold would
 * be visible in the most prominent word of the most important message. It also sidesteps
 * a gender agreement Hale has no business guessing about the parent.
 */
export const ASSENT_ACK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: ASSENT_ACK,
  fr: "C'est fait - tout est couvert. Je texte juste quand il le faut, et STOP marche toujours.",
};

export const DECLINE_ACK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: DECLINE_ACK,
  fr: 'Pas de problème - textez-moi quand vous voulez. Les dates et les trouvailles sont là quand vous en aurez besoin.',
};

export const AMBIGUOUS_CLARIFY_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: AMBIGUOUS_CLARIFY,
  fr: "Comme vous voulez - je surveille au moins les dates d'inscription? Celles-là sont faciles à manquer.",
};

/**
 * The CASL keyword replies. STOP gets one final confirmation and then silence; HELP
 * (and anything unparseable) gets the same honest capability line, because a parent
 * who typed something we couldn't read needs to know what we CAN do, not an error.
 */
export const STOP_ACK =
  "You're unsubscribed - I won't text you again. Reply START if you ever want me back.";
export const HELP_REPLY =
  "I'm Hale - I keep track of your family's week and text you when something needs doing. Tell me your kids' names and ages and I'll take it from there. Reply STOP to unsubscribe.";
export const START_ACK = "You're back - I'll text you when something needs doing.";

/**
 * The French keyword replies — now the answer to a keyword rather than a line waiting
 * for one.
 *
 * WHAT CANADIAN CARRIERS REQUIRE, verified against the Canadian Telecommunications
 * Association's "Canadian Common Short Code Compliance Policies" v2.1 (January 2026,
 * §3.1): five keywords are mandatory for every program — STOP, ARRET, HELP, AIDE, INFO —
 * "regardless of the intended audience", and texting AIDE or ARRET "must return a French
 * response" while a French-only program must still answer English STOP and HELP. Twilio
 * recognises NONE of the French ones by default: its built-in set is English only
 * (STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/REVOKE/OPTOUT/QUIT, START/YES/UNSTOP, HELP/INFO),
 * and localised keywords exist only as explicit entries on a Messaging Service with
 * Advanced Opt-Out configured. CASL itself is silent on the language of the unsubscribe
 * mechanism; the carrier policy is the binding requirement here, not the statute.
 *
 * HALE MEETS IT NOW. `matchKeyword` (keywords.ts) claims ARRET, AIDE and DEBUT with the
 * same CASL semantics as their English twins, and hands the language along WITH the
 * match — so an AIDE cannot be answered in English by a detector that reads the body and
 * finds one ambiguous word. That is what unblocked the line below: #491 said "Répondez
 * STOP" and said why (naming a keyword that does nothing is worse than not naming it),
 * and the tail now names the two words a French parent can actually send.
 *
 * WHY THE HELP LINE OFFERS AIDE AT ALL, given that a parent reading it may well have
 * just typed it: this line has a second door. An unparseable first reply during intake
 * lands on it too (machine.ts), and that parent never typed a keyword — for them
 * "AIDE pour de l'aide" is the instruction, not an echo.
 *
 * `désabonner` keeps its é (GSM-7 has it). The keyword tokens are written WITHOUT their
 * accents — ARRET, DEBUT — because that is how a keyword is typed under pressure and
 * because `matchKeyword` folds the accent anyway, so both spellings arrive at the same
 * place; printing the bare form promises the easier one.
 */
export const HELP_REPLY_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: HELP_REPLY,
  fr: "Je suis Hale - je garde le fil de la semaine de votre famille et je vous texte quand quelque chose demande votre attention. Dites-moi le nom et l'age de vos enfants et je m'occupe du reste. Répondez ARRET pour vous désabonner, AIDE pour de l'aide.",
};

/**
 * The French unsubscribe confirmation — the one twin #491 could not write, because a
 * French STOP acknowledgment can only be reached by a French STOP keyword.
 *
 * FOUNDER REVIEW: these words are new, not a translation of a reviewed line.
 *
 * `Terminé` rather than a translation of "You're unsubscribed": every French rendering
 * of that phrase agrees with the parent's gender (`désabonné`/`désabonnée`), and Hale
 * guesses at neither the parent's gender nor its own anywhere in this file. It also
 * deliberately does NOT reuse `C'est fait`, which opens the consent acknowledgment — the
 * two events are opposites and should not share an opening.
 *
 * It offers DEBUT rather than START because the parent reading it just wrote French, and
 * an escape hatch in the other language is the same broken promise the whole French half
 * of this file exists to end. Both words work; this one is the one they will reach for.
 */
export const STOP_ACK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: STOP_ACK,
  fr: 'Terminé - je ne vous texte plus. Répondez DEBUT si vous voulez que je revienne.',
};

export const START_ACK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: START_ACK,
  fr: 'Vous voilà de retour - je vous texte quand quelque chose demande votre attention.',
};

/**
 * Said ONCE when the one follow-up went unanswered and something Hale cannot invent is
 * still outstanding. It states the blocker plainly and then goes quiet rather than
 * asking a third time — the session stays open, so an answer sent later still completes
 * the setup.
 */
export function detailsBlocked(missing: readonly IntakeGap[]): string {
  if (missing.includes('ages')) {
    return missing.includes('location')
      ? "I can't set your family up until I know your kids' ages and your postal code - send them whenever you're ready."
      : "I can't set your family up until I know how old your kids are - send their ages whenever you're ready.";
  }
  return "I can't set your family up until I know your postal code - send it whenever you're ready.";
}

/** The honest close when a postal code is outside the region Hale is cleared for
 * (rule #1). Nothing is provisioned; the reply says so rather than leaving a family
 * believing they are signed up. */
export const REGION_UNAVAILABLE_REPLY =
  "I'm only set up for families in Canada right now, so I can't help yet - I haven't set anything up.";

/**
 * The same honest close in French, and the one Hale is most likely to owe a francophone:
 * a Quebec postal code is inside the region and an out-of-country one is not, so this
 * line is what a French-writing parent outside Canada reads.
 *
 * `Je fonctionne` rather than `Je suis configurée`: Hale takes no gender in French, here
 * or anywhere else in this file, and a participle that agreed with "une IA" would be the
 * product quietly choosing one.
 */
export const REGION_UNAVAILABLE_REPLY_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: REGION_UNAVAILABLE_REPLY,
  fr: "Je fonctionne seulement pour les familles au Canada pour l'instant, donc je ne peux pas encore vous aider - je n'ai rien mis en place.",
};
