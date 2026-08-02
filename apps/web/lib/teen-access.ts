import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';

/**
 * VIL-147 · Teen raw-content access — the rule #1 NAMED EXCEPTION, whole.
 *
 * A parent may read a 13+ teen's raw content ONLY under an explicit, logged,
 * time-limited, teen-assented grant — exactly what the privacy page promises. This
 * module owns both halves:
 *
 *   WRITE  requestTeenAccessGrant → recordTeenAssent | openTeenSafetyEscalation
 *          → revokeTeenAccessGrant. Every transition writes an immutable audit_log
 *          row (rule #6) and, where it is a consent decision, a consent_records row
 *          (the append-only PIPEDA/CASL ledger). The grant table is the ENFORCEMENT
 *          source of truth; consent_records is the compliance ledger — the same
 *          split mcp_grants uses.
 *
 *   READ   loadTeenAccessUnlocks → redactsTeenContent. ONE predicate, consulted by
 *          every parent-facing surface. With no grant it returns today's behaviour
 *          byte-for-byte, so absent this feature nothing changes anywhere.
 *
 * CHANNEL SCOPING (F14 verdict #8). A grant authorizes a scope + a duration, never
 * a blanket read — and its CHANNEL is always the authenticated in-app parent
 * session. No outbound path consults a grant: not email, SMS, push, ICS, a
 * third-party MCP read, or a public page. A grant is a disclosure to ONE parent on
 * ONE surface, not a downgrade of the teen's redaction everywhere. That invariant
 * is asserted by teen-access-outbound.test.ts.
 *
 * WHAT v1 ACTUALLY DOES. Hale cannot reach a teen at all — `children` has no contact
 * column and a teen has no `users` row — and telling the teen is a CONDITION of both
 * activation paths (assent is theirs to give; the safety escalation is permitted by
 * rule #1 only "where the teen is notified"). So today NO grant can become active:
 * a request is recorded and stays pending, and openTeenSafetyEscalation closes and
 * throws when its notice does not land. The bypass is blocked by code, not by the
 * absence of a button, so adding a UI cannot switch it on. The single follow-up that
 * unblocks the feature is a real teen notification channel.
 */

/** The closed scope vocabulary, sourced from the pg enum so the two cannot drift. */
export const TEEN_ACCESS_SCOPES = schema.teenAccessScopeEnum.enumValues;
export type TeenAccessScope = (typeof TEEN_ACCESS_SCOPES)[number];

export function isTeenAccessScope(value: string): value is TeenAccessScope {
  return (TEEN_ACCESS_SCOPES as readonly string[]).includes(value);
}

/**
 * The hard ceiling on a grant (rule #1 "time-limited"). Seven days is one Sunday-loop
 * cycle: long enough for a parent to actually act on what they were worried about,
 * short enough that continued access is a decision the teen re-makes every week
 * rather than a standing surveillance right they consented to once.
 */
export const MAX_GRANT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A safety escalation bypasses teen ASSENT, so it is held to the shortest window
 * that is still useful: the bypass buys time to handle a credible risk of harm, not
 * a week of unassented reading.
 */
export const SAFETY_ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The fields the active-grant decision is made from. Nothing else is consulted. */
export interface TeenGrantState {
  childId: string;
  scope: TeenAccessScope;
  teenAssentAt: Date | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  safetyEscalation: boolean;
}

/**
 * THE predicate. Pure and total, so every condition is exhaustively testable and a
 * mistake in any SQL WHERE clause can only ever narrow the candidate set, never
 * widen access — the query filters, this function decides.
 *
 * Fails closed on every axis: no assent (unless the declared safety escalation), no
 * activation window, a half-set window, a window that has not opened, one that has
 * closed, a revoked grant, or a window longer than its kind is allowed to be.
 */
