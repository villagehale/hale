import { type Database, schema } from '@hale/db';
import { lt } from 'drizzle-orm';
import type { RelayTicket } from './relay-token';

/**
 * Voice v1 — claiming a call, so a ticket can only be spent once.
 *
 * relay-token.ts makes the ticket unforgeable and short-lived. Neither property makes it
 * single-use, and it is a bearer string in a url a third party logs: within its window,
 * whoever holds a copy can connect and be believed. This is the other half — the first
 * socket to present a ticket for a call gets it, and every later one is refused before
 * anything is read.
 *
 * THE INSERT IS THE CLAIM. Not a select-then-insert, which is two statements with a race
 * between them, and not an in-process set, which is one instance's opinion in a fleet
 * that has many (Vercel Fluid). The unique index decides, atomically, and losing it is a
 * plain empty `returning`. Same idiom as the outbound-send and provider-incident claims.
 *
 * A LOST CLAIM IS A SECURITY EVENT WITH A KNOWN SUBJECT, so unlike a forged connect —
 * which has no verified identity and gets a log line — it leaves an audit_log row on the
 * family the ticket named. The actor is 'system': the parent in the ticket is who the
 * connection CLAIMED to be, and writing their id in the actor column would put an act
 * they did not commit in their own trail (rule #6 is about a true record, not a full one).
 */

/**
 * Long enough that no live call can outlast it — the session caps a call at nine minutes
 * and the platform at 800 seconds — and short enough that the table stays a day of calls.
 * Retention is housekeeping only; the exactly-once property is the unique index's, never
 * the sweep's.
 */
const CLAIM_RETENTION_HOURS = 24;

/** True for the first socket to present a ticket for this call, false for every one
 * after it. */
export async function claimRelayCall(
  database: Database,
  ticket: RelayTicket,
  at: Date,
): Promise<boolean> {
  await database
    .delete(schema.voiceRelayClaims)
    .where(
      lt(
        schema.voiceRelayClaims.claimedAt,
        new Date(at.getTime() - CLAIM_RETENTION_HOURS * 3_600_000),
      ),
    );

  const claimed = await database
    .insert(schema.voiceRelayClaims)
    .values({ callSid: ticket.callSid, claimedAt: at })
    .onConflictDoNothing({ target: schema.voiceRelayClaims.callSid })
    .returning({ id: schema.voiceRelayClaims.id });

  if (claimed.length > 0) return true;

  await database.insert(schema.auditLog).values({
    familyId: ticket.familyId,
    actor: 'system',
    actionTaken: 'voice_relay_ticket_replayed',
    // The claim row that refused this replay. Its table keys on call sid, so the sid
    // IS the row's identity — a traceability query can walk straight to the winner.
    targetTable: 'voice_relay_claims',
    targetId: ticket.callSid,
    after: { callSid: ticket.callSid, ticketParentUserId: ticket.parentUserId },
    occurredAt: at,
  });
  return false;
}
