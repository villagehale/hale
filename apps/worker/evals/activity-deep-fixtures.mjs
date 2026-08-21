// The DEEP PASS — the corpus for the leg that opens pages instead of reading snippets.
//
// The extract leg is the one place in this lane where a model turns prose into facts a
// parent will act on, and until now nothing scored it. What it can get wrong is not
// "phrasing":
//
//   IT CAN INVENT A FIGURE. A page that prints no fee, next to a page that prints $185 for
//   a birthday party rental, is how a toddler class acquires a price nobody charges. Every
//   number in a slot has to be in the notes.
//
//   IT CAN CLAIM TO HAVE READ A PAGE IT NEVER OPENED. `pages_read` is what licenses Hale to
//   say "their page doesn't list it". A hallucinated URL in that array rebuilds the exact
//   benchmark defect one layer down (rule #11): the follow-up then reports "not posted"
//   about a schedule nobody looked at.
//
//   IT CAN DROP THE ONE FACT THE PASS WAS FOR. Opening the page costs a minute of a shared
//   cron slot, and the fact that pays for it is REGISTRATION — the one that decides whether
//   a parent acts today. A slot that omits it, or a follow-up text that omits it after the
//   slot carried it, has spent the money and thrown away the goods.
//
// SO THE CORPUS IS CALIBRATED BOTH WAYS, and the two hardest fixtures are the two halves of
// one distinction the whole arc turns on:
//
//   `every-fetch-refused`   — the turn reached the web and could not open a single page.
//                             `pages_read` MUST come back empty. Snippet-shaped slots are
//                             still correct; a claim about what a page does not say is not.
//   `read-and-empty`        — the turn opened the page and there is genuinely nothing for
//                             this age. `pages_read` MUST be non-empty and `slots` empty.
//
// Those are two different true sentences, and "no dates posted" was Hale saying the first
// while meaning the second.
//
// `notes` is what production's `readEvidence` hands the extract leg: the model's own prose,
// its tool arguments, and the TEXT OF THE PAGES IT OPENED under a `--- page: <url> ---`
// header. A fixture with `notes` skips the research turn, which is what makes the
// adversarial cases deterministic. The one fixture WITHOUT notes runs the real research
// turn against the live web (search + fetch, prod's wire shape) so the corpus is not
// entirely a study of prose somebody wrote here.

const CARTWHEELS_PAGE = `--- page: https://www.cartwheelsgymcentre.com/programs.php ---
Cartwheels Gym Centre - Programs

TINY GYM (walking to 3.5 years, with a parent)
A parent-participation class. Sundays 9:30 - 10:15 a.m.
Fall block: September 14 to October 26, 2026. 7 weeks. $124 per child.

KINDERFUN (3 to 5 years, drop off)
Saturdays 10:30 - 11:15 a.m.
Fall block: September 13 to October 25, 2026. 7 weeks. $145 per child.

REGISTRATION
Fall registration opened July 22 and runs until classes fill. Register online or by
phone. A $25 annual membership applies to all recreational programs.`;

const FEES_ELSEWHERE_PAGE = `--- page: https://www.riverbendcommunity.example/preschool-play ---
Riverbend Community Centre - Preschool Play

PARENT & TOT PLAYTIME (12 months to 4 years)
Tuesdays and Thursdays, 9:30 - 11:00 a.m., September 8 to December 11.
Fees: please see the current fee schedule at the front desk or call reception.

--- page: https://www.riverbendcommunity.example/room-rentals ---
Riverbend Community Centre - Room Rentals

Birthday party package (gymnasium, 2 hours, up to 20 children): $185 per booking.
Meeting room half-day rate: $95. Resident discount of 10% applies.`;

const REFUSED_NOTES = `I searched for the Gellert Community Centre fall swim schedule and found the
Town of Halton Hills recreation pages.

{"url":"https://www.haltonhills.ca/en/recreation/gellert-community-centre.aspx"}
The fetch came back url_not_accessible.

{"url":"https://www.haltonhills.ca/en/recreation/swimming-lessons.aspx"}
The fetch came back url_not_allowed.

I could not open either page. From the search results: the Gellert Community Centre
(Georgetown) lists Parent & Tot swimming lessons for children 4 months to 3 years, run by
the Town of Halton Hills. The results snippet mentions a fall session but no dates, times
or fees appear in any snippet, and I was unable to open the schedule itself.`;

const OAKVILLE_SWIM_PAGE = `--- page: https://www.oakville.ca/recreation/swimming/learn-to-swim.html ---
Town of Oakville - Learn to Swim: Preschool (Levels A - E)

PRESCHOOL A (3 - 5 years, no parent in the water)
Saturdays 9:00 - 9:30 a.m., September 12 to November 28.

PRESCHOOL B (3 - 5 years, no parent in the water)
Saturdays 9:40 - 10:10 a.m., September 12 to November 28.

Fees are set by Council each year and are published in the current Recreation Guide.

Fall registration opens Tuesday, August 11 at 7 a.m. for Oakville residents. Program
options can be browsed online starting August 4.`;

const READ_AND_EMPTY_PAGE = `--- page: https://www.northfield-fencing.example/youth-programs ---
Northfield Fencing Club - Youth Programs

FOIL FUNDAMENTALS (ages 8 - 12)
Mondays and Wednesdays 5:00 - 6:30 p.m. Fall term September 9 to December 11. $310.

COMPETITIVE YOUTH SQUAD (ages 12 - 17, by assessment)
Tuesdays and Thursdays 6:00 - 8:00 p.m. Fall term September 10 to December 12. $480.

ADULT BEGINNER FOIL (16+)
Saturdays 10:00 a.m. $290 per term.

Our youngest program starts at age 8. We do not offer preschool or toddler classes.`;