export function isTeenGrantActive(grant: TeenGrantState, now: Date): boolean {
  if (grant.revokedAt !== null) return false;
  if (grant.teenAssentAt === null && !grant.safetyEscalation) return false;

  const { startsAt, expiresAt } = grant;
  if (startsAt === null || expiresAt === null) return false;
  if (now < startsAt) return false;
  if (now >= expiresAt) return false;

  const limit = grant.safetyEscalation ? SAFETY_ESCALATION_WINDOW_MS : MAX_GRANT_WINDOW_MS;
  if (expiresAt.getTime() - startsAt.getTime() > limit) return false;

  return true;
}

/** The bounded window a new activation gets. The only place a duration is chosen. */
export function boundGrantWindow(
  now: Date,
  safetyEscalation: boolean,
): { startsAt: Date; expiresAt: Date } {
  const span = safetyEscalation ? SAFETY_ESCALATION_WINDOW_MS : MAX_GRANT_WINDOW_MS;
  return { startsAt: now, expiresAt: new Date(now.getTime() + span) };
}

/**
 * The resolved unlock set for one parent, at one instant. Deliberately an opaque
 * membership test rather than a list: a caller cannot enumerate it, forget a
 * condition, and re-derive "active" for itself.
 */
export interface TeenAccessUnlocks {
  allows(childId: string, scope: TeenAccessScope): boolean;
}

/** The default every read falls back to: nothing is unlocked. */
export const NO_TEEN_UNLOCKS: TeenAccessUnlocks = { allows: () => false };

export function teenAccessUnlocksFrom(
  grants: readonly TeenGrantState[],
  now: Date,
): TeenAccessUnlocks {
  const active = new Set(
    grants
      .filter((grant) => isTeenGrantActive(grant, now))
      .map((grant) => `${grant.childId} ${grant.scope}`),
  );
  return { allows: (childId, scope) => active.has(`${childId} ${scope}`) };
}

/**
 * The ONE seam grant-awareness enters a parent-facing read through.
 *
 * `concernsTeen` stays the existing age-derived answer to "is this a 13+ child's
 * content?" (effectiveTeenContent and friends — untouched). This function answers
 * the different question the surfaces actually need: "must it be REDACTED?" — which
 * is the same thing until a grant exists.
 *
 * `unlocks` defaults to NO_TEEN_UNLOCKS, so any caller that has not been threaded,
 * or any new caller that forgets, gets today's behaviour rather than a leak.
 */
export function redactsTeenContent(
  concernsTeen: boolean,
  childId: string | null,
  scope: TeenAccessScope,
  unlocks: TeenAccessUnlocks = NO_TEEN_UNLOCKS,
): boolean {
  if (!concernsTeen) return false;
  // A row Hale could not attribute to a specific child cannot be shown to be the
  // granted teen's, so no grant can unlock it.
  if (childId === null) return true;
  return !unlocks.allows(childId, scope);
}

/** Candidate grants for one parent: family + viewer scoped, unrevoked. The pure
 * predicate re-checks assent, window and duration — this only narrows. */
function candidateGrantsQuery(database: Database, familyId: string, parentUserId: string) {
  return database
    .select({
      childId: schema.teenAccessGrants.childId,
      scope: schema.teenAccessGrants.scope,
      teenAssentAt: schema.teenAccessGrants.teenAssentAt,
      startsAt: schema.teenAccessGrants.startsAt,
      expiresAt: schema.teenAccessGrants.expiresAt,
      revokedAt: schema.teenAccessGrants.revokedAt,
      safetyEscalation: schema.teenAccessGrants.safetyEscalation,
    })
    .from(schema.teenAccessGrants)
    .where(
      and(
        eq(schema.teenAccessGrants.familyId, familyId),
        eq(schema.teenAccessGrants.grantedToUserId, parentUserId),
        isNull(schema.teenAccessGrants.revokedAt),
      ),
    );
}

