import type { Municipality } from '@hale/db';

/**
 * THE EVERGREEN VENUES DATASET — the standing places a GTA family can take a small child
 * on an ordinary day, so "what can we do tomorrow" is never answered empty-handed.
 *
 * The Village discovery run finds SCHEDULED events, and on a week where nothing has been
 * discovered or nothing has checked out, Hale had nothing to say. That is the gap this
 * fills, and it fills it with the one thing that does not expire: a free drop-in that is
 * simply THERE — an EarlyON centre, a library branch, a park. Family-AGNOSTIC public
 * reference data with no family_id and no PII, exactly like registration-windows-data.ts
 * (rule #1), and code-level for the same reason: it changes by hand-verified sweep, not
 * by row.
 *
 * PROVENANCE. 83 venues across 15 municipalities, each confirmed to exist from its OWN
 * municipal / library / EarlyON-operator source — no directories, no aggregators —
 * during the August 2026 sweep. Structure by region: EarlyON Child & Family Centres are
 * free (birth-6), run by named operators (Links2Care in Halton Hills, Oakville
 * Parent-Child Centre, ROCK in Burlington, PLASP + BrightStart in Peel, DDSB school hubs
 * in Durham) or by the city itself (Toronto, York). Every library system in scope runs
 * free weekly baby/toddler/family storytimes. Splash pads are free everywhere; City of
 * Toronto drop-in leisure/family swim is free at all city pools year-round.
 *
 * DO NOT PARAPHRASE THE CONTENT. Every `name`, `area`, `what` and `cadence` below is the
 * sweep's own verified wording. These strings are true because they were checked against
 * `source` in these words; rewriting one un-verifies it. Same discipline as
 * coaching-playbooks.ts.
 *
 * ── THE CAVEATS, which are the whole reason this is a VENUES dataset and NOT a schedule
 *
 * 1. CADENCES DRIFT. Library storytime days and times change every season; EarlyON
 *    schedules are republished monthly-to-seasonally (Links2Care posts a seasonal PDF,
 *    York Region updates every third Friday, Durham lives on keyon.ca, Peel on the
 *    Region's portal). A row whose `cadence` says "check" or "verify" has NO published
 *    stable cadence, and nothing may ever invent one for it. That is why `cadence` is
 *    prose rather than a weekday and a time: there is no honest way to store a day this
 *    dataset does not know.
 * 2. SEASONALITY. Splash pads and wading pools run roughly Victoria Day to Labour Day
 *    only, and outdoor EarlyON park programs are summer variants of indoor sites. A
 *    recommender must gate water play on the month — see WARM_MONTHS in
 *    standing-option.ts, which is where that gate is enforced.
 * 3. STATUTORY HOLIDAYS close pools, EarlyON centres and libraries. Nothing here knows
 *    the holiday calendar, which is another reason a standing venue is offered as a
 *    standing venue and never as "open tomorrow".
 * 4. COST. Everything here is free EXCEPT Halton Hills swims ($2.50 child / $4 adult),
 *    Caledon drop-in swims (low-cost), and Oakville library storytimes, which are free
 *    but TICKETED 15 minutes before start.
 * 5. TODDLER SWIM RULE. Under-7s need a guardian 14+/18+ in the water, max two children
 *    per adult. This is the main reason `rec` rows are not offered as a standing option.
 * 6. SYSTEM ROWS. Some rows describe a system rather than one address (Toronto Public
 *    Library's storytimes, the Toronto EarlyON network, Markham's 33 splash pads),
 *    because enumerating every branch would be stale-prone. Their `area` says so.
 * 7. DDSB hub rows are school-based: school-year weekdays, closed summers, PA days and
 *    breaks.
 * 8. Two operators are not .ca-municipal (links2care.ca, plasp.com, brightstartcaledon.com,
 *    rockonline.ca, op-cc.ca) — they are the official EarlyON operators their regions
 *    link to. Riverdale Farm's cadence was confirmed via the City of Toronto Parks
 *    official channel because the toronto.ca page refused the fetch.
 * 9. Verified as-existing August 2026. Re-verify the full set roughly every six months,
 *    and the `cadence` strings each season.
 *
 * ── TWO TRAITS OF THE TEXT that matter downstream, recorded rather than edited away
 *
 * `source` IS NEVER SENT TO A PARENT. It is provenance — how a claim can be re-checked
 * without re-running the sweep — and the SMS coach is forbidden to write a URL at all
 * (coach-channel-sms.md, "Never send them to the app"). It is deliberately absent from
 * the shape handed to a model; see StandingOption in standing-option.ts. Same treatment
 * as `PlaybookCreator.verified`.
 *
 * Some `cadence` strings name a bare DOMAIN ("check hhpl.ca calendar") because that is
 * what the source said. Left verbatim here, and the skill carries the matching
 * instruction: say "worth checking their current schedule" rather than writing the
 * address. `name` and `area` also use em dashes, which are not GSM-7 — a reply that
 * quotes one costs the message its single-segment encoding.
 */

/**
 * What kind of standing place this is.
 *
 * `earlyon` — free drop-in play and parent support, birth to six.
 * `library` — a branch running free baby/toddler/family storytimes.
 * `park` — outdoor play, usually including seasonal water play.
 * `rec` — a pool or community centre. Carried for completeness and NOT offered as a
 *   standing option: these are the rows with a cost and the guardian-in-the-water rule
 *   (caveats 4 and 5), which is not the shape of "somewhere you can just turn up".
 */
