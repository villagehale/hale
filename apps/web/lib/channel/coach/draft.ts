import { randomUUID } from 'node:crypto';
import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import type { ActionType, CalendarPlacementPayload } from '@hale/types';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { calendarInstantsClose, calendarTitlesEqual } from '~/lib/channel/calendar-ask';
import { standingCalendarOfferId } from '~/lib/integrations/email-alert-offer';
import { dedupHashFor, recordVerdict } from '~/lib/pipeline/record';
import { reviewAction } from '~/lib/pipeline/review';

/**
 * VIL-221 · C2 — how a texted instruction becomes a HELD draft.
 *
 * This is the mint-placements / draftInlineAction mold with one thing changed: the
 * trigger. The engine is identical on purpose — a change a parent asked for by text
 * must arrive in the approvals queue indistinguishable from one they asked for by tap,
 * carrying the same synthetic event, the same reviewer verdict (rule #3), and the same
 * audit rows (rule #6). Anything less would mean two spines that can disagree about
 * what is allowed, and the text one would be the weaker.
 *
 * It NEVER executes (rule #4). `drafted_for_approval` is the terminal state here; the
 * family_events write happens later, if and only if the parent approves and the
 * executor's calendar_add / _move / _cancel runs. That is why the reply the coach
 * writes is always future-tense.
 *
 * The dedup hash carries a fresh uuid, deliberately — the same choice draftInlineAction
 * makes and the OPPOSITE of the week-plan composer's. A recompose re-deriving the same
 * placement should collide; a parent asking twice should not. A conversation where the
 * second "actually, cancel it" silently did nothing (because the first had been
 * declined and its hash was permanent) is the worse failure.
 */

const CHANNEL_SOURCE = 'channel_sms';
const CHANNEL_EVENT_TYPE = 'channel_sms.calendar_intent';
export const CHANNEL_AUDIT_ACTION = 'channel_sms.calendar_drafted';

/** The three schedule verbs C2 can draft. A strict subset of ActionType so a caller
 * cannot route an arbitrary action type through the texting surface. */
export type ChannelCalendarActionType = Extract<
  ActionType,
  'calendar_add' | 'calendar_move' | 'calendar_cancel'
>;

export interface ChannelDraftInput {
  familyId: string;
  /** The texting parent — audit actor (rule #6 / PIPEDA "who asked"). */
  actor: string;
  actionType: ChannelCalendarActionType;
  payload: CalendarPlacementPayload;
  /** Why this draft exists, in one line — the reviewer's rationale and the trail's. */
  rationale: string;
  /** True when the change targets a 13+ child's item, so the synthetic event carries
   * the teen flag the downstream redaction cap reads (rule #1). Age-derived by the
   * caller from the resolved row, never a stored flag. */
  teenContent: boolean;
}

export interface ChannelDraftResult {
  actionId: string;
}

/**
 * Who a calendar_add draft is for, written on its mint row (VIL-525). `private` is a 1:1
 * thread. `group` is the group chat the turn ran in, which may be a chat that is not the
 * household's own group; `chatId` is null when the turn did not say which chat it was.
 */
export type DraftOrigin = { surface: 'private' } | { surface: 'group'; chatId: string | null };

export function draftOriginForTurn(turn: {
  audience: 'direct' | 'group';
  groupChatId?: string | null;
}): DraftOrigin {
  return turn.audience === 'group'
    ? { surface: 'group', chatId: turn.groupChatId ?? null }
    : { surface: 'private' };
}

/**
 * What an ask already has waiting. `already_pending` names the draft, `already_asked` the
 * standing offer. `group_chat_unknown` is a group ask whose chat is not known, so no
 * group draft could be checked.
 */
export type PendingCalendarAdd =
  | { outcome: 'already_pending' | 'already_asked'; id: string }
  | { outcome: 'none' | 'group_chat_unknown' };

/**
 * The seam the tools draft through. Injected so the tool tests drive the DRAFTING RULES
 * (the per-turn cap, the event resolution, the refusals) against a fake, while the
 * production binding runs the real reviewer against real Claude — which is where rule
 * #8 puts the model, in the eval and in prod, never in a unit test.
 */
export interface ChannelDraftPort {
  draft(input: ChannelDraftInput): Promise<ChannelDraftResult>;
  /**
   * A `calendar_add` already waiting on this occasion, or the offer that already
   * asked it. Absent on a port that does not look — the tool then drafts, which is
   * what every test double did before VIL-513.
   */
  pendingIdentical?(input: {
    familyId: string;
    title: string;
    startsAt: string;
    childId: string | null;
  }): Promise<PendingCalendarAdd>;
}

