import { NextResponse, type NextRequest } from 'next/server';
import { db } from '~/lib/db';
import { verifyConnectState } from '~/lib/integrations/connect-state';
import { CONNECTOR_SCOPES, exchangeCodeForTokens } from '~/lib/integrations/google-oauth';
import { saveConnection } from '~/lib/integrations/store';

// Node runtime: node:crypto (state verify), fetch (token exchange), Drizzle.
export const runtime = 'nodejs';

/**
 * GET /api/integrations/callback — Google's redirect back after consent. The
 * provider-agnostic single callback: the signed `state` carries which
 * family+user+provider this is for, so there's no per-provider callback path and
 * nothing to trust from the query except the signature. On success the connection
 * is stored (tokens envelope-encrypted) and the parent is bounced back to Settings.
 * Failures redirect with a status flag — never a raw error (no token/secret leak).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const origin = process.env.APP_URL ?? url.origin;
  const back = (status: string) => NextResponse.redirect(`${origin}/settings?connect=${status}`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (url.searchParams.get('error') || !code || !state) {
    return back('denied');
  }

  let bound: ReturnType<typeof verifyConnectState>;
  try {
    bound = verifyConnectState(state);
  } catch {
    return back('invalid');
  }

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      redirectUri: `${origin}/api/integrations/callback`,
    });
    const scopes = tokens.scope ? tokens.scope.split(' ') : [...CONNECTOR_SCOPES[bound.provider]];
    await saveConnection(db(), {
      familyId: bound.familyId,
      userId: bound.userId,
      provider: bound.provider,
      scopes,
      tokens,
    });
  } catch {
    return back('error');
  }

  return back(bound.provider);
}
