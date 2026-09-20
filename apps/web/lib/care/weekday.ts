import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * HOW THIS HOUSEHOLD'S WEEKDAYS ARE COVERED — the fact, its flag, and its one
 * writer-pinned reader.
 *
 * Outside `lib/channel` deliberately. `writeFact` has five callers today and not
 * one of them is in that tree: the channel tree READS facts and delegates every
 * write outward, the way `stated-state.ts` does ("NO NEW WRITE PATH ... a second
 * DOOR to it, not a second writer"). The grammar that reads a parent's words lives
 * in lib/channel/weekday-care; the row it produces is written here.
 *
 * WHY A MEMORY FACT AND NOT A COLUMN ON `children`. The coach reads live facts for
 * the focused child into its own prompt with no new code (coach/context.ts), teen
 * redaction is already derived live off the date of birth there rather than from a
 * flag that goes stale on a birthday, and a child who moves from home to daycare in
 * September wants `writeFact`'s bi-temporal supersede rather than an overwrite on a
 * table with no history.
 *
 * WHICH MAKES THE WRITER PIN LOAD-BEARING. `fact_key` is free text with no registry
 * and the app coach's `save_memory` tool lets a model choose any key it likes under
 * `inferred_by: 'ask-hale'`, so the key alone proves nothing. Every reader here
 * matches the WRITER as well as the key, for the reason the registration ladder
 * states verbatim: "The WRITER is what makes a row trustworthy, never the key."
 */

/** The `family_memory_facts.fact_key` this feature owns. Never read without
 * {@link WEEKDAY_CARE_FACT_WRITER} beside it. */
export const WEEKDAY_CARE_FACT_KEY = 'weekday_care';

/** Stamped into `inferred_by` by the one writer, and REQUIRED by every reader. */
export const WEEKDAY_CARE_FACT_WRITER = 'weekday-care-reply';

/**
 * What a parent can settle about a weekday. The axis is what HALE DOES NEXT, not a
 * taxonomy of childcare: `home` means weekday-morning drop-ins are useful to this
 * household (a parent, a grandparent, a nanny - all the same to the finder),
 * `daycare` means they are not, and `starting_soon` means neither is true yet.
 */
export type WeekdayCare = 'home' | 'daycare' | 'starting_soon';

const WEEKDAY_CARE_VALUES: readonly WeekdayCare[] = ['home', 'daycare', 'starting_soon'];

export interface WeekdayCareFact {
  childId: string;
  care: WeekdayCare;
  /** The provider, only when the parent named one in so many words. Null is the
   * ordinary case and is never guessed at. */
  provider: string | null;
  /** When this became true — the turn the parent said it. */
  validFrom: Date;
}

export const WEEKDAY_CARE_ENABLED_ENV = 'WEEKDAY_CARE_ENABLED';

/**
 * Is the weekday-care behaviour armed?
 *
 * STRICT equality on the literal 'true', the discipline `f14Enabled` states and for
 * the same reason: `vercel env add` from a piped `echo` stores a TRAILING NEWLINE,
 * so a value that prints as `true` is really `'true\n'` and a truthiness check reads
 * that as ON.
 *
 * Its own flag rather than F14's, because the two answer different questions: F14
 * asks whether Hale may text this household unprompted at all, and this asks whether
 * this behaviour exists. The follow-up sweep reads its own third flag on top.
 */
export function weekdayCareEnabled(): boolean {
  return process.env[WEEKDAY_CARE_ENABLED_ENV] === 'true';
}

function parseFactValue(value: unknown): { care: WeekdayCare; provider: string | null } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const care = record.care;
  if (typeof care !== 'string' || !WEEKDAY_CARE_VALUES.includes(care as WeekdayCare)) return null;
  const provider = record.provider;
  return {
    care: care as WeekdayCare,
    provider: typeof provider === 'string' && provider.length > 0 ? provider : null,
  };
}

/**
 * Every live weekday-care fact this family holds, WRITER-PINNED — the only read.
 *
 * Three predicates, and dropping any one of them changes what it means: the KEY says
 * which question, the WRITER says whose answer to trust, and `valid_until IS NULL`
 * says the parent has not superseded it. A row written by `ask-hale` under the same
 * key is invisible here, and a test asserts exactly that.
 *
 * Family-wide rows (`child_id IS NULL`) are skipped rather than coerced: this fact is
 * about one child by construction, and a null-child row under this key is something
 * else wearing the name.
 */
export async function loadWeekdayCare(
  database: Database,
  familyId: string,
): Promise<WeekdayCareFact[]> {
  const rows = await database
    .select({
      childId: schema.familyMemoryFacts.childId,
      factValue: schema.familyMemoryFacts.factValue,
      validFrom: schema.familyMemoryFacts.validFrom,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        eq(schema.familyMemoryFacts.factKey, WEEKDAY_CARE_FACT_KEY),
        eq(schema.familyMemoryFacts.inferredBy, WEEKDAY_CARE_FACT_WRITER),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );

  return rows.flatMap((row) => {
    if (row.childId === null) return [];
    const parsed = parseFactValue(row.factValue);
    if (parsed === null) return [];
    return [{ childId: row.childId, ...parsed, validFrom: row.validFrom }];
  });
}
