import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { type ReplyLanguage, acceptReplyLanguage } from '~/lib/channel/language';

/**
 * VIL-572 · THE ONE LANGUAGE HALE WRITES TO A PARENT IN UNPROMPTED.
 *
 * A reply answers each text in the language that text came in; the coach reads the
 * parent's own words for that. Everything Hale sends on its own (follow-ups, reminders,
 * email alerts, check-ins) reads {@link readParentLanguage} or {@link parentLanguage}
 * instead, and that value moves only on purpose: the parent asks for a language, or
 * texts in another one {@link SUSTAINED_TEXTS} times in a row. One Chinese text among
 * twenty-two English ones once turned the next follow-up Chinese, because every
 * inbound text overwrote `users.locale`. Here a single text only starts a count.
 *
 * The tags are the inbound screen's. This code never reads the parent's words; it only
 * compares tags, by their primary subtag, so `en-US` and `en` are one language.
 */

/** Texts in a row, in one other language, that make it the parent's language. */
export const SUSTAINED_TEXTS = 3;

export interface StoredParentLanguage {
  /** `users.proactive_language`: null until the parent has set one. */
  proactiveLanguage: string | null;
  languageStreakTag: string | null;
  languageStreakCount: number;
}

/** The parent's stored language, else the family's, else English. */
export function parentLanguage(
  stored: string | null | undefined,
  familyPrimary: string | null | undefined,
): ReplyLanguage {
  return acceptReplyLanguage(stored) ?? acceptReplyLanguage(familyPrimary) ?? 'en';
}

function primarySubtag(tag: ReplyLanguage): string {
  return tag.split('-')[0] as string;
}

function sameLanguage(a: ReplyLanguage, b: ReplyLanguage): boolean {
  return primarySubtag(a) === primarySubtag(b);
}

export type LanguageStep =
  /** The screen read no tag off this text. Nothing moves. */
  | { kind: 'unread'; next: StoredParentLanguage }
  /** The text was in the parent's language (or asked for it). Any run is over. */
  | { kind: 'kept'; next: StoredParentLanguage }
  /** The text was in another language, and the run is not long enough yet. */
  | { kind: 'counting'; next: StoredParentLanguage }
  | {
      kind: 'switched';
      from: ReplyLanguage;
      to: ReplyLanguage;
      why: 'asked' | 'sustained';
      next: StoredParentLanguage;
    };

/** What one inbound text does to the stored language. Pure. */
export function stepParentLanguage(
  stored: StoredParentLanguage,
  familyPrimary: string | null,
  reading: { seen: string | null; requested: string | null },
): LanguageStep {
  const current = parentLanguage(stored.proactiveLanguage, familyPrimary);
  const settled = (language: ReplyLanguage | null): StoredParentLanguage => ({
    proactiveLanguage: language,
    languageStreakTag: null,
    languageStreakCount: 0,
  });

  const requested = acceptReplyLanguage(reading.requested);
  if (requested !== null) {
    if (sameLanguage(requested, current)) return { kind: 'kept', next: settled(requested) };
    return {
      kind: 'switched',
      from: current,
      to: requested,
      why: 'asked',
      next: settled(requested),
    };
  }

  const seen = acceptReplyLanguage(reading.seen);
  if (seen === null) return { kind: 'unread', next: stored };
  if (sameLanguage(seen, current)) {
    return { kind: 'kept', next: settled(stored.proactiveLanguage) };
  }

  const runTag = acceptReplyLanguage(stored.languageStreakTag);
  const count = runTag !== null && sameLanguage(runTag, seen) ? stored.languageStreakCount + 1 : 1;
  if (count >= SUSTAINED_TEXTS) {
    return { kind: 'switched', from: current, to: seen, why: 'sustained', next: settled(seen) };
  }
  return {
    kind: 'counting',
    next: {
      proactiveLanguage: stored.proactiveLanguage,
      languageStreakTag: seen,
      languageStreakCount: count,
    },
  };
}

/** The language every unprompted message to this parent is written in. */
export async function readParentLanguage(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<ReplyLanguage> {
  const [user, family] = await Promise.all([
    database
      .select({ proactiveLanguage: schema.users.proactiveLanguage })
      .from(schema.users)
      .where(eq(schema.users.id, input.parentUserId))
      .limit(1),
    database
      .select({ primaryLanguage: schema.families.primaryLanguage })
      .from(schema.families)
      .where(eq(schema.families.id, input.familyId))
      .limit(1),
  ]);
  return parentLanguage(user[0]?.proactiveLanguage, family[0]?.primaryLanguage);
}

export type LanguageObservation =
  | { status: 'unread' | 'kept' | 'counting' }
  | { status: 'switched'; why: 'asked' | 'sustained' }
  | { status: 'not_written'; reason: 'user_missing' | 'write_failed' };

/**
 * Apply one inbound text's tags to the parent's stored language.
 *
 * A switch writes an audit row in the same transaction. The row is about one adult, so
 * History and the family export leave it out (trail/verbs.ts, rights/export.ts). It
 * never throws: a failed write must not cost the parent their reply (rule #11), and it
 * comes back named instead.
 */
export async function observeParentLanguage(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    seen: string | null;
    requested: string | null;
  },
): Promise<LanguageObservation> {
  try {
    return await database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      const [user] = await tx
        .select({
          proactiveLanguage: schema.users.proactiveLanguage,
          languageStreakTag: schema.users.languageStreakTag,
          languageStreakCount: schema.users.languageStreakCount,
        })
        .from(schema.users)
        .where(eq(schema.users.id, input.parentUserId))
        .limit(1);
      if (!user) return { status: 'not_written', reason: 'user_missing' } as const;
      const [family] = await tx
        .select({ primaryLanguage: schema.families.primaryLanguage })
        .from(schema.families)
        .where(eq(schema.families.id, input.familyId))
        .limit(1);

      const step = stepParentLanguage(user, family?.primaryLanguage ?? null, input);
      const moved =
        step.next.proactiveLanguage !== user.proactiveLanguage ||
        step.next.languageStreakTag !== user.languageStreakTag ||
        step.next.languageStreakCount !== user.languageStreakCount;
      if (moved) {
        await tx
          .update(schema.users)
          .set({ ...step.next, updatedAt: new Date() })
          .where(eq(schema.users.id, input.parentUserId));
      }
      if (step.kind !== 'switched') return { status: step.kind };
      await tx.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.parentUserId,
        actionTaken: 'parent_language_changed',
        targetTable: 'users',
        targetId: input.parentUserId,
        before: { language: step.from },
        after: { language: step.to, why: step.why },
      });
      return { status: 'switched', why: step.why } as const;
    });
  } catch (err) {
    // The driver's message can echo the statement; it holds tags, never the parent's words.
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'parent language: write failed',
    );
    return { status: 'not_written', reason: 'write_failed' };
  }
}