/**
 * The unlock set for one parent's session. Called ONCE per read by the loader that
 * already pre-fetches family-level state (familyHasTeen), so the sync mappers stay
 * sync. A signed-out / family-less caller gets NO_TEEN_UNLOCKS.
 */
export async function loadTeenAccessUnlocks(
  database: Database,
  familyId: string,
  parentUserId: string | null,
  now: Date = new Date(),
): Promise<TeenAccessUnlocks> {
  if (parentUserId === null) return NO_TEEN_UNLOCKS;
  const rows = await candidateGrantsQuery(database, familyId, parentUserId);
  return teenAccessUnlocksFrom(rows, now);
}

/**
 * The single-pair form, for a guard that already knows the child and scope it is
 * deciding (the Ask Hale tool boundary). Shares the same query and the same pure
 * predicate as the batch form, so the two can never disagree.
 */
export async function activeTeenGrant(
  database: Database,
  lookup: {
    familyId: string;
    childId: string;
    scope: TeenAccessScope;
    parentUserId: string | null;
  },
  now: Date = new Date(),
): Promise<boolean> {
  const unlocks = await loadTeenAccessUnlocks(database, lookup.familyId, lookup.parentUserId, now);
  return unlocks.allows(lookup.childId, lookup.scope);
}

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

/** The teen notification rule #1 requires. Carries NO raw content — only who, what
 * scope, and why, so the teen learns a request exists without it leaking anything. */
export interface TeenAccessNotification {
  teenChildId: string;
  grantId: string;
  scope: TeenAccessScope;
  /** Set when the grant is already readable — the safety-escalation exception. */
  safetyEscalation: boolean;
}

/** Resolves to the channel the teen was reached on, or null when Hale has none. */
export type TeenNotifier = (notification: TeenAccessNotification) => Promise<string | null>;

/**
 * v1 teen notifier. `children` carries no contact column and a teen has no `users`
 * row, so there is genuinely NOWHERE to deliver — and inventing a channel would be
 * the dishonesty this ticket exists to fix. It returns null, which leaves
 * `teen_notified_at` NULL: the obligation stays OPEN, is visible on every grant row,
 * and is stated plainly to the parent in Settings. The audit row records the attempt
 * and its outcome either way (rule #6).
 */
export const undeliverableTeenNotifier: TeenNotifier = async () => null;

export interface TeenAccessDeps {
  notifyTeen: TeenNotifier;
  now?: Date;
}

export function defaultTeenAccessDeps(): TeenAccessDeps {
  return { notifyTeen: undeliverableTeenNotifier };
}

