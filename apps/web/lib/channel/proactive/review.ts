import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { deliverFamilyOutbound } from '~/lib/channel/linq/family-outbound';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { voiceClient } from '~/lib/loop/voice/compose';
import { writeFact } from '~/lib/memory/facts';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { composeProactiveBatch } from './compose';
import { decideForFamily } from './decide';
import { proactiveCadence } from './flag';
import { type OpenCandidate, planHourlyReview } from './hold';
import { CADENCE_FACT_KEY, cadenceFactValue, readCadenceFact } from './preference';
import {
  type FamilySnapshot,
  type LoadedFamilyContext,
  type PriorDecision,
  type RecentSend,
  type SnapshotCandidate,
  formatSnapshotLocalNow,
} from './snapshot';
import { loadFamilyContext, unansweredStreak } from './snapshot';
import { volumeIsUnusual } from './volume';

/**
 * VIL-226 · the hourly review. Off does nothing. Shadow decides and logs.
 * Live composes and sends through the red lines, marked immediate so the
 * send is not queued again. An empty queue never calls the model.
 */

export interface ProactiveReviewSummary {
  mode: 'off' | 'shadow' | 'live';
  families: number;
  decided: number;
  sent: number;
  shadowed: number;
  held: number;
  dropped: number;
  skipped: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runProactiveReview(
  database: Database,
  deps: { client?: AgentClient | null; transport?: ChannelTransport; now?: Date } = {},
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
  };
  if (mode === 'off') return summary;
  if (typeof database.select !== 'function') {
    console.error('proactive review: no database — nothing reviewed');
    return summary;
  }
  const now = deps.now ?? new Date();
  const client = deps.client === undefined ? voiceClient() : deps.client;
  const open = await database
    .select({
      id: schema.proactiveCandidates.id,
      familyId: schema.proactiveCandidates.familyId,
      what: schema.proactiveCandidates.what,
      why: schema.proactiveCandidates.why,
      sourceUrl: schema.proactiveCandidates.sourceUrl,
      worthlessAfter: schema.proactiveCandidates.worthlessAfter,
      parentRequested: schema.proactiveCandidates.parentRequested,
      dedupeKey: schema.proactiveCandidates.dedupeKey,
      status: schema.proactiveCandidates.status,
      reason: schema.proactiveCandidates.reason,
      holdUntil: schema.proactiveCandidates.holdUntil,
      decidedAt: schema.proactiveCandidates.decidedAt,
      createdAt: schema.proactiveCandidates.createdAt,
    })
    .from(schema.proactiveCandidates)
    .where(inArray(schema.proactiveCandidates.status, ['queued', 'held']));
  const byFamily = new Map<string, OpenCandidate[]>();
  for (const row of open) {
    if (row.status !== 'queued' && row.status !== 'held') continue;
    const item: OpenCandidate = {
      id: row.id,
      what: row.what,
      why: row.why,
      sourceUrl: row.sourceUrl,
      worthlessAfter: row.worthlessAfter ? row.worthlessAfter.toISOString() : null,
      parentRequested: row.parentRequested,
      dedupeKey: row.dedupeKey,
      status: row.status,
      reason: row.reason,
      holdUntil: row.holdUntil ? row.holdUntil.toISOString() : null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
    const list = byFamily.get(row.familyId) ?? [];
    list.push(item);
    byFamily.set(row.familyId, list);
  }
  for (const [familyId, candidates] of byFamily) {
    summary.families += 1;
    if (candidates.length === 0) {
      summary.skipped += 1;
      continue;
    }
    try {
      await reviewFamily(
        database,
        familyId,
        candidates,
        now,
        client,
        deps.transport,
        mode,
        summary,
      );
    } catch (err) {
      summary.skipped += 1;
      console.error({ err, familyId }, 'proactive review: family failed');
    }
  }
  return summary;
}

async function reviewFamily(
  database: Database,
  familyId: string,
  candidates: OpenCandidate[],
  now: Date,
  client: AgentClient | null,
  transport: ChannelTransport | undefined,
  mode: 'shadow' | 'live',
  summary: ProactiveReviewSummary,
): Promise<void> {
  const context = await loadFamilyContext(database, familyId, now);
  const anchor = signalAnchor(candidates);
  const externalSignal = anchor ? await freshSignalSince(database, familyId, anchor) : false;
  const plan = planHourlyReview({
    items: candidates,
    now,
    timeZone: context.timeZone,
    externalSignal,
  });
  if (plan.skipModel) {
    summary.skipped += 1;
    return;
  }
  const snapshot = await snapshotFor(
    database,
    familyId,
    plan.candidates,
    plan.priorDecisions,
    context,
    now,
  );
  const { decision, skipped } = await decideForFamily({
    snapshot,
    client,
    database,
    familyId,
  });
  if (!decision) {
    summary.skipped += 1;
    console.info({ familyId, skipped }, 'proactive review: no decision');
    return;
  }
  summary.decided += 1;
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'proactive_cadence_decision',
    targetTable: 'proactive_candidates',
    targetId: familyId,
    after: {
      action: decision.action,
      itemIds: decision.itemIds,
      reason: decision.reason,
      mode,
    },
  });
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
      memoryKind: 'lasting',
      memorySource: 'inferred',
      sourcedAt: now,
    });
  }
  const chosen = candidates.filter((item) => decision.itemIds.includes(item.id));
  if (decision.action !== 'send_now' || chosen.length === 0) {
    if (chosen.length === 0) {
      summary.skipped += 1;
      console.info(
        { familyId, action: decision.action },
        'proactive review: decision named no items',
      );
      return;
    }
    const status = decision.action === 'drop' ? 'dropped' : 'held';
    await mark(database, chosen, status, decision.reason, decision.holdUntil, now);
    if (decision.action === 'drop') summary.dropped += 1;
    else summary.held += 1;
    return;
  }
  if (mode === 'shadow') {
    console.info(
      { familyId, items: chosen.length, reason: decision.reason },
      'proactive review: shadow would send',
    );
    await mark(database, chosen, 'shadowed', decision.reason, null, now);
    summary.shadowed += 1;
    return;
  }
  const message = await composeProactiveBatch({
    items: chosen,
    client,
    database,
    familyId,
  });
  const target = message ? await reviewSendTarget(database, familyId, transport) : null;
  if (!message || !target) {
    console.error(
      { familyId, composed: Boolean(message), reason: message ? 'no_send_target' : 'unvoiced' },
      'proactive review: batch unsent',
    );
    summary.skipped += 1;
    return;
  }
  const delivered = await deliverFamilyOutbound(database, {
    familyId,
    body: message,
    to: target.to,
    legacy: target.transport,
    cadenceLane: 'immediate',
    now,
  });
  if (delivered.status !== 'sent') {
    console.error({ familyId, status: delivered.status }, 'proactive review: send did not leave');
    summary.skipped += 1;
    return;
  }
  await mark(database, chosen, 'sent', decision.reason, null, now);
  summary.sent += 1;
  await alertVolume(database, familyId, now);
}

