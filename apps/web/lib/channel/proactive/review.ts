import type { AgentClient } from '@hale/agent';
import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  WEEKDAY_AFTER_SCHOOL_TEMPLATE_KEY,
  WEEKDAY_BREAK_TEMPLATE_KEY,
  WEEKDAY_CARE_ASK_TEMPLATE_KEY,
  type WeekdayCareContext,
  loadWeekdayCareContext,
} from '~/lib/care/weekday';
import {
  type FamilyTextRecipient,
  loadFamilyTextRecipients,
} from '~/lib/channel/family-recipients';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { dedupeActive } from '~/lib/channel/ledger';
import {
  type FamilyOutboundTarget,
  deliverFamilyOutbound,
  familyOutboundTarget,
  householdCopies,
} from '~/lib/channel/linq/family-outbound';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  PROACTIVE_QUIET_HOURS,
  type ProactiveHoldReason,
  type ProactiveSendKind,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { eventKeyFromWeekdayBreakDedupe } from '~/lib/channel/weekday-care/key';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { dayKeyOf } from '~/lib/format/datetime';
import { voiceClient } from '~/lib/loop/voice/compose';
import { writeFact } from '~/lib/memory/facts';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { addDaysToKey, zonedLocalInstant } from '~/lib/plan/spine';
import { type WriterResult, composeProactiveBatch } from './compose';
import { type DecideResult, type DeciderDecision, decideForFamily } from './decide';
import {
  type SendFinalizerPorts,
  finalizeProactiveSend,
  recordProactiveSend,
  writeProactiveAudit,
} from './finalize';
import { type ProactiveCadence, proactiveCadence, requestedCadence, unroutedKinds } from './flag';
import { type OpenCandidate, planHourlyReview } from './hold';
import { CADENCE_FACT_KEY, cadenceFactValue } from './preference';
import { type FamilySnapshot, loadFamilyContext, loadFamilySnapshot } from './snapshot';
import { type ToolCandidate, boundedLine } from './tools';
import { volumeIsUnusual } from './volume';

/**
 * VIL-226 · the hourly review. Off does nothing and reads nothing. Shadow decides and
 * records. Live composes and sends what the decider chose, through the same red lines
 * every proactive send crosses: the gate (consent, opt-out, quiet hours), the sending
 * line's health, and a sendable number. Every hold and drop is a named reason on the
 * row and an audit row (rules #6 and #11).
 */

export interface ProactiveReviewSummary {
  /** What PROACTIVE_CADENCE asked for. Differs from `mode` while live cannot arm yet. */
  requested: ProactiveCadence;
  mode: ProactiveCadence;
  families: number;
  decided: number;
  sent: number;
  shadowed: number;
  held: number;
  dropped: number;
  skipped: number;
  failed: number;
}

export interface ProactiveReviewDeps {
  client: AgentClient | null;
  transport: ChannelTransport;
  decide(input: { snapshot: FamilySnapshot; client: AgentClient | null }): Promise<DecideResult>;
  compose(input: {
    items: readonly ToolCandidate[];
    client: AgentClient | null;
    cadenceNote: string | null;
  }): Promise<WriterResult>;
  buildGate(database: Database): OutboundGatePorts;
  resolveSendablePhone(database: Database, parentUserId: string): Promise<string | null>;
  linePaused(database: Database): Promise<boolean>;
  /** Every parent seat with a live number: who a claimed group's one bubble reaches. */
  loadRecipients(database: Database, familyId: string): Promise<FamilyTextRecipient[]>;
  outboundTarget(database: Database, familyId: string): Promise<FamilyOutboundTarget>;
  /** The sweep's own thread write (finalize.ts). Required: a send with no thread is a
   * sentence the parent's reply has no antecedent for (rule #11). */
  threadMessage: typeof threadProactiveMessage;
  /** The sweep's own close of the first-find promise. Required, as in the sweep. */
  fulfillCommitment: typeof fulfillCommitment;
  fetch?: typeof fetch;
}