export interface TeenAccessGrantRequest {
  familyId: string;
  /** The parent asking — the audit actor, and the only viewer a grant unlocks for. */
  parentUserId: string;
  /** The 13+ child whose content is redacted (children.id) — the teen to notify. */
  teenChildId: string;
  scope: TeenAccessScope;
  /** The parent's stated reason. Required: "explicit" means they said why. */
  reason: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Records a parent's REQUEST to read a teen's raw content. This reveals nothing and
 * unlocks nothing: the row is written with no activation window, so the read
 * predicate cannot match it until the teen assents. Writes the grant row, its
 * consent-ledger row (granted=false — a request, not a grant) and its audit row in
 * ONE transaction, then notifies the teen. Errors bubble (rule #8).
 */
export async function requestTeenAccessGrant(
  database: Database,
  request: TeenAccessGrantRequest,
  deps: TeenAccessDeps = defaultTeenAccessDeps(),
): Promise<{ grantId: string }> {
  const now = deps.now ?? new Date();
  const reason = request.reason.trim();
  if (reason.length === 0) {
    throw new Error('requestTeenAccessGrant: a reason is required');
  }

  const grantId = await database.transaction(async (tx) => {
    const consentRows = await tx
      .insert(schema.consentRecords)
      .values({
        userId: request.parentUserId,
        familyId: request.familyId,
        consentType: 'teen_content_access',
        granted: false,
        consentScope: request.scope,
        policyVersion: POLICY_VERSION,
        ip: request.ip ?? null,
        userAgent: request.userAgent ?? null,
      })
      .returning({ id: schema.consentRecords.id });
    const consentRecordId = consentRows[0]?.id;
    if (!consentRecordId) {
      throw new Error('requestTeenAccessGrant: consent insert returned no row');
    }

    const grantRows = await tx
      .insert(schema.teenAccessGrants)
      .values({
        familyId: request.familyId,
        childId: request.teenChildId,
        grantedToUserId: request.parentUserId,
        scope: request.scope,
        reason,
        requestedAt: now,
        consentRecordId,
      })
      .returning({ id: schema.teenAccessGrants.id });
    const id = grantRows[0]?.id;
    if (!id) {
      throw new Error('requestTeenAccessGrant: grant insert returned no row');
    }

    await tx.insert(schema.auditLog).values({
      familyId: request.familyId,
      actor: request.parentUserId,
      actionTaken: 'teen_content_access.requested',
      targetTable: 'teen_access_grants',
      targetId: id,
      after: { teenChildId: request.teenChildId, scope: request.scope, reason },
    });

    return id;
  });

  await notifyTeenAndRecord(database, deps, {
    familyId: request.familyId,
    actor: request.parentUserId,
    grantId,
    teenChildId: request.teenChildId,
    scope: request.scope,
    safetyEscalation: false,
    now,
  });

  return { grantId };
}

/**
 * Dispatches the teen notification and records what actually happened. Kept in one
 * place so "the teen is notified" is a single, auditable act rather than something
 * each caller re-implements — and so a channel-less teen leaves an OPEN obligation
 * (teen_notified_at stays NULL) instead of a silently-satisfied one.
 */
async function notifyTeenAndRecord(
  database: Database,
  deps: TeenAccessDeps,
  input: {
    familyId: string;
    actor: string;
    grantId: string;
    teenChildId: string;
    scope: TeenAccessScope;
    safetyEscalation: boolean;
    now: Date;
  },
): Promise<string | null> {
  const channel = await deps.notifyTeen({
    teenChildId: input.teenChildId,
    grantId: input.grantId,
    scope: input.scope,
    safetyEscalation: input.safetyEscalation,
  });

  if (channel !== null) {
    await database
      .update(schema.teenAccessGrants)
      .set({ teenNotifiedAt: input.now, updatedAt: input.now })
      .where(eq(schema.teenAccessGrants.id, input.grantId));
  }

  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.actor,
    actionTaken: 'teen_content_access.teen_notified',
    targetTable: 'teen_access_grants',
    targetId: input.grantId,
    after: {
      scope: input.scope,
      safetyEscalation: input.safetyEscalation,
      delivered: channel !== null,
      channel,
    },
  });

  return channel;
}

/**
 * The teen assents (rule #5) — the ONLY non-escalation path to a readable grant.
 * Activation happens HERE, at assent, not at request time: a window that started
 * when the parent asked would silently burn down while the teen thought about it.
 * Writes the granted=true consent-ledger row and the audit row in one transaction.
 */
