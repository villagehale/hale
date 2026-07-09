import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { mintConnectNonce } from '~/lib/integrations/connect-nonce';
import { CONNECT_STATE_TTL_SECONDS, signConnectState } from '~/lib/integrations/connect-state';
import { buildGoogleAuthUrl, isConnectorProvider } from '~/lib/integrations/google-oauth';
import type { MobileConnectUrlResponse } from '../../types';

// Node runtime: node:crypto (state signing) + the Drizzle client.
export const runtime = 'nodejs';

/**
 * GET /api/mobile/integrations/connect-url?provider=gcal|gmail|gdrive — the native
 * counterpart to the cookie-authed web connect route. The app can't ride a browser
 * cookie into Google's consent screen, so this Bearer-authed route hands back the
 * consent `url` for the app to open in a system browser. The url carries the SAME
 * signed state as the web flow (familyId+userId+provider, HMAC, 10-min TTL) PLUS
 * surface='mobile', so the shared callback authenticates purely on the signature —
 * no browser session — and redirects to the public /connected page instead of web
 * Settings. Read-only scopes only (rule #1); no token ever touches this response.
 *
 * no DB (dev preview) → 503, signed-out → 401, bad provider → 400, no family → 403.
 */
export async function GET(req: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const provider = new URL(req.url).searchParams.get('provider') ?? '';
  if (!isConnectorProvider(provider)) {
    return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
  }

  const database = db();
  const [familyId, userId] = await Promise.all([
    resolveFamilyForUser(session.user.id, database),
    resolveUserIdForUser(session.user.id, database),
  ]);
  if (!familyId || !userId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const origin = process.env.APP_URL ?? new URL(req.url).origin;
  const nonceExpiresAt = new Date(Date.now() + CONNECT_STATE_TTL_SECONDS * 1000);
  const nonce = await mintConnectNonce(database, familyId, nonceExpiresAt);
  const state = signConnectState({ familyId, userId, provider, surface: 'mobile', nonce });
  const url = buildGoogleAuthUrl({
    provider,
    state,
    redirectUri: `${origin}/api/integrations/callback`,
  });

  const body: MobileConnectUrlResponse = { url };
  return NextResponse.json(body);
}
