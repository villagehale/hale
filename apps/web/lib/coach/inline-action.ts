import { randomUUID } from 'node:crypto';
import type { AgentClient } from '@hale/agent';
import { type ContentProvenance, type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { dedupHashFor, recordVerdict } from '~/lib/pipeline/record';
import { reviewAction } from '~/lib/pipeline/review';
import { actionTypeForIntent, labelForIntent } from './action-intent';

/**
 * Routes an inline Ask Hale action intent through the EXISTING approval engine: it
 * mints a synthetic `ask_hale` event, drafts an action HELD at
 * drafted_for_approval, then runs the reviewer (rule #3) and persists its verdict.
 * It never executes (rule #4) — execution stays the parent's separate
 * /api/actions/:id/approve path. Every write is family-scoped (rule #1) and every
 * transition writes an immutable audit_log row (rule #6 / PIPEDA right-to-access).
 *
 * Why review inline: /api/actions/:id/approve rejects any draft whose
 * reviewerVerdict is not 'approved' (rule #3 — no approval on prose alone). A draft
 * that never runs the reviewer is therefore structurally un-approvable. So the
 * inline path must produce a verdict at draft time, exactly as the inbound pipeline
 * does (ingestEvent: draft → reviewAction → recordVerdict) — we CALL that same
 * reviewer (its rule-#3 coverage downgrade and rule-#2 prompt-by-reference are its
 * own) rather than reimplementing it.
 *
 * Why a synthetic event: an `actions` row requires an `event_id` (the pipeline's
 * one-action-per-event invariant). An action minted here has no inbound signal, so we
 * record one whose source is the ORIGIN that asked for it (see ORIGIN_STAMPS) — the
 * trail shows whether a parent asked in a conversation or a cron composed it, never an
 * email/calendar signal.
 *
 * The intent kind is mapped to a known ActionType server-side (actionTypeForIntent)
 * so a client can never ask the engine to draft an arbitrary action type — an
 * unknown kind throws rather than drafting anything.
 */

/**
 * Which trusted interface asked for the draft. `ask_hale` and `mcp` are a person or
 * their assistant asking in a conversation; `registration_sweep` is a cron composing
 * from municipal rows with no one in the loop.
 */
export type InlineActionOrigin = 'ask_hale' | 'mcp' | 'registration_sweep';

/**
 * The provenance an origin stamps on the trail: the synthetic event's type and the
 * audit verb. A Record rather than a chain of ternaries, because the ternaries this
 * replaced defaulted every unlisted origin to `ask_hale` — so adding an origin and
 * forgetting to branch on it silently claimed a parent conversation (VIL-264, the
 * registration sweep). Typed against the union, a new origin without its stamps is a
 * COMPILE error instead. Every verb here must also be registered in the trail's
 * AUDIT_VERBS, or the row degrades to the neutral "recorded an update" sentence.
 */
const ORIGIN_STAMPS: Record<InlineActionOrigin, { eventType: string; auditVerb: string }> = {
  ask_hale: { eventType: 'ask_hale.action_intent', auditVerb: 'ask_hale.action_drafted' },
  mcp: { eventType: 'mcp.action_proposal', auditVerb: 'mcp.action_drafted' },
  registration_sweep: {
    eventType: 'registration_sweep.shortlist_minted',
    auditVerb: 'registration_sweep.action_drafted',
  },
};

export interface InlineActionInput {
  familyId: string;
  /** Acting parent's user id — the audit actor (rule #6). */
  actor: string;
  /** Intent kind from detectActionIntents; validated against the closed set here. */
  intentKind: string;
  /** Which child the conversation was focused on, or null for the whole family. */
  childId: string | null;
  /** The answer text that implied the action — carried as the draft's rationale. */
  sourceAnswer: string;
  /** Which trusted interface requested the draft. All of them reuse this same
   * approval spine; the origin only changes provenance/audit labels. REQUIRED, and
   * deliberately without a default: there is no neutral answer to "who asked", so the
   * fallback this replaced had to pick one — it picked `ask_hale`, and every caller
   * that forgot to pass an origin then claimed a parent conversation it never had
   * (VIL-264, the registration sweep). Every caller knows its own answer. */
  origin: InlineActionOrigin;
  /** The drafted item's title, for a caller that knows a better one than the answer's
   * own first line (the registration sweep names the municipality and the cycle). */
  title?: string;
  /** The one link behind the draft, rendered as the card's "view source". */
  sourceUrl?: string;
  /**
   * Where this draft's content came from (rule #1). Declared by the CALLER, because
   * only the caller knows: the registration sweep composes from municipal rows and no
   * child's words are in it, while an Ask Hale answer or an MCP proposal is a reply to
   * something a household said and may concern any child. Omitted means
   * 'child_content' — the private answer — so a new caller fails closed.
   */
  contentProvenance?: ContentProvenance;
}

/**
 * How long a title lifted from an answer may run before it is cut. Long enough for a
 * municipal cycle name or a health task; short enough to read as a plan-item heading.
 */
const MAX_DRAFT_TITLE = 120;

/**
 * The draft's title when the caller did not supply one: the answer's own first line,
 * which is the sentence the parent acted on ("Help me book: 18-month visit"). Falls
 * back to the intent's chip label, so the title is never empty — the executor rejects
 * a titleless internal write, which is exactly the failure this builder exists to
 * prevent.
 *
 * ASCII "..." rather than a typographic ellipsis: an approved title lands on the
 * family's plan, and one non-GSM-7 character anywhere downstream of that flips a whole
 * SMS to UCS-2 and halves its budget (see sms-segments.ts).
 */
const TITLE_ELLIPSIS = '...';

function titleFrom(sourceAnswer: string, fallback: string): string {
  const firstLine = sourceAnswer.split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? '';
  if (!firstLine) return fallback;
  if (firstLine.length <= MAX_DRAFT_TITLE) return firstLine;
  const cut = firstLine.slice(0, MAX_DRAFT_TITLE - TITLE_ELLIPSIS.length).trimEnd();
  return `${cut}${TITLE_ELLIPSIS}`;
}

export interface InlineActionResult {
  actionId: string;
  eventId: string;
}

export async function draftInlineAction(
  input: InlineActionInput,
  database: Database,
  client: AgentClient,
  now: Date = new Date(),
): Promise<InlineActionResult> {
  const actionType = actionTypeForIntent(input.intentKind);
  const label = labelForIntent(input.intentKind);
  if (!actionType || !label) {
    throw new Error(`draftInlineAction: unknown intent '${input.intentKind}'`);
  }

  // A unique synthetic id keeps the dedup hash distinct per draft so re-tapping a
  // chip mints a fresh draft rather than colliding on the one-action-per-event index.
  const origin = input.origin;
  const { eventType, auditVerb: auditAction } = ORIGIN_STAMPS[origin];
  const dedupHash = dedupHashFor(input.familyId, origin, `${input.intentKind}|${randomUUID()}`);

  // teen_content = age-derived at the write site: a synthetic event scoped to a 13+
  // child must carry the teen flag (rule #1), so the downstream redaction cap sees
  // the same value a classified event would. Family-wide drafts (null child) stay
  // false — there is no child to age.
  const teenContent =
    input.childId !== null && (await isTeenChild(input.familyId, input.childId, database, now));

  const insertedEvent = await database
    .insert(schema.events)
    .values({
      familyId: input.familyId,
      source: origin,
      eventType,
      childId: input.childId,
      teenContent,
      contentProvenance: input.contentProvenance ?? 'child_content',
      payload: { intentKind: input.intentKind, sourceAnswer: input.sourceAnswer, origin },
      classifierSuggestion: { kind: 'autonomous_action', actionType },
      classifiedAt: now,
      dedupHash,
      status: 'drafted',
    })
    .onConflictDoNothing({ target: [schema.events.familyId, schema.events.dedupHash] })
    .returning({ id: schema.events.id });

  const eventId = insertedEvent[0]?.id;
  if (!eventId) {
    throw new Error('draftInlineAction: events insert returned no row');
  }

  // The draft's payload is what the EXECUTOR is handed verbatim when the parent
  // approves (memory-writer.loadActionForApproval → runExecutor), and it is also the
  // only payload the approvals card reads — the event's copy is selected nowhere on
  // that surface. So the fields the ActionType requires (`title`) and the fields the
  // parent needs to decide (`summary`, `source_url`) belong HERE, not just on the
  // event. `action_hash` is the same stamp mint-placements makes, so the reviewer's
  // check_action_idempotency has a key to read.
  const payload = {
    intentKind: input.intentKind,
    childId: input.childId,
    title: input.title?.trim() || titleFrom(input.sourceAnswer, label),
    summary: input.sourceAnswer,
    ...(input.sourceUrl ? { source_url: input.sourceUrl } : {}),
    action_hash: dedupHash,
  };

  const insertedAction = await database
    .insert(schema.actions)
    .values({
      eventId,
      familyId: input.familyId,
      actionType,
      payload,
      userVisibleState: 'drafted_for_approval',
    })
    .onConflictDoNothing({ target: schema.actions.eventId })
    .returning({ id: schema.actions.id });

  const actionId = insertedAction[0]?.id;
  if (!actionId) {
    throw new Error('draftInlineAction: actions insert returned no row');
  }

  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.actor,
    actionTaken: auditAction,
    targetTable: 'actions',
    targetId: actionId,
    after: { actionType, intentKind: input.intentKind, childId: input.childId, origin },
  });

  // Review inline (rule #3) so the draft carries a verdict the approve path will
  // accept. reviewAction owns the tool-use loop, the coverage downgrade, and its
  // own prompt-by-reference (rule #2); recordVerdict persists the verdict + tool
  // results and writes the reviewer's audit row (rule #6). The action stays at
  // drafted_for_approval whatever the verdict — Hale never acts unprompted (rule
  // #4); an 'approved' verdict only means a parent's click may execute it.
  const verdict = await reviewAction(
    {
      familyId: input.familyId,
      draft: {
        id: actionId,
        eventId,
        familyId: input.familyId,
        actionType,
        payload,
        draftConfidence: 1,
        rationale: input.sourceAnswer,
        recipientVisibility: 'internal_only',
        draftedAt: now.toISOString(),
      },
    },
    database,
    client,
  );

  await recordVerdict(database, {
    familyId: input.familyId,
    eventId,
    actionId,
    actionType,
    verdict: verdict.verdict,
    usage: verdict.usage,
    costUsd: verdict.costUsd,
    model: verdict.model,
  });

  return { actionId, eventId };
}

/**
 * Whether a child is in the teenager stage right now, derived from their date of
 * birth (never a stored flag). Family-scoped: a childId from another family does
 * not match and reads as non-teen. Returns false if the child row is missing.
 */
async function isTeenChild(
  familyId: string,
  childId: string,
  database: Database,
  now: Date,
): Promise<boolean> {
  const rows = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)));
  const dob = rows[0]?.dateOfBirth;
  return dob !== undefined && deriveStage(dob, now) === 'teenager';
}
