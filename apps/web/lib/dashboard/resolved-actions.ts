import { type Database, schema } from '@hale/db';
import { type SQL, and, desc, eq } from 'drizzle-orm';
import { type TeenAccessUnlocks, redactsTeenContent } from '~/lib/teen-access';
import type { HistoryActionRow } from './history';
import { effectiveTeenContent } from './mappers';

/**
 * A family's resolved actions inside `scope`, newest-resolved first, with the rule-#1
 * redaction already applied (event for teen_content, child for DOB), so a 13+ child's
 * raw payload never reaches a caller that maps these rows to a view. Session-free: the
 * caller resolves the family, the viewer's unlocks and the scope. One body for the
 * Approvals history and "What Hale did", so the two can never drift apart on teen
 * content.
 *
 * The 50-row window mirrors the pending queue and the trail; a keyset page isn't
 * wired yet, so this reads the most recent 50 by draftedAt.
 */

export interface ResolvedActionRow {
  row: HistoryActionRow;
  executorResult: Record<string, unknown> | null;
}

export async function readResolvedActionRows(
  database: Database,
  input: { familyId: string; scope: SQL; unlocks: TeenAccessUnlocks; familyHasTeen: boolean },
): Promise<ResolvedActionRow[]> {
  const { familyId, scope, unlocks, familyHasTeen } = input;
  const rows = await database
    .select({
      id: schema.actions.id,
      actionType: schema.actions.actionType,
      payload: schema.actions.payload,
      reviewerVerdict: schema.actions.reviewerVerdict,
      reviewerVerdictAt: schema.actions.reviewerVerdictAt,
      draftedAt: schema.actions.draftedAt,
      userVisibleState: schema.actions.userVisibleState,
      executedAt: schema.actions.executedAt,
      revertedAt: schema.actions.revertedAt,
      revertedReason: schema.actions.revertedReason,
      executorResult: schema.actions.executorResult,
      teenContent: schema.events.teenContent,
      contentProvenance: schema.events.contentProvenance,
      childId: schema.events.childId,
      childName: schema.children.name,
      childDob: schema.children.dateOfBirth,
    })
    .from(schema.actions)
    .innerJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
    .leftJoin(schema.children, eq(schema.events.childId, schema.children.id))
    .where(and(eq(schema.actions.familyId, familyId), scope))
    .orderBy(desc(schema.actions.draftedAt))
    .limit(50);
  return (
    rows
      .map((row) => {
        // The "when" stamp is the terminal instant: executed / reverted / reviewer
        // verdict, falling back to draftedAt (always present) — a display default at
        // an explicit boundary, not a masked null.
        const resolvedAt =
          row.revertedAt ?? row.executedAt ?? row.reviewerVerdictAt ?? row.draftedAt;
        const historyRow: HistoryActionRow = {
          id: row.id,
          actionType: row.actionType,
          payload: row.payload,
          reviewerVerdict: row.reviewerVerdict,
          draftedAt: row.draftedAt,
          teenContent: redactsTeenContent(
            effectiveTeenContent(
              row.teenContent,
              row.childDob ?? null,
              familyHasTeen,
              row.contentProvenance,
            ),
            row.childId ?? null,
            'message_content',
            unlocks,
          ),
          childId: row.childId ?? null,
          childLabel: row.childName ?? null,
          userVisibleState: row.userVisibleState as HistoryActionRow['userVisibleState'],
          executedAt: row.executedAt,
          revertedReason: row.revertedReason,
          resolvedAt,
        };
        return { row: historyRow, executorResult: row.executorResult ?? null };
      })
      // Newest RESOLVED first — the query orders by draftedAt (indexed), but the
      // resolved instant is what the list reads by, so re-sort on it here.
      .sort((a, b) => b.row.resolvedAt.getTime() - a.row.resolvedAt.getTime())
  );
}
