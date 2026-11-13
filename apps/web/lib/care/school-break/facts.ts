import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { HALE_RECORD, writeFact } from '~/lib/memory/facts';
import type { BreakDay } from './read';

/**
 * VIL-685 · THIS FAMILY'S WINTER BREAK — the fact, its writers, and its one reader.
 *
 * One live row per family: `writeFact`'s identity is (family, no child, logistic, key),
 * so the school's page, the school's email and the parent's own words supersede each
 * other. The parent wins: the sweep never writes over a parent's answer, and a parent's
 * answer always replaces the school's.
 *
 * Every row carries its source: the school's page URL and the page words each day stands
 * on, the school email's own words (with the host it authenticated as), or the parent's
 * own words. A row without one is never written. `name` is the break's name as the page
 * or the email printed it, or as the parent said it; a parent who gave no name leaves it
 * null, and nothing here makes one up.
 *
 * WRITER-PINNED, like the weekday-care fact: `fact_key` is free text, so every read
 * matches the writer as well as the key.
 */

export const SCHOOL_BREAK_FACT_KEY = 'school_winter_break';
/** The sweep, from the school's own calendar page or the school's own email. */
export const SCHOOL_BREAK_BOARD_WRITER = 'school-break-board';
/** The reply to Hale's one question, from the parent's own words. */
export const SCHOOL_BREAK_REPLY_WRITER = 'school-break-reply';

const WRITERS = [SCHOOL_BREAK_BOARD_WRITER, SCHOOL_BREAK_REPLY_WRITER] as const;

const valueSchema = z.object({
  schoolYear: z.string(),
  name: z.string().nullable(),
  firstDay: z.string(),
  lastDay: z.string(),
  source: z.enum(['board_page', 'school_email', 'parent']),
  sourceUrl: z.string().nullable(),
  boardHost: z.string().nullable(),
  quotes: z.array(z.string()).min(1),
});

export type SchoolBreakFactValue = z.infer<typeof valueSchema>;

export interface SchoolBreakFact extends SchoolBreakFactValue {
  factId: string;
}

/**
 * The live break this family holds for `schoolYear`, or null. A row from another school
 * year is not this winter's break, and a row whose value does not parse is skipped:
 * a writer here never writes one, so it is something else wearing the key.
 */
export async function loadSchoolBreak(
  database: Database,
  familyId: string,
  schoolYear: string,
): Promise<SchoolBreakFact | null> {
  const rows = await database
    .select({ factId: schema.familyMemoryFacts.id, factValue: schema.familyMemoryFacts.factValue })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        isNull(schema.familyMemoryFacts.childId),
        eq(schema.familyMemoryFacts.factKey, SCHOOL_BREAK_FACT_KEY),
        inArray(schema.familyMemoryFacts.inferredBy, [...WRITERS]),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );
  for (const row of rows) {
    const parsed = valueSchema.safeParse(row.factValue);
    if (parsed.success && parsed.data.schoolYear === schoolYear) {
      return { factId: row.factId, ...parsed.data };
    }
  }
  return null;
}

export type SchoolBreakWrite =
  | {
      source: 'board_page';
      familyId: string;
      schoolYear: string;
      name: string;
      firstDay: BreakDay;
      lastDay: BreakDay;
      sourceUrl: string;
      boardHost: string;
      now: Date;
    }
  | {
      source: 'school_email';
      familyId: string;
      schoolYear: string;
      name: string;
      firstDay: BreakDay;
      lastDay: BreakDay;
      /** The host the email authenticated as. */
      boardHost: string;
      now: Date;
    }
  | {
      source: 'parent';
      familyId: string;
      parentUserId: string;
      schoolYear: string;
      /** The parent's own name for it, or null when they gave none. */
      name: string | null;
      firstDay: string;
      lastDay: string;
      /** The parent's own words the days were read from. */
      quote: string;
      now: Date;
    };

/**
 * THE ONE WRITER. Audit row first, then the fact, in one transaction (rule #6). The audit
 * carries the days and the source kind, never the parent's words: `audit_log` is immutable
 * and exportable, and the words stay in the one family-scoped fact row.
 */
export async function recordSchoolBreak(
  database: Database,
  write: SchoolBreakWrite,
): Promise<void> {
  const value: SchoolBreakFactValue =
    write.source !== 'parent'
      ? {
          schoolYear: write.schoolYear,
          name: write.name,
          firstDay: write.firstDay.date,
          lastDay: write.lastDay.date,
          source: write.source,
          sourceUrl: write.source === 'board_page' ? write.sourceUrl : null,
          boardHost: write.boardHost,
          quotes: [...new Set([write.firstDay.quote, write.lastDay.quote])],
        }
      : {
          schoolYear: write.schoolYear,
          name: write.name,
          firstDay: write.firstDay,
          lastDay: write.lastDay,
          source: 'parent',
          sourceUrl: null,
          boardHost: null,
          quotes: [write.quote],
        };
  await database.transaction(async (tx) => {
    await tx.insert(schema.auditLog).values({
      familyId: write.familyId,
      actor: write.source === 'parent' ? write.parentUserId : 'system',
      actionTaken: 'school_break_recorded',
      targetTable: 'family_memory_facts',
      targetId: write.familyId,
      after: {
        source: value.source,
        schoolYear: value.schoolYear,
        firstDay: value.firstDay,
        lastDay: value.lastDay,
        ...(value.sourceUrl ? { sourceUrl: value.sourceUrl } : {}),
      },
    });
    await writeFact(tx, {
      familyId: write.familyId,
      childId: null,
      factType: 'logistic',
      factKey: SCHOOL_BREAK_FACT_KEY,
      factValue: value,
      confidence: 1,
      inferredBy: write.source === 'parent' ? SCHOOL_BREAK_REPLY_WRITER : SCHOOL_BREAK_BOARD_WRITER,
      heard:
        write.source === 'parent' ? { in: 'one_to_one', userId: write.parentUserId } : HALE_RECORD,
      validFrom: write.now,
    });
  });
}
