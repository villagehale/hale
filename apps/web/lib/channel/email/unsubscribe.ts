import { type Database, schema } from '@hale/db';
import { type EmailType, recordOptOut } from '~/lib/cron/email-compliance';
import { UNSUBSCRIBABLE_STREAMS } from './streams';

/**
 * A CASL unsubscribe arriving by email, and the ONE implementation of it — because the
 * inbound domain now has two doors and the word means the same thing at both.
 *
 * It writes to `email_opt_outs`, the store the app ALREADY treats as the live answer to
 * "may we email this person" — the absence of a row is the consent. Minting a second
 * store for the same question would create two readers that can disagree, and the wrong
 * one would email a parent who asked us to stop.
 *
 * It opts the sender out of EVERY stream, which is what the word means when a person
 * types it: a parent who writes "unsubscribe" has not asked to be removed from one
 * category and kept on five others. That is the same scope a texted STOP has, which
 * revokes the channel outright rather than one message class.
 *
 * Nothing is sent back. SMS answers a STOP because carriers require one final
 * confirmation; email has no such rule, and emailing someone who just asked not to be
 * emailed is the thing they asked us not to do.
 *
 * The write goes through `recordOptOut`, the same function the unsubscribe LINK and the
 * settings toggle call, rather than a second inline insert that could drift from it. It
 * is idempotent on the unique (user, stream) index and reports whether THIS call was the
 * one that changed anything.
 *
 * That report is used, because on the reply door an unsubscribe writes no
 * `channel_messages` row and is therefore invisible to the Message-ID dedupe — every
 * redelivery re-runs this. The audit row is written only when a stream ACTUALLY changed,
 * so a retried webhook does not make the trail read as a parent unsubscribing over and
 * over. Rule #6 asks for a row per ACTION, and opting out something already opted out is
 * not one; this is the same reasoning as X1's STOP alert firing once per unsubscribe
 * rather than once per click.
 *
 * ONE ROW SHAPE FOR BOTH DOORS, deliberately. Which local part a parent happened to reply
 * to is a fact about routing, not about what they asked for, and splitting the trail on
 * it would make "how many people unsubscribed by email" a question with two answers.
 */
export async function honourEmailUnsubscribe(
  database: Database,
  args: { userId: string; familyId: string },
): Promise<'unsubscribed'> {
  await database.transaction(async (tx) => {
    const changed: EmailType[] = [];
    for (const emailType of UNSUBSCRIBABLE_STREAMS) {
      const first = await recordOptOut(tx as unknown as Database, args.userId, emailType);
      if (first) changed.push(emailType);
    }
    if (changed.length === 0) return;

    await tx.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.userId,
      actionTaken: 'email_unsubscribe_received',
      targetTable: 'email_opt_outs',
      targetId: args.userId,
      after: { streams: changed, via: 'inbound_email' },
    });
  });
  return 'unsubscribed';
}
