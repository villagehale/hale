import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq, isNull } from 'drizzle-orm';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { readTeenSafeFamilyEventsInWindow } from '~/lib/loop/assistant-events';
import { type ChildNameLevel, loadLoopPrefsView } from '~/lib/loop/prefs';
import { readWeekPlan } from '~/lib/loop/queries';
import { genericSensitiveWhat, leveledWhat } from '~/lib/loop/templates/weekly-plan/core';
import type { PlanChild } from '~/lib/loop/templates/weekly-plan/payload';
import { weekWindow } from '~/lib/plan/spine';
import type { VillageCandidateView } from '~/lib/village/mappers';
import { readVillage } from '~/lib/village/queries';

export interface McpWeekPlan {
  weekStart: string;
  summary: string | null;
  status: string;
  items: Array<{
    kind: schema.WeekPlanItemKind;
    title: string;
    startsAt: string | null;
    endsAt: string | null;
    location: string | null;
    needs: schema.WeekPlanItemNeeds;
    privacySensitive: boolean;
  }>;
}

/**
 * Project the stored week_plans artifact for an OUTBOUND third-party MCP read
 * (consent type `mcp_third_party_model`). The compose-time teen HARD gate makes the
 * artifact safe for the account holder's own surfaces, but the stored titles still
 * bake NON-teen first names and full health detail, and the composer only genericizes
 * by teen — not the `sensitive` flag. A third-party model must see no more than the
 * strictest outbound channel (SMS/push) would reveal, so this re-renders every item
 * at read time (rule #1): the parent's child_name_level dial with a LIVE teen
 * re-derivation (a child who turned 13 since compose is now stripped), health/sensitive
 * items genericized, and any `sensitive`-sourced family event coarsened + de-located.
 */
export function toMcpWeekPlan(
  plan: schema.WeekPlan,
  children: readonly PlanChild[],
  level: ChildNameLevel,
  sensitiveSourceIds: ReadonlySet<string>,
  now: Date,
): McpWeekPlan {
  const byId = new Map(children.map((c) => [c.id, c]));
  return {
    weekStart: plan.weekStart,
    summary: plan.summary,
    status: plan.status,
    items: plan.items.map((item) => {
      const itemChildren = item.childIds
        .map((id) => byId.get(id))
        .filter((c): c is PlanChild => c !== undefined);
      const anyTeen = itemChildren.some((c) => deriveStage(c.dateOfBirth, now) === 'teenager');
      const sensitiveSourced =
        item.sourceRef?.table === 'family_events' && sensitiveSourceIds.has(item.sourceRef.id);
      const isPrivate = item.privacySensitive || sensitiveSourced;
      return {
        kind: item.kind,
        // Sensitive/health → coarse "what" (never rides the strict channels); otherwise
        // the name re-leveled to the family's dial + live teen re-derivation.
        title: isPrivate ? genericSensitiveWhat(item) : leveledWhat(item, children, level, now),
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        location: isPrivate || anyTeen ? null : item.location,
        needs: item.needs,
        privacySensitive: isPrivate,
      };
    }),
  };
}

/** The `sensitive` family-event ids for a family — the composer bakes these into the
 * artifact with raw titles (it gates only by teen), so the MCP projection coarsens
 * them here to match get_upcoming_events (which redacts teen OR sensitive). */
async function sensitiveFamilyEventIds(
  database: Database,
  familyId: string,
): Promise<ReadonlySet<string>> {
  const rows = await database
    .select({ id: schema.familyEvents.id })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        eq(schema.familyEvents.sensitive, true),
        isNull(schema.familyEvents.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

async function loadPlanChildren(database: Database, familyId: string): Promise<PlanChild[]> {
  return database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
      gender: schema.children.gender,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
}

export async function getWeekPlanForMcp(
  database: Database,
  input: { familyId: string; userId: string; weekStart?: string },
  now: Date = new Date(),
): Promise<McpWeekPlan> {
  const timeZone = await readFamilyTimezone(database, input.familyId);
  const weekStart = input.weekStart ?? weekWindow(now, timeZone).startKey;
  const plan = await readWeekPlan(database, input.familyId, weekStart);
  if (!plan) return { weekStart, summary: null, status: 'not_composed', items: [] };

  // The grant owner's own name-level dial governs their outbound surfaces; default is
  // 'generic' (most private), the right floor for a third-party disclosure.
  const [children, level, sensitiveIds] = await Promise.all([
    loadPlanChildren(database, input.familyId),
    loadLoopPrefsView(input.userId, database).then((v) => v.childNameLevel),
    sensitiveFamilyEventIds(database, input.familyId),
  ]);
  return toMcpWeekPlan(plan, children, level, sensitiveIds, now);
}

export async function getUpcomingEventsForMcp(
  database: Database,
  input: { familyId: string; days: number },
  now: Date = new Date(),
) {
  const end = new Date(now.getTime() + input.days * 24 * 60 * 60 * 1_000);
  return readTeenSafeFamilyEventsInWindow(database, input.familyId, now, end, now);
}

export interface McpVillagePick {
  id: string;
  title: string;
  kind: string;
  summary: string;
  cadence: string | null;
  eventDate: string | null;
  venueName: string | null;
  sourceUrl: string | null;
  teenAttributed: boolean;
}

/** Bounded, read-only projection of the existing teen-safe Village view. */
export function toMcpVillagePicks(
  candidates: readonly VillageCandidateView[],
  limit: number,
): McpVillagePick[] {
  return candidates.slice(0, limit).map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    kind: candidate.kind,
    summary: candidate.summary,
    cadence: candidate.cadence,
    eventDate: candidate.eventDate,
    venueName: candidate.venueName,
    sourceUrl: candidate.sourceUrl,
    teenAttributed: candidate.teenAttributed,
  }));
}

export async function getVillagePicksForMcp(
  database: Database,
  input: { familyId: string; limit: number },
): Promise<McpVillagePick[]> {
  const village = await readVillage(database, input.familyId);
  return toMcpVillagePicks(village.candidates, input.limit);
}
