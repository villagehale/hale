import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { z } from 'zod';
import { db } from '~/lib/db';
import { canonicalMcpResource, isMcpScope } from '~/lib/mcp/contracts';
import { mcpRequestOrigin } from '~/lib/mcp/http';
import { verifyMcpBearer } from '~/lib/mcp/oauth-store';
import { productionMcpToolDeps } from '~/lib/mcp/production-deps';
import { type McpGrantContext, type McpToolName, invokeMcpTool } from '~/lib/mcp/tool-runner';

export const runtime = 'nodejs';
export const maxDuration = 60;

function grantFrom(authInfo: AuthInfo | undefined): McpGrantContext | null {
  const extra = authInfo?.extra;
  if (
    !authInfo ||
    !extra ||
    typeof extra.grantId !== 'string' ||
    typeof extra.familyId !== 'string' ||
    typeof extra.userId !== 'string' ||
    typeof extra.clientName !== 'string' ||
    authInfo.scopes.some((scope) => !isMcpScope(scope))
  ) {
    return null;
  }
  return {
    grantId: extra.grantId,
    familyId: extra.familyId,
    userId: extra.userId,
    clientId: authInfo.clientId,
    clientName: extra.clientName,
    scopes: authInfo.scopes.filter(isMcpScope),
  };
}

function callTool(tool: McpToolName, input: unknown, authInfo: AuthInfo | undefined) {
  const grant = grantFrom(authInfo);
  if (!grant) {
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: '{"error":"unauthorized"}' }],
    };
  }
  return invokeMcpTool(tool, input, grant, productionMcpToolDeps(db()));
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      'get_week_plan',
      {
        title: 'Get week plan',
        description:
          "Read this family's persisted Hale week plan. Teen details are already redacted server-side.",
        inputSchema: {
          weekStart: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe('Monday date as YYYY-MM-DD; defaults to the current family-local week.'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      (input, extra) => callTool('get_week_plan', input, extra.authInfo),
    );

    server.registerTool(
      'get_upcoming_events',
      {
        title: 'Get upcoming events',
        description:
          "Read this family's live upcoming calendar items. Teen and sensitive details are genericized server-side.",
        inputSchema: {
          days: z.number().int().min(1).max(90).default(30),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      (input, extra) => callTool('get_upcoming_events', input, extra.authInfo),
    );

    server.registerTool(
      'get_village_picks',
      {
        title: 'Get Village picks',
        description:
          "Read a bounded set of this family's current Village recommendations. Teen picks remain category-only.",
        inputSchema: {
          limit: z.number().int().min(1).max(20).default(10),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      (input, extra) => callTool('get_village_picks', input, extra.authInfo),
    );

    server.registerTool(
      'propose_action',
      {
        title: 'Propose an action',
        description:
          'Create a Hale draft for a parent to review. This never executes; parent approval in Hale is always required.',
        inputSchema: {
          intentKind: z.enum(['find_activities', 'add_to_plan', 'book_checkup', 'set_reminder']),
          focusedChildId: z.string().uuid().optional(),
          rationale: z.string().trim().min(4).max(2_000),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      (input, extra) => callTool('propose_action', input, extra.authInfo),
    );
  },
  {
    serverInfo: { name: 'hale', version: '1.0.0' },
    capabilities: { tools: {} },
  },
  {
    basePath: '/api',
    disableSse: true,
    maxDuration,
    verboseLogs: false,
  },
);

async function verifyToken(req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken?.startsWith('hale_mcp_')) return undefined;
  const resource = canonicalMcpResource(mcpRequestOrigin(req));
  const grant = await verifyMcpBearer(db(), bearerToken, resource);
  if (!grant) return undefined;
  return {
    token: bearerToken,
    clientId: grant.clientId,
    scopes: grant.scopes,
    resource: new URL(resource),
    extra: {
      grantId: grant.grantId,
      familyId: grant.familyId,
      userId: grant.userId,
      clientName: grant.clientName,
    },
  };
}

const authenticated = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: '/.well-known/oauth-protected-resource',
});

export { authenticated as GET, authenticated as POST, authenticated as DELETE };
