import type { DiscoveryQuery, FamilyStage } from '@hale/types';
import type { DiscoveredCandidate, DiscoveryProvider } from './types.js';

/**
 * The always-available discovery floor: a small, hand-curated, GEO-AGNOSTIC
 * seed of activity *types* that reliably exist in most populated areas. It
 * never invents a venue, schedule, or price — each seed is the kind of option
 * a thoughtful local parent knows is "probably nearby", so its confidence is
 * honest-but-modest and its `coverageNote` says so in plain words.
 *
 * Privacy (rule #1): a seed reasons only about the COARSE area echoed from the
 * query and never names the child. The query type has no field for a precise
 * location, so one cannot leak in.
 */

interface Seed {
  title: string;
  description: string;
  stages: readonly FamilyStage[];
  /** Interest tags this seed speaks to; empty = broadly-loved, stage-typical. */
  interests: readonly string[];
  confidence: number;
  coverageNote: string;
}

const SEEDS: readonly Seed[] = [
  {
    title: 'Public library baby storytime',
    description:
      'A free, low-key lap-sit storytime most public libraries run for infants and caregivers.',
    stages: ['newborn'],
    interests: ['books', 'music', 'language'],
    confidence: 0.7,
    coverageNote: 'Public libraries with infant programs are common in most areas.',
  },
  {
    title: 'Parent-and-baby drop-in group',
    description:
      'A community-centre drop-in where caregivers and newborns gather; no registration, come-as-you-are.',
    stages: ['newborn'],
    interests: [],
    confidence: 0.6,
    coverageNote: 'Community centres often host caregiver drop-ins; schedules vary by area.',
  },
  {
    title: 'Parent-and-tot swim',
    description:
      'An introductory water-comfort class for toddlers with a caregiver in the water, common at municipal pools.',
    stages: ['toddler'],
    interests: ['water', 'swimming', 'movement'],
    confidence: 0.65,
    coverageNote: 'Municipal pools commonly offer parent-and-tot swim; sessions are seasonal.',
  },
  {
    title: 'Toddler music-and-movement class',
    description: 'A short, repeated, song-and-shaker class pitched at toddler attention spans.',
    stages: ['toddler'],
    interests: ['music', 'movement', 'dance'],
    confidence: 0.6,
    coverageNote: 'Music-together-style classes run widely; specific providers vary.',
  },
  {
    title: 'Neighbourhood park and playground',
    description:
      'Unstructured outdoor play at a local park — free, flexible, and good for gross-motor practice.',
    stages: ['toddler', 'child'],
    interests: ['outdoor', 'nature', 'movement'],
    confidence: 0.8,
    coverageNote: 'Public parks exist in essentially every area.',
  },
  {
    title: 'Library after-school reading club',
    description: 'A weekly school-age reading or activity club many libraries run after school.',
    stages: ['child'],
    interests: ['books', 'reading', 'language'],
    confidence: 0.65,
    coverageNote: 'Library after-school programming is common; days vary by branch.',
  },
  {
    title: 'Community soccer or sports league',
    description: 'A recreational, low-pressure youth sports league for school-age children.',
    stages: ['child'],
    interests: ['soccer', 'sports', 'movement', 'outdoor'],
    confidence: 0.6,
    coverageNote: 'Recreational youth leagues are common; seasons and ages vary.',
  },
  {
    title: 'Teen volunteer or maker program',
    description:
      'A teen-led volunteering, coding, or maker program — optional and self-directed, often at a library or community centre.',
    stages: ['teenager'],
    interests: ['coding', 'art', 'volunteering', 'making'],
    confidence: 0.55,
    coverageNote: 'Teen programs vary widely by area; treat as a starting point.',
  },
  {
    title: 'Community pool lap or open swim',
    description: 'Open-swim or lane time a teenager can use independently at a municipal pool.',
    stages: ['teenager'],
    interests: ['water', 'swimming', 'sports', 'movement'],
    confidence: 0.6,
    coverageNote: 'Municipal pools commonly offer open swim; hours vary.',
  },
];

function matchesInterest(seed: Seed, interests: readonly string[]): boolean {
  if (seed.interests.length === 0 || interests.length === 0) return true;
  const wanted = new Set(interests.map((i) => i.toLowerCase()));
  return seed.interests.some((tag) => wanted.has(tag.toLowerCase()));
}

/**
 * Rank a seed for a query: an explicit interest hit outranks a stage-typical
 * fallback, and higher base confidence breaks ties — so a swim class for a
 * water-loving toddler sorts above a generic park.
 */
function score(seed: Seed, interests: readonly string[]): number {
  const wanted = new Set(interests.map((i) => i.toLowerCase()));
  const interestHit = seed.interests.some((tag) => wanted.has(tag.toLowerCase()));
  return (interestHit ? 1 : 0) + seed.confidence;
}

export class FakeDiscoveryProvider implements DiscoveryProvider {
  readonly name = 'fake';

  async discover(query: DiscoveryQuery): Promise<DiscoveredCandidate[]> {
    return SEEDS.filter(
      (seed) => seed.stages.includes(query.stage) && matchesInterest(seed, query.interests),
    )
      .sort((a, b) => score(b, query.interests) - score(a, query.interests))
      .slice(0, query.limit)
      .map((seed) => ({
        title: seed.title,
        description: seed.description,
        stage: query.stage,
        areaCoarse: query.areaCoarse,
        source: 'curated_seed',
        confidence: seed.confidence,
        coverageNote: seed.coverageNote,
      }));
  }
}
