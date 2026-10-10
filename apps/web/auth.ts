import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { authConfig } from '~/auth.config';
import { presentChannelSigninToken } from '~/lib/auth/channel-signin';
import { authorizeClaimByPhone } from '~/lib/auth/claim-phone-authorize';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { db } from '~/lib/db';

// Full Auth.js v5 config for the Node API route (app/api/auth/[...nextauth]).
// Spreads the Edge-safe base (auth.config.ts — Google + identity callbacks) and
// adds the phone Credentials providers, whose authorize pulls in Node-only deps
// (node:crypto, the Postgres client). The Edge middleware uses auth.config.ts
// directly, so those deps never reach the Edge bundle.
//
// Google's external id is the OAuth `sub`. Phone sign-in returns the
// external_auth_id the account already has (`sms:<blind index>`). Both land in
// users.external_auth_id, so the family-linking seam (lib/family.ts) is
// provider-agnostic. Email/password and magic-link providers are gone.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    ...authConfig.providers,
    Credentials({
      // The phone door: a family that arrived by TEXT proving it holds the number
      // its account is already keyed to. This provider does NOT mint or
      // find-or-create an identity — the account exists, and authorize returns the
      // external_auth_id it already has, so signing in by phone can never fork a
      // second account off the same family.
      id: 'claim-phone',
      credentials: {
        phone: { label: 'Phone', type: 'tel' },
        code: { label: 'Code', type: 'text' },
      },
      // The whole check (per-IP throttle, OTP verify, both gates) lives in the
      // wrapper so this chokepoint is testable without standing up NextAuth.
      authorize: (raw) => authorizeClaimByPhone(raw),
    }),
    Credentials({
      // The phone door's LINK shape (the connector handoff): a single-use, 15-minute
      // token Hale texted into a verified parent's own thread. Like claim-phone,
      // authorize can create nothing: it resolves the external_auth_id the account
      // already has, so redeeming a link can never fork a second account off the
      // same family.
      id: 'channel-link',
      credentials: { token: { label: 'Token', type: 'text' } },
      // The chokepoint for EVERY channel-link sign-in — the /connect redeem action AND
      // a direct POST to /api/auth/callback/channel-link — so the per-IP rate limit
      // lives here to throttle token guessing on both paths. Null on ANY failure
      // (limited, malformed, unknown / expired / already consumed) so Auth.js surfaces
      // one generic CredentialsSignin (rule #1: never which gate closed).
      //
      // This does NOT burn the token. Google consent success does, so closing the
      // Google screen leaves the same link usable until it expires.
      async authorize(raw) {
        const token = typeof raw?.token === 'string' ? raw.token : '';
        if (!token) {
          return null;
        }
        if (await authRateLimited()) {
          return null;
        }
        const result = await presentChannelSigninToken(token, db());
        if (!result.ok) {
          // The label only — the token never reaches a log line (rule #1).
          console.info({ reason: result.reason }, 'channel-link: sign-in refused');
          return null;
        }
        return { id: result.identity.id, email: result.identity.email };
      },
    }),
  ],
});
