// find-reasoning-judge eval fixtures (VIL-524). Each `draft` is a nearby-find reply as
// the coach might write it. `withhold: 'yes'` only where the whole draft is the coach's
// own search, ranking, sources or a comment on the result set, with nothing a parent can
// use (packages/agent/skills/find-reasoning-judge.md). A draft that names any find, or
// that tells the parent plainly what is and is not on, is sent as written.

export const FIND_REASONING_JUDGE_FIXTURES = [
  {
    id: 'en-shared-page-only',
    draft: 'All three finds share one page, so I ranked them by distance and kept the closest.',
    expect: 'yes',
  },
  {
    id: 'en-count-and-weighing-only',
    draft:
      'I checked four listings and two came back with Saturday dates. I weighed both against nap time.',
    expect: 'yes',
  },
  {
    id: 'en-sources-only',
    draft:
      'My search pulled from the city listings and a parents forum. The forum looked more current, so I leaned on it.',
    expect: 'yes',
  },
  {
    id: 'fr-shared-page-only',
    draft: "J'ai trouvé trois activités sur la même page et je les ai classées par distance.",
    expect: 'yes',
  },
  {
    id: 'es-search-only',
    draft: 'Busqué en tres sitios y todos los resultados salen de la misma página.',
    expect: 'yes',
  },
  {
    id: 'en-two-finds',
    draft:
      'Storytime at the branch library, Saturday at 10, free drop-in. Toddler gym at the rec centre, Sunday 9:30.',
    expect: 'no',
  },
  {
    id: 'en-aside-then-find',
    draft: 'All three finds share one page… Toddler storytime Saturday at 10 at the library.',
    expect: 'no',
  },
  {
    id: 'en-count-introduces-finds',
    draft:
      'Three good ones this weekend: the splash pad is open Saturday 9 to 5, a puppet show Sunday at 2 at the community hall, and parent-and-tot swim Sunday at 10.',
    expect: 'no',
  },
  {
    id: 'en-shared-page-handed-over',
    draft:
      'Saturday 10am storytime and Sunday 11am crafts are both on the library events page: [link-1]',
    expect: 'no',
  },
  {
    id: 'fr-one-find',
    draft: "Heure du conte samedi à 10 h à la bibliothèque du quartier, c'est gratuit.",
    expect: 'no',
  },
  {
    id: 'en-nothing-on-is-an-answer',
    draft: 'Nothing near you this Saturday fits a two-year-old. Want me to look at Sunday?',
    expect: 'no',
  },
];

// followup-process-judge fixtures (VIL-571). Each `draft` is an activity follow-up text.
// `expect: 'flag'` where a sentence reports Hale's own search instead of a find, a gap,
// an empty answer or the next step (packages/agent/skills/followup-process-judge.md);
// `flagged` is a fragment of the sentence that must be named. `expect: 'clean'` is sent.
export const FOLLOWUP_PROCESS_JUDGE_FIXTURES = [
  {
    id: 'en-find-then-listings-set-aside',
    draft:
      'Little Movers runs Tiny Gym Saturdays at 9:30, $120 for eight weeks - their site says. I also checked two other gyms nearby, but one was full and the other starts at age 4.',
    expect: 'flag',
    flagged: 'two other gyms',
  },
  {
    id: 'en-find-then-page-count',
    draft:
      "Riverside Pool has Parent and Tot swim Sundays at 10, $86 for nine lessons - their site says. I opened six pages and three of them were last year's guides.",
    expect: 'flag',
    flagged: 'six pages',
  },
  {
    id: 'en-ranking-explained',
    draft:
      'I ranked the three by distance and kept the closest. Maple Library has toddler storytime Thursdays at 10:30, free - their site says.',
    expect: 'flag',
    flagged: 'ranked',
  },
  {
    id: 'fr-find-then-sources',
    draft:
      "Le centre Les Petits Pas offre de la gym pour les 2-3 ans le samedi à 9 h 30, 95 $ - selon leur site. J'ai comparé leur site avec un forum de parents et j'ai fait plus confiance au site.",
    expect: 'flag',
    flagged: 'forum',
  },
  {
    id: 'en-find-gap-and-watch',
    draft:
      "Little Movers runs Tiny Gym for 18 months to 3 years - their site says. I could not pin down the fall day or price, so I'll keep watching and text you when I can get to them.",
    expect: 'clean',
  },
  {
    id: 'en-two-finds-with-registration',
    draft:
      'Riverside Pool has Parent and Tot Mondays at 10, $86 for nine - their site says, and registration opens Sept 1 at 7am. Maple Library runs free storytime Thursdays at 10:30, per their events page.',
    expect: 'clean',
  },
  {
    id: 'en-empty-answer-where-looked',
    draft:
      "I went through the town's fall listings and there is nothing running for that age this season. I'll keep watching and text you if that changes.",
    expect: 'clean',
  },
  {
    id: 'es-find-and-more-options',
    draft:
      'Little Movers tiene gimnasia para niños de 1 a 3 años los sábados a las 9:30, 120 $ - según su sitio. Hay más opciones; pídemelas aquí cuando quieras.',
    expect: 'clean',
  },
  // From real follow-ups, scrubbed (the repo is public): invented venues and towns, no
  // names. The raw 2026-11-03 phone-audit texts are not in the repo; these keep the shapes
  // it reported (VIL-571 bookkeeping tail, VIL-564 gap-and-watch, VIL-572 a follow-up in
  // Chinese). The first is the finder eval's own empty-search draft, which this judge
  // flagged whole when it first ran inside the compose loop.
  {
    id: 'audit-empty-first-person-where-looked',
    draft:
      "I searched for toddler underwater basket weaving and went through Brookfield's fall recreation pages. There is nothing running for that age, only novelty and joke results. I'll keep watching and text you if one turns up.",
    expect: 'clean',
  },
  {
    id: 'audit-empty-with-page-count-and-ranking',
    draft:
      "I opened eleven pages across four sites and ranked what was left by distance. Nothing near you runs for two-year-olds this fall. I'll keep watching and text you if that changes.",
    expect: 'flag',
    flagged: 'eleven pages',
  },
  {
    id: 'audit-find-then-listings-left-out',
    draft:
      "Tumble Tots at the Brookfield rec centre runs Wednesdays at 10, $96 for eight weeks - their site says. The other two listings I found were last spring's and a private studio with no toddler class, so I left them out.",
    expect: 'flag',
    flagged: 'left them out',
  },
  {
    id: 'audit-gap-and-watch',
    draft:
      "Little Sprouts Gym has a parent-and-tot class for under-3s - their site says. I couldn't pin down the days or times, so I'll keep watching and text you when I can get to them.",
    expect: 'clean',
  },
  {
    id: 'audit-zh-find-then-other-pools',
    draft:
      'Riverbend 社区中心的亲子游泳课每周六上午10点，八节课120元，这是他们网站上写的。我还查看了另外三个泳池的页面，但都没有适合这个年龄的课程。',
    expect: 'flag',
    flagged: '另外三个泳池',
  },
];
