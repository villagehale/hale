import { type Database, schema } from '@hale/db';
import { and, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { linqGroupOnboardingV2Enabled } from './config';
import { isUndefinedTable } from './roster';

/**
 * Group onboarding v2 — how long a number Hale read from a group may outlive its purpose.
 *
 * A roster member is a phone Hale saw in a chat, not a person who asked Hale for anything.
 * Its encrypted number exists so Hale can ask that person who they are. Once the answer is
 * no — declined, not family, left, removed, or refused a seat — or once the roster belongs
 * to no family at all, the purpose is spent and keeping the number is retention with no
 * reason (rule #1, PIPEDA principle 4.5, Law 25 s.23). Family erasure does not reach these
 * rows on its own: a family-less roster has no family to cascade from.
 *
 * Two steps, one transaction:
 *  - a roster with no family (`no_family`, `mixed_family`, `not_group`, `refused`) that has
 *    not changed for the window is deleted with its members. A `roster_pending` roster is
 *    kept: it is still waiting on a fetch, and holds no members until the fetch settles.
 *  - a member in a terminal, never-seated status that has not changed for the window has
 *    its encrypted number set to null. The blind index stays, so the same phone is still
 *    recognised on a re-add and the live-unique index still holds. Seated members
 *    (`known_parent`, `confirmed`) and members still being asked are not touched.
 *
 * The age is measured from `updated_at` — how long the row has sat in that state — so a
 * roster that was retried yesterday is not swept because it was first read last month.
 * Releasing a number leaves `updated_at` alone (it is not a change of state); the
 * `phone_e164_encrypted IS NOT NULL` predicate is what makes a second run a no-op.
 *
 * Audit (rule #6): one `linq_group_roster_numbers_released` row per family whose members
 * were released, counts only. A family-less roster has nowhere to write one —
 * `audit_log.family_id` is NOT NULL — so those counts are returned and logged by the cron
 * (counts only, no ids), the convention `runDeletionSweep` keeps for erasures with no
 * surviving family.
 *
 * It runs on the delete sweep only while `LINQ_GROUP_ONBOARDING_V2_ENABLED` is exactly
 * `true`. Flag off is today's sweep: this returns `flag_off` and writes nothing.
 * Apply 0158 and 0159 together before the flag goes on. 0159 is what lets the number
 * column be null; an UPDATE against the 0158 NOT NULL column throws inside the sweep.
 */
export const ROSTER_RETENTION_DAYS = 30;
const ROSTER_RETENTION_MS = ROSTER_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const NUMBER_RELEASED_STATUSES: schema.LinqRosterMemberStatus[] = [
  'declined',
  'not_family',
  'left',
  'removed',
  'refused',
];
const FAMILYLESS_ROSTER_STATUSES: schema.LinqGroupRosterStatus[] = [
  'no_family',
  'mixed_family',
  'not_group',
  'refused',
];

export type RosterRetentionOutcome =
  | { outcome: 'flag_off' }
  | { outcome: 'not_migrated' }
  | {
      outcome: 'swept';
      familylessRostersDeleted: number;
      familylessMembersDeleted: number;
      numbersReleased: number;
      /** Released from a roster with no family, so no audit row could carry them. */
      numbersReleasedWithoutFamily: number;
      familiesAudited: number;
    };

export async function sweepRosterRetention(
  database: Database,
  now: Date = new Date(),
): Promise<RosterRetentionOutcome> {
  if (!linqGroupOnboardingV2Enabled()) return { outcome: 'flag_off' };
  const cutoff = new Date(now.getTime() - ROSTER_RETENTION_MS);
  const rosters = schema.linqGroupRosters;
  const members = schema.linqGroupRosterMembers;
  try {
    return await database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;

      const expired = await tx
        .select({ id: rosters.id })
        .from(rosters)
        .where(
          and(
            isNull(rosters.familyId),
            inArray(rosters.status, FAMILYLESS_ROSTER_STATUSES),
            lte(rosters.updatedAt, cutoff),
          ),
        );
      const expiredIds = expired.map((row) => row.id);
      let familylessMembersDeleted = 0;
      if (expiredIds.length > 0) {
        const deleted = await tx
          .delete(members)
          .where(inArray(members.rosterId, expiredIds))
          .returning({ id: members.id });
        familylessMembersDeleted = deleted.length;
        await tx.delete(rosters).where(inArray(rosters.id, expiredIds));
      }

      const released = await tx
        .update(members)
        .set({ phoneE164Encrypted: sql`null` })
        .where(
          and(
            inArray(members.status, NUMBER_RELEASED_STATUSES),
            isNotNull(members.phoneE164Encrypted),
            lte(members.updatedAt, cutoff),
          ),
        )
        .returning({ rosterId: members.rosterId });

      const perFamily = new Map<string, number>();
      let numbersReleasedWithoutFamily = 0;
      if (released.length > 0) {
        const owners = await tx
          .select({ id: rosters.id, familyId: rosters.familyId })
          .from(rosters)
          .where(inArray(rosters.id, [...new Set(released.map((row) => row.rosterId))]));
        const familyOf = new Map(owners.map((row) => [row.id, row.familyId]));
        for (const row of released) {
          const familyId = familyOf.get(row.rosterId);
          if (familyId) perFamily.set(familyId, (perFamily.get(familyId) ?? 0) + 1);
          else numbersReleasedWithoutFamily += 1;
        }
      }
      for (const [familyId, numbersReleased] of perFamily) {
        await tx.insert(schema.auditLog).values({
          familyId,
          actor: 'system',
          actionTaken: 'linq_group_roster_numbers_released',
          targetTable: 'linq_group_roster_members',
          after: { numbersReleased, retentionDays: ROSTER_RETENTION_DAYS },
        });
      }

      return {
        outcome: 'swept' as const,
        familylessRostersDeleted: expiredIds.length,
        familylessMembersDeleted,
        numbersReleased: released.length,
        numbersReleasedWithoutFamily,
        familiesAudited: perFamily.size,
      };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      console.warn({ outcome: 'not_migrated' }, 'linq roster retention: roster tables missing');
      return { outcome: 'not_migrated' };
    }
    throw err;
  }
}
