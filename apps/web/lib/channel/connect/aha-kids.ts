import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { type AhaSnapshot, calendarOverlaps } from './aha-read';

/**
 * Hard rule (Barton, VIL-417). Both wow moments are about the kids only.
 *
 * The connect-time read returns whatever the parent's calendar or mailbox
 * holds: their meetings, appointments, receipts, newsletters. None of that is
 * Hale's to mention. Before the snapshot reaches the model, this module keeps
 * only the items that are matched to the kids or to kid activities, and
 * recomputes overlaps from that subset so a clash is a clash between kid
 * activities, never with a parent's meeting. When nothing kid-related is
 * left, the read is `none_for_kids` and the model writes a plain receipt.
 *
 * The match is a whitelist over third-party data, not a read of the parent's
 * words. The exact-title check in friend-voice.ts still runs on the result.
 */

export interface KidContext {
  /** The kids' first names as stored. */
  childNames: readonly string[];
  /** Titles of activities Hale found for this family. */
  activityTitles: readonly string[];
}

/**
 * Words that mark a calendar or mail item as a kid activity in either
 * language. Health, money, school discipline and the parent's own work are
 * not in this list on purpose: a match here is permission to mention. Words a
 * parent's own calendar uses too (gym, team, practice, registration, class)
 * are left out: a kid item carrying only those is matched by the kid's name
 * or by an activity Hale already found, not by the word.
 */
const KID_ACTIVITY_WORDS: readonly string[] = [
  'swim',
  'swimming',
  'natation',
  'piscine',
  'soccer',
  'football',
  'hockey',
  'skating',
  'skate',
  'patin',
  'patinage',
  'gymnastics',
  'gymnastique',
  'dance',
  'danse',
  'ballet',
  'music',
  'musique',
  'piano',
  'violin',
  'violon',
  'guitar',
  'guitare',
  'choir',
  'chorale',
  'art class',
  'camp',
  'day camp',
  'pa day',
  'pa-day',
  'march break',
  'summer camp',
  'school',
  'école',
  'ecole',
  'daycare',
  'garderie',
  'preschool',
  'prematernelle',
  'prématernelle',
  'kindergarten',
  'maternelle',
  'earlyon',
  'story time',
  'storytime',
  "l'heure du conte",
  'heure du conte',
  'library',
  'bibliothèque',
  'bibliotheque',
  'playgroup',
  'play group',
  'drop-in',
  'splash pad',
  'zoo',
  'aquarium',
  'museum',
  'musée',
  'musee',
  'farm',
  'ferme',
  'scouts',
  'beavers',
  'cubs',
  'guides',
  'sparks',
  'brownies',
  'kids',
  'children',
  'enfants',
  'toddler',
  'tout-petit',
  'baby',
  'bébé',
  'bebe',
  'school trip',
  'field trip',
  'sortie scolaire',
  'after-school',
  'after school',
  'parascolaire',
  'french class',
  'mandarin',
  'chinese class',
  'tutoring',
  'tutorat',
];

function normalize(value: string | null | undefined): string {
  return (value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function wordsOf(value: string): string[] {
  return normalize(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);
}

const WORD_LIST = KID_ACTIVITY_WORDS.map(normalize);

function mentionsKidWord(text: string): boolean {
  const haystack = ` ${normalize(text).replace(/[^\p{L}\p{N}']+/gu, ' ')} `;
  return WORD_LIST.some(
    (word) => haystack.includes(` ${word} `) || haystack.includes(` ${word}s `),
  );
}

function mentionsName(text: string, names: readonly string[]): boolean {
  const haystack = ` ${normalize(text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return names.some((name) => {
    const clean = normalize(name).trim();
    return clean.length >= 2 && haystack.includes(` ${clean} `);
  });
}

/** Two words of four letters or more shared with a known activity title. One word is a coincidence. */
function matchesActivity(text: string, titles: readonly string[]): boolean {
  const words = new Set(wordsOf(text));
  if (words.size === 0) return false;
  return titles.some((title) => {
    const shared = wordsOf(title).filter((word) => words.has(word));
    return new Set(shared).size >= 2;
  });
}

/** True when this text is about a kid or a kid activity. */
export function isKidRelated(text: string, context: KidContext): boolean {
  if (text.trim().length === 0) return false;
  return (
    mentionsName(text, context.childNames) ||
    matchesActivity(text, context.activityTitles) ||
    mentionsKidWord(text)
  );
}

/**
 * The snapshot with every parent-only item removed. Items the read never
 * produced (failed, withheld) pass through unchanged, since there is nothing
 * to filter and the read state already says why.
 */
export function kidRelatedAha(snapshot: AhaSnapshot, context: KidContext): AhaSnapshot {
  if (snapshot.read === 'failed' || snapshot.read === 'withheld') return snapshot;
  const calendar = snapshot.calendar.filter((item) =>
    isKidRelated([item.title, item.location ?? ''].join(' '), context),
  );
  const email = snapshot.email.filter((item) =>
    isKidRelated([item.subject, item.fromName ?? '', item.snippet ?? ''].join(' '), context),
  );
  const hadItems = snapshot.calendar.length > 0 || snapshot.email.length > 0;
  const kept = calendar.length > 0 || email.length > 0;
  return {
    ...snapshot,
    calendar,
    email,
    overlaps: calendarOverlaps(calendar),
    read: kept ? snapshot.read : hadItems ? 'none_for_kids' : snapshot.read,
  };
}

/**
 * What the family already told Hale about the kids: names and the activities
 * Hale found for them. Read once per receipt. The family calendar is not read
 * here on purpose: it is a named privacy door (teen rows), and the found
 * activities are vocabulary enough.
 */
export async function loadKidContext(database: Database, familyId: string): Promise<KidContext> {
  const children = await database
    .select({ familyId: schema.children.familyId, name: schema.children.name })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const candidates = await database
    .select({ familyId: schema.villageCandidates.familyId, title: schema.villageCandidates.title })
    .from(schema.villageCandidates)
    .where(
      and(
        eq(schema.villageCandidates.familyId, familyId),
        isNull(schema.villageCandidates.supersededAt),
      ),
    );
  const own = <T extends { familyId: string }>(rows: T[]) =>
    rows.filter((row) => row.familyId === familyId);
  return {
    childNames: own(children)
      .map((row) => row.name ?? '')
      .filter((name) => name.trim().length > 0),
    activityTitles: own(candidates)
      .map((row) => row.title)
      .filter((title): title is string => typeof title === 'string' && title.trim().length > 0),
  };
}