export async function recordTeenAssent(
  database: Database,
  input: { familyId: string; grantId: string; assentedBy: string },
  now: Date = new Date(),
): Promise<{ status: 'activated' } | { status: 'not_found' }> {
  const { startsAt, expiresAt } = boundGrantWindow(now, false);

  return database.transaction(async (tx) => {
    const updated = await tx
      .update(schema.teenAccessGrants)
      .set({ teenAssentAt: now, startsAt, expiresAt, updatedAt: now })
      .where(
        and(
          eq(schema.teenAccessGrants.id, input.grantId),
          eq(schema.teenAccessGrants.familyId, input.familyId),
          isNull(schema.teenAccessGrants.teenAssentAt),
          isNull(schema.teenAccessGrants.revokedAt),
        ),
      )
      .returning({
        id: schema.teenAccessGrants.id,
        childId: schema.teenAccessGrants.childId,
        scope: schema.teenAccessGrants.scope,
        grantedToUserId: schema.teenAccessGrants.grantedToUserId,
      });
    const grant = updated[0];
    if (!grant) return { status: 'not_found' };

    await tx.insert(schema.consentRecords).values({
      userId: grant.grantedToUserId,
      familyId: input.familyId,
      consentType: 'teen_content_access',
      granted: true,
      consentScope: grant.scope,
      policyVersion: POLICY_VERSION,
      expiresAt,
      evidence: { assentedBy: input.assentedBy, teenChildId: grant.childId },
    });

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.assentedBy,
      actionTaken: 'teen_content_access.assented',
      targetTable: 'teen_access_grants',
      targetId: grant.id,
      after: {
        scope: grant.scope,
        teenChildId: grant.childId,
        startsAt: startsAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    });

    return { status: 'activated' };
  });
}

export interface TeenSafetyEscalation {
  familyId: string;
  parentUserId: string;
  teenChildId: string;
  scope: TeenAccessScope;
  /** Required and typed: an escalation must state the credible risk, in words. */
  reason: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Rule #1's named exception: a credible risk of harm. Deliberately the HEAVIER
 * path — it is the only way to read a teen's content without their assent, so it
 * is activated immediately but held to the 24h window, always notifies the teen,
 * and demands a typed reason. Never a default and never reachable by omission:
 * the caller has to name this function.
 */
export async function openTeenSafetyEscalation(
  database: Database,
  input: TeenSafetyEscalation,
  deps: TeenAccessDeps = defaultTeenAccessDeps(),
): Promise<{ grantId: string; expiresAt: Date }> {
  const now = deps.now ?? new Date();
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error('openTeenSafetyEscalation: a typed reason is required');
  }
  const { startsAt, expiresAt } = boundGrantWindow(now, true);

  const grantId = await database.transaction(async (tx) => {
    const consentRows = await tx
      .insert(schema.consentRecords)
      .values({
        userId: input.parentUserId,
        familyId: input.familyId,
        consentType: 'teen_content_access',
        granted: true,
        consentScope: input.scope,
        policyVersion: POLICY_VERSION,
        expiresAt,
        evidence: { safetyEscalation: true, reason, teenChildId: input.teenChildId },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      })
      .returning({ id: schema.consentRecords.id });
    const consentRecordId = consentRows[0]?.id;
    if (!consentRecordId) {
      throw new Error('openTeenSafetyEscalation: consent insert returned no row');
    }

    const grantRows = await tx
      .insert(schema.teenAccessGrants)
      .values({
        familyId: input.familyId,
        childId: input.teenChildId,
        grantedToUserId: input.parentUserId,
        scope: input.scope,
        reason,
        safetyEscalation: true,
        requestedAt: now,
        startsAt,
        expiresAt,
        consentRecordId,
      })
      .returning({ id: schema.teenAccessGrants.id });
    const id = grantRows[0]?.id;
    if (!id) {
      throw new Error('openTeenSafetyEscalation: grant insert returned no row');
    }

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'teen_content_access.safety_escalation',
      targetTable: 'teen_access_grants',
      targetId: id,
      after: {
        teenChildId: input.teenChildId,
        scope: input.scope,
        reason,
        startsAt: startsAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    });

    return id;
  });

  const channel = await notifyTeenAndRecord(database, deps, {
    familyId: input.familyId,
    actor: input.parentUserId,
    grantId,
    teenChildId: input.teenChildId,
    scope: input.scope,
    safetyEscalation: true,
    now,
  });

  // Rule #1 permits this exception only "where the teen is notified". An escalation
  // whose notice did not land has not met that condition, so it must not stay open:
  // close it immediately (audited) and fail loudly rather than leave a parent reading
  // their teen's content on the strength of a notification nobody received.
  //
  // Today this ALWAYS fires, because Hale has no way to reach a teen at all — which
  // is the point. The assent bypass is blocked by code, not merely by the absence of
  // a button, so it cannot be switched on by adding a UI.
  if (channel === null) {
    await revokeTeenAccessGrant(
      database,
      { familyId: input.familyId, grantId, revokedBy: input.parentUserId },
      now,
    );
    throw new Error(
      'openTeenSafetyEscalation: the teen could not be notified, so the escalation was closed',
    );
  }

  return { grantId, expiresAt };
}

