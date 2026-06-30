/**
 * PLACEHOLDER local-discovery data. NOT real and NOT from any API. Per hard
 * rule #1, location is always a COARSE area (e.g. "M5V area"), never a precise
 * address — distances are approximate and area-relative.
 */

export const COARSE_AREA = 'M5V area';

export const VILLAGE_INTERESTS = ['All', 'Play', 'Health', 'Outdoors', 'Classes'] as const;
export type VillageInterest = (typeof VILLAGE_INTERESTS)[number];

export type VillageRec = {
  id: string;
  title: string;
  interest: Exclude<VillageInterest, 'All'>;
  distanceKm: number;
  hours: string;
  recommendedBy: number;
  blurb: string;
};

export const VILLAGE_RECS: VillageRec[] = [
  {
    id: 'riverdale-dropin',
    title: 'Riverdale Family Drop-in',
    interest: 'Play',
    distanceKm: 0.8,
    hours: 'open until 5pm',
    recommendedBy: 4,
    blurb: 'Free indoor play space for under-5s, calm in the early afternoon.',
  },
  {
    id: 'harbourfront-walk',
    title: 'Harbourfront stroller walk',
    interest: 'Outdoors',
    distanceKm: 1.5,
    hours: 'daylight',
    recommendedBy: 7,
    blurb: 'Flat, shaded waterfront loop — easy with a pram and a 2-year-old.',
  },
  {
    id: 'baby-time-library',
    title: 'Baby Time at the public library',
    interest: 'Classes',
    distanceKm: 1.1,
    hours: 'Tue & Thu 10:30am',
    recommendedBy: 12,
    blurb: 'Songs and rhymes for 0-18 months. Arrive early for a spot.',
  },
  {
    id: 'sundance-clinic',
    title: 'Sundance pediatric walk-in',
    interest: 'Health',
    distanceKm: 2.0,
    hours: 'open until 8pm',
    recommendedBy: 5,
    blurb: 'After-hours pediatric care; shorter waits on weekday evenings.',
  },
];
