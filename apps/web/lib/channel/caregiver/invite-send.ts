import { type Database, schema } from '@hale/db';
import { and, eq, isNull, ne, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import {
  AMBIGUOUS_SEND_CODES,
  createOutboundTransport,
  readSendRefusal,
} from '~/lib/channel/outbound-transport';
import { pageOps } from '~/lib/monitoring/failure-page';
import type { CaregiverInvite } from './invites';

/** The transport for a send to anyone but the person whose chat this turn is bound to. */
export function transportToPerson(transport: ChannelTransport): ChannelTransport {
  return transport.boundToChat ? createOutboundTransport() : transport;
}

/**
 * Linq did not accept an invite this turn had moved to `awaiting_caregiver_reply`. The row
 * goes back to the parent, so only their next yes retries it. It stays put when somebody
 * answered meanwhile, or the parent opened a newer ask: a second pending row would let a
 * bare yes bind to the wrong person.
 */
export async function settleFailedInviteSend(
  database: Database,
  invite: CaregiverInvite,
  err: unknown,
  now: Date,
): Promise<void> {
  const newer = alias(schema.caregiverInvites, 'newer_invite');
  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const returned = await tx
      .update(schema.caregiverInvites)
      .set({ state: 'awaiting_parent_assent', updatedAt: now })
      .where(
        and(
          eq(schema.caregiverInvites.id, invite.id),
          eq(schema.caregiverInvites.state, 'awaiting_caregiver_reply'),
          isNull(schema.caregiverInvites.closedAt),
          notExists(
            tx
              .select({ id: newer.id })
              .from(newer)
              .where(
                and(
                  eq(newer.invitedByUserId, invite.invitedByUserId),
                  eq(newer.state, 'awaiting_parent_assent'),
                  isNull(newer.closedAt),
                  ne(newer.id, invite.id),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.caregiverInvites.id });
    await tx.insert(schema.auditLog).values({
      familyId: invite.familyId,
      actor: invite.invitedByUserId,
      actionTaken: 'third_party_invite_send_failed',
      targetTable: 'caregiver_invites',
      targetId: invite.id,
      after: { role: invite.role, returnedToParent: returned.length === 1 },
    });
  });
  const code = readSendRefusal(err)?.code;
  await pageOps(database, {
    site: 'third_party_invite_unsent',
    facts: {
      lane: invite.role === 'co_parent' ? 'co_parent' : 'caregiver',
      why: code !== undefined && !AMBIGUOUS_SEND_CODES.has(code) ? 'refused' : 'unclear',
    },
    ref: invite.id,
  });
}
