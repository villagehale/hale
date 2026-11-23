import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { createOutboundTransport, linqRefusedForCertain } from '~/lib/channel/outbound-transport';
import { type OpsPagerOutcome, pageOps } from '~/lib/monitoring/failure-page';
import { type CaregiverInvite, INVITE_SEND_FAILED_VERB } from './invites';

/** The transport for a send to anyone but the person whose chat this turn is bound to. */
export function transportToPerson(transport: ChannelTransport): ChannelTransport {
  return transport.boundToChat ? createOutboundTransport() : transport;
}

/**
 * Linq did not accept an invite this turn had moved to `awaiting_caregiver_reply`. Only a
 * certain refusal closes the row: nothing landed, so the parent can invite again. Anything
 * unclear may have reached the phone, so the row stays exactly as if it was sent, where the
 * person's yes, no and stop all work and it lapses on its normal clock.
 */
export async function settleFailedInviteSend(
  database: Database,
  invite: CaregiverInvite,
  err: unknown,
  now: Date,
): Promise<OpsPagerOutcome> {
  const refused = linqRefusedForCertain(err);
  const why = refused ? 'refused' : 'unclear';
  const opsPage = await pageOps(database, {
    site: 'third_party_invite_unsent',
    facts: { lane: invite.role === 'co_parent' ? 'co_parent' : 'caregiver', why },
    ref: invite.id,
  });
  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const closed = refused
      ? await tx
          .update(schema.caregiverInvites)
          .set({ state: 'expired_unsent', closedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.caregiverInvites.id, invite.id),
              eq(schema.caregiverInvites.state, 'awaiting_caregiver_reply'),
              isNull(schema.caregiverInvites.closedAt),
            ),
          )
          .returning({ id: schema.caregiverInvites.id })
      : [];
    await tx.insert(schema.auditLog).values({
      familyId: invite.familyId,
      actor: invite.invitedByUserId,
      actionTaken: INVITE_SEND_FAILED_VERB,
      targetTable: 'caregiver_invites',
      targetId: invite.id,
      after: { role: invite.role, why, opsPage, closedUnsent: closed.length === 1 },
    });
  });
  return opsPage;
}
