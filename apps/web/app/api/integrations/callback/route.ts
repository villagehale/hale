import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '~/auth';
import {
  connectedNoticeLabel,
  defaultConnectedNoticePorts,
  sendConnectorConnectedText,
} from '~/lib/channel/connect/connected-notice';
import { asTextConnectProvider } from '~/lib/channel/connect/text-connect';
import { db } from '~/lib/db';
import { resolveUserIdForUser } from '~/lib/family';
import { type ConnectState, verifyConnectState } from '~/lib/integrations/connect-state';
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
 *   - web and text: require an authed session whose user == the bound user. The texted
 *     link's redeem page signs that session in before the consent starts, so the two
 *     surfaces are held to exactly the same check.
 *   - mobile: rejected outright — the native mint route (and the single-use-nonce
 *     binding that made mobile consent bindable) was retired with the Expo app
 *     (VIL-318), so a mobile-surface state can only be stale or replayed.
 *
 * WHERE IT LANDS is the surface's, not the query's: a parent who started in a text
 * thread ends on a page they can close plus one text back (no portal in the path), and a
 * parent who started in Settings goes back to Settings. Failures redirect with a status
 * flag — never a raw error (no token/secret leak).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const origin = process.env.APP_URL ?? url.origin;
  // Before the state is verified we can't know the surface — web is the safe
  // default (an unverifiable state never reached another flow anyway).
  const back = (status: string, surface?: ConnectState['surface'], provider?: string) => {
    if (surface === 'text') {
      const query = new URLSearchParams({ provider: provider ?? '', status });
      return NextResponse.redirect(`${origin}/connected?${query.toString()}`);
    }
    if (surface === 'mobile') {
      return NextResponse.redirect(`${origin}/connected?status=${status}`);
    }
    return NextResponse.redirect(`${origin}/settings?connect=${status}`);
  };

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // No state at all binds to nothing and says nothing about where the parent came
  // from — the web dead end. Google echoes the state even on a denial, so every other
  // outcome below can answer on the surface the consent started from.
  if (!state) return back('denied');

  let bound: ReturnType<typeof verifyConnectState>;
  try {
    bound = verifyConnectState(state);
  } catch {
    return back('invalid');
  }

  // Bind the completing party to the state's minter (consent-fixation guard, rule #1).
  if (bound.surface === 'mobile') {
    // The mobile mint (and its single-use-nonce binding) was retired with the Expo
    // app (VIL-318): nothing mints a mobile state any more, so one arriving here is
    // stale or replayed — fail closed rather than complete an unbindable consent.
    return back('invalid', 'mobile');
  }
  // A text surface names a provider Hale has a receipt for, or this deployment did not
  // mint it: fail closed rather than complete a connect whose promised text is a blank.
  const textProvider = bound.surface === 'text' ? asTextConnectProvider(bound.provider) : null;
  if (bound.surface === 'text' && !textProvider) return back('invalid');
  const surface = bound.surface;

  if (url.searchParams.get('error') || !code) return back('denied', surface, bound.provider);

  const database = db();
  const session = await auth();
  const externalAuthId = session?.user?.id;
  const sessionUserId = externalAuthId
    ? await resolveUserIdForUser(externalAuthId, database)
    : null;
  if (!sessionUserId || sessionUserId !== bound.userId) {
    return back('invalid', surface, bound.provider);
  }

  let integrationId: string;
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
      return back('denied', surface, bound.provider);
    }
    integrationId = await saveConnection(database, {
      familyId: bound.familyId,
      userId: bound.userId,
      provider: bound.provider,
      scopes,
      tokens,
    });
  } catch {
    return back('error', surface, bound.provider);
  }

  if (textProvider) {
    // Awaited inside the handler on purpose: this runs on the request Google redirected,
    // and `after()` would let the process finish before the one text the parent is
    // standing there waiting for. The receipt never changes what the page says — the
    // connection is already stored — so its outcome is a log line (rule #11).
    const receipt = await sendConnectorConnectedText(
      database,
      {
        familyId: bound.familyId,
        parentUserId: bound.userId,
        provider: textProvider,
        integrationId,
        now: new Date(),
      },
      defaultConnectedNoticePorts(),
    );
    console.info(
      { familyId: bound.familyId, provider: textProvider, receipt: connectedNoticeLabel(receipt) },
      'connector connected from a text - the done page is up; this is what the receipt did',
    );
    return back('ok', 'text', textProvider);
  }

  return back(bound.provider);
}
