import { type Database, schema } from '@hale/db';
import { LEGAL_LAST_UPDATED } from '~/components/hale/legal-layout';

/**
 * The policy version a consent is recorded against. Reuses the legal pages'
 * last-updated date as the single source of truth, so a consent row always names
 * the exact policy text the user agreed to (the Privacy Policy promises we
 * "record each consent including the policy version and time").
 */
export const POLICY_VERSION = LEGAL_LAST_UPDATED;

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