export function defaultProactiveReviewDeps(): ProactiveReviewDeps {
  return {
    client: voiceClient(),
    transport: createOutboundTransport(),
    decide: decideForFamily,
    compose: composeProactiveBatch,
    buildGate: buildOutboundGatePorts,
    resolveSendablePhone,
    linePaused: readLinePaused,
    loadRecipients: loadFamilyTextRecipients,
    outboundTarget: familyOutboundTarget,
    threadMessage: threadProactiveMessage,
    fulfillCommitment,
  };
}

/** True when Linq has flagged or throttled any Hale sending line. */
export async function readLinePaused(database: Database): Promise<boolean> {
  const [row] = await database
    .select({ paused: schema.linqLineHealth.paused })
    .from(schema.linqLineHealth)
    .where(eq(schema.linqLineHealth.paused, true))
    .limit(1);
  return row !== undefined;
}

interface QueuedItem extends OpenCandidate {
  familyId: string;
  parentUserId: string;
  kind: ProactiveSendKind;
  category: (typeof schema.channelMessages.$inferInsert)['category'];
  templateKey: string;
  dedupeKey: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runProactiveReview(
  database: Database,
  deps: ProactiveReviewDeps,
  now: Date,
): Promise<ProactiveReviewSummary> {
  const requested = requestedCadence();
  const mode = proactiveCadence();
  if (requested !== mode) {
    console.warn(
      { requested, mode, unrouted: unroutedKinds() },
      'proactive review: live requested, but these classes still send on their own - running shadow',
    );
  }
  const summary: ProactiveReviewSummary = {
    requested,
    mode,
    families: 0,
    decided: 0,
    sent: 0,
    shadowed: 0,
    held: 0,
    dropped: 0,
    skipped: 0,
    failed: 0,
  };
  if (mode === 'off') return summary;

  const open = await database
    .select()
    .from(schema.proactiveCandidates)
    .where(inArray(schema.proactiveCandidates.status, ['queued', 'held']));
  const byFamily = new Map<string, QueuedItem[]>();
  for (const row of open) {
    if (row.status !== 'queued' && row.status !== 'held') continue;
    const item: QueuedItem = {
      id: row.id,
      familyId: row.familyId,
      parentUserId: row.parentUserId,
      kind: row.kind as ProactiveSendKind,
      category: row.category,
      templateKey: row.templateKey,
      dedupeKey: row.dedupeKey,
      what: row.what,
      why: row.why,
      decision: row.decision,
      sourceUrl: row.sourceUrl,
      worthlessAfter: row.worthlessAfter ? row.worthlessAfter.toISOString() : null,
      parentRequested: row.parentRequested,
      status: row.status,
      reason: row.reason,
      holdUntil: row.holdUntil ? row.holdUntil.toISOString() : null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
    byFamily.set(row.familyId, [...(byFamily.get(row.familyId) ?? []), item]);
  }

  for (const [familyId, items] of byFamily) {
    summary.families += 1;
    try {
      await reviewFamily(database, deps, { familyId, items, now, mode, summary });
    } catch (err) {
      summary.failed += 1;
      console.error(
        { err: err instanceof Error ? err.message : 'unknown', familyId },
        'proactive review: family failed',
      );
    }
  }
  return summary;
}

async function audit(
  database: Database,
  familyId: string,
  actionTaken: string,
  after: Record<string, unknown>,
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken,
    targetTable: 'families',
    targetId: familyId,
    after,
  });
}

async function mark(
  database: Database,
  ids: readonly string[],
  set: {
    status: 'held' | 'dropped' | 'sent' | 'shadowed';
    reason: string;
    decision: DeciderDecision['action'] | null;
    holdUntil: string | null;
    now: Date;
  },
): Promise<void> {
  if (ids.length === 0) return;
  await database
    .update(schema.proactiveCandidates)
    .set({
      status: set.status,
      reason: set.reason,
      decision: set.decision,
      holdUntil: set.holdUntil ? new Date(set.holdUntil) : null,
      decidedAt: set.now,
    })
    .where(inArray(schema.proactiveCandidates.id, [...ids]));
}

/**
 * A named hold that the decider did not choose: the red lines at send time. The decider
 * chose `send_now`, and the row keeps that, so the hourly plan (hold.ts) does not hand it
 * back to the model on the day turning. Quiet hours carry their end as the clock.
 */
