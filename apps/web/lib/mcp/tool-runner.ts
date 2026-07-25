import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpScope } from './contracts';

export const MCP_TOOL_SCOPES = {
  get_week_plan: 'week_plan.read',
  get_upcoming_events: 'events.read',
  get_village_picks: 'village.read',
  propose_action: 'actions.propose',
} as const satisfies Record<string, McpScope>;

export type McpToolName = keyof typeof MCP_TOOL_SCOPES;

export interface McpGrantContext {
  grantId: string;
  familyId: string;
  userId: string;
  clientId: string;
  clientName: string;
  scopes: McpScope[];
}

export interface McpToolAudit {
  familyId: string;
  userId: string;
  grantId: string;
  clientId: string;
  tool: McpToolName;
  scope: McpScope;
  outcome: 'success' | 'rate_limited' | 'denied_scope' | 'invalid_input' | 'failed';
}

export interface McpToolDeps {
  getWeekPlan: (input: {
    familyId: string;
    userId: string;
    weekStart?: string;
  }) => Promise<unknown>;
  getUpcomingEvents: (input: {
    familyId: string;
    days: number;
  }) => Promise<unknown>;
  getVillagePicks: (input: {
    familyId: string;
    limit: number;
  }) => Promise<unknown>;
  proposeAction: (input: {
    familyId: string;
    actor: string;
    intentKind: 'find_activities' | 'add_to_plan' | 'book_checkup' | 'set_reminder';
    childId: string | null;
    sourceAnswer: string;
    origin: 'mcp';
  }) => Promise<{ actionId: string; status: 'drafted_for_approval' }>;
  /** True when the per-grant fail-closed MCP cap refuses this invocation. */
  rateLimited: (grantId: string) => Promise<boolean>;
  audit: (entry: McpToolAudit) => Promise<void>;
}

export interface McpToolResult extends CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

const weekPlanInput = z.object({
  weekStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
const upcomingEventsInput = z.object({
  days: z.number().int().min(1).max(90).default(30),
});
const villagePicksInput = z.object({
  limit: z.number().int().min(1).max(20).default(10),
});
const proposeActionInput = z.object({
  intentKind: z.enum(['find_activities', 'add_to_plan', 'book_checkup', 'set_reminder']),
  focusedChildId: z.string().uuid().optional(),
  rationale: z.string().trim().min(4).max(2_000),
});

function result(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function error(code: string, detail: string): McpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: code, detail }) }],
  };
}

/**
 * The protocol-independent MCP tool boundary. It checks the grant's exact scope,
 * validates untrusted tool arguments, delegates to the existing product seam, and
 * writes one metadata-only audit outcome for every valid-grant invocation.
 */
export async function invokeMcpTool(
  tool: McpToolName,
  input: unknown,
  grant: McpGrantContext,
  deps: McpToolDeps,
): Promise<McpToolResult> {
  const scope = MCP_TOOL_SCOPES[tool];
  const audit = (outcome: McpToolAudit['outcome']) =>
    deps.audit({
      familyId: grant.familyId,
      userId: grant.userId,
      grantId: grant.grantId,
      clientId: grant.clientId,
      tool,
      scope,
      outcome,
    });

  if (await deps.rateLimited(grant.grantId)) {
    await audit('rate_limited');
    return error('rate_limited', 'This connection is making requests too quickly.');
  }

  if (!grant.scopes.includes(scope)) {
    await audit('denied_scope');
    return error('insufficient_scope', `This connection does not have ${scope}.`);
  }

  try {
    let output: unknown;
    switch (tool) {
      case 'get_week_plan': {
        const parsed = weekPlanInput.safeParse(input);
        if (!parsed.success) {
          await audit('invalid_input');
          return error('invalid_input', 'weekStart must be a YYYY-MM-DD date.');
        }
        output = await deps.getWeekPlan({
          familyId: grant.familyId,
          userId: grant.userId,
          weekStart: parsed.data.weekStart,
        });
        break;
      }
      case 'get_upcoming_events': {
        const parsed = upcomingEventsInput.safeParse(input);
        if (!parsed.success) {
          await audit('invalid_input');
          return error('invalid_input', 'days must be a whole number from 1 to 90.');
        }
        output = {
          events: await deps.getUpcomingEvents({
            familyId: grant.familyId,
            days: parsed.data.days,
          }),
        };
        break;
      }
      case 'get_village_picks': {
        const parsed = villagePicksInput.safeParse(input);
        if (!parsed.success) {
          await audit('invalid_input');
          return error('invalid_input', 'limit must be a whole number from 1 to 20.');
        }
        output = {
          picks: await deps.getVillagePicks({
            familyId: grant.familyId,
            limit: parsed.data.limit,
          }),
        };
        break;
      }
      case 'propose_action': {
        const parsed = proposeActionInput.safeParse(input);
        if (!parsed.success) {
          await audit('invalid_input');
          return error('invalid_input', 'Use a supported action intent and a short rationale.');
        }
        const proposal = await deps.proposeAction({
          familyId: grant.familyId,
          actor: grant.userId,
          intentKind: parsed.data.intentKind,
          childId: parsed.data.focusedChildId ?? null,
          sourceAnswer: parsed.data.rationale,
          origin: 'mcp',
        });
        output = {
          ...proposal,
          detail: 'The proposal is held in Hale until a parent reviews and approves it.',
        };
        break;
      }
    }
    await audit('success');
    return result(output);
  } catch {
    await audit('failed');
    // Tool inputs and downstream errors can contain family text. Log metadata only.
    console.error({ tool, grantId: grant.grantId }, 'MCP tool failed');
    return error('tool_failed', 'Hale could not complete that request just now.');
  }
}