/** A parent (or the teen) closes an access window early. Idempotent: a grant that
 * is already revoked reports not_found rather than writing a second revocation. */
export async function revokeTeenAccessGrant(
  database: Database,
  input: { familyId: string; grantId: string; revokedBy: string },
  now: Date = new Date(),
): Promise<{ status: 'revoked' } | { status: 'not_found' }> {
  return database.transaction(async (tx) => {
    const updated = await tx
      .update(schema.teenAccessGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.teenAccessGrants.id, input.grantId),
          eq(schema.teenAccessGrants.familyId, input.familyId),
          isNull(schema.teenAccessGrants.revokedAt),
        ),
      )
      .returning({
        id: schema.teenAccessGrants.id,
        childId: schema.teenAccessGrants.childId,
        scope: schema.teenAccessGrants.scope,
        grantedToUserId: schema.teenAccessGrants.grantedToUserId,
      });
    const grant = updated[0];
    if (!grant) return { status: 'not_found' };

    await tx.insert(schema.consentRecords).values({
      userId: grant.grantedToUserId,
      familyId: input.familyId,
      consentType: 'teen_content_access',
      granted: false,
      consentScope: grant.scope,
      policyVersion: POLICY_VERSION,
      revokedAt: now,
      evidence: { revokedBy: input.revokedBy, teenChildId: grant.childId },
    });

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.revokedBy,
      actionTaken: 'teen_content_access.revoked',
      targetTable: 'teen_access_grants',
      targetId: grant.id,
      after: { scope: grant.scope, teenChildId: grant.childId },
    });

    return { status: 'revoked' };
  });
}

export interface TeenAccessGrantSummary {
  id: string;
  childId: string;
  scope: TeenAccessScope;
  reason: string;
  safetyEscalation: boolean;
  requestedAt: string;
  expiresAt: string | null;
  /** True only while the read predicate would actually honour this grant. */
  active: boolean;
  assented: boolean;
  revoked: boolean;
  /** False while Hale still owes this teen the notification rule #1 requires. */
  teenNotified: boolean;
}

/**
 * The parent-facing list behind the Settings section — every grant this parent has
 * asked for, in whatever state, so "explicit and logged" is something they can see
 * rather than something we assert. `active` is computed by the SAME pure predicate
 * the reads use, so the UI can never claim a grant is live when it is not.
 */
export async function listTeenAccessGrants(
  database: Database,
  familyId: string,
  parentUserId: string,
  now: Date = new Date(),
): Promise<TeenAccessGrantSummary[]> {
  const rows = await database
    .select()
    .from(schema.teenAccessGrants)
    .where(
      and(
        eq(schema.teenAccessGrants.familyId, familyId),
        eq(schema.teenAccessGrants.grantedToUserId, parentUserId),
      ),
    )
    .orderBy(desc(schema.teenAccessGrants.requestedAt))
    .limit(50);

  return rows.map((row) => ({
    id: row.id,
    childId: row.childId,
    scope: row.scope,
    reason: row.reason,
    safetyEscalation: row.safetyEscalation,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    active: isTeenGrantActive(row, now),
    assented: row.teenAssentAt !== null,
    revoked: row.revokedAt !== null,
    teenNotified: row.teenNotifiedAt !== null,
  }));
}