async function holdByName(
  database: Database,
  familyId: string,
  items: readonly QueuedItem[],
  reason: string,
  now: Date,
  held: { holdUntil?: Date; parentUserId?: string } = {},
): Promise<void> {
  const itemIds = items.map((item) => item.id);
  await mark(database, itemIds, {
    status: 'held',
    reason,
    decision: 'send_now',
    holdUntil: held.holdUntil ? held.holdUntil.toISOString() : null,
    now,
  });
  await audit(database, familyId, 'proactive_cadence_held', {
    reason,
    itemIds,
    ...(held.parentUserId ? { parentUserId: held.parentUserId } : {}),
  });
}

/** The next end of the gate's quiet window, in this parent's own zone. */
function quietHoursEnd(now: Date, timeZone: string): Date {
  const today = dayKeyOf(now, timeZone);
  const end = zonedLocalInstant(today, PROACTIVE_QUIET_HOURS.end, timeZone);
  if (end.getTime() > now.getTime()) return end;
  return zonedLocalInstant(addDaysToKey(today, 1), PROACTIVE_QUIET_HOURS.end, timeZone);
}

/** A weekday-care ask is once per household ever (lib/care/weekday), whoever it went to. */
function askedAlready(context: WeekdayCareContext, item: QueuedItem): boolean {
  switch (item.templateKey) {
    case WEEKDAY_CARE_ASK_TEMPLATE_KEY:
      return context.askedBefore;
    case WEEKDAY_AFTER_SCHOOL_TEMPLATE_KEY:
      return context.askedAfterSchool === true;
    case WEEKDAY_BREAK_TEMPLATE_KEY: {
      const eventKey = eventKeyFromWeekdayBreakDedupe(item.dedupeKey);
      return eventKey !== null && (context.askedBreakKeys ?? []).includes(eventKey);
    }
    default:
      return false;
  }
}

const WEEKDAY_ASK_KEYS: readonly string[] = [
  WEEKDAY_CARE_ASK_TEMPLATE_KEY,
  WEEKDAY_AFTER_SCHOOL_TEMPLATE_KEY,
  WEEKDAY_BREAK_TEMPLATE_KEY,
];

/**
 * The ledger is the last word on whether a text already went. A candidate queued in
 * shadow (where the old path still sent it) or by a sweep that sent it since is dropped
 * by name, not texted twice; the sweep reads the same two answers before it hands off.
 */
async function dropAlreadySent(
  database: Database,
  familyId: string,
  items: readonly QueuedItem[],
  now: Date,
  summary: ProactiveReviewSummary,
): Promise<QueuedItem[]> {
  const care = items.some((item) => WEEKDAY_ASK_KEYS.includes(item.templateKey))
    ? await loadWeekdayCareContext(database, familyId)
    : null;
  const dropped = new Map<'already_sent' | 'already_asked', QueuedItem[]>();
  const kept: QueuedItem[] = [];
  for (const item of items) {
    const reason = (await dedupeActive(item.dedupeKey, database))
      ? 'already_sent'
      : care && askedAlready(care, item)
        ? 'already_asked'
        : null;
    if (reason) dropped.set(reason, [...(dropped.get(reason) ?? []), item]);
    else kept.push(item);
  }
  for (const [reason, group] of dropped) {
    const itemIds = group.map((item) => item.id);
    await mark(database, itemIds, {
      status: 'dropped',
      reason,
      decision: 'send_now',
      holdUntil: null,
      now,
    });
    await audit(database, familyId, 'proactive_cadence_skipped', { reason, itemIds });
    summary.dropped += 1;
  }
  return kept;
}

/** Every member a copy reaches may be texted, or the first refusal by name. */
async function gateCopy(
  gate: OutboundGatePorts,
  familyId: string,
  copy: { members: readonly string[]; items: readonly QueuedItem[] },
  now: Date,
): Promise<
  { refused: { reason: ProactiveHoldReason; parentUserId: string } } | { optOutFull: boolean }
> {
  let optOutFull = false;
  for (const parentUserId of copy.members) {
    for (const kind of new Set(copy.items.map((item) => item.kind))) {
      const verdict = await assertProactiveSendAllowed({ familyId, parentUserId, kind, now }, gate);
      if (!verdict.allowed) return { refused: { reason: verdict.reason, parentUserId } };
      if (verdict.optOut === 'full') optOutFull = true;
    }
  }
  return { optOutFull };
}

