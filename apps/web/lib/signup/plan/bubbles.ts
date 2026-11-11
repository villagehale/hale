/** One send in a plan notice: a model-written bubble, or the one Hale-owned link. */
export type PlanNoticePart = { type: 'text'; body: string } | { type: 'link'; url: string };

/** Insert the one Hale-owned link as its own part, after bubble `after` (0-based). */
export function withLinkBubbles(
  bubbles: readonly string[],
  link: string | null,
  after = 0,
): PlanNoticePart[] {
  const texts = bubbles.map((body): PlanNoticePart => ({ type: 'text', body }));
  if (!link) return texts;
  const i = Math.min(Math.max(after, 0) + 1, texts.length);
  return [...texts.slice(0, i), { type: 'link', url: link }, ...texts.slice(i)];
}

export function asBubbles(value: string | readonly string[] | null): string[] | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : null;
  }
  const bubbles = value.map((item) => item.trim()).filter((item) => item.length > 0);
  return bubbles.length > 0 ? bubbles : null;
}
