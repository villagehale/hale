import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { asTextConnectProvider } from '~/lib/channel/connect/text-connect';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import { signConnectState } from '~/lib/integrations/connect-state';
import {
  buildGoogleAuthUrl,
  connectorClientSource,
  connectorRedirectUri,
  isConnectorProvider,
} from '~/lib/integrations/google-oauth';

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
  const url = new URL(req.url);
  // ONE host, named when it is the wrong one (rule #11). The redirect_uri Google has
  // registered is built from appBaseUrl(), so a request arriving on any other host —
  // a per-branch preview, the *.vercel.app alias — cannot complete this flow. It
  // refuses HERE, with a reason, instead of bouncing off Google's
  // redirect_uri_mismatch or landing back as an unexplained connect=invalid. Preview
  // testing of the connector flow sets APP_URL (and a throwaway project's client
  // pair) in the Preview env; local dev matches already (.env.example APP_URL).
  if (url.host !== new URL(appBaseUrl()).host) {
    return NextResponse.json({ error: 'wrong_host' }, { status: 409 });
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
  // `from=text` is the redeem page saying the parent is standing in a thread. It only
  // counts for a provider Hale can text about — a text surface for any other would
  // promise a receipt (connect/text-connect.ts) that never arrives.
  const fromText =
    url.searchParams.get('from') === 'text' && asTextConnectProvider(provider) !== null;
  const state = signConnectState({
    familyId,
    userId,
    provider,
    ...(fromText ? { surface: 'text' as const } : {}),
  });
  const authUrl = buildGoogleAuthUrl({
    provider,
    state,
    redirectUri: connectorRedirectUri(),
  });
  // WHICH Google project is about to be asked for this grant, said once per connect
  // and in one place (rule #11). Ids and the named source only — never a client id,
  // never a secret (rule #1). 'signin_project' is the fallback running: connect keeps
  // working without the connector pair, and this line plus the connect audit row's
  // `oauthClient` are how anyone answers "which project granted this token".
  console.info(
    { familyId, provider, oauthClient: connectorClientSource() },
    'connector consent starting - this is the Google project the grant will belong to',
  );
  return NextResponse.redirect(authUrl);
}
