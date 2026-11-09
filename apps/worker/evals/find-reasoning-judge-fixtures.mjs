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