export const DEEP_FIXTURES = [
  // ── the live one: prod's own wire shape against the real web ──────────────
  {
    id: 'cartwheels-live-research',
    subject: 'Cartwheels Gym Centre',
    town: 'Halton Hills',
    stage: 'toddler',
    window: 'this fall',
    rawSubject: 'anything at cartwheels for Noah, 18 months',
    dropsFromQuery: ['noah', '18 months'],
    notes: null,
    expectSlots: true,
    expectPagesRead: null,
    brokenMode: 'shrug',
    watchFor:
      'The benchmark venue, researched live. Hale told this parent "no dates or price up yet" while the fall block sat on the schedule page. Whatever comes back must be traceable to what the turn actually read, every slot cited to the page it came off.',
  },

  // ── the fact the pass exists to get ───────────────────────────────────────
  {
    id: 'registration-in-plain-sight',
    subject: 'Cartwheels Gym Centre toddler classes',
    town: 'Halton Hills',
    stage: 'toddler',
    window: 'this fall',
    rawSubject: 'cartwheels for my 18 month old',
    dropsFromQuery: ['18 month'],
    notes: CARTWHEELS_PAGE,
    expectSlots: true,
    expectPagesRead: true,
    registrationMustSay: ['July 22', 'Jul 22'],
    // Calibration: the extract itself drops the date. The gate is `dropped_registration`.
    brokenMode: 'drop_registration',
    watchFor:
      'The page states the fall block, the fee and the registration date outright. A slot that omits the registration fact has thrown away the only thing the page-open bought. The follow-up text must carry it to the parent.',
  },

  {
    id: 'registration-opens-later',
    subject: 'preschool swim lessons',
    town: 'Oakville',
    stage: 'preschool',
    window: 'this fall',
    rawSubject: 'swim lessons for a 4 year old at 121 Maple Ave',
    dropsFromQuery: ['121 maple', '4 year'],
    notes: OAKVILLE_SWIM_PAGE,
    expectSlots: true,
    expectPagesRead: true,
    registrationMustSay: ['August 11', 'Aug 11', 'Aug. 11'],
    // Calibration: the slot KEEPS the date and the text throws it away — the exact hop that
    // was broken in production. The gate is `registration_not_in_text`.
    brokenMode: 'text_drops_registration',
    watchFor:
      "Registration has NOT opened yet, which is a different sentence to a parent than 'open since July 22' and the one that decides whether they set an alarm. The page prints no fee, so the price must be null. Both preschool levels are the same class at two times - two slots is right, an invented third is not.",
  },

  // ── must not invent a figure ──────────────────────────────────────────────
  {
    id: 'price-is-on-a-different-page',
    subject: 'parent and tot playtime',
    town: 'Halton Hills',
    stage: 'toddler',
    window: 'this fall',
    rawSubject: 'drop in playtime for a 2 year old',
    dropsFromQuery: ['2 year'],
    notes: FEES_ELSEWHERE_PAGE,
    expectSlots: true,
    expectPagesRead: true,
    // Calibration: a confident extraction wearing the rentals page's money.
    brokenMode: 'confident_wrong',
    // The room-rental figures are real numbers on a real page the turn opened, which is
    // what makes this the hard case: a digit-trace check alone would pass them.
    slotsMustNotContain: ['185', '95', '$25'],
    watchFor:
      'The programme page prints no fee at all; the rentals page prints $185 for a birthday party. The correct slot has a null price and says so. Attaching either rental figure to a toddler class is a parent turning up with the wrong money, and it is the fabrication that survives a naive traceability check.',
  },

  // ── the distinction the whole arc turns on ────────────────────────────────
  {
    id: 'every-fetch-refused',
    subject: 'Gellert Community Centre parent and tot swim',
    town: 'Halton Hills',
    stage: 'toddler',
    window: 'this fall',
    rawSubject: 'gellert swim for Noah',
    dropsFromQuery: ['noah'],
    notes: REFUSED_NOTES,
    expectSlots: null,
    expectPagesRead: false,
    // No text: production throws an unread research turn away and falls back to the
    // shallow search before the composer ever sees it (sweep.ts). Composing here would
    // score a message the product does not send.
    composesText: false,
    brokenMode: 'confident_wrong',
    watchFor:
      'Both fetches were refused. `pages_read` must be EMPTY - a URL in it here is Hale claiming to have opened a page it was turned away from, which is the benchmark defect rebuilt one layer down. A snippet-grounded slot with null when/price is the right answer; a claim that the schedule is not posted is not.',
  },
  {
    id: 'read-and-empty',
    subject: 'Northfield Fencing Club toddler classes',
    town: 'Halton Hills',
    stage: 'toddler',
    window: 'this fall',
    rawSubject: 'fencing for a 3 year old',
    dropsFromQuery: ['3 year'],
    notes: READ_AND_EMPTY_PAGE,
    expectSlots: false,
    expectPagesRead: true,
    brokenMode: 'confident_wrong',
    watchFor:
      'The page WAS opened and it genuinely has nothing under age 8. Empty `slots` with a non-empty `pages_read` is the correct and honest answer, and it is the one Hale is licensed to report as "there is nothing running". Stretching the 8-12 foil class to fit a toddler is the failure here.',
  },
];
