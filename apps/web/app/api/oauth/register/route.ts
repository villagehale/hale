import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '~/lib/db';
import { validateOAuthRedirectUri } from '~/lib/mcp/contracts';
import { registerMcpOauthClient } from '~/lib/mcp/oauth-store';
import { clientIp, enforceRateLimit } from '~/lib/rate-limit/apply';

export const runtime = 'nodejs';

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(120),
  redirect_uris: z.array(z.string().max(2_048)).min(1).max(5),
  token_endpoint_auth_method: z.literal('none').optional().default('none'),
  grant_types: z.array(z.literal('authorization_code')).optional(),
  response_types: z.array(z.literal('code')).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const limited = await enforceRateLimit('mcp-register', clientIp(req), true);
  if (limited) return limited;

  const parsed = registrationSchema.safeParse(await req.json().catch(() => null));
  if (
    !parsed.success ||
    parsed.data.redirect_uris.some((uri) => !validateOAuthRedirectUri(uri)) ||
    new Set(parsed.success ? parsed.data.redirect_uris : []).size !==
      (parsed.success ? parsed.data.redirect_uris.length : 0)
  ) {
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: 'Invalid client registration.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const client = await registerMcpOauthClient(db(), {
    clientName: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
  });
  return NextResponse.json(
    {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
