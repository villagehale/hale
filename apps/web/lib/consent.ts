import { type Database, schema } from '@hale/db';

/**
 * The policy version a consent is recorded against, so a consent row names the
 * policy text the user agreed to (the Privacy Policy promises we "record each
 * consent including the policy version and time"). It is the legal pages'
 * last-updated date, and it is PERSISTED into consent_records — changing this
 * string changes what every new consent claims, so it moves only when the policy
 * copy itself does.
 *
 * The policies now live on the marketing site (see lib/legal-links.ts), which
 * dates each page separately: keep this in step with them by hand.
 */
export const POLICY_VERSION = 'June 25, 2026';

/** A query surface with `.insert` — satisfied by both Database and a Drizzle tx. */
type Inserter = Pick<Database, 'insert'>;

export interface RecordConsentInput {
  userId: string;
  /** Null for an account-level consent not yet tied to a family. */
  familyId?: string | null;
  consentType: schema.NewConsentRecord['consentType'];
  granted: boolean;
  /** Free-form key when the consent is for a specific integration or action class. */
  consentScope?: string | null;
  /** Defaults to the current POLICY_VERSION; pass through for a back-dated record. */
  policyVersion?: string;
}

/**
 * Inserts one immutable consent_records row (granted_at defaults to now() in the
 * DB). Pass a Drizzle tx as the inserter to record a consent inside the same
 * transaction as the action that captured it, so the consent and its trigger
 * commit together. Account-level consents (terms, privacy, cross-border, LLM)
 * carry the family id once it exists; an absent family id stores null.
 */
export async function recordConsent(
  inserter: Inserter,
  input: RecordConsentInput,
): Promise<void> {
  await inserter.insert(schema.consentRecords).values({
    userId: input.userId,
    familyId: input.familyId ?? null,
    consentType: input.consentType,
    granted: input.granted,
    consentScope: input.consentScope ?? null,
    policyVersion: input.policyVersion ?? POLICY_VERSION,
  });
}
