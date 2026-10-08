import { distinctiveWords } from '~/lib/channel/followup/screen';

export interface NamedActivityLink {
  title: string;
  url: string;
}

/**
 * The pages behind the activities this reply actually named.
 *
 * The model is told never to write a URL. The link is appended here, and only for a
 * title whose distinctive words are all in the body, so a Saturday mention does not
 * pick up every find from the turn.
 */
export function activityLinkSuffix(
  body: string,
  links: readonly NamedActivityLink[] | undefined,
): string {
  if (!links || links.length === 0) return '';
  const hay = body.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of links) {
    if (seen.has(link.url) || hay.includes(link.url.toLowerCase())) continue;
    const words = distinctiveWords(link.title);
    if (words.length === 0) continue;
    if (!words.every((word) => hay.includes(word))) continue;
    seen.add(link.url);
    out.push(link.url);
  }
  return out.join(' ');
}
