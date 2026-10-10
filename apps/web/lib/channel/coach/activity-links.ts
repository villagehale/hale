/**
 * The pages behind the activities this reply actually named.
 *
 * The model is told never to write a URL. The link is appended here when the reply
 * refers to one offered find: the title in full, a unique phrase from it ("lantern
 * craft"), the venue plus the activity type, or — when this is the only find the
 * reply is offering — a shortened title. A Saturday mention still does not pick up
 * every find from the turn.
 *
 * No imports. The coach-channel eval loads this file under tsx, where the `~/` alias
 * does not resolve.
 */

export interface NamedActivityLink {
  title: string;
  url: string;
  /** A place the title does not already name, when the offer has one. */
  venue?: string;
}

const GENERIC_TITLE_WORDS = new Set([
  'class',
  'classes',
  'lesson',
  'lessons',
  'session',
  'sessions',
  'practice',
  'club',
  'camp',
  'group',
  'meetup',
  'meeting',
  'program',
  'programme',
  'activity',
  'event',
  'time',
  'day',
  'week',
  'kids',
  'kid',
  'child',
  'children',
  'family',
  'parent',
  'baby',
  'toddler',
  'drop',
  'and',
  'the',
  'for',
  'with',
  'from',
  'this',
  'that',
  'your',
  'our',
]);

function sameLink(a: NamedActivityLink, b: NamedActivityLink): boolean {
  return a.url === b.url && a.title === b.title;
}

function wordsOf(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && !GENERIC_TITLE_WORDS.has(word)),
    ),
  ];
}

function tokensOf(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
}

function otherFindMentioned(
  hay: string,
  link: NamedActivityLink,
  links: readonly NamedActivityLink[],
): boolean {
  return links.some((other) => {
    if (sameLink(other, link)) return false;
    return wordsOf(other.title).some((word) => hay.includes(word));
  });
}

/**
 * Does this reply refer to this find, among the finds offered this turn?
 *
 * Full title first. Then a two-word phrase that belongs to this title alone, then
 * the venue plus one word of the activity, then a shortened title when no other
 * offered find is named.
 */
export function replyNamesActivity(
  body: string,
  link: NamedActivityLink,
  links: readonly NamedActivityLink[],
): boolean {
  const hay = body.toLowerCase();
  const words = wordsOf(link.title);
  if (words.length > 0 && words.every((word) => hay.includes(word))) return true;

  const tokens = tokensOf(link.title);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const phrase = `${tokens[i]} ${tokens[i + 1]}`;
    if (!hay.includes(phrase)) continue;
    const shared = links.some(
      (other) => !sameLink(other, link) && other.title.toLowerCase().includes(phrase),
    );
    if (!shared) return true;
  }

  if (link.venue) {
    const venueWords = wordsOf(link.venue);
    const venueHit = venueWords.length > 0 && venueWords.every((word) => hay.includes(word));
    const typeWords = words.filter((word) => !venueWords.includes(word));
    if (venueHit && typeWords.some((word) => hay.includes(word))) return true;
  }

  const hits = words.filter((word) => hay.includes(word));
  if (hits.length === 0 || otherFindMentioned(hay, link, links)) return false;
  if (links.length === 1 || hits.length >= 2) return true;
  return hits.some((word) => word.length >= 6);
}

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
    if (!replyNamesActivity(body, link, links)) continue;
    seen.add(link.url);
    out.push(link.url);
  }
  return out.join(' ');
}