function writerItem(item: QueuedItem): ToolCandidate {
  return {
    id: item.id,
    what: item.what,
    why: item.why,
    sourceUrl: item.sourceUrl,
    worthlessAfter: item.worthlessAfter,
    parentRequested: item.parentRequested,
  };
}

async function reviewFamily(
  database: Database,
  deps: ProactiveReviewDeps,
  input: {
    familyId: string;
    items: QueuedItem[];
    now: Date;
    mode: 'shadow' | 'live';
    summary: ProactiveReviewSummary;
  },
): Promise<void> {
  const { familyId, items, now, mode, summary } = input;
  const context = await loadFamilyContext(database, familyId, now);
  if (!context) {
    summary.skipped += 1;
    await audit(database, familyId, 'proactive_cadence_skipped', { reason: 'no_primary_parent' });
    return;
  }
  const anchor = latestHold(items);
  const externalSignal = anchor ? await freshSignalSince(database, familyId, anchor) : false;
  const plan = planHourlyReview({ items, now, timeZone: context.timeZone, externalSignal });
  if (plan.skipModel) {
    summary.skipped += 1;
    return;
  }
  const snapshot = await loadFamilySnapshot(database, {
    familyId,
    context,
    candidates: plan.candidates,
    priorDecisions: plan.priorDecisions,
    now,
  });
  const { decision, skipped } = await deps.decide({ snapshot, client: deps.client });
  if (!decision) {
    summary.skipped += 1;
    await audit(database, familyId, 'proactive_cadence_skipped', { reason: skipped, mode });
    return;
  }
  summary.decided += 1;
  // Model free text, written with parent texts and calendar titles in view: one bounded
  // line before it reaches an immutable audit row or the candidate row.
  const reason = boundedLine(decision.reason);

  const offered = new Set(plan.candidates.map((candidate) => candidate.id));
  const chosen = items.filter((item) => offered.has(item.id) && decision.itemIds.includes(item.id));
  const unchosen = items.filter((item) => offered.has(item.id) && !chosen.includes(item));
  await audit(database, familyId, 'proactive_cadence_decision', {
    action: decision.action,
    itemIds: chosen.map((item) => item.id),
    unchosen: unchosen.map((item) => item.id),
    reason,
    holdUntil: decision.holdUntil,
    mode,
  });
  await mark(
    database,
    unchosen.map((item) => item.id),
    { status: 'held', reason: 'not_chosen', decision: null, holdUntil: null, now },
  );

  if (decision.frequencyPreference) {
    await writeFact(database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: CADENCE_FACT_KEY,
      factValue: cadenceFactValue(
        decision.frequencyPreference.direction,
        boundedLine(decision.frequencyPreference.note),
      ),
      confidence: 1,
      inferredBy: 'proactive-decider',
      validFrom: now,
    });
  }
  if (chosen.length === 0) return;

  const ids = chosen.map((item) => item.id);
  if (decision.action === 'drop') {
    await mark(database, ids, {
      status: 'dropped',
      reason,
      decision: 'drop',
      holdUntil: null,
      now,
    });
    summary.dropped += 1;
    return;
  }
  if (decision.action === 'hold') {
    await mark(database, ids, {
      status: 'held',
      reason,
      decision: 'hold',
      holdUntil: decision.holdUntil,
      now,
    });
    summary.held += 1;
    return;
  }
  if (mode === 'shadow') {
    await mark(database, ids, {
      status: 'shadowed',
      reason,
      decision: 'send_now',
      holdUntil: null,
      now,
    });
    summary.shadowed += 1;
    return;
  }
  await sendChosen(database, deps, {
    familyId,
    chosen,
    cadenceNote: snapshot.frequencyPreference?.note ?? null,
    reason,
    now,
    summary,
  });
}