/**
 * Bound to one turn: every draft it mints records that turn's origin, and every ask it
 * checks is scoped to it.
 */
export function productionChannelDraftPort(
  database: Database,
  client: AgentClient,
  turn: { now: Date; parentUserId: string; origin: DraftOrigin },
): ChannelDraftPort {
  return {
    draft: (input) =>
      mintChannelCalendarDraft({ ...input, origin: turn.origin }, database, client, turn.now),
    pendingIdentical: (input) =>
      findPendingIdenticalCalendarAdd(database, {
        ...input,
        parentUserId: turn.parentUserId,
        now: turn.now,
        origin: turn.origin,
      }),
  };
}

function recordedOrigin(after: unknown): DraftOrigin | null {
  const origin = (after as { origin?: { surface?: unknown; chatId?: unknown } } | null)?.origin;
  if (origin?.surface === 'private') return { surface: 'private' };
  if (origin?.surface === 'group') {
    return { surface: 'group', chatId: typeof origin.chatId === 'string' ? origin.chatId : null };
  }
  return null;
}

/**
 * Each action's origin. The mint row's recorded origin when it has one. A draft minted
 * before origins were recorded is read from the group-plan stamp: stamped for a chat is
 * that group, and unstamped is private.
 */
export async function calendarDraftOrigins(
  database: Database,
  familyId: string,
  actionIds: readonly string[],
): Promise<ReadonlyMap<string, DraftOrigin>> {
  if (actionIds.length === 0) return new Map();
  const rows = await database
    .select({
      targetId: schema.auditLog.targetId,
      actionTaken: schema.auditLog.actionTaken,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.targetTable, 'actions'),
        inArray(schema.auditLog.actionTaken, [CHANNEL_AUDIT_ACTION, 'group_plan.drafted']),
        inArray(schema.auditLog.targetId, [...actionIds]),
      ),
    );
  const recorded = new Map<string, DraftOrigin>();
  const stamped = new Map<string, string>();
  for (const row of rows) {
    if (!row.targetId) continue;
    if (row.actionTaken === CHANNEL_AUDIT_ACTION) {
      const origin = recordedOrigin(row.after);
      if (origin) recorded.set(row.targetId, origin);
      continue;
    }
    const chatId = (row.after as { chatId?: unknown } | null)?.chatId;
    if (typeof chatId === 'string') stamped.set(row.targetId, chatId);
  }
  return new Map(
    actionIds.map((id): [string, DraftOrigin] => {
      const origin = recorded.get(id);
      if (origin) return [id, origin];
      const chatId = stamped.get(id);
      return [id, chatId === undefined ? { surface: 'private' } : { surface: 'group', chatId }];
    }),
  );
}

function sameOrigin(left: DraftOrigin | undefined, right: DraftOrigin): boolean {
  if (left?.surface !== right.surface) return false;
  return left.surface === 'private' || (right.surface === 'group' && left.chatId === right.chatId);
}

/**
 * The drafted add for this occasion, or the offer that already asked it.
 *
 * Only drafts for the same audience and the same child are candidates. Among those, a
 * minute-off clock is the draft already waiting (VIL-525) and hours apart is not; the
 * newest wins. A standing offer is the private ask that already went out, so a private
 * ask for the same occasion does not mint a second draft. A group ask never answers a
 * private offer.
 */
