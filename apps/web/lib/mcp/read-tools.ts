import type { Database, schema } from '@hale/db';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { readTeenSafeFamilyEventsInWindow } from '~/lib/loop/assistant-events';
import { readWeekPlan } from '~/lib/loop/queries';
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

/** The stored artifact is teen-safe; this removes internal IDs and provenance. */
export function toMcpWeekPlan(plan: schema.WeekPlan): McpWeekPlan {
  return {
    weekStart: plan.weekStart,
    summary: plan.summary,
    status: plan.status,
    items: plan.items.map((item) => ({
      kind: item.kind,
      title: item.title,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      location: item.location,
      needs: item.needs,
      privacySensitive: item.privacySensitive,
    })),
  };
}

export async function getWeekPlanForMcp(
  database: Database,
  input: { familyId: string; weekStart?: string },
  now: Date = new Date(),
): Promise<McpWeekPlan> {
  const timeZone = await readFamilyTimezone(database, input.familyId);
  const weekStart = input.weekStart ?? weekWindow(now, timeZone).startKey;
  const plan = await readWeekPlan(database, input.familyId, weekStart);
  return plan
    ? toMcpWeekPlan(plan)
    : { weekStart, summary: null, status: 'not_composed', items: [] };
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
