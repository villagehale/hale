import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { draftInlineAction } from '~/lib/coach/inline-action';
import { pipelineClient } from '~/lib/pipeline/client';
import { enforceRateLimit } from '~/lib/rate-limit/apply';
import { getUpcomingEventsForMcp, getVillagePicksForMcp, getWeekPlanForMcp } from './read-tools';
import type { McpToolDeps } from './tool-runner';

async function familyChildOrNull(
  database: Database,
  familyId: string,
  childId: string | null,
): Promise<string | null> {
  if (!childId) return null;
  const rows = await database
    .select({ id: schema.children.id })
    .from(schema.children)
    .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Production adapters: every MCP tool delegates to an existing Hale domain seam. */
export function productionMcpToolDeps(database: Database): McpToolDeps {
  return {
    getWeekPlan: (input) => getWeekPlanForMcp(database, input),
    getUpcomingEvents: (input) => getUpcomingEventsForMcp(database, input),
    getVillagePicks: (input) => getVillagePicksForMcp(database, input),
    async proposeAction(input) {
      const childId = await familyChildOrNull(database, input.familyId, input.childId);
      if (input.childId && !childId) {
        throw new Error('MCP proposal child is not in the authorized family');
      }
      const { actionId } = await draftInlineAction(
        { ...input, childId },
        database,
        pipelineClient(),
      );
      return { actionId, status: 'drafted_for_approval' };
    },
    async rateLimited(grantId) {
      return (await enforceRateLimit('mcp-tool', grantId, true)) !== null;
    },
    async audit(entry) {
      await database.insert(schema.auditLog).values({
        familyId: entry.familyId,
        actor: entry.userId,
        actionTaken: 'mcp.tool_called',
        targetTable: 'mcp_grants',
        targetId: entry.grantId,
        after: {
          clientId: entry.clientId,
          tool: entry.tool,
          scope: entry.scope,
          outcome: entry.outcome,
        },
      });
    },
  };
}