async function mark(
  database: Database,
  items: readonly SnapshotCandidate[],
  status: 'held' | 'dropped' | 'sent' | 'shadowed',
  reason: string,
  holdUntil: string | null,
  now: Date,
): Promise<void> {
  const ids = items.map((item) => item.id);
  if (ids.length === 0) return;
  await database
    .update(schema.proactiveCandidates)
    .set({
      status,
      reason,
      decision: status,
      holdUntil: holdUntil ? new Date(holdUntil) : null,
      decidedAt: now,
    })
    .where(inArray(schema.proactiveCandidates.id, ids));
}

async function reviewSendTarget(
  database: Database,
  familyId: string,
  transport: ChannelTransport | undefined,
): Promise<{ to: string; transport: ChannelTransport } | null> {
  const [member] = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  if (!member) return null;
  const to = await resolveSendablePhone(database, member.userId);
  if (!to) return null;
  return { to, transport: transport ?? createOutboundTransport() };
}

function signalAnchor(items: readonly OpenCandidate[]): Date | null {
  const times = items
    .filter((item) => item.status === 'held' && item.decidedAt)
    .map((item) => Date.parse(item.decidedAt as string))
    .filter((time) => !Number.isNaN(time));
  if (times.length === 0) return null;
  return new Date(Math.max(...times));
}

/** A parent reply, a new household occasion, a Gmail offer, or a calendar edit. */
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
      and(eq(schema.familyEvents.familyId, familyId), gte(schema.familyEvents.createdAt, since)),
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
  return Boolean(calendar);
}

async function snapshotFor(
  database: Database,
  familyId: string,
  candidates: SnapshotCandidate[],
  priorDecisions: PriorDecision[],
  context: LoadedFamilyContext,
  now: Date,
): Promise<FamilySnapshot> {
  const since = new Date(now.getTime() - 14 * DAY_MS);
  const messages = await database
    .select({
      direction: schema.channelMessages.direction,
      createdAt: schema.channelMessages.createdAt,
      body: schema.channelMessages.body,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        gte(schema.channelMessages.createdAt, since),
      ),
    );
  const outbound = messages.filter((row) => row.direction === 'out');
  const inbound = messages.filter((row) => row.direction === 'in');
  const recentSends: RecentSend[] = outbound.map((row) => ({
    at: row.createdAt.toISOString(),
    replied: inbound.some((text) => text.createdAt.getTime() > row.createdAt.getTime()),
  }));
  const [pref] = await database
    .select({ factValue: schema.familyMemoryFacts.factValue })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        eq(schema.familyMemoryFacts.factType, 'preference'),
        eq(schema.familyMemoryFacts.factKey, CADENCE_FACT_KEY),
        sql`${schema.familyMemoryFacts.validUntil} IS NULL`,
      ),
    )
    .limit(1);
  return {
    timeZone: context.timeZone,
    now: now.toISOString(),
    localNow: formatSnapshotLocalNow(now, context.timeZone),
    household: context.household,
    calendar: context.calendar,
    freeWindows: context.freeWindows,
    deadlines: context.deadlines,
    watches: context.watches,
    candidates,
    recentSends,
    unansweredStreak: unansweredStreak(recentSends),
    frequencyPreference: readCadenceFact(pref?.factValue),
    declines: context.declines,
    recentParentTexts: inbound
      .map((row) => (typeof row.body === 'string' ? row.body.slice(0, 160) : ''))
      .filter((text) => text.length > 0)
      .slice(-5),
    priorDecisions,
  };
}

async function alertVolume(database: Database, familyId: string, now: Date): Promise<void> {
  const since = new Date(now.getTime() - DAY_MS);
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.direction, 'out'),
        gte(schema.channelMessages.createdAt, since),
      ),
    );
  const count = row?.count ?? 0;
  if (!volumeIsUnusual(count)) return;
  console.error({ familyId, count }, 'proactive cadence: unusual family volume');
  await postOpsSlack(
    `Proactive volume alert: one family sent ${count} outbound messages in 24h. This is an alert, not a cap.`,
  );
}