async function sendChosen(
  database: Database,
  deps: ProactiveReviewDeps,
  input: {
    familyId: string;
    chosen: QueuedItem[];
    cadenceNote: string | null;
    reason: string;
    now: Date;
    summary: ProactiveReviewSummary;
  },
): Promise<void> {
  const { familyId, now, summary } = input;
  const chosen = await dropAlreadySent(database, familyId, input.chosen, now, summary);
  if (chosen.length === 0) return;
  // Nothing in the queue is time-critical (those send immediately), so a flagged line
  // holds the whole batch.
  if (await deps.linePaused(database)) {
    await holdByName(database, familyId, chosen, 'line_health', now);
    summary.held += 1;
    return;
  }

  const byParent = new Map<string, QueuedItem[]>();
  for (const item of chosen) {
    byParent.set(item.parentUserId, [...(byParent.get(item.parentUserId) ?? []), item]);
  }
  const target = await deps.outboundTarget(database, familyId);
  const perParent = [...byParent.entries()].map(([parentUserId, items]) => ({
    parentUserId,
    items,
  }));
  // A claimed group is one bubble for the household, so its one copy carries every
  // chosen item and reaches every member: each of them is gated, and one refusal holds
  // the copy. Without a group each parent gets their own copy of their own items.
  let copies: Array<{ parentUserId: string; items: QueuedItem[]; members: string[] }>;
  if (target.channel === 'group') {
    const seats = await deps.loadRecipients(database, familyId);
    const members = [
      ...new Set([
        ...seats.map((seat) => seat.parentUserId),
        ...perParent.map((copy) => copy.parentUserId),
      ]),
    ];
    copies = householdCopies(target, perParent).map((copy) => ({
      ...copy,
      items: chosen,
      members,
    }));
  } else {
    copies = perParent.map((copy) => ({ ...copy, members: [copy.parentUserId] }));
  }

  const gate = deps.buildGate(database);
  const gated: Array<{ parentUserId: string; items: QueuedItem[]; optOutFull: boolean }> = [];
  for (const copy of copies) {
    const verdict = await gateCopy(gate, familyId, copy, now);
    if ('refused' in verdict) {
      const { reason, parentUserId } = verdict.refused;
      const holdUntil =
        reason === 'quiet_hours'
          ? quietHoursEnd(now, await gate.parentTimeZone(parentUserId))
          : undefined;
      await holdByName(database, familyId, copy.items, reason, now, { holdUntil, parentUserId });
      summary.held += 1;
      continue;
    }
    gated.push({
      parentUserId: copy.parentUserId,
      items: copy.items,
      optOutFull: verdict.optOutFull,
    });
  }
  if (gated.length === 0) return;

  // One text per distinct set of items: parents who share the same items share one
  // composition, and a parent is never texted about an item that is not theirs.
  const writtenFor = new Map<string, WriterResult>();
  const voiced: Array<(typeof gated)[number] & { message: string }> = [];
  for (const copy of gated) {
    const distinct = new Map<string, ToolCandidate>();
    for (const item of copy.items) {
      const key = `${item.kind}\n${item.what}`;
      if (!distinct.has(key)) distinct.set(key, writerItem(item));
    }
    const setKey = [...distinct.keys()].sort().join('\n\n');
    let written = writtenFor.get(setKey);
    if (!written) {
      written = await deps.compose({
        items: [...distinct.values()],
        client: deps.client,
        cadenceNote: input.cadenceNote,
      });
      writtenFor.set(setKey, written);
    }
    if ('skipped' in written) {
      await holdByName(database, familyId, copy.items, `unvoiced:${written.skipped}`, now);
      summary.held += 1;
      continue;
    }
    voiced.push({ ...copy, message: written.message });
  }

  const finalizer: SendFinalizerPorts = {
    recordSend: recordProactiveSend,
    audit: writeProactiveAudit,
    threadMessage: deps.threadMessage,
  };
  let firstMessageId: string | null = null;
  for (const copy of voiced) {
    const to = await deps.resolveSendablePhone(database, copy.parentUserId);
    if (!to) {
      await holdByName(database, familyId, copy.items, 'no_send_target', now);
      summary.held += 1;
      continue;
    }
    const delivered = await deliverFamilyOutbound(database, {
      familyId,
      body: withOptOut(copy.message, copy.optOutFull ? 'full' : 'short'),
      to,
      legacy: deps.transport,
      target,
      fetch: deps.fetch,
      now,
    });
    if (delivered.status !== 'sent') {
      // A group cap names when it resets; that is the hold's clock.
      const holdUntil =
        delivered.status === 'held' && 'until' in delivered ? delivered.until : undefined;
      await holdByName(database, familyId, copy.items, `delivery_${delivered.reason}`, now, {
        holdUntil,
      });
      summary.held += 1;
      continue;
    }
    const covered = copy.items;
    const coveredIds = covered.map((item) => item.id);
    const labels = [...new Set(covered.map((item) => item.why))];
    // The sweep's own verb for a nudge, so the trail reads a decider send the same way.
    const messageId = await finalizeProactiveSend(database, finalizer, {
      familyId,
      recipientUserId: copy.parentUserId,
      channel: delivered.channel === 'imessage' ? 'imessage' : 'sms',
      providerMessageId: delivered.providerMessageId,
      providerChatId: delivered.chatId,
      sentAt: now,
      items: covered,
      composed: copy.message,
      audit: {
        actionTaken: covered.every((item) => item.kind === 'nudge')
          ? 'proactive_nudge_sent'
          : 'proactive_cadence_sent',
        after: {
          ...(labels.length === 1 ? { kind: labels[0] } : {}),
          kinds: labels,
          itemIds: coveredIds,
        },
      },
    });
    if (firstMessageId === null) firstMessageId = messageId;
    await mark(database, coveredIds, {
      status: 'sent',
      reason: input.reason,
      decision: 'send_now',
      holdUntil: null,
      now,
    });
    summary.sent += 1;
  }
  if (firstMessageId !== null) {
    await deps.fulfillCommitment(database, {
      familyId,
      kind: 'first_find',
      channelMessageId: firstMessageId,
      now,
    });
  }
  await alertVolume(database, familyId, now);
}

