import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { type DeferredCapability, capabilityLit, isDeferredCapability } from './registry';

/**
 * VIL-303 · the denials Hale said out loud, and the corrections that closed them.
 *
 * SEND-TIME ONLY, like the promise ledger (commitments/ledger.ts): a no is recorded
 * against the outbound message that carried it, so a reply that never reached a
 * transport told nobody anything and owes nobody a correction. The same holds for the
 * correction: it closes only once the message that said it has been sent.
 *
 * Nothing in here throws. It runs after the parent already has the text, where an
 * exception buys a carrier retry and a duplicate reply (rule #11).
 */

/** What one turn said about the deferred capabilities. Both lists empty is not a value
 * a turn carries: it carries null instead. */
export interface CapabilityNotes {
  /** Capabilities this reply told the parent are not something Hale can do yet. */
  declined: DeferredCapability[];
  /** Capabilities whose earlier no this reply corrected. */
  corrected: DeferredCapability[];
}

export type CapabilityNotesOutcome =
  | { status: 'recorded'; declined: number; corrected: number }
  | { status: 'not_recorded'; reason: 'no_ledger_row' | 'write_failed' };

/** An earlier no that is now false: the capability is lit for this family. */
export interface OwedCorrection {
  capability: DeferredCapability;
  /** The UTC day Hale said no, YYYY-MM-DD. */
  toldOn: string;
}

function pgErrorCode(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof err.code === 'string'
    ? err.code
    : 'unknown';
}

export async function recordCapabilityNotes(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    notes: CapabilityNotes;
    channelMessageId: string | null;
    now: Date;
  },
): Promise<CapabilityNotesOutcome> {
  if (input.channelMessageId === null) {
    console.error(
      { declined: input.notes.declined.length, corrected: input.notes.corrected.length },
      'capabilities: notes on a reply with no ledger row - not recorded',
    );
    return { status: 'not_recorded', reason: 'no_ledger_row' };
  }
  const messageId = input.channelMessageId;
  try {
    return await database.transaction(async (tx) => {
      let declined = 0;
      let corrected = 0;
      for (const capability of new Set(input.notes.declined)) {
        const [row] = await tx
          .insert(schema.capabilityDenials)
          .values({
            familyId: input.familyId,
            userId: input.parentUserId,
            capability,
            deniedIn: messageId,
            deniedAt: input.now,
          })
          // One open no per parent and capability: saying it twice owes one correction.
          .onConflictDoNothing()
          .returning({ id: schema.capabilityDenials.id });
        if (!row) continue;
        declined += 1;
        await tx.insert(schema.auditLog).values({
          familyId: input.familyId,
          actor: 'system',
          actionTaken: 'capability_denial_recorded',
          audience: input.parentUserId,
          targetTable: 'capability_denials',
          targetId: row.id,
          after: { capability },
        });
      }
      for (const capability of new Set(input.notes.corrected)) {
        const rows = await tx
          .update(schema.capabilityDenials)
          .set({ correctedAt: input.now, correctedBy: messageId })
          .where(
            and(
              eq(schema.capabilityDenials.familyId, input.familyId),
              eq(schema.capabilityDenials.userId, input.parentUserId),
              eq(schema.capabilityDenials.capability, capability),
              isNull(schema.capabilityDenials.correctedAt),
            ),
          )
          .returning({ id: schema.capabilityDenials.id });
        for (const row of rows) {
          corrected += 1;
          await tx.insert(schema.auditLog).values({
            familyId: input.familyId,
            actor: 'system',
            actionTaken: 'capability_denial_corrected',
            audience: input.parentUserId,
            targetTable: 'capability_denials',
            targetId: row.id,
            after: { capability, correctedBy: messageId },
          });
        }
      }
      return { status: 'recorded' as const, declined, corrected };
    });
  } catch (err) {
    console.error(
      { code: pgErrorCode(err) },
      'capabilities: notes write failed - a no or its correction is unrecorded',
    );
    return { status: 'not_recorded', reason: 'write_failed' };
  }
}

/**
 * This parent's open denials whose capability is real now. Keys the registry no longer
 * knows are skipped: a capability that was dropped has nothing to correct to.
 */
export async function loadOwedCorrections(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<OwedCorrection[]> {
  const rows = await database
    .select({
      capability: schema.capabilityDenials.capability,
      deniedAt: schema.capabilityDenials.deniedAt,
    })
    .from(schema.capabilityDenials)
    .where(
      and(
        eq(schema.capabilityDenials.familyId, input.familyId),
        eq(schema.capabilityDenials.userId, input.parentUserId),
        isNull(schema.capabilityDenials.correctedAt),
      ),
    )
    .orderBy(schema.capabilityDenials.deniedAt);
  return rows.flatMap((row) =>
    isDeferredCapability(row.capability) && capabilityLit(row.capability, input.familyId)
      ? [{ capability: row.capability, toldOn: row.deniedAt.toISOString().slice(0, 10) }]
      : [],
  );
}
