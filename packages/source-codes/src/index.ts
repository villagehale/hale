/**
 * The ONE list of source codes Hale knows (VIL source attribution).
 *
 * Shared by the marketing site (which decides whether a `?s=` / `?src=` /
 * poster `utm_campaign` code is pre-filled into the first text) and the SMS
 * intake (which reads the `(via <code>)` tag back out of that text). Before
 * this package the two kept separate rules: the site accepted any kebab code
 * and the server silently dropped every code not in its registry, so a new
 * campaign code reached the parent's composer and vanished at the text.
 *
 * Source-only (no build step) and dependency-free so both Next apps can
 * transpile it directly.
 */

/** The shape of any source code that may ride a URL or an SMS body. */
export const SOURCE_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SOURCE_CODE_MAX_LENGTH = 48;

/** A per-family referral tag (`friend-<12 hex>`), recognised by shape. */
export const REFERRAL_CODE_PATTERN = /^friend-[0-9a-f]{12}$/;
/** A co-parent join tag (`join-<32 hex>`), recognised by shape. */
export const JOIN_CODE_PATTERN = /^join-[0-9a-f]{32}$/;

export function isReferralCodeShape(raw: string): boolean {
  return REFERRAL_CODE_PATTERN.test(raw.toLowerCase());
}

export function isJoinCodeShape(raw: string): boolean {
  return JOIN_CODE_PATTERN.test(raw.toLowerCase());
}

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
 * Launch attribution codes (Nov 12 outreach). ATTRIBUTION-ONLY: the intake keeps and
 * stores them, but they carry no venue name or area, so `venueForCode` returns null and
 * the greeting is the ordinary one — no fixed copy rides on them.
 */
export const ATTRIBUTION_ONLY_CODES: ReadonlySet<string> = new Set([
  'earlyon-vaughan',
  'earlyon-peel',
  'earlyon-toronto',
  'earlyon-etobicoke',
  'earlyon-northyork',
  'earlyon-scarborough',
  'earlyon-durham',
  'earlyon-halton',
  'earlyon-brampton',
  'earlyon-caledon',
  'settle-york',
  'settle-peel',
  'settle-toronto',
  'settle-scarborough',
  'lib-vaughan',
  'lib-richmondhill',
  'board-vaughan',
  'board-richmondhill',
  'board-mississauga',
  'board-toronto',
  'board-oakville',
  'board-durham',
  'daycare-york',
  'daycare-peel',
  'daycare-toronto',
  'media-yorkregion',
  'media-dailyhive',
  'media-blogto',
  'media-torontocom',
  'media-mississauganews',
  'media-oakvillenews',
  'media-bramptonguardian',
  'reddit-asktoronto',
  'ads-vaughan',
  'ads-richmondhill',
  'ads-toronto',
  'ads-halton',
  'ads-durham',
  'ads-ymca',
  'social-linkedin',
  'social-x',
]);

/**
 * The canonical code for a raw tag, or null when Hale does not know it.
 *
 * Join and referral tags are recognised by SHAPE (their meaning lives in a table);
 * venue codes must be in {@link SOURCE_VENUES}, matched case-insensitively.
 */
export function resolveSourceCode(raw: string): string | null {
  if (raw.length === 0 || raw.length > SOURCE_CODE_MAX_LENGTH) return null;
  if (isJoinCodeShape(raw)) return raw.toLowerCase();
  if (isReferralCodeShape(raw)) return raw.toLowerCase();
  if (Object.hasOwn(SOURCE_VENUES, raw)) return raw;
  const upper = raw.toUpperCase();
  if (Object.hasOwn(SOURCE_VENUES, upper)) return upper;
  const lower = raw.toLowerCase();
  if (Object.hasOwn(SOURCE_VENUES, lower)) return lower;
  if (ATTRIBUTION_ONLY_CODES.has(lower)) return lower;
  return null;
}

/** Whether a code is one the intake will keep. */
export function isRegisteredSourceCode(raw: string): boolean {
  return resolveSourceCode(raw) !== null;
}

/**
 * The `(via <code>)` tag, found ANYWHERE in a body — a parent may type after the
 * prefilled tag or move it. The tag must close right after the code, so an ordinary
 * "(via the highway)" never matches. The first tag that resolves wins.
 */
const VIA_TAG = /\(via\s+([a-z0-9]+(?:-[a-z0-9]+)*)\)/gi;

export function sourceCodeFromViaTag(body: string): string | null {
  for (const match of body.matchAll(VIA_TAG)) {
    const code = resolveSourceCode(match[1] as string);
    if (code) return code;
  }
  return null;
}
