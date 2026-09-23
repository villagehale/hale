import { type Database, schema } from '@hale/db';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { EMPTY_SATURDAY_TEMPLATE_KEY } from './empty-saturday-copy';

/**
 * IS THE EMPTY-SATURDAY ASK STILL OPEN? Derived from the ledger, the way the
 * weekday-care question is.
 *
 * The locked sentence is a yes/no. Listing it (yes: false, no: false) is what
 * stops a bare YES from approving an unrelated draft. A yes is not a delivery:
 * the held candidate is not auto-sent. The turn falls through to the coach,
 * whose next search is what a later how-it-went answer can bias.
 *
 * 48 hours, per parent, and closed the moment anything newer goes out.
 * `SENT_STATUSES` rather than the dedupe key's consumed set: a failed send
 * never reached a phone, and a question nobody was asked is not open.
 */

export const EMPTY_SATURDAY_QUESTION_TTL_MS = 48 * 3_600_000;

export async function emptySaturdayQuestion(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<{ id: string; askedAt: Date } | null> {
  const [ask] = await database
    .select({
      id: schema.channelMessages.id,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.templateKey, EMPTY_SATURDAY_TEMPLATE_KEY),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  if (!ask) return null;
  if (input.now.getTime() - ask.createdAt.getTime() > EMPTY_SATURDAY_QUESTION_TTL_MS) return null;

  const [newer] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(schema.channelMessages.createdAt, ask.createdAt),
      ),
    )
    .limit(1);
  if (newer) return null;
  return { id: ask.id, askedAt: ask.createdAt };
}
