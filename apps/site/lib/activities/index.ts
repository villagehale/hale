import type { FaqItem } from '~/lib/faq/index';

/**
 * Local "things to do with your kid in <city>" pages — Hale's own SEO surface,
 * because finding trusted local activities is what the product does. Each city is
 * built from activity categories that are genuinely universal across Canadian
 * cities (public-library early-literacy, rec-centre parent-and-tot swim, community
 * drop-in play, parks and splash pads, markets and festivals) plus one
 * province-specific drop-in program, so a page is accurate rather than a thin
 * doorway.
 *
 * REVIEW-BEFORE-INDEX GATE (same as milestones/answers): every city ships
 * `published: false`. Provincial program names change (e.g. Alberta's Parent Link
 * Centres became Family Resource Networks; Quebec's halte-garderies vary by
 * borough) — a human verifies a city's `provincialProgram` against the current
 * official source, then flips `published: true` to let it into the sitemap.
 */
export interface ActivityIdea {
  title: string;
  body: string;
}

export interface ActivityCity {
  slug: string;
  city: string;
  province: string;
  provinceCode: string;
  updated: string;
  published: boolean;
  /** One or two sentences of city-specific framing. */
  intro: string;
  /** A well-known local asset to make the page concretely about this place. */
  landmark: string;
  /** The province's public drop-in family program — the one field needing review. */
  provincialProgram: { name: string; body: string };
  faqs: readonly FaqItem[];
}

/**
 * The activity categories that exist in every Canadian city, phrased for the given
 * city. Shared so the "what's out there" advice stays consistent; the per-city
 * uniqueness lives in `intro`, `landmark`, `provincialProgram`, and `faqs`.
 */
export function universalIdeas(city: ActivityCity): ActivityIdea[] {
  return [
    {
      title: 'Story-time at the public library',
      body: `Almost every ${city.city} library branch runs free early-literacy programs — baby rhyme time, toddler story-time, songs and a picture book. No registration for most drop-in sessions; check your nearest branch's calendar.`,
    },
    {
      title: 'Parent-and-tot swim at a rec centre',
      body: `${city.city}'s public recreation centres run warm-water parent-and-baby and parent-and-tot swim classes — a gentle first activity you do together, in small, patient groups.`,
    },
    {
      title: 'Drop-in play and open gym',
      body: `Community and family centres offer indoor drop-in play — soft-play, climbers, toys, and room to move — which is exactly what a rainy or cold ${city.city} day calls for.`,
    },
    {
      title: 'Parks, playgrounds, and splash pads',
      body: `Free and always open: ${city.landmark} and neighbourhood playgrounds and summer splash pads. The everyday outing that never gets old for little ones.`,
    },
    {
      title: `${city.provincialProgram.name}`,
      body: city.provincialProgram.body,
    },
    {
      title: 'Markets and family festivals',
      body: `Weekend farmers' markets and seasonal community festivals around ${city.city} are easy, low-pressure outings — space to wander, music, snacks, and other families about.`,
    },
  ];
}

