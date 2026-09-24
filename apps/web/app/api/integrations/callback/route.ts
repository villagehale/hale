import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '~/auth';
import {
  connectedNoticeLabel,
  defaultConnectedNoticePorts,
  sendConnectorConnectedText,
} from '~/lib/channel/connect/connected-notice';
import { asTextConnectProvider } from '~/lib/channel/connect/text-connect';
import { holdGoogleGivenName } from '~/lib/channel/identity/parent-call-name';
import { sendCoparentGroupCalendarReceipt } from '~/lib/channel/linq/group-coparent';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import { googleAccountBlindIndex } from '~/lib/crypto/blind-index';
import { db } from '~/lib/db';
import { resolveUserIdForUser } from '~/lib/family';
import { type ConnectState, verifyConnectState } from '~/lib/integrations/connect-state';
import {
  CONNECTOR_SCOPES,
  GOOGLE_PROFILE_SCOPE,
  connectorRedirectUri,
  exchangeCodeForTokens,
} from '~/lib/integrations/google-oauth';
import { readGoogleAccountSub, readGoogleGivenName } from '~/lib/integrations/google-profile';
import { otherParentHoldsGoogleAccount, saveConnection } from '~/lib/integrations/store';

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
  // The same one host the consent was minted against (google-oauth connectorRedirectUri),
  // never the request's origin: Google returns to the registered redirect_uri, so the
  // only host that can legitimately be here is this one, and reading it from the request
  // would only let a proxy or an alias decide where the parent lands next.
  const origin = appBaseUrl();
  // Before the state is verified we can't know the surface — web is the safe
  // default (an unverifiable state never reached another flow anyway).
  const back = (
    status: string,
    surface?: ConnectState['surface'],
    provider?: string,
    extra?: { who?: string; lang?: string },
  ) => {
    if (surface === 'text') {
      const query = new URLSearchParams({ provider: provider ?? '', status });
      if (extra?.who) query.set('who', extra.who);
      if (extra?.lang) query.set('lang', extra.lang);
      return NextResponse.redirect(`${origin}/connected?${query.toString()}`);
    }
    if (surface === 'mobile') {
      return NextResponse.redirect(`${origin}/connected?status=${status}`);
    }
    return NextResponse.redirect(`${origin}/settings?connect=${status}`);
  };

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // Google echoes the state even on a denial, so a denial that CAN be read still
  // answers on the surface its consent started from. One that cannot is the web dead
  // end, and keeps the word it has always had.
  const declined = Boolean(url.searchParams.get('error')) || !code;
  if (!state) return back('denied');

  let bound: ReturnType<typeof verifyConnectState>;
  try {
    bound = verifyConnectState(state);
  } catch {
    return back(declined ? 'denied' : 'invalid');
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

  if (declined) return back('denied', surface, bound.provider);

  const database = db();
  const session = await auth();
  const externalAuthId = session?.user?.id;
  const sessionUserId = externalAuthId
    ? await resolveUserIdForUser(externalAuthId, database)
    : null;
  if (!sessionUserId || sessionUserId !== bound.userId) {
    return back('invalid', surface, bound.provider);
  }

  let connectId: string;
  try {
    const tokens = await exchangeCodeForTokens({
      code,
      redirectUri: connectorRedirectUri(),
    });
    // Granular consent lets the user deselect the scope, and a provider bug could
    // broaden it: the grant must contain EXACTLY what this connector needs and
    // nothing outside the readonly universe — otherwise store nothing (a stored
    // 'active' connection whose token 403s would error-flap forever; a broader
    // one would silently hold power we never asked the parent to consent to).
    const scopes = (tokens.scope ?? '').split(' ').filter(Boolean);
    const expected = CONNECTOR_SCOPES[bound.provider];
    // Profile is optional. Calendar-only (or mail-only, files-only) still connects.
    // Anything outside the connector scopes plus that one profile scope is broader
    // than what we asked, and is stored nowhere.
    const allowed = new Set<string>([
      ...Object.values(CONNECTOR_SCOPES).flat(),
      GOOGLE_PROFILE_SCOPE,
    ]);
    const grantedOk =
      expected.every((sc) => scopes.includes(sc)) && scopes.every((sc) => allowed.has(sc));
    if (!grantedOk) {
      return back('denied', surface, bound.provider);
    }
    let providerMetadata: Record<string, unknown> | undefined;
    if (scopes.includes(GOOGLE_PROFILE_SCOPE) && tokens.accessToken) {
      const sub = await readGoogleAccountSub(tokens.accessToken);
      if (!sub) {
        console.info({ familyId: bound.familyId }, 'google account: identity unread');
      } else {
        const accountKey = googleAccountBlindIndex(sub);
        const held = await otherParentHoldsGoogleAccount(database, {
          familyId: bound.familyId,
          userId: bound.userId,
          accountKey,
        });
        if (held) {
          console.info(
            { familyId: bound.familyId, provider: bound.provider },
            'google account: held by the other parent',
          );
          // Nothing is stored. The page tells them the co-parent opens the link.
          let who = '';
          let lang = 'en';
          try {
            const [named] = await database
              .select({ name: schema.users.name })
              .from(schema.users)
              .where(eq(schema.users.id, bound.userId))
              .limit(1);
            const [home] = await database
              .select({ primaryLanguage: schema.families.primaryLanguage })
              .from(schema.families)
              .where(eq(schema.families.id, bound.familyId))
              .limit(1);
            who = named?.name?.trim() ?? '';
            if (home?.primaryLanguage?.toLowerCase().startsWith('fr')) lang = 'fr';
          } catch (err) {
            console.info(
              { familyId: bound.familyId, code: err instanceof Error ? err.name : 'unknown' },
              'google account: own-link name unread',
            );
          }
          return back('own_link', surface, bound.provider, who ? { who, lang } : undefined);
        }
        providerMetadata = { googleAccountKey: accountKey };
      }
    }
    ({ connectId } = await saveConnection(database, {
      familyId: bound.familyId,
      userId: bound.userId,
      provider: bound.provider,
      scopes,
      tokens,
      providerMetadata,
    }));
    await rememberGoogleGivenName(database, {
      familyId: bound.familyId,
      userId: bound.userId,
      scopes,
      accessToken: tokens.accessToken,
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
        connectId,
        now: new Date(),
      },
      defaultConnectedNoticePorts(),
    );
    console.info(
      { familyId: bound.familyId, provider: textProvider, receipt: connectedNoticeLabel(receipt) },
      'connector connected from a text - the done page is up; this is what the receipt did',
    );
    try {
      const groupReceipt = await sendCoparentGroupCalendarReceipt(database, {
        familyId: bound.familyId,
        userId: bound.userId,
        provider: textProvider,
        connectId,
        now: new Date(),
      });
      console.info(
        { familyId: bound.familyId, provider: textProvider, groupReceipt },
        'connector connected: group calendar receipt',
      );
    } catch (err) {
      console.warn(
        { familyId: bound.familyId, err: err instanceof Error ? err.name : 'unknown' },
        'connector connected: group calendar receipt failed',
      );
    }
    return back('ok', 'text', textProvider);
  }

  return back(bound.provider);
}

/**
 * Hold a Google given name when the parent actually granted profile, and name
 * every way that does not happen. Never throws: the connection is already stored,
 * and a profile miss must not turn a successful connect into `connect=error`.
 */
async function rememberGoogleGivenName(
  database: Database,
  input: { familyId: string; userId: string; scopes: string[]; accessToken: string },
): Promise<void> {
  if (!input.scopes.includes(GOOGLE_PROFILE_SCOPE)) {
    console.info({ familyId: input.familyId }, 'google profile: not granted');
    return;
  }
  if (!input.accessToken) {
    console.info({ familyId: input.familyId }, 'google profile: no access token');
    return;
  }
  try {
    const given = await readGoogleGivenName(input.accessToken);
    if (!given) {
      console.info({ familyId: input.familyId }, 'google profile: no usable given name');
      return;
    }
    const held = await holdGoogleGivenName(database, {
      familyId: input.familyId,
      userId: input.userId,
      givenName: given,
    });
    console.info({ familyId: input.familyId, held }, 'google profile: given name hold');
  } catch (err) {
    console.error(
      { familyId: input.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'google profile: hold failed',
    );
  }
}
