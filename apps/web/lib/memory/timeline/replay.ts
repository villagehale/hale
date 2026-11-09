import { type Database, schema } from '@hale/db';
import { getMemorySlice } from '@hale/worker/memory-writer';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import { loadPlanFacts } from '~/lib/channel/plan/reply';
import { loadAgentContext } from '~/lib/coach/context';
import { buildDistillTools, buildInferenceTools } from '~/lib/cron/inference-tools';
import { assembleMemoryBrief } from '~/lib/memory/brief';
import { forgetFamilyFact } from '~/lib/memory/forget';
import { type FamilyMemoryExport, loadFamilyMemoryExport } from '~/lib/rights/export-memory';
import { seedFamily } from '~/lib/testing/pglite';
import {
  HORIZONS,
  type Horizon,
  type PromptPath,
  TIMELINE_START,
  type Timeline,
  type TimelineStep,
} from './fixtures';

/**
 * VIL-598 leg A · replay one timeline's gold writes into a database up to a horizon,
 * then read the family back the way every prompt does. No model runs: the writes go
 * through the real save, forget and delete paths, and the reads are the real readers.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The gold extractor is sure of what it saves; the floor is not what is under test. */
const GOLD_CONFIDENCE = 0.9;

export function dayAt(day: number): Date {
  return new Date(TIMELINE_START.getTime() + day * DAY_MS);
}

/** Half a day after the horizon's last step, so a step on that day has landed. */
export function horizonNow(horizon: Horizon): Date {
  return dayAt(HORIZONS[horizon] + 0.5);
}

export interface ReplayedFamily {
  familyId: string;
  parentUserId: string;
  coParentUserId: string | null;
  childIds: Map<string, string>;
  /** Each gold write the real tool did not treat as the fixture said, by step. */
  replayErrors: string[];
}

export interface FamilyReadBack {
  contexts: Record<PromptPath, string>;
  /** Every stored row of the family's memory and its raw inputs, deleted ones included:
   *  the positive control that a planted value exists before its absence is scored. */
  store: string;
  storeCounts: { facts: number; episodes: number };
  primaryExport: FamilyMemoryExport;
  coParentExport: FamilyMemoryExport | null;
}

function childIdOf(family: ReplayedFamily, ref: string | null): string | null {
  if (ref === null) return null;
  const id = family.childIds.get(ref);
  if (!id) throw new Error(`timeline names an unknown child ref ${ref}`);
  return id;
}

async function replayStep(
  database: Database,
  family: ReplayedFamily,
  conversationId: string,
  step: TimelineStep,
  index: number,
): Promise<void> {
  const at = dayAt(step.day);
  const ctx = { familyId: family.familyId, actor: 'system' };
  switch (step.kind) {
    case 'save': {
      const tool = buildInferenceTools(database, at).find((t) => t.name === 'save_memory');
      if (!tool) throw new Error('save_memory is not registered');
      const result = (await tool.handler(
        {
          childId: childIdOf(family, step.child),
          factType: step.factType,
          factKey: step.factKey,
          factValue: { summary: step.summary },
          confidence: GOLD_CONFIDENCE,
          memoryClass: step.memoryClass,
          disposition: step.disposition,
          ...(step.observedDay !== undefined
            ? { observedAt: dayAt(step.observedDay).toISOString() }
            : {}),
          ...(step.expiresDay !== undefined
            ? { expiresAt: dayAt(step.expiresDay).toISOString() }
            : {}),
          ...(step.correctsKey ? { correctsKey: step.correctsKey } : {}),
        },
        ctx,
      )) as { saved: boolean; reason?: string };
      const expected = step.refused ? { saved: false, reason: step.refused } : { saved: true };
      if (result.saved !== expected.saved || (step.refused && result.reason !== step.refused)) {
        family.replayErrors.push(
          `step ${index} ${step.factKey}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(result)}`,
        );
      }
      return;
    }
    case 'forget': {
      const [live] = await database
        .select({ id: schema.familyMemoryFacts.id })
        .from(schema.familyMemoryFacts)
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, family.familyId),
            eq(schema.familyMemoryFacts.factKey, step.factKey),
            isNull(schema.familyMemoryFacts.validUntil),
          ),
        );
      const result = live
        ? await forgetFamilyFact(database, {
            familyId: family.familyId,
            factId: live.id,
            actor: family.parentUserId,
            now: at,
          })
        : null;
      if (result?.forgotten !== 1) {
        family.replayErrors.push(`step ${index} forget ${step.factKey}: ${JSON.stringify(result)}`);
      }
      return;
    }
    case 'turn': {
      await database.insert(schema.messages).values({
        conversationId,
        role: 'user',
        content: step.content,
        childId: childIdOf(family, step.child),
        createdAt: at,
        deletedAt: step.deletedDay !== undefined ? dayAt(step.deletedDay) : null,
      });
      return;
    }
    case 'inbound': {
      await database.insert(schema.events).values({
        familyId: family.familyId,
        source: step.source,
        eventType: step.source === 'email' ? 'email.received' : 'message.received',
        payload: { body: step.body, ...(step.inGroup ? { inGroup: true } : {}) },
        dedupHash: `timeline-${family.familyId}-${index}`,
        receivedAt: at,
      });
      return;
    }
    case 'episode': {
      await database.insert(schema.familyMemoryEpisodes).values({
        familyId: family.familyId,
        childId: childIdOf(family, step.child),
        occurredAt: at,
        episodeType: step.episodeType,
        summary: step.summary,
        deletedAt: step.deletedDay !== undefined ? dayAt(step.deletedDay) : null,
      });
      return;
    }
  }
}

