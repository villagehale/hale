import { teenChildIds } from '~/lib/channel/role-scope';
import { noticeTitleFor } from '~/lib/integrations/calendar-notice-title';
import { teenNameIn } from '~/lib/privacy/teen-name';

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

/**
 * The title a household calendar block may keep and the group may hear (VIL-651): only the
 * title of an event the parent organized, or their own, cleaned the way the 1:1 notice
 * cleans it. Anyone else's event, and a row stored before its standing was kept, has none:
 * its organizer can rename it at any time, so its title is their words, not the family's.
 */
export function spokenBlockTitle(
  standing: string | null,
  title: string | null | undefined,
): string | null {
  return noticeTitleFor(standing, title) || null;
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
  /**
   * How many children the household has, named or not. The single-name fallback
   * is only for a household of one. A filtered name list of length 1 must not
   * claim an event that did not say that name when a sibling has no name on file.
   */
  rosterSize = childNames.length,
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
  if (names.length === 1 && rosterSize === 1)
    return { kid: names[0] as string, event: title.trim() };
  return null;
}

/** True when the text names one of these teens as a whole word (rule #1). */
export function namesTeen(text: string, teenNames: readonly string[]): boolean {
  return teenNameIn(text, teenNames);
}

/**
 * Every child of one household as the teen guard reads it (rule #1), named or not.
 * Built only by {@link teenRoster} from the whole children read, so a caller cannot drop a
 * child with no name before the guard asks whether that child is a teen.
 */
export interface TeenRoster {
  childNames: string[];
  teenNames: string[];
  /** Children in the household, named or not. */
  size: number;
  /** A 13+ child has no name a title could be matched against. */
  unnamedTeen: boolean;
}

export function teenRoster(
  children: readonly { id: string; name: string | null; dateOfBirth: string }[],
  now: Date,
): TeenRoster {
  const teens = teenChildIds(children, now);
  const named = (child: { name: string | null }) => (child.name ? [child.name] : []);
  const teenRows = children.filter((child) => teens.has(child.id));
  return {
    childNames: children.flatMap(named),
    teenNames: teenRows.flatMap(named),
    size: children.length,
    unnamedTeen: teenRows.some((child) => (child.name?.trim() ?? '').length < 2),
  };
}

/**
 * Fail closed for a teen with no name (rule #1): with one in the household, a kid title
 * is theirs unless it names a younger child.
 */
export function unnamedTeenMayOwn(title: string | null, roster: TeenRoster): boolean {
  if (!roster.unnamedTeen) return false;
  if (!title) return true;
  const credited = splitKidEvent(title, roster.childNames, roster.size)?.kid;
  return (
    credited === undefined ||
    teenNameIn(title, roster.teenNames) ||
    teenNameIn(credited, roster.teenNames)
  );
}

/**
 * A block about a teen keeps its time — its parent is still busy then — and loses its
 * title, so no group line can name the teen or the event (rule #1). A title that names
 * a teen, or that the household's only child would be credited with when that child is
 * a teen, is a teen's. With a teen who has no name on file, so is every kid block that
 * names no younger child.
 */
export function withoutTeenTitles<T extends { title: string | null; kidRelated: boolean }>(
  blocks: readonly T[],
  roster: TeenRoster,
): T[];
/** @deprecated Name lists a caller filtered can drop a teen with no name: pass {@link teenRoster}. */
export function withoutTeenTitles<T extends { title: string | null; kidRelated: boolean }>(
  blocks: readonly T[],
  childNames: readonly string[],
  teenNames: readonly string[],
  /** The household's only child is 13+, even when that child has no name on file. */
  onlyChildIsTeen?: boolean,
): T[];
export function withoutTeenTitles<T extends { title: string | null; kidRelated: boolean }>(
  blocks: readonly T[],
  rosterOrNames: TeenRoster | readonly string[],
  teenNames: readonly string[] = [],
  onlyChildIsTeen = false,
): T[] {
  const roster: TeenRoster =
    'unnamedTeen' in rosterOrNames
      ? rosterOrNames
      : {
          childNames: [...rosterOrNames],
          teenNames: [...teenNames],
          size: rosterOrNames.length,
          unnamedTeen: onlyChildIsTeen && !teenNames.some((name) => name.trim().length >= 2),
        };
  const teens = roster.teenNames.map((name) => name.trim()).filter((name) => name.length >= 2);
  const namedTeens = (title: string) => {
    if (teens.length === 0) return false;
    const credited = splitKidEvent(title, roster.childNames)?.kid;
    return teenNameIn(title, teens) || (credited !== undefined && teenNameIn(credited, teens));
  };
  return blocks.map((block) => {
    const teen =
      (block.title ? namedTeens(block.title) : false) ||
      (block.kidRelated && unnamedTeenMayOwn(block.title, roster));
    return teen ? { ...block, title: null, kidRelated: false } : block;
  });
}
