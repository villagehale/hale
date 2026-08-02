import { type Database, schema } from '@hale/db';

/**
 * The last-updated dates of the two policies, which the marketing site
 * (apps/site/app/{terms,privacy}/page.tsx) dates INDEPENDENTLY — privacy moved to
 * July 31 for the SMS-transit disclosure while terms stayed on June 25. Each
 * constant is bound to its live page by the drift test in consent.test.ts, so a
 * re-dated policy cannot silently leave its constant behind (VIL-257).
 */
export const TERMS_VERSION = 'June 25, 2026';
export const PRIVACY_VERSION = 'July 31, 2026';

/**
 * The policy version a consent is recorded against, so a consent row names the
 * policy text the user agreed to (the Privacy Policy promises we "record each
 * consent including the policy version and time"). PERSISTED into consent_records —
 * changing this string changes what every new consent claims, so it moves only when
 * the policy copy itself does.
 *
 * It names BOTH policies, each labelled: a consent is given under the terms and the
 * privacy policy together, and a single bare date silently under-names whichever of
 * the two moved last. Historical rows keep whatever they were written with — the
 * ledger is append-only, and a row is a record of what was true when it was made.
 */
export const POLICY_VERSION = `Terms ${TERMS_VERSION} · Privacy ${PRIVACY_VERSION}`;

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
