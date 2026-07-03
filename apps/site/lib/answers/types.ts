import type { FamilyStage, FrameworkCitation } from '@hale/types';

/** One heading + body block in an answer's main text. */
export interface AnswerSection {
  heading: string;
  /** Plain-text paragraphs. No inline HTML — copy is rendered as text, not markup. */
  body: string[];
}

/** One entry in the page's FAQPage block — a related question a parent also asks. */
export interface AnswerFaq {
  question: string;
  answer: string;
}

/**
 * A cornerstone answer page. Content is grounded in `citations` (see
 * lib/answers/frameworks.ts) — every substantive claim traces to a framework in
 * the permitted corpus. YMYL: pages are drafted `published: false` so they are
 * noindexed and excluded from the sitemap until a human reviews them (the
 * review-before-index gate). Flip `published: true` to make a page indexable.
 */
export interface AnswerPage {
  slug: string;
  /** The high-intent parent query this page targets, phrased as a question. */
  question: string;
  /** <title> / OG title — may differ from `question` for length. */
  title: string;
  /** Meta description + OG description. One or two sentences. */
  description: string;
  /** Childhood stage this question sits in — drives the on-page stage label. */
  stage: FamilyStage;
  /** The direct answer, shown up top and used as the FAQPage lead answer. */
  answer: string;
  sections: AnswerSection[];
  /** Every claim's grounding. Rendered as the "Sources" list and Article JSON-LD. */
  citations: FrameworkCitation[];
  faqs: AnswerFaq[];
  /** Slugs of related answers, for internal linking. */
  related: string[];
  /** ISO date the copy was last reviewed — feeds dateModified in JSON-LD. */
  updated: string;
  /**
   * Review gate. Default false → the page is noindexed and kept out of the
   * sitemap. Set true only after a human reviews the copy and its citations.
   */
  published: boolean;
}
