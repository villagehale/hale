import { schema } from '@hale/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { WeekdayCare } from '~/lib/care/weekday';
import { applyCheckInCadence } from '~/lib/channel/checkin/reply';
import { replyLanguage } from '~/lib/channel/language';
import type { PendingDisambiguation } from '~/lib/channel/router/disambiguation';
import type {
  ChannelRouterDeps,
  HandlerContext,
  HandlerVerdict,
  ResolvedAnswer,
} from '~/lib/channel/router/route';
import { defaultPartyReplyDeps, handlePartyReply } from '~/lib/party/reply';
import { pipelineClient } from '~/lib/pipeline/client';
import { decideIntentGate } from './decide';
import { aiIntentRouterEnabled } from './flag';
import { speakParentLine } from './line';
import { type ParentIntentResolver, createParentIntentResolver } from './resolve';
import type { IntentTurn, ParentIntentReading } from './types';

type Claimed = Extract<HandlerVerdict, { claimed: true }>;

export type IntentGateResult =
  | { status: 'handled'; handler: string; verdict: Claimed }
  | { status: 'coach'; reason: string };

const CARE: readonly WeekdayCare[] = ['home', 'daycare', 'starting_soon'];

function client(): ReturnType<typeof pipelineClient> {
  return pipelineClient();
}

export function productionParentIntentResolver(): ParentIntentResolver {
  return createParentIntentResolver(client);
}

