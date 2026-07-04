import { type RegisteredTool, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { companionForChild, deriveStage } from '@hale/types';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { toVillageCandidateView } from '~/lib/village/mappers';
import { visibleCandidates } from '~/lib/village/visibility';

/**
 * The daily-brief agent's tools — every one family-scoped (rule #1: a handler
 * reads only `ctx.familyId`'s rows) and READ-ONLY. The guarded invoker writes the
 * audit row for each call (rule #6); none spend money and none take a raw teen's
 * content (teen developmental detail is excluded at the source, not gated), so
 * the brief composes from a safe slice no matter what the model asks for.
 *
 * `get_companion_brief` mirrors the worker digest's companionHighlightsForChildren
 * (derived from the SAME deterministic companionForChild in @hale/types) rather
 * than importing the worker module across the process boundary.
 */

/** A health item this coarse window counts as "soon" for a daily-brief nudge —
 * mirrors the worker digest's HEALTH_SOON_WEEKS. */
const HEALTH_SOON_WEEKS = 6;

/** How many of the freshest candidates the brief considers. */
const WEEK_VILLAGE_LIMIT = 10;

/** Candidates discovered within this many days count as "this week". */
const WEEK_DAYS = 7;

export function buildDailyBriefTools(
  database: Database,
  now: Date = new Date(),
): RegisteredTool[] {
  const getCompanionBrief = defineTool({
    name: 'get_companion_brief',
    description:
      "Per non-teen child in THIS family: a soon-due routine health item and a milestone worth watching this stage, derived from date of birth. A teenager appears by name only — their developmental detail is excluded (rule #1).",
    inputSchema: z.object({}),
    handler: async (_input, ctx) => {
      const children = await database
        .select({
          id: schema.children.id,
          name: schema.children.name,
          dateOfBirth: schema.children.dateOfBirth,
        })
        .from(schema.children)
        .where(eq(schema.children.familyId, ctx.familyId));

      const highlights: Array<{ name: string; notes: string[] }> = [];
      const teenNames: string[] = [];

      for (const child of children) {
        if (deriveStage(child.dateOfBirth, now) === 'teenager') {
          teenNames.push(child.name);
          continue;
        }
        const view = companionForChild(
          { dateOfBirth: child.dateOfBirth, name: child.name },
          now,
        );
        const notes: string[] = [];

        const soon = view.nextHealth.find((item) => item.dueInWeeks <= HEALTH_SOON_WEEKS);
        if (soon) {
          const when =
            soon.dueInWeeks <= 0
              ? 'due now'
              : `due in ${soon.dueInWeeks} ${soon.dueInWeeks === 1 ? 'week' : 'weeks'}`;
          notes.push(`${child.name}'s ${soon.what} are ${when}`);
        }

        const watch = view.milestones.find((m) => m.timing === 'in_window');
        if (watch) {
          notes.push(`watch for "${watch.what.toLowerCase()}" around this stage`);
        }

        if (notes.length > 0) {
          highlights.push({ name: child.name, notes });
        }
      }

      return { highlights, teenNames };
    },
  });

  const getWeekVillage = defineTool({
    name: 'get_week_village',
    description:
      "Local classes, groups, and activities surfaced for THIS family's area within the last week. Teen-attributed items are redacted to a category only (rule #1).",
    inputSchema: z.object({}),
    handler: async (_input, ctx) => {
      const children = await database
        .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
        .from(schema.children)
        .where(eq(schema.children.familyId, ctx.familyId));
      const teenChildIds = new Set(
        children.filter((c) => deriveStage(c.dateOfBirth, now) === 'teenager').map((c) => c.id),
      );

      const since = new Date(now.getTime() - WEEK_DAYS * 24 * 60 * 60 * 1000);
      const currentRunRows = await database
        .select()
        .from(schema.villageCandidates)
        .where(
          and(
            eq(schema.villageCandidates.familyId, ctx.familyId),
            isNull(schema.villageCandidates.supersededAt),
            gte(schema.villageCandidates.discoveredAt, since),
          ),
        )
        .orderBy(
          desc(schema.villageCandidates.confidence),
          desc(schema.villageCandidates.discoveredAt),
        )
        .limit(WEEK_VILLAGE_LIMIT);

      const candidates = visibleCandidates(currentRunRows, now)
        .map((row) =>
          toVillageCandidateView(row, row.childId !== null && teenChildIds.has(row.childId)),
        )
        .map((c) => ({ title: c.title, kind: c.kind, summary: c.summary }));

      return { candidates };
    },
  });

  return [getCompanionBrief, getWeekVillage];
}
