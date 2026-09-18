import { type Database, schema } from '@hale/db';
import { lte } from 'drizzle-orm';

/**
 * VIL-353 · THE DAY NOTE — the parent's own sentence about their evening, and the two
 * rules that bound it.
 *
 * WHERE IT LIVES. Its own table (`family_check_in_notes`), not `family_memory_facts`.
 * The fact store is the shared memory the coach's tools read and hand to a model, and
 * rule #1 says a parent's unedited words about their household never reach a shared,
 * teen- or caregiver-readable surface. A `visibility` column on the shared table would
 * make that a rule every future reader has to remember; a table nothing else reads makes
 * it unexpressible. (It also cannot hold this data: no expiry column, and one live row
 * per key would have each evening supersede the last.)
 *
 * HOW LONG IT LIVES. Thirty days, stamped on the row at write time. Law 25 requires
 * destruction once the purpose is achieved, and the purpose of the RAW words is the
 * synthesis pass that will promote a durable fact out of them (VIL-354) — which does not
 * need the sentence a month later. The stamp is on the row rather than derived from a
 * constant so that shortening the constant later cannot extend the life of data already
 * collected.
 */

/** How long a parent's raw words are kept. */
export const NOTE_RETENTION_DAYS = 30;

const RETENTION_MS = NOTE_RETENTION_DAYS * 24 * 3_600_000;

/**
 * THE CATEGORIES HALE DOES NOT WRITE DOWN, even when a parent volunteers them.
 *
 * Anthropic's own memory defaults never extract health, race, religion, politics or
 * gender identity; Hale adds therapy, custody and legal, immigration and money. A day
 * note is the one place in this product where a parent types freely into a store, so it
 * is the one place that needs the screen.
 *
 * WHAT THIS IS AND IS NOT. It is a deterministic FLOOR, not a classifier — it catches the
 * explicit markers and nothing subtle, and a sentence that slips past it is still bounded
 * by the two structural guarantees above (a table nothing shares, thirty days). Reading
 * the sentence with a model to judge it better would mean sending exactly the content we
 * have decided not to keep to a third party in order to decide not to keep it.
 *
 * IT ERRS TOWARD REFUSING. A toddler's fever is health data about a child, and the cost
 * of refusing to store it is one evening Hale does not remember; the cost of storing it
 * is a category rule #1 says we do not hold. The words are grouped only so the list is
 * reviewable — which category matched is never logged, audited or said back to the
 * parent, because naming it would repeat the thing we just declined to keep.
 *
 * IT READS FRENCH TOO, and that is not a nicety. Hale answers in French wherever the
 * parent writes it, so an English-only screen would be a privacy floor that exists for
 * anglophone households and not for the Quebec ones Law 25 is written for. The entries
 * are spelled WITHOUT accents because `normalize` folds them first.
 */
