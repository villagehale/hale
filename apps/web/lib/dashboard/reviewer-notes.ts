import { type Database, schema } from '@hale/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { HumanApproval } from './action-review';
import type { ActorResolver } from './mappers';

/**
 * The two facts about a draft that live ONLY in the audit trail, read for a batch of
 * action ids in one query.
 *
 * There is no reviewer-reasoning column on `actions`: both persistence sites
 * (apps/worker memory-writer.recordReviewerVerdict, apps/web pipeline/record.recordVerdict)
 * put the reviewer's `rationale` into the verdict audit row's `after` blob and nowhere
 * else. Likewise a parent's approval writes no column — approve.ts only enqueues, and
 * `action.approved_by_human` is minted later by whoever drains the queue. So the audit
 * log is the source of truth for both, and this is the one reader that asks it.
 *
 * Family-scoped like every other dashboard read: the caller already resolved the
 * family, and the query pins `family_id` so an action id from elsewhere reads empty.
 */

/**
 * The verdict rows, both dialects. The worker writes `action.reviewer.<enum value>`;
 * the web draft pipeline writes `action.reviewed.<verdict kind>`. A surface that knew
 * only one dialect would silently show no reasoning for half the product's drafts.
 */
const REVIEWER_VERDICT_VERBS = [
  'action.reviewer.approved',
  'action.reviewer.rejected',
  'action.reviewer.flagged',
  'action.reviewed.approve',
  'action.reviewed.reject',
  'action.reviewed.flag_for_human',
] as const;

const HUMAN_APPROVAL_VERB = 'action.approved_by_human';

export interface ActionAuditFacts {
  /** The reviewer's own sentence, or null when it recorded none. */
  note: string | null;
  /** The recorded human approval, or null when nobody has approved yet. */
  approval: HumanApproval | null;
}

export const NO_AUDIT_FACTS: ActionAuditFacts = { note: null, approval: null };

/** `after.rationale`, when the stored blob actually carries a non-empty string. */
function rationaleOf(after: unknown): string | null {
  if (typeof after !== 'object' || after === null) return null;
  const rationale = (after as { rationale?: unknown }).rationale;
  return typeof rationale === 'string' && rationale.trim() ? rationale.trim() : null;
}

/**
 * The reviewer note + human approval for each of `actionIds`, keyed by action id.
 *
 * Rows are read oldest-first and written into the map as they come, so a re-review
 * (a second verdict row for the same draft) leaves the LATEST rationale standing —
 * the one that describes the draft as it is now.
 */
export async function loadActionAuditFacts(
  database: Database,
  familyId: string,
  actionIds: string[],
  resolveActor: ActorResolver,
): Promise<Map<string, ActionAuditFacts>> {
  const facts = new Map<string, ActionAuditFacts>();
  if (actionIds.length === 0) return facts;

  const rows = await database
    .select({
      targetId: schema.auditLog.targetId,
      actionTaken: schema.auditLog.actionTaken,
      actor: schema.auditLog.actor,
      after: schema.auditLog.after,
      occurredAt: schema.auditLog.occurredAt,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.targetTable, 'actions'),
        inArray(schema.auditLog.targetId, actionIds),
        inArray(schema.auditLog.actionTaken, [...REVIEWER_VERDICT_VERBS, HUMAN_APPROVAL_VERB]),
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));

  for (const row of rows) {
    const key = row.targetId;
    if (key === null) continue;
    const current = facts.get(key) ?? { note: null, approval: null };
    if (row.actionTaken === HUMAN_APPROVAL_VERB) {
      facts.set(key, {
        ...current,
        approval: { at: row.occurredAt, actor: resolveActor(row.actor) },
      });
      continue;
    }
    const note = rationaleOf(row.after);
    if (note !== null) facts.set(key, { ...current, note });
    else facts.set(key, current);
  }

  return facts;
}
