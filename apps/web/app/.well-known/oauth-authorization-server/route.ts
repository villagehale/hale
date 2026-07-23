import { NextResponse } from 'next/server';
import { MCP_SCOPES } from '~/lib/mcp/contracts';
import { mcpRequestOrigin } from '~/lib/mcp/http';

export const dynamic = 'force-dynamic';

export function GET(req: Request): Response {
  const issuer = mcpRequestOrigin(req);
  return NextResponse.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/api/oauth/token`,
      registration_endpoint: `${issuer}/api/oauth/register`,
      scopes_supported: MCP_SCOPES,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    },
    {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    },
  );
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
