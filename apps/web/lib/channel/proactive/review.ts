import type { AgentClient } from '@hale/agent';
import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import {
  deliverFamilyOutbound,
  familyOutboundTarget,
  householdCopies,
} from '~/lib/channel/linq/family-outbound';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  type ProactiveSendKind,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { voiceClient } from '~/lib/loop/voice/compose';
import { writeFact } from '~/lib/memory/facts';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { type WriterResult, composeProactiveBatch } from './compose';
import { type DecideResult, type DeciderDecision, decideForFamily } from './decide';
import { type ProactiveCadence, proactiveCadence } from './flag';
import { type OpenCandidate, planHourlyReview } from './hold';
import { CADENCE_FACT_KEY, cadenceFactValue } from './preference';
import {
  type FamilySnapshot,
  type SnapshotCandidate,
  loadFamilyContext,
  loadFamilySnapshot,
} from './snapshot';
import { volumeIsUnusual } from './volume';

/**
 * VIL-226 · the hourly review. Off does nothing and reads nothing. Shadow decides and
 * records. Live composes and sends what the decider chose, through the same red lines
 * every proactive send crosses: the gate (consent, opt-out, quiet hours), the sending
 * line's health, and a sendable number. Every hold and drop is a named reason on the
 * row and an audit row (rules #6 and #11).
 */

export interface ProactiveReviewSummary {
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
    items: readonly SnapshotCandidate[];
    client: AgentClient | null;
    cadenceNote: string | null;
  }): Promise<WriterResult>;
  buildGate(database: Database): OutboundGatePorts;
  resolveSendablePhone(database: Database, parentUserId: string): Promise<string | null>;
  linePaused(database: Database): Promise<boolean>;
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
  const mode = proactiveCadence();
  const summary: ProactiveReviewSummary = {
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
    targetTable: 'proactive_candidates',
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
      ...(set.decision ? { decision: set.decision } : {}),
      holdUntil: set.holdUntil ? new Date(set.holdUntil) : null,
      decidedAt: set.now,
    })
    .where(inArray(schema.proactiveCandidates.id, [...ids]));
}

/** A named hold that the decider did not choose: the red lines at send time. */
async function holdByName(
  database: Database,
  familyId: string,
  items: readonly QueuedItem[],
  reason: string,
  now: Date,
): Promise<void> {
  const itemIds = items.map((item) => item.id);
  await mark(database, itemIds, { status: 'held', reason, decision: null, holdUntil: null, now });
  await audit(database, familyId, 'proactive_cadence_held', { reason, itemIds });
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

  const offered = new Set(plan.candidates.map((candidate) => candidate.id));
  const chosen = items.filter((item) => offered.has(item.id) && decision.itemIds.includes(item.id));
  const unchosen = items.filter((item) => offered.has(item.id) && !chosen.includes(item));
  await audit(database, familyId, 'proactive_cadence_decision', {
    action: decision.action,
    itemIds: chosen.map((item) => item.id),
    unchosen: unchosen.map((item) => item.id),
    reason: decision.reason,
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
        decision.frequencyPreference.note,
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
      reason: decision.reason,
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
      reason: decision.reason,
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
      reason: decision.reason,
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
    reason: decision.reason,
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
  const { familyId, chosen, now, summary } = input;
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
  const target = await familyOutboundTarget(database, familyId);
  // A claimed group is one bubble for the household, so its one copy carries every
  // chosen item; without a group each parent gets their own copy of their own items.
  const perParent = [...byParent.entries()].map(([parentUserId, items]) => ({
    parentUserId,
    items,
  }));
  const copies =
    target.channel === 'group'
      ? householdCopies(target, perParent).map((copy) => ({ ...copy, items: chosen }))
      : perParent;

  const gated: Array<{ parentUserId: string; items: QueuedItem[]; optOutFull: boolean }> = [];
  for (const copy of copies) {
    let optOutFull = false;
    let refused: string | null = null;
    for (const kind of new Set(copy.items.map((item) => item.kind))) {
      const verdict = await assertProactiveSendAllowed(
        { familyId, parentUserId: copy.parentUserId, kind, now },
        deps.buildGate(database),
      );
      if (!verdict.allowed) {
        refused = verdict.reason;
        break;
      }
      if (verdict.optOut === 'full') optOutFull = true;
    }
    if (refused) {
      await holdByName(database, familyId, copy.items, refused, now);
      summary.held += 1;
      continue;
    }
    gated.push({ ...copy, optOutFull });
  }
  if (gated.length === 0) return;

  const distinct = new Map<string, SnapshotCandidate>();
  for (const item of gated.flatMap((copy) => copy.items)) {
    const key = `${item.kind}\n${item.what}`;
    if (!distinct.has(key)) distinct.set(key, item);
  }
  const written = await deps.compose({
    items: [...distinct.values()],
    client: deps.client,
    cadenceNote: input.cadenceNote,
  });
  if ('skipped' in written) {
    await holdByName(
      database,
      familyId,
      gated.flatMap((copy) => copy.items),
      `unvoiced:${written.skipped}`,
      now,
    );
    summary.held += 1;
    return;
  }

  for (const copy of gated) {
    const to = await deps.resolveSendablePhone(database, copy.parentUserId);
    if (!to) {
      await holdByName(database, familyId, copy.items, 'no_send_target', now);
      summary.held += 1;
      continue;
    }
    const delivered = await deliverFamilyOutbound(database, {
      familyId,
      body: withOptOut(written.message, copy.optOutFull ? 'full' : 'short'),
      to,
      legacy: deps.transport,
      target,
      now,
    });
    if (delivered.status !== 'sent') {
      await holdByName(database, familyId, copy.items, `delivery_${delivered.reason}`, now);
      summary.held += 1;
      continue;
    }
    const covered = copy.items;
    const channel: 'imessage' | 'sms' = delivered.channel === 'imessage' ? 'imessage' : 'sms';
    await database
      .insert(schema.channelMessages)
      .values(
        covered.map((item, index) => ({
          familyId,
          parentUserId: item.parentUserId,
          channel,
          direction: 'out' as const,
          category: item.category,
          templateKey: item.templateKey,
          dedupeKey: item.dedupeKey,
          status: acceptedStatus(channel),
          providerMessageId: index === 0 ? delivered.providerMessageId : null,
          providerChatId: delivered.chatId,
          sentAt: now,
        })),
      )
      .onConflictDoNothing();
    const coveredIds = covered.map((item) => item.id);
    await mark(database, coveredIds, {
      status: 'sent',
      reason: input.reason,
      decision: 'send_now',
      holdUntil: null,
      now,
    });
    await audit(database, familyId, 'proactive_cadence_sent', {
      itemIds: coveredIds,
      kinds: [...new Set(covered.map((item) => item.kind))],
      channel,
    });
    summary.sent += 1;
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

/** A parent reply, a Gmail offer, a household occasion, or a calendar edit since `since`. */
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
  return calendar !== undefined;
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
