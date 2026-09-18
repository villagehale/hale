import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { CAREGIVER_ROLES, type CaregiverRole } from '~/lib/channel/role-scope';

/**
 * The caregiver seats a loop message may be addressed to — the audience half of the leg
 * the M6 invite promised and nothing had ever sent.
 *
 * ONE READER for both senders (the weekly plan and the event reminders), because the
 * three conditions below are a definition of "active seat" and two copies of a definition
 * is how one of them ends up missing the revocation check.
 *
 * THE THREE CONDITIONS, none of which implies another (caregiver/invites.ts says the same
 * thing from the writing side):
 *
 *   1. A `family_members` row in one of the CAREGIVER_ROLES. Only `acceptInvite` writes
 *      one, inside the transaction that also writes the consent and the channel — so an
 *      invite that was never answered, was declined, or expired has no row here at all,
 *      and "accepted" needs no separate column to read.
 *   2. An ACTIVE verified SMS channel: `parent_channels` for this user, kind sms,
 *      verified, not revoked. The same three columns `loadSmsChannelState` reads for its
 *      `enrolled` answer (channels/sms-consent-core.ts) — expressed as a join here
 *      because a weekly sweep should not decrypt a phone number to learn a boolean.
 *      This is what a caregiver's STOP takes away: the intake machine revokes the channel
 *      per USER (channel/intake/machine.ts), so their row drops out of this join while
 *      the rest of the household is untouched.
 *   3. `users.timezone` / `users.week_start_day` — theirs, not the family's. A grandmother
 *      two provinces away gets her Sunday at her own eight o'clock.
 *
 * The pre-filter is not the consent gate. The A2 dispatch re-asks `smsConsentLive` at send
 * time and suppresses on the live answer, which is the authoritative check; filtering here
 * is what stops a revoked seat minting a `suppressed_consent` ledger row every single week
 * for a person who already said no.
 */

export interface CaregiverSeat {
  familyId: string;
  userId: string;
  role: CaregiverRole;
  /** The caregiver's own IANA zone (users.timezone, default America/Toronto). */
  timezone: string;
  /** The caregiver's own users.week_start_day (0=Sun, the product default). */
  weekStartDay: number;
}

/** Bound on one run's fan-out, mirroring the parents' `MAX_SEND_PARENTS_PER_RUN`: a
 * household can seat several caregivers, and an unbounded sweep is how a cron tick that
 * used to take a second starts timing out. */
export const MAX_CAREGIVER_SEATS_PER_RUN = 200;

export async function selectCaregiverSeats(database: Database): Promise<CaregiverSeat[]> {
  const rows = await database
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.users.id,
      role: schema.familyMembers.role,
      timezone: schema.users.timezone,
      weekStartDay: schema.users.weekStartDay,
    })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .innerJoin(
      schema.parentChannels,
      and(
        eq(schema.parentChannels.userId, schema.users.id),
        eq(schema.parentChannels.kind, 'sms'),
        isNotNull(schema.parentChannels.verifiedAt),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .where(inArray(schema.familyMembers.role, [...CAREGIVER_ROLES]))
    .limit(MAX_CAREGIVER_SEATS_PER_RUN);

  return rows.map((r) => ({
    familyId: r.familyId,
    userId: r.userId,
    role: r.role as CaregiverRole,
    timezone: r.timezone,
    weekStartDay: r.weekStartDay,
  }));
}
