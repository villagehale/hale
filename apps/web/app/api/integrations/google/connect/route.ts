import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { threadOnboardingV2Enabled } from '~/lib/channel/intake/thread-onboarding-v2';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { adoptSigninToken } from '~/lib/integrations/adopt-signin-token';
import { signConnectState } from '~/lib/integrations/connect-state';
import {
  buildGoogleBundleAuthUrl,
  connectorClientSource,
  connectorRedirectUri,
} from '~/lib/integrations/google-oauth';

// Node runtime: node:crypto (state signing) + the Drizzle client.
export const runtime = 'nodejs';

/**
 * GET /api/integrations/google/connect — VIL-721's one link: ONE Google consent that
 * asks for Gmail and the calendar together, so a parent taps once and meets Google's
 * unverified-app screen once (google-oauth.ts says why one consent is still rule #1).
 *
 * The same gates as one connector's door (api/integrations/[provider]/connect), in the
 * same order, plus two of its own, each named:
 *  - `not_offered` (404) while THREAD_ONBOARDING_V2_ENABLED is off. Nothing mints this
 *    link while dark; one tapped from an older text lands here and starts nothing.
 *  - `text_only` (400) without `from=text`: the bundle exists for a texted link, so the
 *    return leg always owes a done page and a text back, never Settings.
 * The callback reads the bundle from the signed state, never from a query string.
 */
export async function GET(req: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.json({ error: 'auth_required' }, { status: 501 });
  }
  if (!threadOnboardingV2Enabled()) {
    console.info({ outcome: 'not_offered' }, 'google bundle consent: flag off - nothing started');
    return NextResponse.json({ error: 'not_offered' }, { status: 404 });
  }
  const url = new URL(req.url);
  // ONE host, named when it is the wrong one (rule #11): Google's registered
  // redirect_uri is built from appBaseUrl(), as on the per-connector door.
  if (url.host !== new URL(appBaseUrl()).host) {
    return NextResponse.json({ error: 'wrong_host' }, { status: 409 });
  }
  if (url.searchParams.get('from') !== 'text') {
    return NextResponse.json({ error: 'text_only' }, { status: 400 });
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
  const channelSigninTokenId = await adoptSigninToken(database, {
    familyId,
    userId,
    provider: 'google',
    link: url.searchParams.get('link'),
  });
  const state = signConnectState({
    familyId,
    userId,
    provider: 'google',
    surface: 'text',
    ...(channelSigninTokenId ? { channelSigninTokenId } : {}),
  });
  const authUrl = buildGoogleBundleAuthUrl({
    state,
    redirectUri: connectorRedirectUri(),
    userId,
  });
  // Which Google project is about to be asked, said once (rule #11). Ids and the named
  // source only, never a client id or a secret (rule #1).
  console.info(
    { familyId, provider: 'google', oauthClient: connectorClientSource() },
    'connector consent starting - this is the Google project the grant will belong to',
  );
  return NextResponse.redirect(authUrl);
}
