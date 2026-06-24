import { randomUUID } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { actionTypeForIntent } from './action-intent';
import { dedupHashFor } from '~/lib/pipeline/record';

/**
 * Routes an inline Ask Hale action intent through the EXISTING approval engine: it
 * mints a synthetic `ask_hale` event and a drafted action HELD at
 * drafted_for_approval. It never executes (rule #4) — execution stays the parent's
 * separate /api/actions/:id/approve path. Every write is family-scoped (rule #1)
 * and produces one immutable audit_log row attributed to the acting parent (rule
 * #6 / PIPEDA right-to-access).
 *
 * Why a synthetic event: an `actions` row requires an `event_id` (the pipeline's
 * one-action-per-event invariant). A chat-originated action has no inbound signal,
 * so we record one whose source is `ask_hale` — the trail shows the action came
 * from a conversation, not an email/calendar signal.
 *
 * The intent kind is mapped to a known ActionType server-side (actionTypeForIntent)
 * so a client can never ask the engine to draft an arbitrary action type — an
 * unknown kind throws rather than drafting anything.
 */

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
}

export interface InlineActionResult {
  actionId: string;
  eventId: string;
}

export async function draftInlineAction(
  input: InlineActionInput,
  database: Database,
  now: Date = new Date(),
): Promise<InlineActionResult> {
  const actionType = actionTypeForIntent(input.intentKind);
  if (!actionType) {
    throw new Error(`draftInlineAction: unknown intent '${input.intentKind}'`);
  }

  // A unique synthetic id keeps the dedup hash distinct per draft so re-tapping a
  // chip mints a fresh draft rather than colliding on the one-action-per-event index.
  const dedupHash = dedupHashFor(input.familyId, 'ask_hale', `${input.intentKind}|${randomUUID()}`);

  const insertedEvent = await database
    .insert(schema.events)
    .values({
      familyId: input.familyId,
      source: 'ask_hale',
      eventType: 'ask_hale.action_intent',
      childId: input.childId,
      payload: { intentKind: input.intentKind, sourceAnswer: input.sourceAnswer },
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

  const insertedAction = await database
    .insert(schema.actions)
    .values({
      eventId,
      familyId: input.familyId,
      actionType,
      payload: { intentKind: input.intentKind, childId: input.childId },
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
    actionTaken: 'ask_hale.action_drafted',
    targetTable: 'actions',
    targetId: actionId,
    after: { actionType, intentKind: input.intentKind, childId: input.childId },
  });

  return { actionId, eventId };
}
