import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

/**
 * WHO A FAMILY-SCOPED PROACTIVE SWEEP IS ACTUALLY TEXTING.
 *
 * The site promises a co-parent "the same radar and reminders, on their own number", and
 * the loop senders keep it — the weekly plan and the event reminders both select
 * `['primary_parent', 'co_parent']` (loop/send.ts, loop/reminders/run.ts). The two
 * FLAGSHIP unprompted lanes did not: the registration ladder and the nudge sweep each
 * joined `family_members` on `role = 'primary_parent'` and texted exactly one number, so
 * the household's second parent heard about a registration morning from their partner or
 * not at all (audit 2026-09-17).
 *
 * ONE READER, because the bug was two copies of a recipient rule that had drifted from a
 * third. A sweep asks this module who its message is for and gets every parent seat that
 * can be texted right now.
 *
 * THE PREDICATE IS THE SEND SIDE'S OWN (`resolveSendablePhone`, sms-consent-core): an
 * ACTIVE, VERIFIED, NON-REVOKED `sms` channel. Not a consent-ledger read — after a STOP
 * the CASL ledger still holds a granted row forever, and the live channel is the only
 * honest answer to "may we text this number now". A departed co-parent's channel is
 * revoked by the same transaction that takes their seat (coparent/depart.ts), so they
 * fall out of this list without anything here knowing what departure is.
 *
 * IT IS NOT THE GATE. Consent, volume and the clock stay
 * `assertProactiveSendAllowed`'s, per recipient — selecting on them here would put the
 * same policy in two places and let them disagree, which is the discipline both sweeps'
 * own family selectors already keep.
 */

/** The two seats that get the household's own messages. A caregiver is a scoped lane
 * (role-scope.ts) and is deliberately absent: they never receive the radar. */
const TEXTABLE_ROLES = ['primary_parent', 'co_parent'] as const;

export type FamilyTextRole = (typeof TEXTABLE_ROLES)[number];

export interface FamilyTextRecipient {
  parentUserId: string;
  /** THIS recipient's own wall clock — what the gate's quiet-hours check reads. */
  timeZone: string;
  role: FamilyTextRole;
}

/**
 * Every parent seat in this family with a live, verified SMS channel — the primary
 * parent first, then the co-parent.
 *
 * THE ORDER IS LOAD-BEARING and not cosmetic: a family-scoped promise (MEM-10's
 * `registration_plan`, `first_find`) is opened and discharged against the FIRST message
 * that carried it, so the row a ledger points at has to be the same one on every tick
 * rather than whatever the planner happened to return first.
 *
 * An empty list is an ordinary answer — a household whose only parent pressed STOP — and
 * the callers count it as such rather than treating it as an error.
 */
export async function loadFamilyTextRecipients(
  database: Database,
  familyId: string,
): Promise<FamilyTextRecipient[]> {
  const rows = await database
    .select({
      parentUserId: schema.users.id,
      timeZone: schema.users.timezone,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
    // The send side's own predicate. At most one ACTIVE row per (user, kind) —
    // `parent_channels_user_kind_active_idx` — so this join can never fan a seat out.
    .innerJoin(
      schema.parentChannels,
      and(
        eq(schema.parentChannels.userId, schema.familyMembers.userId),
        eq(schema.parentChannels.kind, 'sms'),
        isNotNull(schema.parentChannels.verifiedAt),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        inArray(schema.familyMembers.role, [...TEXTABLE_ROLES]),
      ),
    );

  return rows
    .filter((row): row is typeof row & { role: FamilyTextRole } =>
      (TEXTABLE_ROLES as readonly string[]).includes(row.role),
    )
    .sort((a, b) =>
      a.role === b.role
        ? a.parentUserId.localeCompare(b.parentUserId)
        : a.role === 'primary_parent'
          ? -1
          : 1,
    )
    .map((row) => ({ parentUserId: row.parentUserId, timeZone: row.timeZone, role: row.role }));
}