const CITIES: readonly ActivityCity[] = [
  {
    slug: 'toronto',
    city: 'Toronto',
    province: 'Ontario',
    provinceCode: 'ON',
    updated: '2026-07-05',
    published: false,
    intro:
      'From the Beaches to Etobicoke, Toronto is full of free and low-cost things to do with a baby or toddler — you just have to know where families actually go.',
    landmark: 'High Park, the Toronto Islands, and the waterfront trails',
    provincialProgram: {
      name: 'EarlyON Child and Family Centres',
      body: 'Ontario runs free EarlyON Child and Family Centres across Toronto — drop-in play, songs and circle time, and support for parents and caregivers with children under six. Find your closest centre through the City of Toronto or Ontario.ca.',
    },
    faqs: [
      {
        question: 'Where can I find free activities for toddlers in Toronto?',
        answer:
          'Start with Toronto Public Library story-times and free EarlyON Child and Family Centres for drop-in play, then add city parks, splash pads, and community-centre open gyms — all free.',
      },
      {
        question: 'What can I do with a baby in Toronto on a rainy day?',
        answer:
          'Library baby rhyme time, an EarlyON drop-in centre, a parent-and-baby swim at a city pool, or indoor drop-in play at a community centre are all warm, low-cost rainy-day options.',
      },
    ],
  },
  {
    slug: 'ottawa',
    city: 'Ottawa',
    province: 'Ontario',
    provinceCode: 'ON',
    updated: '2026-07-05',
    published: false,
    intro:
      'Ottawa families have an unusual amount of green space and free programming close at hand — from the canal paths to the neighbourhood family centres.',
    landmark: 'the Rideau Canal pathways and the riverside parks',
    provincialProgram: {
      name: 'EarlyON Child and Family Centres',
      body: 'Ontario’s free EarlyON Child and Family Centres run across Ottawa — drop-in play and early-years programs for children under six with a parent or caregiver. Locations are listed by the City of Ottawa.',
    },
    faqs: [
      {
        question: 'Where can I find free things to do with kids in Ottawa?',
        answer:
          'Ottawa Public Library story-times, free EarlyON centres for drop-in play, the Rideau Canal pathways and riverside parks, and community-centre open gyms are all free and family-friendly.',
      },
    ],
  },
  {
    slug: 'vancouver',
    city: 'Vancouver',
    province: 'British Columbia',
    provinceCode: 'BC',
    updated: '2026-07-05',
    published: false,
    intro:
      'Between the seawall, the community centres, and BC’s family programs, Vancouver makes it easy to get out with a little one whatever the weather.',
    landmark: 'the seawall, Stanley Park, and the neighbourhood beaches',
    provincialProgram: {
      name: 'StrongStart BC and Family Places',
      body: 'In BC, look for free StrongStart BC early-learning drop-ins (often at public schools) and neighbourhood Family Places / family drop-in programs — play-based sessions for young children with a parent or caregiver.',
    },
    faqs: [
      {
        question: 'Where can I find free activities for toddlers in Vancouver?',
        answer:
          'Vancouver Public Library story-times, free StrongStart BC drop-ins and Family Places, community-centre parent-and-tot programs, plus the seawall and beaches — all free.',
      },
    ],
  },
  {
    slug: 'calgary',
    city: 'Calgary',
    province: 'Alberta',
    provinceCode: 'AB',
    updated: '2026-07-05',
    published: false,
    intro:
      'Calgary’s pathway network, libraries, and family resource centres add up to a lot of low-cost ways to fill a morning with a baby or toddler.',
    landmark: 'the river pathways, Prince’s Island Park, and Fish Creek',
    provincialProgram: {
      name: 'Family Resource Networks',
      body: 'In Alberta, look for a Family Resource Network (FRN) near you — free drop-in play and early-childhood programs for families with young children. FRNs replaced the former Parent Link Centres; find yours through the Government of Alberta.',
    },
    faqs: [
      {
        question: 'Where can I find free things to do with a baby in Calgary?',
        answer:
          'Calgary Public Library story-times, a local Family Resource Network for free drop-in play, the river pathways and Prince’s Island Park, and recreation-centre parent-and-tot swim are all affordable options.',
      },
    ],
  },
  {
    slug: 'montreal',
    city: 'Montreal',
    province: 'Quebec',
    provinceCode: 'QC',
    updated: '2026-07-05',
    published: false,
    intro:
      'Montreal’s neighbourhoods each have their own parks, libraries, and family houses — a walkable, low-cost world for parents with young kids.',
    landmark: 'Parc du Mont-Royal, Parc La Fontaine, and the borough parks',
    provincialProgram: {
      name: 'Maisons de la famille and library story hours',
      body: 'In Quebec, look for your borough’s Maison de la famille (family house) for drop-in activities and parent support, and the free l’heure du conte (story hour) at Montreal’s public libraries.',
    },
    faqs: [
      {
        question: 'Where can I find free activities for young children in Montreal?',
        answer:
          'Montreal library story hours (l’heure du conte), a neighbourhood Maison de la famille for drop-in activities, and the city’s parks — Mont-Royal, La Fontaine, and borough parks — are all free.',
      },
    ],
  },
];

export const allCities: readonly ActivityCity[] = CITIES;
export const publishedCities: readonly ActivityCity[] = CITIES.filter((c) => c.published);

export function getCity(slug: string): ActivityCity | undefined {
  return CITIES.find((c) => c.slug === slug);
}
