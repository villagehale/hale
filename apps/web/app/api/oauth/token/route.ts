import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '~/lib/db';
import { canonicalMcpResource } from '~/lib/mcp/contracts';
import { mcpRequestOrigin } from '~/lib/mcp/http';
import { exchangeAuthorizationCode } from '~/lib/mcp/oauth-store';
import { clientIp, enforceRateLimit } from '~/lib/rate-limit/apply';

export const runtime = 'nodejs';

const tokenSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(20).max(256),
  client_id: z.string().min(8).max(256),
  redirect_uri: z.string().url().max(2_048),
  resource: z.string().url().max(2_048),
  code_verifier: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9\-._~]+$/),
});

export async function POST(req: Request): Promise<Response> {
  const limited = await enforceRateLimit('mcp-token', clientIp(req), true);
  if (limited) return limited;

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return oauthError('invalid_request', 400);
  }
  const parsed = tokenSchema.safeParse(Object.fromEntries((await req.formData()).entries()));
  if (!parsed.success) return oauthError('invalid_request', 400);

  const expectedResource = canonicalMcpResource(mcpRequestOrigin(req));
  if (parsed.data.resource !== expectedResource) return oauthError('invalid_target', 400);

  const result = await exchangeAuthorizationCode(db(), {
    code: parsed.data.code,
    clientId: parsed.data.client_id,
    redirectUri: parsed.data.redirect_uri,
    resource: parsed.data.resource,
    codeVerifier: parsed.data.code_verifier,
  });
  if (result.status !== 'issued') return oauthError('invalid_grant', 400);

  return NextResponse.json(
    {
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      scope: result.scope,
    },
    { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
  );
}

function oauthError(error: string, status: number): Response {
  return NextResponse.json(
    { error },
    { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
  );
}
