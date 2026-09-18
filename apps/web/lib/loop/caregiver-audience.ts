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
 *
 * AND IT CARRIES NO BOUND, deliberately, mirroring the parents' `selectReminderParents`.
 * A `LIMIT` here would be a bound on a FAN-OUT expressed inside a DEFINITION, and the two
 * cannot share a list: whoever reads this asking "is this person an active seat?" would
 * get `false` for a live grandmother purely because the row ahead of her filled a cap —
 * a refusal manufactured by a performance knob. The senders bound their own fan-out where
 * it happens (`MAX_SEND_CAREGIVERS_PER_RUN` in loop/send.ts, after the send-moment filter,
 * exactly as the parents' leg does), and the reminder fire gate asks the ROW about its own
 * recipient (`DueReminder.smsChannelActive`) rather than asking this list.
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
    .where(inArray(schema.familyMembers.role, [...CAREGIVER_ROLES]));

  return rows.map((r) => ({
    familyId: r.familyId,
    userId: r.userId,
    role: r.role as CaregiverRole,
    timezone: r.timezone,
    weekStartDay: r.weekStartDay,
  }));
}