export async function findPendingIdenticalCalendarAdd(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    title: string;
    startsAt: string;
    childId: string | null;
    now: Date;
    origin: DraftOrigin;
  },
): Promise<PendingCalendarAdd> {
  const { origin } = input;
  if (origin.surface === 'group' && origin.chatId === null) {
    console.info(
      { familyId: input.familyId, outcome: 'group_chat_unknown' },
      'texted calendar add: group chat unknown, no group draft checked',
    );
    return { outcome: 'group_chat_unknown' };
  }
  const rows = await database
    .select({ id: schema.actions.id, payload: schema.actions.payload })
    .from(schema.actions)
    .where(
      and(
        eq(schema.actions.familyId, input.familyId),
        eq(schema.actions.userVisibleState, 'drafted_for_approval'),
        eq(schema.actions.actionType, 'calendar_add'),
      ),
    )
    // No row limit: audience and child are read after the query, so a page of newer
    // drafts for another chat or child would hide the one this ask is about.
    .orderBy(desc(schema.actions.draftedAt));
  const origins = await calendarDraftOrigins(
    database,
    input.familyId,
    rows.map((row) => row.id),
  );
  const hit = rows.find((row) => {
    const payload = row.payload as { title?: unknown; startsAt?: unknown; childId?: unknown };
    const childId = typeof payload.childId === 'string' ? payload.childId : null;
    return (
      sameOrigin(origins.get(row.id), origin) &&
      childId === input.childId &&
      typeof payload.title === 'string' &&
      typeof payload.startsAt === 'string' &&
      calendarTitlesEqual(payload.title, input.title) &&
      calendarInstantsClose(payload.startsAt, input.startsAt)
    );
  });
  if (hit) return { outcome: 'already_pending', id: hit.id };
  if (origin.surface === 'group') return { outcome: 'none' };
  const offerId = await standingCalendarOfferId(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    title: input.title,
    startsAt: input.startsAt,
    now: input.now,
  });
  return offerId ? { outcome: 'already_asked', id: offerId } : { outcome: 'none' };
}

export async function mintChannelCalendarDraft(
  input: ChannelDraftInput & { origin: DraftOrigin },
  database: Database,
  client: AgentClient,
  now: Date = new Date(),
): Promise<ChannelDraftResult> {
  const dedupHash = dedupHashFor(input.familyId, CHANNEL_SOURCE, randomUUID());
  // `satisfies` rather than an annotation: the inferred literal type carries an
  // implicit index signature (an interface does not), which is what drizzle's jsonb
  // column and DraftedAction's payload both require.
  const payload = { ...input.payload, action_hash: dedupHash } satisfies CalendarPlacementPayload;
  const childId = input.payload.childId ?? null;

  const insertedEvent = await database
    .insert(schema.events)
    .values({
      familyId: input.familyId,
      source: CHANNEL_SOURCE,
      eventType: CHANNEL_EVENT_TYPE,
      childId,
      teenContent: input.teenContent,
      // The parent's own words are NOT copied here (rule #1): the message body lives in
      // exactly one place (the conversation thread), and the payload carries only the
      // resolved change. What the trail needs is what would happen, not what was typed.
      payload: { actionType: input.actionType, title: payload.title },
      classifierSuggestion: { kind: 'autonomous_action', actionType: input.actionType },
      classifiedAt: now,
      dedupHash,
      status: 'drafted',
    })
    .onConflictDoNothing({ target: [schema.events.familyId, schema.events.dedupHash] })
    .returning({ id: schema.events.id });

  const eventId = insertedEvent[0]?.id;
  if (!eventId) {
    throw new Error('mintChannelCalendarDraft: events insert returned no row');
  }

  const insertedAction = await database
    .insert(schema.actions)
    .values({
      eventId,
      familyId: input.familyId,
      actionType: input.actionType,
      payload,
      userVisibleState: 'drafted_for_approval',
    })
    .onConflictDoNothing({ target: schema.actions.eventId })
    .returning({ id: schema.actions.id });

  const actionId = insertedAction[0]?.id;
  if (!actionId) {
    throw new Error('mintChannelCalendarDraft: actions insert returned no row');
  }

  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.actor,
    actionTaken: CHANNEL_AUDIT_ACTION,
    targetTable: 'actions',
    targetId: actionId,
    // Only an add is a group's plan (the stamp's own rule). A move or cancel is answered
    // on the 1:1 list, wherever it was asked.
    after: {
      actionType: input.actionType,
      dedupHash,
      childId,
      ...(input.actionType === 'calendar_add' ? { origin: input.origin } : {}),
    },
  });

  // Rule #3: /api/actions/:id/approve rejects any draft whose reviewer verdict is not
  // 'approved', so a draft minted without a verdict is structurally un-approvable — the
  // parent would text YES and nothing would happen. The verdict does not execute
  // anything; it only makes the parent's yes capable of doing so.
  const verdict = await reviewAction(
    {
      familyId: input.familyId,
      draft: {
        id: actionId,
        eventId,
        familyId: input.familyId,
        actionType: input.actionType,
        payload,
        draftConfidence: 1,
        rationale: input.rationale,
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
    actionType: input.actionType,
    verdict: verdict.verdict,
    usage: verdict.usage,
    costUsd: verdict.costUsd,
    model: verdict.model,
  });

  return { actionId };
}
