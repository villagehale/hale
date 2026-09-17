import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { POLICY_VERSION } from '~/lib/consent';
import { appendMcpGrantWithdrawals } from '~/lib/mcp/oauth-store';
import { revokeTeenAccessGrantsForDepartingMember } from '~/lib/teen-access';

/**
 * VIL-355 · one parent leaves, and the household keeps its record.
 *
 * `runDeletionSweep` (`rights/delete.ts`) erases a FAMILY: every row, every byte, one
 * cascade. There was no other door, so a co-parent asking to be erased could only ever
 * be answered by deleting the children's whole history — including the primary parent's,
 * who did not ask for anything. This is the per-ACTOR door.
 *
 * WHAT LEAVING HAS TO MEAN. The seat was never the only way into this household, and a
 * departure that removed only the seat left three live reads standing: an MCP bearer
 * grant (30-day TTL, and `verifyMcpBearer` never joined `family_members`), a Gmail or
 * Calendar connector (swept by provider and status, with no membership check), and any
 * teen-access grant, which is keyed on the reader rather than on their seat. So the
 * transaction ends EVERY standing access this actor holds in this family, and the tally
 * counts each one separately — a single number would let a missed door hide inside a
 * non-zero total.
 *
 * WHAT IT LEAVES BEHIND, DELIBERATELY, AND SAYS SO. `family_memory_facts` are the
 * HOUSEHOLD's record, not this parent's — the bedtime, the allergy, the sitter's name —
 * and they were never provenanced per author (VIL-353 is where that would come from).
 * Their thread (`channel-sms:<userId>`) is family-scoped too. Their `users` row, the
 * revoked `parent_channels` row holding their encrypted number, and the
 * `caregiver_invites` row that authorised the one text Hale sent them all survive: the
 * number is the EVIDENCE of express consent, which CASL requires be producible for
 * three years after it ends, and erasing it would destroy the only proof that the
 * message Hale sent was lawful. Every one of those is a COUNT in the return value
 * rather than a silence (rule #11), and the route hands the whole tally to the person
 * who asked, so an erasure request is never answered with only the good news.
 *
 * FOLLOW-UP, NAMED HERE BECAUSE NOTHING ELSE NAMES IT. When this was their only
 * household, `users` has no family FK and `runDeletionSweep` only ever deletes families,
 * so the row is orphaned with no path that will ever remove it. An orphan-user erasure
 * sweep, on the retention clock the encrypted number is held under, is a separate
 * change — it is not something this door can do, and pretending otherwise by deleting
 * the row early would take the consent evidence with it.
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
  /** Live MCP bearer grants closed — the connected-assistant door into this family. */
  mcpGrantsRevoked: number;
  /** Their user-scoped connectors (Gmail/Calendar/Drive) disconnected, tokens purged. */
  connectorsRevoked: number;
  /** Teen raw-content windows closed — rule #1's named exception, held by THEM. */
  teenGrantsRevoked: number;
  membershipRemoved: true;
  /** `granted=false` rows appended — one per messaging scope that was still standing. */
  consentWithdrawn: number;
  /** ── kept on purpose, each named rather than absent (rule #11) ─────────────── */
  /** Threads left alone: family-scoped, and the household's own record. */
  threadRetained: number;
  /** Revoked `parent_channels` rows kept — the CASL evidence of express consent. */
  channelRecordRetained: number;
  /** `caregiver_invites` rows kept — the authorisation for the text Hale sent them. */
  inviteRecordRetained: number;
  /** Their `users` row is never deleted here; no per-user erasure sweep exists yet. */
  identityRetained: true;
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

    // Each of these is a live READ into the children's data that outlives the seat by
    // its own clock, so each is closed here and counted on its own. `revoked_at IS NULL`
    // / `status <> 'revoked'` keeps an already-closed door closed at its ORIGINAL date —
    // re-stamping it would move the instant a CASL or PIPEDA read is taken against.
    const revokedGrants = await tx
      .update(schema.mcpGrants)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.mcpGrants.familyId, familyId),
          eq(schema.mcpGrants.userId, actorUserId),
          isNull(schema.mcpGrants.revokedAt),
        ),
      )
      .returning({
        id: schema.mcpGrants.id,
        clientId: schema.mcpGrants.clientId,
        scopes: schema.mcpGrants.scopes,
      });
    // Closing the grant ends the access; the ledger is what a consent list and a PIPEDA
    // access read answer from, and it is the MCP door's own half of the revocation
    // rather than this one's invention — so it is written by the module that owns it.
    await appendMcpGrantWithdrawals(tx, {
      userId: actorUserId,
      familyId,
      grants: revokedGrants,
      grantedAt: now,
    });

    const revokedConnectors = await tx
      .update(schema.integrations)
      .set({ oauthTokensEncrypted: null, status: 'revoked', updatedAt: now })
      .where(
        and(
          eq(schema.integrations.familyId, familyId),
          eq(schema.integrations.userId, actorUserId),
          ne(schema.integrations.status, 'revoked'),
        ),
      )
      .returning({ id: schema.integrations.id, provider: schema.integrations.provider });

    // Asked for by name rather than done here, and that is structural: `lib/channel` is
    // banned from the teen-grant machinery (`teen-access-outbound.test.ts`), because an
    // outbound tree that can reach the grant reader can leak unlocked teen content. The
    // module that owns the table closes the windows — enforcement row, consent ledger
    // and audit row together — inside this transaction. This ONE write-only symbol is
    // exempted there by name, for this file only; anything else teen-shaped in here
    // still fails the check.
    const teenGrantsRevoked = await revokeTeenAccessGrantsForDepartingMember(tx, {
      familyId,
      userId: actorUserId,
      now,
    });

    // ── what is KEPT, counted so the answer can say it out loud ──────────────
    const retainedChannels = await tx
      .select({
        id: schema.parentChannels.id,
        phoneE164Hash: schema.parentChannels.phoneE164Hash,
      })
      .from(schema.parentChannels)
      .where(
        and(
          eq(schema.parentChannels.userId, actorUserId),
          eq(schema.parentChannels.familyId, familyId),
        ),
      );
    const hashes = retainedChannels.map((row) => row.phoneE164Hash);
    const retainedInvites =
      hashes.length === 0
        ? []
        : await tx
            .select({ id: schema.caregiverInvites.id })
            .from(schema.caregiverInvites)
            .where(
              and(
                eq(schema.caregiverInvites.familyId, familyId),
                inArray(schema.caregiverInvites.phoneE164Hash, hashes),
              ),
            );
    const retainedThreads = await tx
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
    //
    // The verbs are the departure's OWN, not the ones each door writes when a parent
    // closes it by hand. Reusing those looked like thrift and was a false claim about
    // the reader: this family's trail is read by the parent who STAYED, the actor has no
    // seat any more so it renders under Hale's byline (buildActorResolver), and the
    // house sentences are first person — "you turned off texting with Hale" about
    // somebody else's number. The reason lives in `after` and nothing renders `after`,
    // so it has to be in the verb.
    await tx.insert(schema.auditLog).values([
      ...revokedChannels.map((channel) => ({
        familyId,
        actor: actorUserId,
        actionTaken: 'co_parent_channel_sms_revoked',
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
      ...revokedGrants.map((grant) => ({
        familyId,
        actor: actorUserId,
        actionTaken: 'co_parent_mcp_grant_revoked',
        targetTable: 'mcp_grants',
        targetId: grant.id,
        after: { clientId: grant.clientId, reason: 'co_parent_departed' },
      })),
      ...revokedConnectors.map((connector) => ({
        familyId,
        actor: actorUserId,
        actionTaken: 'co_parent_integration_revoked',
        targetTable: 'integrations',
        targetId: connector.id,
        after: { provider: connector.provider, reason: 'co_parent_departed' },
      })),
      {
        familyId,
        actor: actorUserId,
        actionTaken: 'co_parent_departed',
        targetTable: 'family_members',
        targetId: actorUserId,
        after: { role: 'co_parent', threadRetained: retainedThreads.length },
      },
    ]);

    return {
      outcome: 'departed',
      channelRevoked: revokedChannels.length,
      mcpGrantsRevoked: revokedGrants.length,
      connectorsRevoked: revokedConnectors.length,
      teenGrantsRevoked,
      membershipRemoved: true,
      consentWithdrawn: withdrawals.length,
      threadRetained: retainedThreads.length,
      channelRecordRetained: retainedChannels.length,
      inviteRecordRetained: retainedInvites.length,
      identityRetained: true,
    };
  });
}
