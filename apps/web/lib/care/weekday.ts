import { type Database, schema } from '@hale/db';
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY } from '~/lib/channel/intake/radar';
import { CONSUMED_SEND_STATUSES, SENT_STATUSES } from '~/lib/channel/ledger';
import { proactiveNudgeTemplateKey } from '~/lib/channel/nudge/shell';
import { eventKeyFromWeekdayBreakDedupe } from '~/lib/channel/weekday-care/key';
import { writeFact } from '~/lib/memory/facts';

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

/** The ledger row that proves this household has been asked the fallback (or a legacy
 * care ask). Its own constant because the send stamps it and three readers query for it. */
export const WEEKDAY_CARE_ASK_TEMPLATE_KEY = proactiveNudgeTemplateKey('weekday_care');

/** Ask-once for the after-school prompt. Distinct from the fallback so an old care
 * ask does not permanently block a later school-age ask. */
export const WEEKDAY_AFTER_SCHOOL_TEMPLATE_KEY = proactiveNudgeTemplateKey('weekday_after_school');

/** Ask-once per verified break event. The event key lives in the dedupe key. */
export const WEEKDAY_BREAK_TEMPLATE_KEY = proactiveNudgeTemplateKey('weekday_break');

/**
 * A school break or PA day Hale may name. Production has no school-calendar source,
 * so {@link loadVerifiedSchoolBreak} returns none of these. Tests inject one.
 */
export interface VerifiedSchoolBreak {
  /** Colon-free, and it ends with the verified ISO date (`pa-day-2026-10-09`). */
  eventKey: string;
  /** The event's own name: `PA day`, `March break`. Never invented here. */
  label: string;
  /** Family-local day key the source verified. */
  date: string;
  source: 'school_calendar' | 'connected_calendar' | 'connected_email' | 'known_booking';
}

/** Why production cannot name a PA day or a local break. */
export const NO_VERIFIED_SCHOOL_CALENDAR = 'no_verified_school_calendar' as const;

/**
 * There is no school-calendar, connected-calendar, or booking source for a PA day
 * or a break in this codebase. Absence is the result, named, not a guessed date.
 */
export function loadVerifiedSchoolBreak(): {
  break: null;
  reason: typeof NO_VERIFIED_SCHOOL_CALENDAR;
} {
  return { break: null, reason: NO_VERIFIED_SCHOOL_CALENDAR };
}

/** The weather swap's row — one of the two D23 anchors. */
const WEATHER_SWAP_TEMPLATE_KEY = proactiveNudgeTemplateKey('weather_swap');

export interface WeekdayCareFact {
  /** The row's own id. A reader asking "is this still the answer?" can only settle it
   * by IDENTITY: a family that changes daycare says `daycare` twice, so the word is
   * unchanged while the answer underneath it is a different row. */
  factId: string;
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
      factId: schema.familyMemoryFacts.id,
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
    return [{ factId: row.factId, childId: row.childId, ...parsed, validFrom: row.validFrom }];
  });
}

/**
 * WHAT THE WEEKDAY LEGS KNOW ABOUT THIS HOUSEHOLD — the facts it has stated, and the
 * two ledger questions the ask's preconditions rest on.
 */
export interface WeekdayCareContext {
  /** Every live, writer-pinned weekday-care fact. Empty means "nobody has told us",
   * never "they said no". */
  stated: readonly WeekdayCareFact[];
  /** Has the fallback (or a legacy care ask) ever gone out to this family? */
  askedBefore: boolean;
  /** Has the after-school ask ever gone out? Absent on older fixtures means no. */
  askedAfterSchool?: boolean;
  /** Verified-break event keys already attempted. Absent means none. */
  askedBreakKeys?: readonly string[];
  /**
   * A verified upcoming break, or null/absent when none is on file. Production
   * leaves this null: {@link loadVerifiedSchoolBreak} has no source to read.
   */
  verifiedBreak?: VerifiedSchoolBreak | null;
  /** Has Hale ever sent this family a weekend find? */
  weekendFindSent: boolean;
}

type SendStatus = (typeof CONSUMED_SEND_STATUSES)[number];

