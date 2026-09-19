import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { POLICY_VERSION } from '../consent.js';

/**
 * VIL-355 follow-up · the account that outlived every household it belonged to.
 *
 * `runDeletionSweep` erases FAMILIES and lets the FK cascade do the rest, which is right
 * for everything keyed on a family and covers nothing that is not. A `users` row is not:
 * it has no family FK at all. So a co-parent who left, a caregiver whose grant was
 * revoked and a parent whose household was erased all ended in the same place — a row
 * nothing would ever remove, holding a name, an address, a sign-in secret and, in the
 * case this exists for, a LIVE verified phone channel that no household stands behind.
 * `departCoParent` names this gap in its own header; this is the change it points at.
 *
 * WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT. It closes every door and empties
 * every user-scoped table, then ANONYMISES the users row rather than deleting it. The
 * deletion is the tempting version and it is wrong: `parent_channels` cascades from
 * `users`, and that row's encrypted number is the evidence of express consent CASL
 * requires be producible for three years after it ends. Deleting the person would
 * destroy the only proof that the message Hale sent them was lawful.
 *
 * WHO IT CAN REACH, and why a brand-new signup cannot be one of them: the subject has to
 * HAVE HELD a channel. "No seat" alone would match every account between sign-up and
 * creating a family. There is no race with provisioning either — `provisionFromIntake`
 * and `acceptInvite` both write the seat and the channel in ONE transaction, so a
 * half-built member never exists to be seen.
 *
 * IT NEEDS NO DONE-MARKER COLUMN. The work it does is exactly what makes a row stop
 * matching {@link selectOrphanedUsers}: no live channel, no identity, no user-scoped
 * rows. A second pass is a no-op because there is nothing left to do, not because a flag
 * says so — which is also the only definition of "finished" that stays true if a pass
 * dies halfway through.
 */

export interface OrphanSweepSummary {
  /** People whose last doors were closed on this run. */
  swept: number;
  /** Live SMS channels revoked — the ones a household no longer stands behind. */
  channelsRevoked: number;
  /** `granted=false` rows appended, one per messaging scope still standing. */
  consentWithdrawn: number;
  /** Rows removed from the four tables that hang off `users.id` alone. */
  scopedRowsDeleted: number;
  /** `users` rows stripped of name, address and sign-in identity. */
  identitiesAnonymised: number;
}

export function emptyOrphanSweepSummary(): OrphanSweepSummary {
  return {
    swept: 0,
    channelsRevoked: 0,
    consentWithdrawn: 0,
    scopedRowsDeleted: 0,
    identitiesAnonymised: 0,
  };
}

export interface OrphanedUser {
  userId: string;
  /** The household whose channel record they still hold — the audit row's home, because
   * `audit_log.family_id` is NOT NULL and a person with no seat has no other address in
   * the trail. Their newest channel's family, so a separated parent's row lands in the
   * household the evidence belongs to. */
  familyId: string;
}

/** The four tables keyed on `users.id` with no family column of their own, so nothing a
 * family cascade will ever reach. Kept as one list because every place below has to
 * agree about it — and because a fifth such table added later is a one-line change here
 * rather than a silent survivor. */
const USER_SCOPED_TABLES = [
  schema.channelSigninTokens,
  schema.phoneVerifications,
  schema.loopPrefs,
  schema.notificationPrefs,
] as const;

/**
 * Everyone with a channel record, no seat anywhere, and something still open.
 *
 * Read wholesale and joined in memory rather than as three SQL anti-joins: the
 * populations are small (a household's parents), the predicate is the whole point of the
 * function, and one readable pass is worth more here than a query plan.
 */
