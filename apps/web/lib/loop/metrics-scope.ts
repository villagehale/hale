import type { Database } from '@hale/db';
import { resolveFounderChannel } from '~/lib/channel/founder/channel';

/**
 * WHO THE FOUNDER'S METRICS ARE ALLOWED TO COUNT — the households a retention number
 * must not be measured over, owned by the metrics and by nothing else.
 *
 * Two env allowlists already hold test-family ids (`F14_FAMILY_ALLOWLIST`,
 * `VILLAGE_INTROS_FAMILY_ALLOWLIST`) and NEITHER may be read here. They are RELEASE
 * CONTROLS: the day the dark launch flips, the founder empties `F14_FAMILY_ALLOWLIST`
 * because everybody is allowed through — and a metric reading it would, in that same
 * moment, silently start counting the founder's own family as a retained cohort member.
 * Nothing would fail, nothing would log, and the first real retention number the
 * product ever produced would be wrong in the flattering direction. An exclusion list
 * and a rollout list answer different questions and have opposite lifecycles, so they
 * are different envs.
 *
 * THE FOUNDER'S FAMILY IS NOT IN THAT ENV, deliberately. It is resolved from
 * {@link resolveFounderChannel} at query time, so there is no id to remember to add and
 * no second place to keep it in step — the same reason that file keeps no digits.
 */

export const METRICS_EXCLUDED_FAMILIES_ENV = 'METRICS_EXCLUDED_FAMILY_IDS';

/** The comma-separated family ids the founder's metrics must not measure — QA and
 * friends-and-family households whose behaviour is not a signal about the product. */
export function metricsExcludedFamilies(): Set<string> {
  return new Set(
    (process.env[METRICS_EXCLUDED_FAMILIES_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/**
 * The env list UNION the founder's own household.
 *
 * A metric reader calls this rather than {@link metricsExcludedFamilies} so the founder
 * can never be forgotten by omission. An absent founder channel (no address configured,
 * no verified SMS row, or one he revoked) is an ORDINARY answer and leaves the env list
 * standing on its own — the founder is then simply not a family this database knows how
 * to identify, which is the same state a single-parent household is in.
 */
export async function resolveMetricsExclusions(database: Database): Promise<Set<string>> {
  const excluded = metricsExcludedFamilies();
  const founder = await resolveFounderChannel(database);
  if (founder) {
    excluded.add(founder.familyId);
  }
  return excluded;
}
