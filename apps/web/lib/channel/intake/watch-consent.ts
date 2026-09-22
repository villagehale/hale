import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';
import { WATCH_OFFER } from './copy';

/**
 * VIL-237 · M2 — recording the answer to the watch-offer.
 *
 * ORDER IS THE POINT. The consent row is written FIRST, inside the same transaction,
 * and only then does the family move to `sms_active` (the stage that says proactive
 * contact was settled). A crash between the two can therefore only ever leave a
 * consent record with no stage flip — never a family marked ready for unprompted
 * contact with no record of them agreeing to it (rule #4, rule #6).
 *
 * A decline and an unresolved ambiguity BOTH write a row, granted=false. "No" is a
 * fact about this family that has to be recorded, and an absent row is
 * indistinguishable from "never asked".
 */

export const WATCH_CONSENT_SCOPE = 'proactive_watch';

/**
 * Stored on the consent row when the live find is the watch. Not an SMS. The
 * parent was not asked a separate yes; their kids-and-postal text is the verbatim.
 */
export const IMPLIED_WATCH_BASIS =
  'The parent sent their kids and a postal code. The live find is the watch.';

export interface WatchConsentInput {
  familyId: string;
  userId: string;
  granted: boolean;
  /** The parent's own words. Verbatim — the consent's legal instrument. */
  verbatimReply: string;
  /** How those words were read. Stored beside them so the reading is falsifiable. */
  interpretation: string;
  /** The channel_messages row the reply arrived on, so the record points at the
   * message itself rather than at a copy of its text. */
  channelMessageId: string | null;
  /**
   * What the row says was asked. Defaults to the legacy watch-offer text for a
   * session that is still answering that question. The live path passes
   * {@link IMPLIED_WATCH_BASIS} because that question is not sent.
   */
  question?: string;
}

export async function recordWatchConsent(
  database: Database,
  input: WatchConsentInput,
  now: Date,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.insert(schema.consentRecords).values({
      userId: input.userId,
      familyId: input.familyId,
      consentType: 'proactive_watch',
      granted: input.granted,
      consentScope: WATCH_CONSENT_SCOPE,
      policyVersion: POLICY_VERSION,
      evidence: {
        question: input.question ?? WATCH_OFFER,
        verbatimReply: input.verbatimReply,
        interpretation: input.interpretation,
        channelMessageId: input.channelMessageId,
      },
    });

    await tx
      .update(schema.families)
      .set({ onboardingStage: 'sms_active', updatedAt: now })
      .where(eq(schema.families.id, input.familyId));

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: input.granted ? 'proactive_watch_granted' : 'proactive_watch_declined',
      targetTable: 'consent_records',
      targetId: input.familyId,
      after: { interpretation: input.interpretation },
    });
  });
}