async function anySendWith(
  database: Database,
  familyId: string,
  templateKeys: readonly string[],
  statuses: readonly SendStatus[],
): Promise<boolean> {
  const rows = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.templateKey, [...templateKeys]),
        inArray(schema.channelMessages.status, [...statuses]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The whole weekday-care picture for one family, in three reads.
 *
 * THE TWO STATUS SETS ARE DIFFERENT, AND THAT IS THE DESIGN.
 *
 * `askedBefore` counts a FAILED send, because the dedupe key it consumed is permanent:
 * an ask that read as unasked would be re-decided on every tick and then swallowed by
 * `dedupeActive` (which does count `failed`), so the family would show as `deduped`
 * forever and never as `already_asked`. One ask per household ever means one ATTEMPT.
 *
 * `weekendFindSent` does NOT, because it is a claim about what the parent has read.
 * "Those are weekend options" is false if the only weekend find Hale ever composed
 * never reached the phone, and D23 does not let Hale anchor a question on a send that
 * did not happen. A verified break is a different anchor and does not use this flag.
 */
export async function loadWeekdayCareContext(
  database: Database,
  familyId: string,
): Promise<WeekdayCareContext> {
  const schoolCalendar = loadVerifiedSchoolBreak();
  const [stated, askedBefore, askedAfterSchool, askedBreakKeys, weekendFindSent] =
    await Promise.all([
      loadWeekdayCare(database, familyId),
      anySendWith(database, familyId, [WEEKDAY_CARE_ASK_TEMPLATE_KEY], CONSUMED_SEND_STATUSES),
      anySendWith(database, familyId, [WEEKDAY_AFTER_SCHOOL_TEMPLATE_KEY], CONSUMED_SEND_STATUSES),
      breakKeysAsked(database, familyId),
      anySendWith(
        database,
        familyId,
        [WEATHER_SWAP_TEMPLATE_KEY, INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY],
        SENT_STATUSES,
      ),
    ]);
  return {
    stated,
    askedBefore,
    askedAfterSchool,
    askedBreakKeys,
    verifiedBreak: schoolCalendar.break,
    weekendFindSent,
  };
}

async function breakKeysAsked(database: Database, familyId: string): Promise<string[]> {
  const rows = await database
    .select({ dedupeKey: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.templateKey, WEEKDAY_BREAK_TEMPLATE_KEY),
        inArray(schema.channelMessages.status, [...CONSUMED_SEND_STATUSES]),
      ),
    );
  const keys: string[] = [];
  for (const row of rows) {
    const eventKey = eventKeyFromWeekdayBreakDedupe(row.dedupeKey);
    if (eventKey !== null) keys.push(eventKey);
  }
  return keys;
}

/** What the write did. One shape, and the audit row's `after` is built from it. */
export interface WeekdayCareWriteOutcome {
  status: 'recorded';
  care: WeekdayCare;
  /** Whether a provider was named, and NEVER the name. `audit_log` is immutable and
   * PIPEDA-exportable and has none of the teen redaction a fact read has. */
  providerNamed: boolean;
}

/**
 * THE ONE WRITER. Audit row FIRST, then the fact, in ONE transaction — the shape
 * `recordCheckpointDone` uses, for the reason it states: a permanent state change that
 * landed without its trail is what rule #6 admits no exception to.
 *
 * THE AUDIT TARGET IS THE FAMILY, NOT THE FACT. `writeFact` returns its id only after
 * the insert, so "audit first" and "point the audit at the new fact" cannot both be
 * true. `recordCheckpointDone` resolved this before us and its answer is the one to
 * copy: `targetTable` names the table, `targetId` names the family. Atomicity is the
 * invariant; the ORDER inside one transaction is not, and the row an audit points at
 * does not have to be a row that did not exist yet. The child is recoverable from the
 * fact, and the ask cannot name a teen in the first place.
 *
 * `confidence: 1` — the parent said it in these words, which is what the
 * `CONFIDENCE_FLOOR` exists to distinguish from a hunch.
 */
export async function recordWeekdayCare(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    childId: string;
    care: WeekdayCare;
    provider: string | null;
    now: Date;
  },
): Promise<WeekdayCareWriteOutcome> {
  const providerNamed = input.provider !== null;
  await database.transaction(async (tx) => {
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'weekday_care_recorded',
      targetTable: 'family_memory_facts',
      targetId: input.familyId,
      // Enum-shaped provenance only. The provider string stays in the one family-scoped
      // fact row it was written to.
      after: { care: input.care, providerNamed, source: 'sms_reply' },
    });
    // A parent can answer twice, and a child moves from home to daycare in September.
    // Superseding rather than appending is what keeps one live row per child and what
    // records WHEN it became true.
    await writeFact(tx, {
      familyId: input.familyId,
      childId: input.childId,
      factType: 'logistic',
      factKey: WEEKDAY_CARE_FACT_KEY,
      factValue: { care: input.care, provider: input.provider },
      confidence: 1,
      inferredBy: WEEKDAY_CARE_FACT_WRITER,
      validFrom: input.now,
    });
  });
  return { status: 'recorded', care: input.care, providerNamed };
}

/** A `daycare` answer old enough to ask about. The fact's OWN id, because the follow-up's
 * audit row points at the row it asked about — that row exists before the ask does, so
 * unlike the write above, this one can name it. */
export interface DaycareSubject {
  factId: string;
  childId: string;
  provider: string | null;
  /** When the parent said it — the follow-up window's anchor. */
  validFrom: Date;
}

/**
 * The daycare answers this family gave inside a window, SUPERSEDED ONES INCLUDED.
 *
 * Deliberately not filtered to live rows, and that is what makes `care_changed`
 * observable: a parent who said "daycare" on Monday and "she's home again" on Thursday
 * has a candidate whose window is open and whose answer has moved on, and a reader that
 * only returned live rows would drop it silently. The caller compares against
 * {@link loadWeekdayCare} and counts the difference.
 */
export async function loadDaycareSubjects(
  database: Database,
  familyId: string,
  window: { floor: Date; latest: Date },
): Promise<DaycareSubject[]> {
  const rows = await database
    .select({
      factId: schema.familyMemoryFacts.id,
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
        gte(schema.familyMemoryFacts.validFrom, window.floor),
        lte(schema.familyMemoryFacts.validFrom, window.latest),
      ),
    )
    .orderBy(asc(schema.familyMemoryFacts.validFrom));

  return rows.flatMap((row) => {
    if (row.childId === null) return [];
    const parsed = parseFactValue(row.factValue);
    if (parsed === null || parsed.care !== 'daycare') return [];
    return [
      {
        factId: row.factId,
        childId: row.childId,
        provider: parsed.provider,
        validFrom: row.validFrom,
      },
    ];
  });
}
