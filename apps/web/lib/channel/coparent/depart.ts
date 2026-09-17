import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { POLICY_VERSION } from '~/lib/consent';

/**
 * VIL-355 · one parent leaves, and the household keeps its record.
 *
 * `runDeletionSweep` (`rights/delete.ts`) erases a FAMILY: every row, every byte, one
 * cascade. There was no other door, so a co-parent asking to be erased could only ever
 * be answered by deleting the children's whole history — including the primary parent's,
 * who did not ask for anything. This is the per-ACTOR door, and everything it does is
 * chosen so the asymmetry is true BY CONSTRUCTION rather than by care: the transaction
 * names `parent_channels`, `consent_records` and `family_members`, and no other table.
 * A family-scoped row cannot be erased here because there is no statement that could.
 *
 * WHAT THAT LEAVES BEHIND, DELIBERATELY. `family_memory_facts` are the HOUSEHOLD's
 * record, not this parent's — the bedtime, the allergy, the sitter's name — and they
 * were never provenanced per author (VIL-353 is where that would come from). Their
 * thread (`channel-sms:<userId>`) is family-scoped too, and stays: counsel's call,
 * recorded in the brief. So the tally names it (rule #11) — `threadRetained` is a
 * COUNT of what was deliberately not touched, visible in the return value rather than
 * silently absent from it.
 *
 * THE DELETE IS THE CLAIM, AND IT GOES FIRST — the discipline both seating transactions
 * keep. The role is re-tested inside the conditional DELETE against the locked row, so a
 * second departure racing the first matches nothing, writes nothing, and is told
 * `not_a_member` rather than appending a second withdrawal to the ledger.
 */

type FamilyRole = (typeof schema.familyMembers.$inferSelect)['role'];

export interface CoParentDeparted {
  outcome: 'departed';
  /** Active SMS channels of THIS actor in THIS family that were revoked. */
  channelRevoked: number;
  membershipRemoved: true;
  /** `granted=false` rows appended — one per messaging scope that was still standing. */
  consentWithdrawn: number;
  /** Threads left alone on purpose. Named, never inferred from silence (rule #11). */
  threadRetained: number;
}

/**
 * Three outcomes, never folded into one another. `not_departable` carries the role it
 * found because the caller owes a different answer to each: the primary parent's
 * erasure is the family sweep, and a caregiver's is the caregiver door.
 */
export type CoParentDeparture =
  | CoParentDeparted
  | { outcome: 'not_departable'; role: FamilyRole }
  | { outcome: 'not_a_member' };

/**
 * The messaging consents this actor still holds in this family, latest row per scope.
 *
 * Read rather than assumed, because there are two doors into the seat and they record
 * different scopes — the SMS invite writes `CO_PARENT_INVITE_CONSENT_SCOPE` (accept.ts),
 * the forwardable link writes `sms_join_origination`. Appending a withdrawal for a scope
 * that was never granted would be a false ledger row, and leaving the other standing
 * would be a worse one. The ledger convention is the house's: latest row by
 * `granted_at` wins, and a withdrawal is an APPENDED `granted=false` row, never an
 * update (`revokeSmsChannel`, `sms-consent-core.ts:352`).
 */
async function standingMessagingScopes(
  tx: Database,
  input: { familyId: string; actorUserId: string },
): Promise<(string | null)[]> {
  const rows = await tx
    .select({
      consentScope: schema.consentRecords.consentScope,
      granted: schema.consentRecords.granted,
      grantedAt: schema.consentRecords.grantedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.userId, input.actorUserId),
        eq(schema.consentRecords.familyId, input.familyId),
        eq(schema.consentRecords.consentType, 'sms_service_messages'),
      ),
    );

  const latest = new Map<string, { granted: boolean; grantedAt: Date; scope: string | null }>();
  for (const row of rows) {
    const key = row.consentScope ?? '';
    const held = latest.get(key);
    if (!held || row.grantedAt >= held.grantedAt) {
      latest.set(key, { granted: row.granted, grantedAt: row.grantedAt, scope: row.consentScope });
    }
  }
  return [...latest.values()].filter((v) => v.granted).map((v) => v.scope);
}

export async function departCoParent(
  database: Database,
  input: { familyId: string; actorUserId: string; now: Date },
): Promise<CoParentDeparture> {
  const { familyId, actorUserId, now } = input;

  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;

    const removed = await tx
      .delete(schema.familyMembers)
      .where(
        and(
          eq(schema.familyMembers.familyId, familyId),
          eq(schema.familyMembers.userId, actorUserId),
          eq(schema.familyMembers.role, 'co_parent'),
        ),
      )
      .returning({ userId: schema.familyMembers.userId });
    if (removed.length === 0) {
      const [seated] = await tx
        .select({ role: schema.familyMembers.role })
        .from(schema.familyMembers)
        .where(
          and(
            eq(schema.familyMembers.familyId, familyId),
            eq(schema.familyMembers.userId, actorUserId),
          ),
        );
      return seated
        ? { outcome: 'not_departable', role: seated.role }
        : { outcome: 'not_a_member' };
    }

    const revokedChannels = await tx
      .update(schema.parentChannels)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.parentChannels.userId, actorUserId),
          eq(schema.parentChannels.familyId, familyId),
          isNull(schema.parentChannels.revokedAt),
        ),
      )
      .returning({ id: schema.parentChannels.id });

    const scopes = await standingMessagingScopes(tx, { familyId, actorUserId });
    const withdrawals =
      scopes.length === 0
        ? []
        : await tx
            .insert(schema.consentRecords)
            .values(
              scopes.map((consentScope) => ({
                userId: actorUserId,
                familyId,
                consentType: 'sms_service_messages' as const,
                granted: false,
                consentScope,
                policyVersion: POLICY_VERSION,
                grantedAt: now,
                evidence: {
                  interpretation: 'the co-parent left the family; their messaging consent ends',
                },
              })),
            )
            .returning({
              id: schema.consentRecords.id,
              consentScope: schema.consentRecords.consentScope,
            });

    const retained = await tx
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.familyId, familyId),
          eq(schema.conversations.noteKey, channelSmsNoteKey(actorUserId)),
        ),
      );

    // One row per EFFECT (rule #6), and nothing that identifies the person who left:
    // not their number, not the name the inviting parent gave them. An operator reading
    // this answers "what was undone", which is all the trail is for.
    await tx.insert(schema.auditLog).values([
      ...revokedChannels.map((channel) => ({
        familyId,
        actor: actorUserId,
        actionTaken: 'channel_sms_revoked',
        targetTable: 'parent_channels',
        targetId: channel.id,
        after: { revoked: true, reason: 'co_parent_departed' },
      })),
      ...withdrawals.map((row) => ({
        familyId,
        actor: actorUserId,
        actionTaken: 'co_parent_access_withdrawn',
        targetTable: 'consent_records',
        targetId: row.id,
        after: { granted: false, consentScope: row.consentScope },
      })),
      {
        familyId,
        actor: actorUserId,
        actionTaken: 'co_parent_departed',
        targetTable: 'family_members',
        targetId: actorUserId,
        after: { role: 'co_parent', threadRetained: retained.length },
      },
    ]);

    return {
      outcome: 'departed',
      channelRevoked: revokedChannels.length,
      membershipRemoved: true,
      consentWithdrawn: withdrawals.length,
      threadRetained: retained.length,
    };
  });
}
