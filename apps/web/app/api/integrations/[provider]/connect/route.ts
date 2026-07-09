import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { signConnectState } from '~/lib/integrations/connect-state';
import { buildGoogleAuthUrl, isConnectorProvider } from '~/lib/integrations/google-oauth';

// Node runtime: node:crypto (state signing) + the Drizzle client.
export const runtime = 'nodejs';

/**
 * GET /api/integrations/[provider]/connect — start the Google consent flow for a
 * connector. Auth is the gate (dev-preview 501, signed-out 401). We bind the
 * consent redirect to the caller's family+user+provider via a signed state token,
 * then redirect to Google. The callback (/api/integrations/callback) trusts that
 * signed state — no server-side session storage needed.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  if (!authConfigured()) {
    return NextResponse.json({ error: 'auth_required' }, { status: 501 });
  }
  const { provider } = await ctx.params;
  if (!isConnectorProvider(provider)) {
    return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
  }
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const database = db();
  const [familyId, userId] = await Promise.all([
    resolveFamilyForUser(externalAuthId, database),
    resolveUserIdForUser(externalAuthId, database),
  ]);
  if (!familyId || !userId) {
    return NextResponse.json({ error: 'no_family' }, { status: 403 });
  }
  const origin = process.env.APP_URL ?? new URL(req.url).origin;
  const state = signConnectState({ familyId, userId, provider });
  const authUrl = buildGoogleAuthUrl({
    provider,
    state,
    redirectUri: `${origin}/api/integrations/callback`,
  });
  return NextResponse.redirect(authUrl);
}