const NOT_KEPT: Record<string, readonly string[]> = {
  health: [
    'diagnosis',
    'diagnosed',
    'symptom',
    'symptoms',
    'fever',
    'sick',
    'vomit',
    'vomited',
    'throwing up',
    'threw up',
    'rash',
    'seizure',
    'asthma',
    'allergic',
    'allergy',
    'medication',
    'meds',
    'prescription',
    'antibiotics',
    'hospital',
    'emergency room',
    'urgent care',
    'doctor',
    'paediatrician',
    'pediatrician',
    'autism',
    'autistic',
    'adhd',
    'depression',
    'depressed',
    'anxiety',
    'fievre',
    'malade',
    'vomi',
    'diagnostic',
    'medicament',
    'medicaments',
    'ordonnance',
    'hopital',
    'urgences',
    'medecin',
    'pediatre',
    'allergie',
    'asthme',
    'anxiete',
  ],
  therapy: [
    'therapy',
    'therapist',
    'counselling',
    'counseling',
    'psychiatrist',
    'psychologist',
    'therapie',
    'therapeute',
    'psychologue',
    'psychiatre',
  ],
  race: ['race', 'racial', 'ethnicity', 'ethnic', 'racisme', 'ethnie'],
  religion: [
    'religion',
    'religious',
    'church',
    'mosque',
    'synagogue',
    'temple',
    'baptism',
    'religieux',
    'eglise',
    'mosquee',
    'bapteme',
  ],
  politics: ['politics', 'political', 'election', 'voted', 'voting', 'politique', 'vote'],
  gender_identity: [
    'transgender',
    'nonbinary',
    'non binary',
    'gender identity',
    'transgenre',
    'non binaire',
    'identite de genre',
  ],
  custody_legal: [
    'custody',
    'divorce',
    'separation',
    'lawyer',
    'solicitor',
    'court',
    'restraining order',
    'child protection',
    'avocat',
    'tribunal',
    'garde partagee',
    'protection de la jeunesse',
  ],
  immigration: [
    'immigration',
    'visa',
    'permanent residency',
    'deportation',
    'asylum',
    'refugee',
    'residence permanente',
    'refugie',
    'asile',
  ],
  money: [
    'salary',
    'income',
    'rent',
    'mortgage',
    'debt',
    'overdraft',
    'bankrupt',
    'eviction',
    'laid off',
    'fired',
    'salaire',
    'loyer',
    'hypotheque',
    'dette',
    'dettes',
    'licencie',
    'expulsion',
  ],
};

/** Every phrase in one flat list, built once. */
const NOT_KEPT_PHRASES: readonly string[] = Object.values(NOT_KEPT).flat();

/**
 * Lowercased, accent-folded, and everything that is not a letter or digit reduced to a
 * single space, with a space at each end so a phrase match is always a WHOLE-word match.
 * 'ok' must not fire on 'smoked', and 'race' must not fire on 'braces'.
 */
function normalize(body: string): string {
  return ` ${body
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/** Whether this is one of the things Hale does not write down. */
export function isNotKept(body: string): boolean {
  const haystack = normalize(body);
  return NOT_KEPT_PHRASES.some((phrase) => haystack.includes(` ${phrase} `));
}

/** The query surface a note write needs — satisfied by both `Database` and a tx. */
export type NoteWriter = Pick<Database, 'insert'>;

/**
 * Keep what the parent said about one local day.
 *
 * UPSERT ON THE DAY, because a parent who answers twice is correcting themselves, not
 * writing a second evening — and because the ack that closes the question can fail to
 * send, which leaves the question standing and a second answer possible.
 */
export async function storeCheckInNote(
  writer: NoteWriter,
  input: {
    familyId: string;
    parentUserId: string;
    sourceMessageId: string;
    notedOn: string;
    note: string;
    now: Date;
  },
): Promise<void> {
  const expiresAt = new Date(input.now.getTime() + RETENTION_MS);
  await writer
    .insert(schema.familyCheckInNotes)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      sourceMessageId: input.sourceMessageId,
      notedOn: input.notedOn,
      note: input.note,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [schema.familyCheckInNotes.familyId, schema.familyCheckInNotes.notedOn],
      set: {
        parentUserId: input.parentUserId,
        sourceMessageId: input.sourceMessageId,
        note: input.note,
        expiresAt,
      },
    });
}

/**
 * Destroy every note past its thirty days, and report how many.
 *
 * IT RIDES THE DELETE SWEEP rather than the evening cron, and the placement is the point:
 * the F14 dark-launch flag can be turned off, and a retention promise that stops being
 * kept when a feature flag flips is not a retention promise. The erasure cron runs
 * whatever else is armed.
 */
export async function purgeExpiredCheckInNotes(
  database: Database,
  now: Date = new Date(),
): Promise<number> {
  const purged = await database
    .delete(schema.familyCheckInNotes)
    .where(lte(schema.familyCheckInNotes.expiresAt, now))
    .returning({ id: schema.familyCheckInNotes.id });
  return purged.length;
}
