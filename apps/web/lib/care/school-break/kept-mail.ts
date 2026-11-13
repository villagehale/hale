import { type Database, schema } from '@hale/db';
import { and, eq, notExists, or } from 'drizzle-orm';

/**
 * VIL-685 · WHICH ALERTED MAIL IS STILL PLAIN KID MAIL. An email alert Hale sent a family
 * (`email_alert_offers`) stops being kid mail the moment any kid-relevance verdict on it
 * says `adult` (the kid check's, or the parent's own: what an untrack such as "that's
 * mine" writes), `unsure`, or that it is a 13+ child's. The one predicate both readers
 * use: the mail reader choosing which senders to weigh (school-mail.ts), and the check
 * that a break already filed still stands on the mail that named its school
 * (standing.ts), so a withdrawal reaches both alike.
 */

/** One alerted message: its connection and Gmail's id for it. */
export interface MailKey {
  integrationId: string;
  messageId: string;
}

const offers = schema.emailAlertOffers;
const verdicts = schema.kidRelevanceVerdicts;

/** No verdict takes this offer's message out of plain kid mail. */
export function stillKidMail(database: Database) {
  return notExists(
    database
      .select({ id: verdicts.id })
      .from(verdicts)
      .where(
        and(
          eq(verdicts.familyId, offers.familyId),
          eq(verdicts.source, 'gmail'),
          eq(verdicts.integrationId, offers.integrationId),
          eq(verdicts.itemKey, offers.messageId),
          or(
            eq(verdicts.verdict, 'adult'),
            eq(verdicts.verdict, 'unsure'),
            eq(verdicts.teen, true),
          ),
        ),
      ),
  );
}

/** At least one of these messages is an alert this family got and is still kid mail. */
export async function anyStillKidMail(
  database: Database,
  familyId: string,
  mail: readonly MailKey[],
): Promise<boolean> {
  if (mail.length === 0) return false;
  const [row] = await database
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(
        eq(offers.familyId, familyId),
        or(
          ...mail.map((key) =>
            and(eq(offers.integrationId, key.integrationId), eq(offers.messageId, key.messageId)),
          ),
        ),
        stillKidMail(database),
      ),
    )
    .limit(1);
  return row !== undefined;
}
