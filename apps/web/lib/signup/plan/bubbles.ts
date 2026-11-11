/** Insert the one Hale-owned link as its own bubble, after `after` (0-based). */
export function withLinkBubbles(
  bubbles: readonly string[],
  link: string | null,
  after = 0,
): string[] {
  if (!link) return [...bubbles];
  const i = Math.min(Math.max(after, 0) + 1, bubbles.length);
  return [...bubbles.slice(0, i), link, ...bubbles.slice(i)];
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
