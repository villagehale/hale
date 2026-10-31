import { randomUUID } from 'node:crypto';
import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import type { ActionType, CalendarPlacementPayload } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import {
  calendarInstantsEqual,
  calendarTitlesEqual,
  matchingCalendarAddId,
} from '~/lib/channel/calendar-ask';
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
const CHANNEL_AUDIT_ACTION = 'channel_sms.calendar_drafted';

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
 * The seam the tools draft through. Injected so the tool tests drive the DRAFTING RULES
 * (the per-turn cap, the event resolution, the refusals) against a fake, while the
 * production binding runs the real reviewer against real Claude — which is where rule
 * #8 puts the model, in the eval and in prod, never in a unit test.
 */
export interface ChannelDraftPort {
  draft(input: ChannelDraftInput): Promise<ChannelDraftResult>;
  /**
   * A `calendar_add` already waiting on this occasion, or the offer that already
   * asked it, or null. Absent on a port that does not look — the tool then drafts,
   * which is what every test double did before VIL-513.
   */
  pendingIdentical?(input: {
    familyId: string;
    parentUserId?: string;
    title: string;
    startsAt: string;
    timeZone?: string;
    now?: Date;
    /** A group ask must not collapse into a private 1:1 offer. */
    audience?: 'direct' | 'group';
    groupChatId?: string;
  }): Promise<string | null>;
}

export function productionChannelDraftPort(
  database: Database,
  client: AgentClient,
  now: Date = new Date(),
): ChannelDraftPort {
  return {
    draft: (input) => mintChannelCalendarDraft(input, database, client, now),
    pendingIdentical: (input) => findPendingIdenticalCalendarAdd(database, input),
  };
}

/** A group-stamped draft for this chat, so a private row is not reused as the group's. */
async function groupDraftForChat(
  database: Database,
  familyId: string,
  actionId: string,
  groupChatId: string | undefined,
): Promise<boolean> {
  const rows = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.targetTable, 'actions'),
        eq(schema.auditLog.targetId, actionId),
        eq(schema.auditLog.actionTaken, 'group_plan.drafted'),
      ),
    )
    .limit(5);
  return rows.some((row) => {
    const chatId = (row.after as { chatId?: unknown } | null)?.chatId;
    if (typeof chatId !== 'string') return false;
    return groupChatId === undefined || chatId === groupChatId;
  });
}

/**
 * The drafted add for this occasion, or the offer that already asked it.
 *
 * A minute-off clock on the same local day is the draft already waiting (VIL-525).
 * An exact instant is the fallback when the caller has no zone. A standing offer
 * is the ask that already went out, so the same occasion does not mint a second
 * draft and is not asked again.
 */
export async function findPendingIdenticalCalendarAdd(
  database: Database,
  input: {
    familyId: string;
    parentUserId?: string;
    title: string;
    startsAt: string;
    timeZone?: string;
    now?: Date;
    audience?: 'direct' | 'group';
    groupChatId?: string;
  },
): Promise<string | null> {
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
    .limit(20);
  const shaped = rows.map((row) => {
    const payload = row.payload as { title?: unknown; startsAt?: unknown };
    const title = typeof payload.title === 'string' ? payload.title : '';
    const startsAt = typeof payload.startsAt === 'string' ? payload.startsAt : '';
    return {
      id: row.id,
      actionType: 'calendar_add' as const,
      occasion: title !== '' && startsAt !== '' ? { title, startsAt } : null,
    };
  });
  const groupAsk = input.audience === 'group';
  if (input.timeZone) {
    const hit = matchingCalendarAddId(shaped, {
      title: input.title,
      startsAt: input.startsAt,
    });
    // A private draft is not a group add. Returning it would skip the mint, and
    // the group origin stamp is written only when a group draft is minted.
    if (hit && !groupAsk) return hit;
    if (
      hit &&
      groupAsk &&
      (await groupDraftForChat(database, input.familyId, hit, input.groupChatId))
    ) {
      return hit;
    }
  } else {
    const hit = shaped.find(
      (row) =>
        row.occasion !== null &&
        calendarTitlesEqual(row.occasion.title, input.title) &&
        calendarInstantsEqual(row.occasion.startsAt, input.startsAt),
    );
    if (hit && !groupAsk) return hit.id;
  }
  // A 1:1 offer is private. A group ask cannot answer it, so it must still draft.
  if (groupAsk) return null;
  if (!input.parentUserId || !input.timeZone || !input.now) return null;
  return standingCalendarOfferId(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    title: input.title,
    startsAt: input.startsAt,
    now: input.now,
  });
}

export async function mintChannelCalendarDraft(
  input: ChannelDraftInput,
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
    after: { actionType: input.actionType, dedupHash, childId },
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