async function recentTurns(deps: ChannelRouterDeps, conversationId: string): Promise<IntentTurn[]> {
  const rows = await deps.database
    .select({ role: schema.messages.role, content: schema.messages.content })
    .from(schema.messages)
    .where(
      and(eq(schema.messages.conversationId, conversationId), isNull(schema.messages.deletedAt)),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(8);
  return rows
    .reverse()
    .slice(0, -1)
    .map((row) => ({
      role: row.role === 'assistant' ? 'hale' : 'parent',
      body: row.content,
    }));
}

/**
 * Flag on: one reading of this message, then the handler that owns it.
 * Low confidence, or an act we will not guess, hands the turn to the coach.
 * The word-list chain does not run after this returns.
 */
export async function runParentIntentGate(
  deps: ChannelRouterDeps,
  turn: HandlerContext,
  resolver: ParentIntentResolver,
): Promise<IntentGateResult> {
  if (!aiIntentRouterEnabled()) return { status: 'coach', reason: 'flag_off' };

  const questions = await turn.openQuestions();
  let reading: ParentIntentReading;
  try {
    reading = await resolver.read({
      text: turn.body,
      recentTurns: await recentTurns(deps, turn.conversationId),
      pending: questions.map((question) => ({
        id: question.id,
        kind: question.kind,
        description: question.description,
      })),
    });
  } catch (err) {
    console.info(
      { reason: 'model_failed', detail: err instanceof Error ? err.name : 'unknown' },
      'parent intent: unresolved',
    );
    reading = { intent: 'unclear', confidence: 'low', targetId: null, index: null, value: null };
  }

  const menu = await deps.disambiguation.pending(deps.database, {
    familyId: turn.familyId,
    parentUserId: turn.parentUserId,
    now: turn.now,
  });
  if (menu) {
    await deps.disambiguation.consume(deps.database, { id: menu.id, now: turn.now });
    const chosen = choiceFromMenu(menu, reading);
    if (chosen) {
      const handled = await callOwner(
        deps,
        turn,
        {
          kind: chosen.kind,
          questionId: chosen.questionId,
          polarity: menu.polarity,
          confidence: 'high',
        },
        reading,
      );
      if (handled) return handled;
    }
  }

  const decision = decideIntentGate(reading, questions);
  if (decision.action === 'coach') return { status: 'coach', reason: decision.reason };
  if (decision.action === 'resolved') {
    const handled = await callOwner(deps, turn, decision, reading);
    return handled ?? { status: 'coach', reason: 'handler_declined' };
  }
  if (reading.intent === 'weekday_care') {
    if (reading.value === 'search_yes' || reading.value === 'search_no') {
      return {
        status: 'coach',
        reason: reading.value === 'search_yes' ? 'weekday_search' : 'weekday_declined',
      };
    }
    await writeWeekdayCare(deps, turn, reading);
    return { status: 'coach', reason: 'weekday_recorded' };
  }
  if (reading.intent === 'party') {
    const party = await actOnParty(deps, turn, reading);
    if (party) return party;
  }
  const directed = await actOnDirected(deps, turn, reading);
  return directed ?? { status: 'coach', reason: 'not_acted' };
}

function choiceFromMenu(
  menu: PendingDisambiguation,
  reading: ParentIntentReading,
): { kind: PendingDisambiguation['options'][number]['kind']; questionId: string } | null {
  if (reading.intent !== 'choose' || reading.confidence !== 'high') return null;
  if (reading.targetId) {
    return menu.options.find((option) => option.questionId === reading.targetId) ?? null;
  }
  if (reading.index === null) return null;
  return menu.options[reading.index - 1] ?? null;
}

async function callOwner(
  deps: ChannelRouterDeps,
  turn: HandlerContext,
  resolved: ResolvedAnswer,
  reading: ParentIntentReading,
): Promise<IntentGateResult | null> {
  const owner = deps.handlers.find((handler) => handler.resolves?.has(resolved.kind));
  if (!owner) {
    deps.log.error({ kind: resolved.kind }, 'parent intent: no handler owns this question');
    return null;
  }
  const verdict = await owner.handle(deps.database, {
    ...turn,
    parentIntent: reading,
    resolved: {
      kind: resolved.kind,
      questionId: resolved.questionId,
      polarity: resolved.polarity,
      confidence: resolved.confidence,
    },
  });
  if (!verdict.claimed) return null;
  return { status: 'handled', handler: owner.name, verdict };
}

async function actOnDirected(
  deps: ChannelRouterDeps,
  turn: HandlerContext,
  reading: ParentIntentReading,
): Promise<IntentGateResult | null> {
  const name = handlerName(reading);
  if (!name) return null;
  const owner = deps.handlers.find((handler) => handler.name === name);
  if (!owner) return null;
  const verdict = await owner.handle(deps.database, {
    ...turn,
    parentIntent: reading,
    resolved: null,
  });
  if (!verdict.claimed) return null;
  if (verdict.reply) {
    const spoken = await speakParentLine({
      flow: reading.intent,
      facts: { sourceLine: verdict.reply, value: reading.value, outcome: verdict.outcome },
      pendingAsk: null,
      language: replyLanguage(turn.body),
      locked: verdict.reply,
    });
    if (!spoken.body)
      return { status: 'handled', handler: owner.name, verdict: { ...verdict, reply: null } };
    if (spoken.source === 'composed') {
      return {
        status: 'handled',
        handler: owner.name,
        verdict: { ...verdict, reply: spoken.body },
      };
    }
  }
  return { status: 'handled', handler: owner.name, verdict };
}

function handlerName(reading: ParentIntentReading): string | null {
  switch (reading.intent) {
    case 'undo':
      return 'approval';
    case 'connect':
    case 'fresh_link':
      return 'connector_link';
    case 'disconnect':
      return 'connector_disconnect';
    case 'health_done':
    case 'health_book':
      return 'health';
    case 'registration':
      return 'registration';
    case 'cadence':
    case 'day_note':
      return 'evening_check_in';
    case 'signup':
      return 'authorized_signup';
    case 'memory':
      return 'family_memory_kinds';
    case 'rec_morning':
      return 'rec_morning';
    case 'coparent_number':
      return 'co_parent_number';
    case 'forward_address':
    case 'forward_off':
      return 'forward_address';
    case 'find_activities':
    case 'book_checkup':
    case 'set_reminder':
    case 'join':
    case 'party':
    case 'weekday_care':
      return null;
    default:
      return null;
  }
}

async function actOnParty(
  deps: ChannelRouterDeps,
  turn: HandlerContext,
  reading: ParentIntentReading,
): Promise<IntentGateResult | null> {
  const directed =
    reading.value === 'link' || reading.value === 'tally' || reading.value === 'cancel'
      ? reading.value
      : null;
  if (!directed) return null;
  const outcome = await handlePartyReply(
    deps.database,
    {
      familyId: turn.familyId,
      parentUserId: turn.parentUserId,
      body: turn.body,
      now: turn.now,
      directed,
    },
    defaultPartyReplyDeps(),
  );
  if (outcome.status === 'ignored') return null;
  if (outcome.status === 'cancelled') {
    deps.log.error(
      { inviteId: outcome.notifyInviteId },
      'party cancel: the intent gate changed the row and did not text guests',
    );
  }
  const spoken = await speakParentLine({
    flow: 'party',
    facts: { sourceLine: outcome.reply, value: directed },
    pendingAsk: null,
    language: replyLanguage(turn.body),
    locked: outcome.reply,
  });
  return {
    status: 'handled',
    handler: 'party',
    verdict: { claimed: true, outcome: outcome.status, reply: spoken.body },
  };
}

async function writeWeekdayCare(
  deps: ChannelRouterDeps,
  turn: HandlerContext,
  reading: ParentIntentReading,
): Promise<void> {
  if (reading.confidence === 'low') return;
  if (!CARE.includes(reading.value as WeekdayCare)) return;
  if (turn.inboundChannelMessageId === null) return;
  const target = await deps.weekdayCareAnswerTarget(deps.database, {
    familyId: turn.familyId,
    parentUserId: turn.parentUserId,
    inboundChannelMessageId: turn.inboundChannelMessageId,
    now: turn.now,
  });
  if (target.status !== 'open' || !('childId' in target)) return;
  await deps.recordWeekdayCare(deps.database, {
    familyId: turn.familyId,
    parentUserId: turn.parentUserId,
    childId: target.childId,
    care: reading.value as WeekdayCare,
    provider: null,
    now: turn.now,
  });
}

/**
 * Cadence is a write plus a line. The write uses the structured value.
 * The line is composed when the flag is on. Exported for the evening handler.
 */
export async function spokenCadence(
  database: Parameters<typeof applyCheckInCadence>[0],
  input: Parameters<typeof applyCheckInCadence>[1],
): Promise<{ status: string; reply: string | null }> {
  const outcome = await applyCheckInCadence(database, input);
  const spoken = await speakParentLine({
    flow: 'checkin_cadence',
    facts: { cadence: input.cadence, language: input.language },
    pendingAsk: null,
    language: input.language,
    locked: outcome.reply,
  });
  return { status: outcome.status, reply: spoken.body };
}
