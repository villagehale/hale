import type { FamilyStage } from '@hale/types';

/** The four CDC developmental domains, in the order they render on every page. */
export type MilestoneDomain =
  | 'social-emotional'
  | 'language-communication'
  | 'cognitive'
  | 'movement-physical';

/** One domain's milestone list on a checkpoint page. */
export interface MilestoneDomainGroup {
  domain: MilestoneDomain;
  /** CDC milestones for this domain, rendered verbatim in they/them. */
  items: string[];
}

/**
 * One CDC "Learn the Signs. Act Early." age checkpoint. This is a portrait of an
 * age, never a scorecard for a child — the page has no inputs and no way to
 * "fail". YMYL: checkpoints ship `published: false` so they render noindex and
 * stay out of the sitemap until a human re-verifies the copy against `sourceUrl`
 * (the review-before-index gate). Flip `published: true` to make one indexable.
 */
export interface MilestoneCheckpoint {
  /** URL segment, e.g. "18-months" or "2-years". */
  slug: string;
  /** Age in months this checkpoint sits at — the sort key and helper target. */
  months: number;
  /** How the age reads in copy, e.g. "18 months" or "2 years". */
  ageLabel: string;
  /** <title> / OG headline, e.g. "What's typical around 18 months". */
  title: string;
  /** Meta + OG description. One or two sentences. */
  description: string;
  /** Childhood stage this age sits in — drives related-answer selection. */
  stage: FamilyStage;
  /** The four CDC domains, each with its milestone list. */
  domains: MilestoneDomainGroup[];
  /** The exact CDC checkpoint page this copy was verified against. */
  sourceUrl: string;
  /** ISO date the copy was last reviewed against `sourceUrl`. */
  updated: string;
  /**
   * Review gate. Default false → the page is noindexed and kept out of the
   * sitemap. Set true only after a human diffs the copy against `sourceUrl`.
   */
  published: boolean;
}
