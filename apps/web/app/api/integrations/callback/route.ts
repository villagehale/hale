import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { resolveUserIdForUser } from '~/lib/family';
import { verifyConnectState } from '~/lib/integrations/connect-state';
import { CONNECTOR_SCOPES, exchangeCodeForTokens } from '~/lib/integrations/google-oauth';
import { saveConnection } from '~/lib/integrations/store';

// Node runtime: node:crypto (state verify), fetch (token exchange), Drizzle.
export const runtime = 'nodejs';

/**
 * GET /api/integrations/callback — Google's redirect back after consent. The
 * provider-agnostic single callback: the signed `state` carries which
 * family+user+provider this is for, so there's no per-provider callback path and
 * nothing to trust from the query except the signature.
 *
 * The signature stops forgery/cross-family FORGING but NOT consent-fixation: a
 * signed state binds to the user who MINTED it, and without a second check the
 * browser COMPLETING consent needn't be that user — an attacker could mint a state
 * for their own family and phish a victim into granting THEIR Google account, whose
 * tokens would then land under the attacker's family (rule #1). So we bind the
 * completer to the minter before storing anything:
 *   - web (no `surface`): require an authed session whose user == the bound user.
 *   - mobile: rejected outright — the native mint route (and the single-use-nonce
 *     binding that made mobile consent bindable) was retired with the Expo app
 *     (VIL-318), so a mobile-surface state can only be stale or replayed.
 *
 * On success the connection is stored (tokens envelope-encrypted) and the parent is
 * bounced back to Settings. Failures redirect with a status flag — never a raw
 * error (no token/secret leak).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const origin = process.env.APP_URL ?? url.origin;
  // Before the state is verified we can't know the surface — web is the safe
  // default (an unverifiable state never reached a mobile flow anyway).
  const back = (status: string, surface?: 'mobile') =>
    surface === 'mobile'
      ? NextResponse.redirect(`${origin}/connected?status=${status}`)
      : NextResponse.redirect(`${origin}/settings?connect=${status}`);

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

  const database = db();

  // Bind the completing party to the state's minter (consent-fixation guard, rule #1).
  if (bound.surface === 'mobile') {
    // The mobile mint (and its single-use-nonce binding) was retired with the Expo
    // app (VIL-318): nothing mints a mobile state any more, so one arriving here is
    // stale or replayed — fail closed rather than complete an unbindable consent.
    return back('invalid', 'mobile');
  } else {
    const session = await auth();
    const externalAuthId = session?.user?.id;
    const sessionUserId = externalAuthId
      ? await resolveUserIdForUser(externalAuthId, database)
      : null;
    if (!sessionUserId || sessionUserId !== bound.userId) {
      return back('invalid');
    }
  }

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      redirectUri: `${origin}/api/integrations/callback`,
    });
    // Granular consent lets the user deselect the scope, and a provider bug could
    // broaden it: the grant must contain EXACTLY what this connector needs and
    // nothing outside the readonly universe — otherwise store nothing (a stored
    // 'active' connection whose token 403s would error-flap forever; a broader
    // one would silently hold power we never asked the parent to consent to).
    const scopes = (tokens.scope ?? '').split(' ').filter(Boolean);
    const expected = CONNECTOR_SCOPES[bound.provider];
    const readonlyUniverse = new Set(Object.values(CONNECTOR_SCOPES).flat());
    const grantedOk =
      expected.every((sc) => scopes.includes(sc)) &&
      scopes.every((sc) => readonlyUniverse.has(sc));
    if (!grantedOk) {
      return back('denied', bound.surface);
    }
    await saveConnection(database, {
      familyId: bound.familyId,
      userId: bound.userId,
      provider: bound.provider,
      scopes,
      tokens,
    });
  } catch {
    return back('error', bound.surface);
  }

  return bound.surface === 'mobile'
    ? NextResponse.redirect(`${origin}/connected?provider=${bound.provider}`)
    : back(bound.provider);
}