export async function selectOrphanedUsers(database: Database): Promise<OrphanedUser[]> {
  const channels = (
    await database
      .select({
        userId: schema.parentChannels.userId,
        familyId: schema.parentChannels.familyId,
        revokedAt: schema.parentChannels.revokedAt,
        createdAt: schema.parentChannels.createdAt,
      })
      .from(schema.parentChannels)
  )
    .slice()
    // Newest first, so the first row a user contributes names the household their
    // channel evidence belongs to. Sorted here rather than in SQL because the whole
    // read is already in memory and the ordering is part of the predicate, not a plan.
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (channels.length === 0) return [];

  const seated = new Set(
    (await database.select({ userId: schema.familyMembers.userId }).from(schema.familyMembers)).map(
      (r) => r.userId,
    ),
  );

  const candidates = new Map<string, { familyId: string; liveChannel: boolean }>();
  for (const row of channels) {
    if (seated.has(row.userId)) continue;
    const held = candidates.get(row.userId);
    if (!held) candidates.set(row.userId, { familyId: row.familyId, liveChannel: false });
    if (row.revokedAt === null) {
      const entry = candidates.get(row.userId);
      if (entry) entry.liveChannel = true;
    }
  }
  if (candidates.size === 0) return [];

  const identities = await database
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      externalAuthId: schema.users.externalAuthId,
    })
    .from(schema.users);
  const identified = new Set(
    identities
      .filter((u) => u.email !== null || u.name !== null || u.externalAuthId !== null)
      .map((u) => u.id),
  );

  const scoped = new Set<string>();
  for (const table of USER_SCOPED_TABLES) {
    for (const row of await database.select({ userId: table.userId }).from(table)) {
      scoped.add(row.userId);
    }
  }

  return [...candidates.entries()]
    .filter(([userId, c]) => c.liveChannel || identified.has(userId) || scoped.has(userId))
    .map(([userId, c]) => ({ userId, familyId: c.familyId }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

/**
 * The messaging consents this person still holds, latest row per (family, scope).
 *
 * The same latest-row-wins convention `departCoParent` reads by, for the same reason: a
 * withdrawal is an APPENDED `granted=false` row, so the ledger carries both answers and
 * only the newest one is true. Appending a withdrawal for a scope that was never granted
 * would be a false row; leaving a standing one would be a worse one.
 */
async function standingMessagingConsents(
  tx: Database,
  userId: string,
): Promise<Array<{ familyId: string | null; consentScope: string | null }>> {
  const rows = await tx
    .select({
      familyId: schema.consentRecords.familyId,
      consentScope: schema.consentRecords.consentScope,
      granted: schema.consentRecords.granted,
      grantedAt: schema.consentRecords.grantedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.userId, userId),
        eq(schema.consentRecords.consentType, 'sms_service_messages'),
      ),
    );

  const latest = new Map<
    string,
    { granted: boolean; grantedAt: Date; familyId: string | null; consentScope: string | null }
  >();
  for (const row of rows) {
    const key = `${row.familyId ?? ''}|${row.consentScope ?? ''}`;
    const held = latest.get(key);
    if (!held || row.grantedAt >= held.grantedAt) latest.set(key, row);
  }
  return [...latest.values()]
    .filter((v) => v.granted)
    .map((v) => ({ familyId: v.familyId, consentScope: v.consentScope }));
}

async function sweepOne(
  database: Database,
  orphan: OrphanedUser,
  now: Date,
): Promise<OrphanSweepSummary> {
  const { userId, familyId } = orphan;
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const result = emptyOrphanSweepSummary();
    result.swept = 1;

    const revoked = await tx
      .update(schema.parentChannels)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(eq(schema.parentChannels.userId, userId), isNull(schema.parentChannels.revokedAt)),
      )
      .returning({ id: schema.parentChannels.id });
    result.channelsRevoked = revoked.length;

    const standing = await standingMessagingConsents(tx, userId);
    if (standing.length > 0) {
      const appended = await tx
        .insert(schema.consentRecords)
        .values(
          standing.map((held) => ({
            userId,
            familyId: held.familyId,
            consentType: 'sms_service_messages' as const,
            granted: false,
            consentScope: held.consentScope,
            policyVersion: POLICY_VERSION,
            grantedAt: now,
            evidence: {
              interpretation:
                'no household holds a seat for this person any more; their messaging consent ends',
            },
          })),
        )
        .returning({ id: schema.consentRecords.id });
      result.consentWithdrawn = appended.length;
    }

    for (const table of USER_SCOPED_TABLES) {
      const removed = await tx
        .delete(table)
        .where(eq(table.userId, userId))
        .returning({ userId: table.userId });
      result.scopedRowsDeleted += removed.length;
    }

    // ANONYMISED, not deleted — the channel row below them is the CASL evidence, and it
    // cascades from this row. What goes is everything that names a person: the address,
    // the name, and the sign-in identity (which for an SMS account is a blind index of
    // their number).
    const anonymised = await tx
      .update(schema.users)
      .set({ email: null, name: null, externalAuthId: null, updatedAt: now })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id });
    result.identitiesAnonymised = anonymised.length;

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'orphan_user_erased',
      targetTable: 'users',
      targetId: userId,
      // Counts only. Nothing that names the person the row is about (rule #1).
      after: {
        channelsRevoked: result.channelsRevoked,
        consentWithdrawn: result.consentWithdrawn,
        scopedRowsDeleted: result.scopedRowsDeleted,
        identityRetained: true,
      },
    });

    return result;
  });
}

export async function runOrphanUserSweep(
  database: Database,
  now: Date = new Date(),
): Promise<OrphanSweepSummary> {
  const total = emptyOrphanSweepSummary();
  for (const orphan of await selectOrphanedUsers(database)) {
    const one = await sweepOne(database, orphan, now);
    total.swept += one.swept;
    total.channelsRevoked += one.channelsRevoked;
    total.consentWithdrawn += one.consentWithdrawn;
    total.scopedRowsDeleted += one.scopedRowsDeleted;
    total.identitiesAnonymised += one.identitiesAnonymised;
  }
  return total;
}
