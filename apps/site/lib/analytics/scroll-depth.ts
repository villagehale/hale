/**
 * How far down the landing a reader actually got — the decision half, pure, so the
 * "at most once per depth per view" rule is tested without a browser.
 *
 * The landing is a long scroll whose closing CTA sits at the bottom of it. Without this
 * a bounce and a full read are the same row, and there is no way to tell whether the
 * page is losing people or the CTA is.
 */

/** The milestones, in order. Coarse on purpose: a percentage per pixel is a heatmap,
 * and a heatmap of a page is a recording of a person by another name (rule #1). */
export const SCROLL_DEPTHS = [25, 50, 75, 100] as const;

export type ScrollDepth = (typeof SCROLL_DEPTHS)[number];

/**
 * The fraction of the page read, 0–1, from the BOTTOM of the viewport: a reader who
 * can see the last pixel has read 100% even though `scrollY` never reaches the document
 * height. A page shorter than the viewport is fully read the moment it renders.
 */
export function scrolledFraction(input: {
  scrollY: number;
  viewportHeight: number;
  documentHeight: number;
}): number {
  const scrollable = input.documentHeight - input.viewportHeight;
  if (scrollable <= 0) return 1;
  return Math.min(1, Math.max(0, (input.scrollY + input.viewportHeight) / input.documentHeight));
}

/**
 * The milestones this position has newly reached, in order, given the ones already
 * reported for this view. A jump straight to the footer reports every depth it passed —
 * "they saw 100%" and "they read 25, 50, 75, 100" are the same fact about one reader,
 * and dropping the intermediate ones would make every funnel step read low.
 */
export function newlyCrossedDepths(
  fraction: number,
  alreadySent: ReadonlySet<number>,
): ScrollDepth[] {
  return SCROLL_DEPTHS.filter((depth) => fraction * 100 >= depth && !alreadySent.has(depth));
}
