import { isJoinCode } from '~/lib/channel/join/code';
import { isReferralCode } from '~/lib/channel/referral/code';

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
 * paraphrased is a promise nobody made. #868 moved every onboarding turn to the
 * friend voice (model-written); the fixed follow-up, watch, assent, connector-offer,
 * identity and cold-start lines that used to live here are gone.
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
  // "family centre", never the centres' program brand: "EarlyON" is a trademarked
  // term (Ontario), so it appears in no greeting, no plate, and no new code. The
  // earlyon-* keys that remain are printed on posters already hanging and cannot
  // change without orphaning those QRs.
  'earlyon-richmondhill': {
    name: 'family centre',
    areaCoarse: 'L4C',
    poster: 'Richmond Hill',
  },
  'earlyon-georgetown': { name: 'family centre', areaCoarse: 'L7G', poster: 'Georgetown' },
  // Per-location Halton Hills posters, so the source code says WHICH centre.
  'earlyon-acton': { name: 'family centre', areaCoarse: 'L7J', poster: 'Acton' },
  // Indoor board at West Neighbourhood House, 248 Ossington Ave — a venue plate,
  // not a City column. Carries the lifetime comp (promo.ts).
  ossington: { name: 'family centre', areaCoarse: 'M6J', poster: 'Ossington' },
  // Indoor board at 3990 14th Ave, Markham — the first GTA board to say yes, so it
  // carries the lifetime Family comp (promo.ts).
  markham: { name: 'family centre', areaCoarse: 'L3R', poster: 'Markham' },
  // Legacy spelling of the Markham code: a copy with this QR is already on the
  // venue's board (first scan 2026-08-28). Remove once the reprint replaces it.
  'earlyon-markham': { name: 'family centre', areaCoarse: 'L3R', poster: 'Markham' },
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
 *
 * A JOIN tag (`join-…`, lib/channel/join/code.ts) is recognised the same way and for the
 * same reason, but what happens to it afterwards is the opposite: the machine DIVERTS on
 * it before a session is ever created, because it names a household that already exists.
 * It is passed through here rather than resolved here because the answer lives in a
 * table and this function is pure — and because a token that buys nothing must still be
 * recognised, so the arrival can be greeted normally rather than told it is too late.
 */
function resolveCode(raw: string): string | null {
  if (isJoinCode(raw)) return raw.toLowerCase();
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
 * What intake still needs before a family can be set up. Both are hard requirements
 * and for the same reason: Hale will not invent either one. A postal code it cannot
 * place is a compliance boundary (rule #1); an age it was never given would be a
 * fabricated date of birth, which every stage, checkpoint and registration band is
 * computed from afterwards.
 */
export type IntakeGap = 'ages' | 'location';

/**
 * The calendar card, its own text, after the call-name.
 *
 * One ask: the link. The bubble is short. The link unfurls as its own card
 * (title + the trust line). The kids-year payoff is the text after it connects,
 * not a second ask here. GSM-7.
 */
export const INTAKE_CALENDAR_CARD_TEMPLATE_KEY = 'intake:calendar_card';

/**
 * The Gmail card, its own text, after the calendar card.
 *
 * One ask: the link. Ignoring it is the skip. Same trust line as the calendar
 * card, with this connector's disconnect words. GSM-7.
 */
export const INTAKE_GMAIL_CARD_TEMPLATE_KEY = 'intake:gmail_card';

/**
 * Last ask of intake on SMS, its own text, after the Gmail card.
 *
 * The SMS door still needs a number before it can text the invite, so this door
 * keeps the number ask. Linq does not use it: the iMessage ask is
 * `linqCoParentAsk` (Sloane, 2026-09-25) and does not collect a phone.
 * This ask does not claim an invite already left. "add my partner" still
 * mints a forwardable link when a parent types that phrase later.
 */
export const INTAKE_COPARENT_ASK_TEMPLATE_KEY = 'intake:coparent_ask';