function latestHold(items: readonly OpenCandidate[]): Date | null {
  const times = items
    .filter((item) => item.status === 'held' && item.decidedAt !== null)
    .map((item) => Date.parse(item.decidedAt as string));
  if (times.length === 0) return null;
  return new Date(Math.max(...times));
}

/**
 * A parent reply, a Gmail offer, a household occasion, a calendar edit, or a status
 * webhook for Hale's sending line since `since`.
 */
async function freshSignalSince(
  database: Database,
  familyId: string,
  since: Date,
): Promise<boolean> {
  const [inbound] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'in'),
        gte(schema.channelMessages.createdAt, since),
      ),
    )
    .limit(1);
  if (inbound) return true;
  const [mail] = await database
    .select({ id: schema.emailAlertOffers.id })
    .from(schema.emailAlertOffers)
    .where(
      and(
        eq(schema.emailAlertOffers.familyId, familyId),
        gte(schema.emailAlertOffers.createdAt, since),
      ),
    )
    .limit(1);
  if (mail) return true;
  const [occasion] = await database
    .select({ id: schema.familyEvents.id })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        householdFamilyEvent(),
        gte(schema.familyEvents.createdAt, since),
      ),
    )
    .limit(1);
  if (occasion) return true;
  const [calendar] = await database
    .select({ eventId: schema.calendarEventSnapshots.eventId })
    .from(schema.calendarEventSnapshots)
    .innerJoin(
      schema.integrations,
      eq(schema.calendarEventSnapshots.integrationId, schema.integrations.id),
    )
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        gte(schema.calendarEventSnapshots.updatedAt, since),
      ),
    )
    .limit(1);
  if (calendar) return true;
  const [line] = await database
    .select({ phoneNumber: schema.linqLineHealth.phoneNumber })
    .from(schema.linqLineHealth)
    .where(gte(schema.linqLineHealth.updatedAt, since))
    .limit(1);
  return line !== undefined;
}

/** An alert, not a cap: the send already left. */
async function alertVolume(database: Database, familyId: string, now: Date): Promise<void> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        gte(schema.channelMessages.createdAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  const count = row?.count ?? 0;
  if (!volumeIsUnusual(count)) return;
  console.error({ familyId, count }, 'proactive cadence: unusual family volume');
  await postOpsSlack(
    `Proactive volume alert: one family has ${count} outbound texts in 24h. This is an alert, not a cap.`,
  );
}
