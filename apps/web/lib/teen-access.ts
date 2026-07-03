import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';

/**
 * Teen raw-content access — the rule #1 NAMED EXCEPTION. A parent may request to
 * see a 13+ teen's redacted content, but only via an EXPLICIT, LOGGED, TIME-LIMITED
 * grant that NOTIFIES the teen. This module writes the REQUEST side:
 *
 *   - a consent_records row of type teen_content_access, granted=false (a request,
 *     not yet a grant), scoped to the action, with an expiry (time-limited); and
 *   - an immutable audit_log row (rule #6) targeting that consent row, actor = the
 *     requesting parent — so PIPEDA right-to-access answers "which parent asked".
 *
 * Both commit in ONE transaction, then the teen is notified. The CONSUME side
 * (teen approves → granted=true; a read honours an active, unexpired grant) is a
 * deliberate follow-up — the affordance and the audited request are real now.
 */

/** How long a granted request stays valid — the time-limited window (rule #1). */
export const GRANT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves the 13+ teen an approval row concerns, family-scoped: action → event →
 * child, confirming the action belongs to `familyId` (rule #1, fail closed — a
 * foreign action resolves to null). Returns the teen's child id ONLY when the
 * concerns-child is a teenager (age-derived via deriveStage, never the classifier
 * flag) — a request to unlock content only makes sense for a redacted teen row.
 * Null when the action isn't this family's, names no child, or the child isn't 13+.
 */
export async function resolveActionTeenChild(
  database: Database,
  familyId: string,
  actionId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const rows = await database
    .select({
      childId: schema.events.childId,
      childDob: schema.children.dateOfBirth,
    })
    .from(schema.actions)
    .innerJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
    .leftJoin(schema.children, eq(schema.events.childId, schema.children.id))
    .where(and(eq(schema.actions.id, actionId), eq(schema.actions.familyId, familyId)))
    .limit(1);

  const row = rows[0];
  if (!row?.childId || !row.childDob) return null;
  if (deriveStage(row.childDob, now) !== 'teenager') return null;
  return row.childId;
}

export interface TeenContentAccessRequest {
  familyId: string;
  /** The parent making the request (users.id) — the audit actor. */
  parentUserId: string;
  /** The 13+ child whose content is redacted (children.id) — the teen to notify. */
  teenChildId: string;
  /** The approval/action the request is scoped to (consent_scope). */
  actionId: string;
}

/** The teen notification the named exception requires. Carries NO raw content —
 * only the child + the consent row, so the teen can be told a request exists. */
export interface TeenAccessNotification {
  teenChildId: string;
  consentId: string;
}

export type TeenNotifier = (notification: TeenAccessNotification) => Promise<void>;

export interface RequestTeenContentAccessDeps {
  notifyTeen: TeenNotifier;
  now?: Date;
}

/**
 * Stub teen notifier. The teen-facing account/channel and the push copy are not
 * wired yet (a follow-up alongside the consume side); this makes the notification
 * dispatch a real, awaited seam without addressing a device. Never logs content.
 */
export const stubTeenNotifier: TeenNotifier = async () => {
  // Intentionally a no-op until the teen channel exists — the request + audit are
  // the load-bearing parts; the notification copy/target lands with the consume side.
};

export function defaultTeenAccessDeps(): RequestTeenContentAccessDeps {
  return { notifyTeen: stubTeenNotifier };
}

/**
 * Records the parent's time-limited request to see a teen's redacted content, plus
 * its audit row, in one transaction (rule #6), then notifies the teen. Returns the
 * new consent row id. Errors bubble (rule #8) — a failed write must not silently
 * present as a granted request.
 */
export async function requestTeenContentAccess(
  database: Database,
  request: TeenContentAccessRequest,
  deps: RequestTeenContentAccessDeps = defaultTeenAccessDeps(),
): Promise<{ consentId: string }> {
  const now = deps.now ?? new Date();
  const expiresAt = new Date(now.getTime() + GRANT_WINDOW_MS);

  const consentId = await database.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.consentRecords)
      .values({
        userId: request.parentUserId,
        familyId: request.familyId,
        consentType: 'teen_content_access',
        granted: false,
        consentScope: request.actionId,
        policyVersion: POLICY_VERSION,
        expiresAt,
      })
      .returning({ id: schema.consentRecords.id });

    const id = inserted[0]?.id;
    if (!id) {
      throw new Error('requestTeenContentAccess: consent insert returned no row');
    }

    await tx.insert(schema.auditLog).values({
      familyId: request.familyId,
      actor: request.parentUserId,
      actionTaken: 'teen_content_access.requested',
      targetTable: 'consent_records',
      targetId: id,
      after: { actionId: request.actionId, teenChildId: request.teenChildId, expiresAt },
    });

    return id;
  });

  await deps.notifyTeen({ teenChildId: request.teenChildId, consentId });

  return { consentId };
}
