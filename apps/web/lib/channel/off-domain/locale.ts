import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';

/**
 * Store the language the inbound screen read, on the parent who wrote it.
 *
 * The screen already saw the message. This function never sees it, and it does not
 * decide what language that message was: the tag arrives as a string and is stored
 * as that string. Trim only. No allowlist, no case-fold, no pattern.
 *
 * A blank tag, a tag that already matches, and a write that cannot land are each
 * named and none of them throws. A failed write must not cost the parent their
 * reply (rule #11).
 */
export type LocaleWrite =
  | { status: 'updated'; from: string; to: string }
  | { status: 'unchanged' }
  | { status: 'blank' }
  | { status: 'not_written'; reason: 'write_failed' | 'user_missing' };

export async function rememberParentLanguage(
  database: Database,
  parentUserId: string,
  language: string,
): Promise<LocaleWrite> {
  const tag = language.trim();
  if (tag === '') return { status: 'blank' };
  try {
    const rows = await database
      .select({ locale: schema.users.locale })
      .from(schema.users)
      .where(eq(schema.users.id, parentUserId))
      .limit(1);
    const row = rows[0];
    if (!row) return { status: 'not_written', reason: 'user_missing' };
    if (row.locale === tag) return { status: 'unchanged' };
    await database
      .update(schema.users)
      .set({ locale: tag })
      .where(eq(schema.users.id, parentUserId));
    return { status: 'updated', from: row.locale, to: tag };
  } catch (err) {
    // The driver's message can echo the statement. The parent's message is not in
    // this function, and the tag is not added to the log line (rule #1).
    console.error(
      { err: err instanceof Error ? err.message : 'unknown' },
      'parent language: write failed',
    );
    return { status: 'not_written', reason: 'write_failed' };
  }
}
