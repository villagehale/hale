/**
 * Kid-event title checks with no send path.
 *
 * Lives apart from household-calendar so duty copy and the group sync can
 * ask "may this title be spoken?" without importing the outbound sender.
 */

const KID_WORDS = [
  'gymnastics',
  'swim',
  'swimming',
  'soccer',
  'daycare',
  'school',
  'pickup',
  'pick-up',
  'registration',
  'appointment',
  'class',
  'lesson',
  'practice',
  'recital',
  'camp',
  'storytime',
  'earlyon',
  'preschool',
  'nursery',
  'pediatric',
  'ballet',
  'karate',
  'hockey',
  'piano',
  'tutor',
] as const;

export function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu');
}

export function hasWord(title: string, word: string): boolean {
  return wordPattern(word).test(` ${title} `);
}

export function classifyKidCalendarItem(input: {
  title: string | null | undefined;
  childNames: readonly string[];
}): boolean {
  const title = input.title?.trim() ?? '';
  if (title.length === 0) return false;
  for (const name of input.childNames) {
    const token = name.trim();
    if (token.length < 2) continue;
    if (hasWord(title, token)) return true;
  }
  return KID_WORDS.some((word) => hasWord(title, word));
}

/** Title column value. Null unless the row is kid-related. */
export function titleForStorage(
  kidRelated: boolean,
  title: string | null | undefined,
): string | null {
  if (!kidRelated) return null;
  const trimmed = title?.replace(/\s+/g, ' ').trim() ?? '';
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 80);
}

export function splitKidEvent(
  title: string,
  childNames: readonly string[],
): { kid: string; event: string } | null {
  const names = childNames
    .map((name) => name.trim())
    .filter((name) => name.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (!hasWord(title, name)) continue;
    const event = title
      .replace(wordPattern(name), ' ')
      .replace(/^['’]?s\b/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!event) return null;
    return { kid: name, event };
  }
  if (names.length === 1) return { kid: names[0] as string, event: title.trim() };
  return null;
}

/** True when the text names one of these teens as a whole word (rule #1). */
export function namesTeen(text: string, teenNames: readonly string[]): boolean {
  return teenNames.some((name) => name.trim().length >= 2 && hasWord(text, name.trim()));
}

/**
 * A block about a teen keeps its time — its parent is still busy then — and loses its
 * title, so no group line can name the teen or the event (rule #1). A title that names
 * a teen, or that the household's only child would be credited with when that child is
 * a teen, is a teen's.
 */
export function withoutTeenTitles<T extends { title: string | null; kidRelated: boolean }>(
  blocks: readonly T[],
  childNames: readonly string[],
  teenNames: readonly string[],
): T[] {
  const teens = teenNames.map((name) => name.trim()).filter((name) => name.length >= 2);
  if (teens.length === 0) return [...blocks];
  return blocks.map((block) => {
    const title = block.title;
    if (!title) return block;
    const credited = splitKidEvent(title, childNames)?.kid;
    const teen =
      teens.some((name) => hasWord(title, name)) ||
      (credited !== undefined && teens.includes(credited));
    return teen ? { ...block, title: null, kidRelated: false } : block;
  });
}
