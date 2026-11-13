import { type Database, schema } from '@hale/db';
import { GARBLED_TEXT, LinqSendError } from '~/lib/channel/linq/transport';

/**
 * VIL-683 · The send seam (linq/transport.ts) refused a garbled text. Its writer was
 * already asked once more, so this is the second garbled draft: nothing was sent and
 * nothing stands in for it.
 */
export function isGarbledRefusal(err: unknown): err is LinqSendError {
  return err instanceof LinqSendError && err.code === GARBLED_TEXT;
}

/**
 * The refusal on the family's audit trail (rule #6): where it was refused and why, never
 * the words (rule #1). It names no adult, so it is a plain family row.
 */
export async function recordGarbledRefusal(
  database: Database,
  input: { familyId: string; surface: 'intake' | 'family_outbound' },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'channel_text_garbled',
    after: { surface: input.surface, reason: GARBLED_TEXT },
  });
}
