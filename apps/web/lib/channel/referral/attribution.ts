import { type Database, schema } from '@hale/db';
import { isReferralCode, referralCode } from './code';

/**
 * Who sent this family in.
 *
 * The arrival is already recorded: a referred friend's first text carries
 * `(via friend-…)`, the intake parses it into `sms_intake_sessions.source_code`, and
 * provisioning copies it onto the consent record's evidence and the
 * `sms_intake_provisioned` audit row. What none of those hold is the REFERRER, because
 * the tag is a one-way digest — so this is the reader that turns one into the other.
 *
 * WHY A SCAN. The code is HMAC(family id), which is exactly what makes it safe to print
 * and impossible to invert. There is therefore no index that could answer this question
 * directly without storing a second copy of the mapping — a column, a migration, and a
 * row that can drift from the family it describes. Recomputing every family's code
 * instead is one cheap digest per family, and it is asked at most once per new family
 * (and again by whoever is counting referrals), never on a message path.
 *
 * A code that matches nobody returns null and that is an ordinary outcome, not an
 * error: a link can be forwarded long after the family that made it was deleted, and a
 * tag can be typed by hand or forged. Neither is a reason to refuse a family a setup.
 */
export async function resolveReferrerFamilyId(
  database: Database,
  sourceCode: string | null,
): Promise<string | null> {
  if (sourceCode === null || !isReferralCode(sourceCode)) return null;
  const wanted = sourceCode.toLowerCase();
  const families = await database.select({ id: schema.families.id }).from(schema.families);
  return families.find((family) => referralCode(family.id) === wanted)?.id ?? null;
}