export type EvergreenVenueKind = 'earlyon' | 'library' | 'park' | 'rec';

export interface EvergreenVenue {
  municipality: Municipality;
  kind: EvergreenVenueKind;
  /** The venue's own name, as its source prints it. */
  name: string;
  /** Where it is — a street address for a single site, a description for a system row. */
  area: string;
  /** What a family actually gets there, including who it is for and what it costs. */
  what: string;
  /** When it runs, in the source's own words — prose, never a parsed day and time, and
   * frequently an instruction to go and check. See caveat 1. */
  cadence: string;
  /** The page this row was read off. Provenance only; never shown to a parent. */
  source: string;
}

/**
 * The venues, in sweep order (grouped by municipality). Order is LOAD-BEARING: the
 * standing-option selector picks the first row matching a municipality and kind, so a
 * reorder changes which venue a family is offered.
 */
export const EVERGREEN_VENUES: readonly EvergreenVenue[] = [

  // ── Halton Hills ──
  {
    municipality: 'halton_hills',
    kind: 'earlyon',
    name: 'Acton EarlyON Centre (Links2Care)',
    area: 'Acton — 85 Wallace St',
    what: 'Free EarlyON drop-in play, songs, parent support, ages 0-6',
    cadence: 'weekday mornings typical; check Links2Care seasonal schedule',
    source: 'https://links2care.ca/program/earlyon-child-family-centres/',
  },
  {
    municipality: 'halton_hills',
    kind: 'earlyon',
    name: 'EarlyON at Acton Community Hub (MSB Public School)',
    area: 'Acton — 69 Acton Blvd',
    what: 'Free EarlyON drop-in inside McKenzie-Smith Bennett school hub, ages 0-6',
    cadence: 'check Links2Care seasonal schedule',
    source: 'https://links2care.ca/program/earlyon-child-family-centres/',
  },
  {
    municipality: 'halton_hills',
    kind: 'earlyon',
    name: 'EarlyON at Acton Library',
    area: 'Acton — 17 River St',
    what: 'Free EarlyON sessions co-located at the library branch, ages 0-6',
    cadence: 'check Links2Care seasonal schedule',
    source: 'https://links2care.ca/program/earlyon-child-family-centres/',
  },
  {
    municipality: 'halton_hills',
    kind: 'earlyon',
    name: 'Georgetown EarlyON Centre (Links2Care)',
    area: 'Georgetown — 8 James St',
    what: 'Free EarlyON drop-in play + parenting resources, ages 0-6',
    cadence: 'weekdays, weekends and evenings offered; check Links2Care seasonal schedule',
    source: 'https://links2care.ca/program/earlyon-child-family-centres/',
  },
  {
    municipality: 'halton_hills',
    kind: 'earlyon',
    name: 'EarlyON at St. Andrews United Church',
    area: 'Georgetown — 89 Mountainview Rd S',
    what: 'Free EarlyON satellite drop-in, ages 0-6',
    cadence: 'check Links2Care seasonal schedule',
    source: 'https://links2care.ca/program/earlyon-child-family-centres/',
  },
  {
    municipality: 'halton_hills',
    kind: 'earlyon',
    name: 'EarlyON at Norval United Church',
    area: 'Norval (Georgetown) — 14015 Danby Rd',
    what: 'Free EarlyON satellite drop-in, ages 0-6',
    cadence: 'check Links2Care seasonal schedule',
    source: 'https://links2care.ca/program/earlyon-child-family-centres/',
  },
  {
    municipality: 'halton_hills',
    kind: 'library',
    name: 'Halton Hills Public Library — Georgetown Branch',
    area: 'Georgetown — 9 Church St',
    what: 'Free family storytime + early literacy programs',
    cadence: 'Sat 10 a.m. family storytime (drop-in); check hhpl.ca calendar',
    source: 'https://www.hhpl.ca/en/index.aspx',
  },
  {
    municipality: 'halton_hills',
    kind: 'library',
    name: 'Halton Hills Public Library — Acton Branch',
    area: 'Acton — 17 River St',
    what: 'Free family storytime + early literacy programs',
    cadence: 'Sat 10 a.m. family storytime (drop-in); check hhpl.ca calendar',
    source: 'https://www.hhpl.ca/en/index.aspx',
  },
  {
    municipality: 'halton_hills',
    kind: 'park',
    name: 'Dominion Gardens Park',
    area: 'Georgetown — 135 Maple Ave',
    what: 'Playground + free splash pad (refurbished 2022), shade, washrooms, picnic tables',
    cadence: 'splash pad daily 10 a.m.-8 p.m., Victoria Day-Labour Day; playground year-round',
    source: 'https://www.haltonhills.ca/play/facilities,-parks-trails/splash-pads',
  },
  {
    municipality: 'halton_hills',
    kind: 'park',
    name: 'Prospect Park (Fairy Lake)',
    area: 'Acton — 30 Park Ave',
    what: 'Playground + free splash pad overlooking Fairy Lake, gazebo, walking track',
    cadence: 'splash pad daily 10 a.m.-8 p.m., Victoria Day-Labour Day; park year-round',
    source: 'https://www.haltonhills.ca/play/facilities,-parks-trails/splash-pads',
  },
  {
    municipality: 'halton_hills',
    kind: 'park',
    name: 'Gellert Community Park / Eighth Line Park',
    area: 'Georgetown — 10241 Eighth Line',
    what: 'Playgrounds + free splash pad (refurbished 2022), trails, sports fields',
    cadence: 'splash pad daily 10 a.m.-8 p.m., Victoria Day-Labour Day',
    source: 'https://www.haltonhills.ca/play/facilities,-parks-trails/splash-pads',
  },
  {
    municipality: 'halton_hills',
    kind: 'rec',
    name: 'Gellert Community Centre pool',
    area: 'Georgetown — 10241 Eighth Line',
    what: 'Leisure swims incl. warm shallow play pool ideal for toddlers; child $2.50 / adult $4',
    cadence: 'leisure swim daily 2:00-3:30 p.m. + evening slots (Summer 2026 schedule); check seasonal PDF',
    source: 'https://haltonhills.ic12.esolg.ca/en/explore-and-play/resources/Documents/RecSwimSchedule-Summer2026.pdf',
  },
  {
    municipality: 'halton_hills',
    kind: 'rec',
    name: 'Acton Lion\'s Indoor Pool',
    area: 'Acton — 69 Acton Blvd (MSB school)',
    what: 'Indoor 25m pool leisure swims; child $2.50 / adult $4; ages 0-6 need in-water guardian 14+',
    cadence: 'leisure swim daily 2:00-3:30 p.m. (seasonal schedule); check haltonhills.ca/swimming',
    source: 'https://haltonhills.ic12.esolg.ca/en/explore-and-play/resources/Documents/RecSwimSchedule-Summer2026.pdf',
  },

  // ── Toronto ──
  {
    municipality: 'toronto',
    kind: 'earlyon',
    name: 'EarlyON Child and Family Centres (city-wide network)',
    area: 'across Toronto — locator map by address',
    what: 'Free drop-in play + parent support, ages 0-6; many school- and community-based sites incl. Indigenous-led, Francophone, 2SLGBTQ+ programs',
    cadence: 'most sites run weekday sessions; contact centre / check toronto.ca locator',
    source: 'https://www.toronto.ca/community-people/children-parenting/children-programs-activities/child-family-programs-and-groups/child-family-programs/',
  },
  {
    municipality: 'toronto',
    kind: 'library',
    name: 'Toronto Public Library — Baby Time / Toddler Time / Family Storytime',
    area: 'many branches city-wide',
    what: 'Free drop-in storytimes: Baby Time (0-18 mo), Toddler Time (19 mo-3 yr) with stay-and-play after',
    cadence: 'weekly at participating branches; check branch calendar on tpl.ca',
    source: 'https://kids.tpl.ca/ready-for-reading/programs/baby',
  },
  {
    municipality: 'toronto',
    kind: 'park',
    name: 'High Park',
    area: 'west end — Bloor St W / Parkside Dr',
    what: 'Jamie Bell Adventure Playground, free animal display (bison, llamas, peacocks), wading pool + splash pads, trails',
    cadence: 'park daily year-round; water play and train seasonal',
    source: 'https://www.toronto.ca/explore-enjoy/parks-recreation/places-spaces/high-park/',
  },
  {
    municipality: 'toronto',
    kind: 'park',
    name: 'Riverdale Farm',
    area: 'Cabbagetown — 201 Winchester St',
    what: 'Free working farm in the city: cows, pigs, goats; stroller-friendly',
    cadence: 'daily 9 a.m.-5 p.m. year-round incl. holidays',
    source: 'https://x.com/TorontoPFR/status/1997296264451330371',
  },
  {
    municipality: 'toronto',
    kind: 'rec',
    name: 'City of Toronto drop-in swimming (all city pools)',
    area: '60+ indoor/outdoor pools city-wide',
    what: 'Leisure, open and family drop-in swims are FREE at all City-run pools — no registration',
    cadence: 'daily at most pools; check pool schedule on toronto.ca',
    source: 'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/swim-water-activities/drop-in-swimming/',
  },
  {
    municipality: 'toronto',
    kind: 'park',
    name: 'City of Toronto splash pads + supervised wading pools',
    area: 'parks city-wide',
    what: 'Free outdoor water play; wading pools are supervised and toddler-depth',
    cadence: 'splash pads daily 9 a.m.-9 p.m. in season (roughly May-Sept); wading pools daily in summer',
    source: 'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/swim-water-activities/drop-in-water-play/',
  },

  // ── Mississauga ──
  {
    municipality: 'mississauga',
    kind: 'earlyon',
    name: 'PLASP EarlyON — Floradale Public School',
    area: 'west Mississauga — 210 Paisley Blvd',
    what: 'Free EarlyON family drop-in, no pre-registration, ages 0-6',
    cadence: 'Mon-Fri 9:00 a.m.-1:30 p.m.',
    source: 'https://www.plasp.com/earlyon',
  },
  {
    municipality: 'mississauga',
    kind: 'earlyon',
    name: 'PLASP EarlyON — Munden Park Public School',
    area: 'Mississauga — 515 Tedwyn Dr',
    what: 'Free EarlyON family drop-in, no pre-registration, ages 0-6',
    cadence: 'Mon-Fri 9:00 a.m.-1:00 p.m.',
    source: 'https://www.plasp.com/earlyon',
  },
  {
    municipality: 'mississauga',
    kind: 'earlyon',
    name: 'PLASP EarlyON — San Lorenzo Ruiz Catholic ES',
    area: 'Mississauga (Hurontario) — 100 Barondale Dr',
    what: 'Free EarlyON family drop-in, no pre-registration, ages 0-6',
    cadence: 'Mon/Wed/Fri 10:00 a.m.-12:30 p.m.; Tue/Thu 8:15-10:45 a.m.',
    source: 'https://www.plasp.com/earlyon',
  },
  {
    municipality: 'mississauga',
    kind: 'earlyon',
    name: 'PLASP EarlyON — Lancaster Public School',
    area: 'Malton — 7425 Netherwood Rd',
    what: 'Free EarlyON family drop-in, no pre-registration, ages 0-6',
    cadence: 'Mon-Fri 9:30 a.m.-1:30 p.m.',
    source: 'https://www.plasp.com/earlyon',
  },
  {
    municipality: 'mississauga',
    kind: 'library',
    name: 'Mississauga Library — storytimes (18 branches incl. Central)',
    area: 'branches city-wide',
    what: 'Free drop-in storytimes + early literacy programs for babies/toddlers',
    cadence: 'weekly at participating branches; check mississauga.ca/library calendar',
    source: 'https://www.mississauga.ca/library/programs/',
  },
  {
    municipality: 'mississauga',
    kind: 'library',
    name: 'Open Air Storytime — Celebration Square',
    area: 'City Centre — Celebration Square amphitheatre',
    what: 'Free outdoor library storytime: songs, rhymes, stories; first-come drop-in',
    cadence: 'Wednesdays 10:30 a.m., summer season, weather permitting',
    source: 'https://www.mississauga.ca/events-and-attractions/events-calendar/open-air-story-time/',
  },
  {
    municipality: 'mississauga',
    kind: 'park',
    name: 'Jack Darling Memorial Park',
    area: 'Clarkson/Lorne Park — 1180 Lakeshore Rd W',
    what: 'Free lakefront park: 2 playgrounds, splash pad, beach, trails to Rattray Marsh; free parking',
    cadence: 'park daily year-round; splash pad summer season',
    source: 'https://www.mississauga.ca/events-and-attractions/parks/jack-darling-memorial-park/',
  },

  // ── Brampton ──
  {
    municipality: 'brampton',
    kind: 'earlyon',
    name: 'PLASP EarlyON — Eastbourne Drive Public School',
    area: 'Bramalea — 702 Balmoral Dr',
    what: 'Free EarlyON family drop-in, no pre-registration, ages 0-6',
    cadence: 'Mon-Fri 9:30 a.m.-1:30 p.m.',
    source: 'https://www.plasp.com/earlyon',
  },
  {
    municipality: 'brampton',
    kind: 'earlyon',
    name: 'PLASP EarlyON — Pte. Buckam Singh Public School',
    area: 'northeast Brampton — 100 Martin Byrne Dr',
    what: 'Free EarlyON family drop-in, no pre-registration, ages 0-6',
    cadence: 'Mon-Fri 9:30 a.m.-2:30 p.m.',
    source: 'https://www.plasp.com/earlyon',
  },
  {
    municipality: 'brampton',
    kind: 'library',
    name: 'Brampton Library — Baby Storytime / Family Storytime',
    area: 'branches city-wide (Four Corners, Chinguacousy, Springdale...)',
    what: 'Free storytimes: Baby (0-18 mo), Movers & Shakers (18 mo-3 yr), Family (0-6) with free play after',
    cadence: 'weekly at branches; check bramptonlibrary.ca events calendar',
    source: 'https://bramlib.libnet.info/events',
  },
  {
    municipality: 'brampton',
    kind: 'park',
    name: 'Chinguacousy Park',
    area: 'Bramalea — 9050 Bramalea Rd',
    what: 'Free 40-ha park: large playground with tot structure, splash pad + wading pool, petting zoo, gardens',
    cadence: 'park daily year-round; splash pad/zoo seasonal hours',
    source: 'https://www.brampton.ca/EN/residents/Recreation/Community-Centres/Chinguacousy-Park',
  },

  // ── Caledon ──
  {
    municipality: 'caledon',
    kind: 'earlyon',
    name: 'BrightStart Caledon EarlyON — Albion Bolton Community Centre',
    area: 'Bolton — 150 Queen St S',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6',
    cadence: 'check BrightStart schedule (905-857-0090)',
    source: 'https://brightstartcaledon.com/locations/',
  },
  {
    municipality: 'caledon',
    kind: 'earlyon',
    name: 'BrightStart Caledon EarlyON — Caledon East Community Complex',
    area: 'Caledon East — 6215 Old Church Rd (lower level)',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6; summer Fridays move outdoors to Caledon East Park',
    cadence: 'Tue/Thu/Fri/Sat drop-in blocks published; verify current schedule',
    source: 'https://brightstartcaledon.com/location/caledon-east-community-complex/',
  },
  {
    municipality: 'caledon',
    kind: 'earlyon',
    name: 'BrightStart Caledon EarlyON — Southfields Community Centre',
    area: 'Southfields (Mayfield West) — 225 Dougall Ave',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6; outdoor park programs in summer',
    cadence: 'check BrightStart schedule',
    source: 'https://brightstartcaledon.com/locations/',
  },
  {
    municipality: 'caledon',
    kind: 'library',
    name: 'Caledon Public Library — children\'s programs',
    area: 'branches incl. Albion Bolton, Caledon East, Margaret Dunn Valleywood',
    what: 'Free storytimes: Baby Story Time, Wiggles & Giggles (0-3), Artful Toddlers drop-in (2-5)',
    cadence: 'weekly/monthly by branch; check caledonlibrary.com events',
    source: 'https://caledon.library.on.ca/whats-happening/programs-for-children/',
  },
  {
    municipality: 'caledon',
    kind: 'park',
    name: 'Adam Wallace Memorial Park splash pad',
    area: 'Caledon (see facilities.caledon.ca map)',
    what: 'Small accessible free splash pad + adjacent playground, washrooms, shade',
    cadence: 'summer season; check Town facilities listing',
    source: 'https://facilities.caledon.ca/',
  },
  {
    municipality: 'caledon',
    kind: 'rec',
    name: 'Town of Caledon drop-in swimming (indoor pools)',
    area: 'Caledon recreation centres (Bolton/Caledon East/Mayfield)',
    what: 'Low-cost drop-in recreational swims at Town pools',
    cadence: 'check caledon.ca drop-in swim booking calendar',
    source: 'https://www.caledon.ca/en/living-here/aquatics.aspx',
  },

  // ── Markham ──
  {
    municipality: 'markham',
    kind: 'earlyon',
    name: 'EarlyON Markham Centre',
    area: 'Markham — 3990 14th Ave',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6',
    cadence: 'many drop-in first-come sessions; calendar updates every 3rd Friday on York CS portal',
    source: 'https://www.york.ca/support/childrens-services/earlyon-child-and-family-centres',
  },
  {
    municipality: 'markham',
    kind: 'earlyon',
    name: 'EarlyON Markham East Centre',
    area: 'Markham Village — 40 Washington St',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6',
    cadence: 'check York Region EarlyON calendar',
    source: 'https://www.york.ca/support/childrens-services/earlyon-child-and-family-centres',
  },
  {
    municipality: 'markham',
    kind: 'earlyon',
    name: 'On y va Markham (Francophone EarlyON)',
    area: 'Markham — 111 John Button Blvd',
    what: 'Free French-language EarlyON programs, ages 0-6',
    cadence: 'check York Region EarlyON calendar',
    source: 'https://www.york.ca/support/childrens-services/earlyon-child-and-family-centres',
  },
  {
    municipality: 'markham',
    kind: 'library',
    name: 'Markham Public Library — drop-in storytimes',
    area: 'branches incl. Unionville, Markham Village, Cornell, Aaniin',
    what: 'Free drop-in storytimes with books, songs, activities for 0-5',
    cadence: 'weekly (e.g., Unionville Fri 10:30 a.m.; Markham Village Mon 10:30 a.m., Sat 2 p.m.); check MPL events',
    source: 'https://markhampubliclibrary.ca/birth-to-five/',
  },
  {
    municipality: 'markham',
    kind: 'park',
    name: 'City of Markham splash pads (33 parks)',
    area: 'city-wide — e.g., Swan Lake, Victoria Square, Wismer, Millennium Park',
    what: 'Free push-button splash pads with playgrounds at most sites',
    cadence: 'open mid-May to ~Labour Day, daytime hours; status list on markham.ca',
    source: 'https://www.markham.ca/sports-recreation-fitness/parks-trails/splash-pads',
  },

  // ── Vaughan ──
  {
    municipality: 'vaughan',
    kind: 'earlyon',
    name: 'EarlyON Thornhill Centre',
    area: 'Thornhill — 7755 Bayview Ave',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6',
    cadence: 'check York Region EarlyON calendar',
    source: 'https://www.york.ca/support/childrens-services/earlyon-child-and-family-centres',
  },
  {
    municipality: 'vaughan',
    kind: 'earlyon',
    name: 'EarlyON Woodbridge Centre',
    area: 'Woodbridge — 140 Woodbridge Ave, Unit E-400',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6',
    cadence: 'check York Region EarlyON calendar',
    source: 'https://www.york.ca/support/childrens-services/earlyon-child-and-family-centres',
  },
  {
    municipality: 'vaughan',
    kind: 'earlyon',
    name: 'On y va Kleinburg (Francophone EarlyON)',
    area: 'Kleinburg — 10110 Islington Ave',
    what: 'Free French-language EarlyON programs, ages 0-6',
    cadence: 'check York Region EarlyON calendar',
    source: 'https://www.york.ca/support/childrens-services/earlyon-child-and-family-centres',
  },
  {
    municipality: 'vaughan',
    kind: 'library',
    name: 'Vaughan Public Libraries — baby/toddler storytimes',
    area: 'branches incl. Civic Centre, Bathurst Clark, Pierre Berton',
    what: 'Free programs: Baby Adventures Storytime, Little Explorers, Family Storytime, Musical Babies (with EarlyON)',
    cadence: 'weekly by branch; check vaughanpl.info program calendar',
    source: 'https://www.vaughanpl.info/programs',
  },
  {
    municipality: 'vaughan',
    kind: 'park',
    name: 'City of Vaughan splashpads',
    area: 'community/district parks incl. Mackenzie Glen District Park (Maple)',
    what: 'Free splashpads; larger water play at district parks',
    cadence: 'daily 9 a.m.-8 p.m. in summer season, weather permitting',
    source: 'https://www.vaughan.ca/explore-vaughan/parks/water-play-and-splashpads',
  },

  // ── Richmond Hill ──
  {
    municipality: 'richmond_hill',
    kind: 'earlyon',
    name: 'EarlyON Richmond Hill Centre',
    area: 'Richmond Hill — 10610 Bayview Ave, Unit 9',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6',
    cadence: 'check York Region EarlyON calendar',
    source: 'https://www.york.ca/support/childrens-services/earlyon-child-and-family-centres',
  },
  {
    municipality: 'richmond_hill',
    kind: 'library',
    name: 'Richmond Hill Public Library — Babytime / Family Storytime',
    area: 'branches incl. Central, Richmond Green, Oak Ridges',
    what: 'Free baby/toddler drop-in programs (Babytime, Family Storytime, Babies-Toddlers-Preschool drop-in at Richmond Green)',
    cadence: 'weekly by branch; check rhpl.ca program guide',
    source: 'https://www.rhpl.ca/programs-and-events/program-guide',
  },
  {
    municipality: 'richmond_hill',
    kind: 'park',
    name: 'Mill Pond Park',
    area: 'Mill St & Trench St',
    what: 'Free park: playground, pond boardwalk, trails, shade shelter, washrooms',
    cadence: 'daily year-round',
    source: 'https://www.richmondhill.ca/en/things-to-do/Mill-Pond-Park.aspx',
  },
  {
    municipality: 'richmond_hill',
    kind: 'park',
    name: 'Richmond Hill splash pads (16 parks)',
    area: 'city-wide',
    what: 'Free splash pads at 16 parks',
    cadence: 'daily 9 a.m.-8 p.m. in summer season',
    source: 'https://www.richmondhill.ca/en/things-to-do/Things-to-Do-Splash-Pads.aspx',
  },

  // ── Aurora ──
  {
    municipality: 'aurora',
    kind: 'earlyon',
    name: 'EarlyON Aurora Centre',
    area: 'Aurora — 40 Engelhard Dr, Unit 1',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6',
    cadence: 'check York Region EarlyON calendar',
    source: 'https://www.york.ca/support/childrens-services/earlyon-child-and-family-centres',
  },
  {
    municipality: 'aurora',
    kind: 'library',
    name: 'Aurora Public Library',
    area: '15145 Yonge St',
    what: 'Free drop-in storytimes: Family Storytime, Baby & Toddler Storytime (0-2), Tales for Twos & Threes',
    cadence: 'Fri + Sat 10:30 a.m. family storytime; Sun 10:30 a.m. baby/toddler (verify seasonally)',
    source: 'https://aurorapl.ca/under-5/',
  },
  {
    municipality: 'aurora',
    kind: 'park',
    name: 'Town Park splash pad + playground',
    area: 'Aurora — 49 Wells St',
    what: 'Free splash pad in historic Town Park (farmers\' market, events)',
    cadence: 'splash pad daily 9 a.m.-9 p.m., early June-early Sept',
    source: 'https://www.aurora.ca/recreation-arts-and-culture/parks-parksandtrails/splash-pads/',
  },
  {
    municipality: 'aurora',
    kind: 'park',
    name: 'Ada Johnson Park splash pad',
    area: 'Aurora — 60 Hartwell Way',
    what: 'Free splash pad (one of 6 in town incl. Town Square, Trent Park)',
    cadence: 'daily 9 a.m.-9 p.m., early June-early Sept',
    source: 'https://www.aurora.ca/recreation-arts-and-culture/parks-parksandtrails/splash-pads/',
  },

  // ── Oakville ──
  {
    municipality: 'oakville',
    kind: 'earlyon',
    name: 'Oakwood EarlyON Child and Family Centre (OPCC)',
    area: 'Oakville — 357 Bartos Dr (inside Oakwood PS)',
    what: 'Free EarlyON drop-in play + parent programs, ages 0-6',
    cadence: 'check OPCC online calendar',
    source: 'https://www.op-cc.ca/locations.html',
  },
  {
    municipality: 'oakville',
    kind: 'earlyon',
    name: 'North Oakville EarlyON Centre (OPCC)',
    area: 'North Oakville — 483 Dundas St W, Unit 2 (2nd floor)',
    what: 'Free EarlyON drop-in play, opened June 2026',
    cadence: 'check OPCC online calendar',
    source: 'https://www.op-cc.ca/parented-programs/free-earlyon-programs.html',
  },
  {
    municipality: 'oakville',
    kind: 'earlyon',
    name: 'OPCC community EarlyON sites (Kerr St Mission, VIVA Commons, St. Luke\'s)',
    area: 'Kerr Village 485 Kerr St; 1 Sixteen Mile Dr; 3114 Dundas St W',
    what: 'Free EarlyON satellite sessions at community locations',
    cadence: 'varies by site; check OPCC calendar',
    source: 'https://www.op-cc.ca/locations.html',
  },
  {
    municipality: 'oakville',
    kind: 'library',
    name: 'Oakville Public Library — Babytime / Family Storytime',
    area: 'branches incl. Central, Glen Abbey, Iroquois Ridge, Sixteen Mile',
    what: 'Free early-years programs (0-5); unregistered but ticketed — free tickets 15 min before start',
    cadence: 'weekly by branch; check opl.ca events',
    source: 'https://opl.ca/Families/Early-Years',
  },
  {
    municipality: 'oakville',
    kind: 'park',
    name: 'Coronation Park',
    area: 'lakeshore — 1426 Lakeshore Rd W',
    what: 'Free lakefront park: two playgrounds (by age), castle-theme splash pad with toddler spray zone; one of 15 free town splash pads',
    cadence: 'park daily; splash pads 9 a.m.-9 p.m. in season',
    source: 'https://www.oakville.ca/parks-recreation-culture/parks-gardens-trails/parks/splash-pads/',
  },

  // ── Burlington ──
  {
    municipality: 'burlington',
    kind: 'earlyon',
    name: 'ROCK EarlyON — Cumberland',
    area: 'central Burlington — 710 Cumberland Ave',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6 (Reach Out Centre for Kids)',
    cadence: 'call/check ROCK schedule (905-632-9377)',
    source: 'https://rockonline.ca/locations/',
  },
  {
    municipality: 'burlington',
    kind: 'earlyon',
    name: 'ROCK EarlyON — St. Mark',
    area: 'Burlington — 2145 Upper Middle Rd',
    what: 'Free EarlyON drop-in play + parent support, ages 0-6',
    cadence: 'call/check ROCK schedule (289-337-4151)',
    source: 'https://rockonline.ca/locations/',
  },
  {
    municipality: 'burlington',
    kind: 'library',
    name: 'Burlington Public Library — baby & preschooler drop-ins',
    area: 'branches incl. Central, Tansley Woods, Brant Hills',
    what: 'Free Baby Storytime (0-12 mo) with play & chat after, Family Storytime (under 5), drop-in play sessions (0-5)',
    cadence: 'weekly by branch; check attend.bpl.on.ca calendar',
    source: 'https://www.bpl.on.ca/parents/storytime',
  },
  {
    municipality: 'burlington',
    kind: 'park',
    name: 'Spencer Smith Park',
    area: 'downtown waterfront — 1400 Lakeshore Rd',
    what: 'Free lakefront splash pad (30 waterjets) + major playground, washrooms adjacent',
    cadence: 'park daily; splash pad summer season',
    source: 'https://www.burlington.ca/en/parks-facilities-and-rentals/pools-splash-pads-and-spray-parks.aspx',
  },
  {
    municipality: 'burlington',
    kind: 'park',
    name: 'LaSalle Park wading pool & splash park',
    area: 'Aldershot — 50 North Shore Blvd',
    what: 'Wading pool + splash park, playground, waterfront trails',
    cadence: 'summer season; check burlington.ca for hours',
    source: 'https://www.burlington.ca/en/parks-facilities-and-rentals/pools-splash-pads-and-spray-parks.aspx',
  },

  // ── Ajax ──
  {
    municipality: 'ajax',
    kind: 'earlyon',
    name: 'EarlyON hub — Dr. Roberta Bondar PS',
    area: 'Ajax',
    what: 'Free EarlyON school-based community hub, ages 0-6',
    cadence: 'school-year weekdays typical; schedules on keyon.ca',
    source: 'https://www.ddsb.ca/families/early-years/family-support-and-early-years-hubs/',
  },
  {
    municipality: 'ajax',
    kind: 'earlyon',
    name: 'EarlyON hub — Duffin\'s Bay PS',
    area: 'south Ajax',
    what: 'Free EarlyON school-based community hub, ages 0-6',
    cadence: 'schedules on keyon.ca',
    source: 'https://www.ddsb.ca/families/early-years/family-support-and-early-years-hubs/',
  },
  {
    municipality: 'ajax',
    kind: 'earlyon',
    name: 'EarlyON hub — Rosemary Brown PS',
    area: 'north Ajax',
    what: 'Free EarlyON school-based community hub, ages 0-6',
    cadence: 'schedules on keyon.ca',
    source: 'https://www.ddsb.ca/families/early-years/family-support-and-early-years-hubs/',
  },
  {
    municipality: 'ajax',
    kind: 'library',
    name: 'Ajax Public Library — Main Branch',
    area: '55 Harwood Ave S',
    what: 'Free Books for Babies drop-in + EarlyON Baby Social (0-15 mo, register via keyon.ca)',
    cadence: 'check ajaxlibrary.ca events calendar',
    source: 'https://ajaxlibrary.ca/node/1910',
  },
  {
    municipality: 'ajax',
    kind: 'library',
    name: 'Ajax Public Library — Audley Branch',
    area: 'Audley — 1400 Audley Rd N',
    what: 'Free Family Storytime + Ajax Reading Circle (storytime 10-10:30 a.m., crafts after)',
    cadence: 'Saturdays 10 a.m.-12 p.m. (verify on calendar)',
    source: 'https://ajaxlibrary.ca/node/2574',
  },
  {
    municipality: 'ajax',
    kind: 'park',
    name: 'Rotary Park',
    area: 'Ajax waterfront — 177 Lake Driveway W (splash pad 95 Magill Dr)',
    what: 'Free waterfront park: playgrounds for tots to older kids, splash pad, picnic areas, trails, seasonal snack bar',
    cadence: 'park daily; splash pad mid-June-early Sept, weather permitting',
    source: 'https://facilities.ajax.ca/Home/Detail?FacilityTypeIds=20421,20423&ScrollTo=google-map-trigger&CloseMap=true&Id=52a2423f-113e-4183-9a58-5cf25d9e91eb',
  },

  // ── Pickering ──
  {
    municipality: 'pickering',
    kind: 'earlyon',
    name: 'EarlyON hub — Frenchmans Bay PS',
    area: 'Bay Ridges, Pickering',
    what: 'Free EarlyON school-based community hub, ages 0-6',
    cadence: 'schedules on keyon.ca',
    source: 'https://www.ddsb.ca/families/early-years/family-support-and-early-years-hubs/',
  },
  {
    municipality: 'pickering',
    kind: 'earlyon',
    name: 'EarlyON hub — Vaughan Willard PS',
    area: 'Pickering',
    what: 'Free EarlyON school-based community hub, ages 0-6',
    cadence: 'schedules on keyon.ca',
    source: 'https://www.ddsb.ca/families/early-years/family-support-and-early-years-hubs/',
  },
  {
    municipality: 'pickering',
    kind: 'earlyon',
    name: 'EarlyON hub — Glengrove PS',
    area: 'Pickering',
    what: 'Free EarlyON school-based community hub, ages 0-6 (also Claremont PS in north Pickering)',
    cadence: 'schedules on keyon.ca',
    source: 'https://www.ddsb.ca/families/early-years/family-support-and-early-years-hubs/',
  },
  {
    municipality: 'pickering',
    kind: 'library',
    name: 'Pickering Public Library — Central Branch',
    area: 'One The Esplanade',
    what: 'Free Baby & Toddler Storytime (0-2): books, songs, bounces; plus 2-5 storytimes (Claremont branch too)',
    cadence: 'weekly; check cal.pickeringlibrary.ca',
    source: 'https://pickeringlibrary.ca/childrens/',
  },
  {
    municipality: 'pickering',
    kind: 'park',
    name: 'Beachfront Park & Millennium Square',
    area: 'Frenchman\'s Bay waterfront — Liverpool Rd S',
    what: 'Free lakeside splash pad (ages ~2-10), beach, boardwalk',
    cadence: 'splash pad 9 a.m.-8 p.m. summer; park daily year-round',
    source: 'https://www.pickering.ca/parks-recreation-culture/waterfront/beachfront-park-millennium-square/',
  },

  // ── Whitby ──
  {
    municipality: 'whitby',
    kind: 'earlyon',
    name: 'EarlyON hub — Willows Walk PS',
    area: 'Whitby',
    what: 'Free EarlyON school-based community hub, ages 0-6',
    cadence: 'schedules on keyon.ca',
    source: 'https://www.ddsb.ca/families/early-years/family-support-and-early-years-hubs/',
  },
  {
    municipality: 'whitby',
    kind: 'library',
    name: 'Whitby Public Library — Central (+ Rossland, Brooklin branches)',
    area: '405 Dundas St W',
    what: 'Free drop-in storytime at any location; Baby Book Club; 1000 Books Before Kindergarten',
    cadence: 'check whitbylibrary.ca calendar',
    source: 'https://whitbylibrary.ca/children',
  },
  {
    municipality: 'whitby',
    kind: 'park',
    name: 'Town of Whitby splash pads',
    area: 'multiple parks (e.g., Willow Park; lakefront)',
    what: 'Free splash pads across town parks; locations list on whitby.ca',
    cadence: 'summer season, weather-adjusted; check whitby.ca',
    source: 'https://www.whitby.ca/explore-and-enjoy/parks-and-recreation/splash-pads/',
  },

  // ── Oshawa ──
  {
    municipality: 'oshawa',
    kind: 'earlyon',
    name: 'EarlyON hub — Dr. C.F. Cannon PS',
    area: 'Oshawa',
    what: 'Free EarlyON school-based community hub, ages 0-6',
    cadence: 'schedules on keyon.ca',
    source: 'https://www.ddsb.ca/families/early-years/family-support-and-early-years-hubs/',
  },
  {
    municipality: 'oshawa',
    kind: 'earlyon',
    name: 'EarlyON hub — Queen Elizabeth PS',
    area: 'Oshawa',
    what: 'Free EarlyON school-based community hub, ages 0-6',
    cadence: 'schedules on keyon.ca',
    source: 'https://www.ddsb.ca/families/early-years/family-support-and-early-years-hubs/',
  },
  {
    municipality: 'oshawa',
    kind: 'earlyon',
    name: 'EarlyON hub — Village Union PS',
    area: 'south Oshawa',
    what: 'Free EarlyON school-based community hub, ages 0-6 (also Waverly PS via YMCA, Glen Street PS via DCHC)',
    cadence: 'schedules on keyon.ca',
    source: 'https://www.ddsb.ca/families/early-years/family-support-and-early-years-hubs/',
  },
  {
    municipality: 'oshawa',
    kind: 'library',
    name: 'Oshawa Public Libraries — storytimes',
    area: 'branches incl. McLaughlin (65 Bagot St), Northview, Delpark Homes',
    what: 'Free 30-min drop-in storytimes + Bouncing Babies (pre-walkers); caregivers participate',
    cadence: 'weekly by branch; check oshawalibrary.ca calendar',
    source: 'https://oshawalibrary.on.ca/storytimes',
  },
  {
    municipality: 'oshawa',
    kind: 'park',
    name: 'Lakeview Park',
    area: 'Oshawa lakefront — Lakeview Park Ave',
    what: 'Free lakefront park: sandy beach, 3-zone playground (incl. tot area), Oshawa\'s largest splash pad (280 m2)',
    cadence: 'park daily year-round; splash pad summer season',
    source: 'https://www.oshawa.ca/explore-play/waterfront/lakeview-park-beach/',
  },
];