/** A fresh family, its roster, and every step on or before the horizon, in day order. */
export async function replayTimeline(
  database: Database,
  timeline: Timeline,
  horizon: Horizon,
): Promise<ReplayedFamily> {
  const { familyId, parentUserId } = await seedFamily(database, `timeline ${timeline.id}`);
  let coParentUserId: string | null = null;
  if (timeline.coParent) {
    const [coParent] = await database
      .insert(schema.users)
      .values({ externalAuthId: `timeline-coparent-${familyId}` })
      .returning({ id: schema.users.id });
    coParentUserId = coParent?.id as string;
    await database
      .insert(schema.familyMembers)
      .values({ familyId, userId: coParentUserId, role: 'co_parent' });
  }
  const rows = await database
    .insert(schema.children)
    .values(
      timeline.children.map((child) => ({
        familyId,
        name: child.name,
        dateOfBirth: child.dateOfBirth,
      })),
    )
    .returning({ id: schema.children.id, name: schema.children.name });
  const childIds = new Map(
    timeline.children.map((child) => [
      child.ref,
      rows.find((row) => row.name === child.name)?.id as string,
    ]),
  );
  const [conversation] = await database
    .insert(schema.conversations)
    .values({ familyId, createdAt: TIMELINE_START })
    .returning({ id: schema.conversations.id });
  const family: ReplayedFamily = {
    familyId,
    parentUserId,
    coParentUserId,
    childIds,
    replayErrors: [],
  };
  const lastDay = HORIZONS[horizon];
  const steps = timeline.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.day <= lastDay)
    .sort((a, b) => a.step.day - b.step.day || a.index - b.index);
  for (const { step, index } of steps) {
    await replayStep(database, family, conversation?.id as string, step, index);
  }
  return family;
}

function toolOf(tools: ReturnType<typeof buildInferenceTools>, name: string) {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no ${name} tool`);
  return found;
}

/** Reads the family back through every prompt path, its store and its export. */
export async function readBack(
  database: Database,
  timeline: Timeline,
  family: ReplayedFamily,
  now: Date,
): Promise<FamilyReadBack> {
  const { familyId } = family;
  const ctx = { familyId, actor: 'system' };
  const coach = await loadAgentContext(
    {
      familyId,
      question: 'what should we do this week?',
      intent: null,
      focusedChildId: null,
      transcript: [],
      sourceNote: null,
    },
    database,
    now,
  );
  const snapshot = (await toolOf(buildInferenceTools(database, now), 'read_recent_memory').handler(
    {},
    ctx,
  )) as { recentEvents: unknown[] } & Record<string, unknown>;
  const { recentEvents, ...memorySnapshot } = snapshot;
  const turns = await toolOf(buildDistillTools(database, now), 'read_recent_conversations').handler(
    {},
    ctx,
  );
  const fit = await productionActivityFamilyReader().familyFit?.(database, familyId, now);

  const contexts: Record<PromptPath, string> = {
    coach: JSON.stringify(coach),
    brief: (await assembleMemoryBrief(database, familyId, now)).text,
    drafter: JSON.stringify(await getMemorySlice(familyId, database, now)),
    find: JSON.stringify(fit ?? null),
    plan: JSON.stringify(await loadPlanFacts(database, familyId, now)),
    'inferencer.memory': JSON.stringify(memorySnapshot),
    'inferencer.events': JSON.stringify(recentEvents),
    distiller: JSON.stringify(turns),
  };

  const [facts, episodes, events, conversations] = await Promise.all([
    database
      .select()
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId)),
    database
      .select()
      .from(schema.familyMemoryEpisodes)
      .where(eq(schema.familyMemoryEpisodes.familyId, familyId)),
    database.select().from(schema.events).where(eq(schema.events.familyId, familyId)),
    database
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.familyId, familyId)),
  ]);
  const messages =
    conversations.length === 0
      ? []
      : await database
          .select()
          .from(schema.messages)
          .where(
            inArray(
              schema.messages.conversationId,
              conversations.map((c) => c.id),
            ),
          );

  const roster = timeline.children.map((child) => ({
    id: family.childIds.get(child.ref) as string,
    name: child.name,
    dateOfBirth: child.dateOfBirth,
  }));
  const primaryExport = await loadFamilyMemoryExport(
    database,
    familyId,
    roster,
    { userId: family.parentUserId },
    now,
  );
  const coParentExport = family.coParentUserId
    ? await loadFamilyMemoryExport(
        database,
        familyId,
        roster,
        { userId: family.coParentUserId },
        now,
      )
    : null;

  return {
    contexts,
    store: JSON.stringify({ facts, episodes, events, messages }),
    storeCounts: { facts: facts.length, episodes: episodes.length },
    primaryExport,
    coParentExport,
  };
}
