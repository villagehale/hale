import { AGENT_TOOL_ACTION_PREFIX } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, notLike, sql } from 'drizzle-orm';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { type ActorResolver, type TrailView, effectiveTeenContent, toTrailView } from './mappers';

/**
 * A `tool:<name>` audit row is a Concierge agent tool-call SUB-STEP (written by
 * packages/agent), not a parent-facing action. It must never reach the trail —
 * neither the timeline nor the tally. Excluded in the query (below) so the row
 * window stays meaningful; this predicate is the shared definition.
 */
function isAgentToolStep(actionTaken: string): boolean {
  return actionTaken.startsWith(AGENT_TOOL_ACTION_PREFIX);
}

/**
 * Family-scoped, auth-free reads for the History trail (and the data export that
 * reuses it). Kept OUT of queries.ts — which is session/auth-bound — so a caller
 * that already holds an audited family id (the export) can reuse the identical
 * rule-#1 teen redaction without dragging Auth.js into its module graph. One body,
 * so the export can never drift open from the History page.
 */

/**
 * The family's display timezone — the primary parent's `users.timezone` — so every
 * stored instant renders in the family's zone rather than the server's (Vercel =
 * UTC). Falls back to DEFAULT_TIMEZONE when there's no primary parent yet.
 */
export async function readFamilyTimezone(database: Database, familyId: string): Promise<string> {
  const [row] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  return row?.timezone ?? DEFAULT_TIMEZONE;
}

/**
 * Whether the family has any child currently in the teenager stage (deriveStage
 * boundary 156mo). The rule-#1 double-miss fallback: when a row resolves to no
 * child, redact its raw content if the family has a teen.
 */
export async function familyHasTeenager(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows.some((c) => deriveStage(c.dateOfBirth) === 'teenager');
}

/**
 * Builds the trail's actor resolver from the family's member set: a stored
 * `audit_log.actor` uuid that MATCHES a member resolves to that member's role
 * ('you' for the primary, 'co-parent' otherwise); `'system'`, an agent-run uuid,
 * and any UNKNOWN uuid all resolve to Hale. This is the structural guardrail for
 * the actor rule — an id the family doesn't own is NEVER attributed to a human,
 * so Hale's own (agent-run) work and a departed user's actions can't masquerade
 * as the parent reading the trail.
 */
async function buildActorResolver(database: Database, familyId: string): Promise<ActorResolver> {
  const members = await database
    .select({ userId: schema.familyMembers.userId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const roleByUser = new Map(members.map((m) => [m.userId, m.role]));
  return (actor) => {
    const role = roleByUser.get(actor);
    if (role === undefined) return 'hale';
    return role === 'primary_parent' ? 'you' : 'co-parent';
  };
}

/**
 * The trail rows for an EXPLICIT family — the family-scoped body shared by the
 * session-bound loadTrail (which resolves the family from the session) and the
 * data export (which already holds the audited family id).
 */
export async function loadTrailForFamily(
  database: Database,
  familyId: string,
): Promise<TrailView[]> {
  // Rule #1: a trail row's teen_content lives two hops away — audit_log targets
  // an actions row (target_table='actions', target_id=action uuid), which points
  // at the event that carries the flag. We cast actions.id → text (always safe)
  // to match the text target_id, rather than parsing target_id → uuid (which
  // would error on any non-uuid target_id). LEFT JOINs keep rows that don't
  // resolve to an action/event (other target tables) — those carry teenContent
  // = null/false and render in full, the documented trail boundary: we redact
  // exactly when a row resolves to teen_content, never claiming to cover targets
  // we can't tie.
  //
  // Defense-in-depth (rule #1): the stored teen_content is a probabilistic
  // classifier signal, so we ALSO resolve the event's child DOB (third LEFT JOIN)
  // and OR-in the age-derived teen check — a classify miss on a 13+ child's event
  // still redacts. effectiveTeenContent does the OR.
  //
  // The double-miss fallback (family-has-teen) applies ONLY to rows that resolved
  // to an EVENT (teen_content non-null): a family-wide event the classifier didn't
  // attribute still redacts when the family has a teen. Rows that don't resolve to
  // an event (non-`actions` targets — teen_content null) keep the documented trail
  // boundary and render in full, so e.g. a consent/family-settings audit isn't
  // blanket-redacted just because the family has a teenager.
  const [familyHasTeen, timeZone, resolveActor] = await Promise.all([
    familyHasTeenager(database, familyId),
    readFamilyTimezone(database, familyId),
    buildActorResolver(database, familyId),
  ]);
  const rows = await database
    .select({
      entry: schema.auditLog,
      teenContent: schema.events.teenContent,
      childDob: schema.children.dateOfBirth,
      childName: schema.children.name,
    })
    .from(schema.auditLog)
    .leftJoin(
      schema.actions,
      and(
        eq(schema.auditLog.targetTable, 'actions'),
        eq(sql`${schema.actions.id}::text`, schema.auditLog.targetId),
      ),
    )
    .leftJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
    .leftJoin(schema.children, eq(schema.events.childId, schema.children.id))
    // Exclude the Concierge agent's internal tool-call sub-steps (action_taken
    // `tool:<name>`, see packages/agent): they're not parent-facing actions, so they
    // must neither render on the timeline nor inflate the tally. Filtered in the
    // query so the 50-row window stays 50 MEANINGFUL rows (both callers — History
    // and the right-to-access export — get the same parent-facing set).
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        notLike(schema.auditLog.actionTaken, `${AGENT_TOOL_ACTION_PREFIX}%`),
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(50);
  return rows
    .filter((row) => !isAgentToolStep(row.entry.actionTaken))
    .map((row) => {
      const resolvedToEvent = row.teenContent !== null;
      // The child tag names the attributed child by NAME — including a teenager
      // (policy 1: the parent entered it, and two teens must never both read "your
      // teen"). This is the LABEL only; the row's CONTENT is separately redacted
      // via effectiveTeenContent below. A row with no attributed child (non-`actions`
      // target, family-wide event) reads null → "whole family".
      const childLabel = row.childName ?? null;
      return toTrailView(
        row.entry,
        effectiveTeenContent(
          row.teenContent ?? false,
          row.childDob ?? null,
          resolvedToEvent && familyHasTeen,
        ),
        timeZone,
        resolveActor,
        childLabel,
      );
    });
}
