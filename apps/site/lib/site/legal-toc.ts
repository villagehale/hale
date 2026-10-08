/**
 * The section whose heading has reached the line just under the sticky header.
 * A line at the viewport top marks the previous section for as long as the
 * heading is still sitting under the bar, which is one section behind.
 */
export function currentLegalSection(headingTops: readonly number[], line: number): number {
  let current = 0;
  for (let index = 0; index < headingTops.length; index++) {
    const top = headingTops[index];
    if (top !== undefined && top <= line) current = index;
  }
  return current;
}
