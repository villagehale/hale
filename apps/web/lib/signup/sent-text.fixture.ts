import { type Database, schema } from '@hale/db';

/**
 * The outbound ledger row of a text about a sign-up ask that went, as a send site writes
 * it once the transport took it: what a test hands the stamp's keep (store.ts `askStamp`).
 * Its `send_recorded_at` is stamped by the database. A fixture, never imported by
 * production code.
 */
export async function sentSignupText(
  database: Database,
  to: { familyId: string; parentUserId: string; sentAt?: Date },
): Promise<string> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: to.familyId,
      parentUserId: to.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      status: 'queued',
      sentAt: to.sentAt ?? new Date(),
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('sentSignupText: no row');
  return row.id;
}
