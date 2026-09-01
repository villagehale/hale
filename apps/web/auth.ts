import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { authConfig } from '~/auth.config';
import { authorizeClaimByPhone } from '~/lib/auth/claim-phone-authorize';
import { consumeChannelSigninToken } from '~/lib/auth/channel-signin';
import { authenticateCredential } from '~/lib/auth/credentials';
import { consumeMagicLinkToken } from '~/lib/auth/magic-link';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { requireEmailVerification } from '~/lib/auth-config';
import { db } from '~/lib/db';

// Full Auth.js v5 config for the Node API route (app/api/auth/[...nextauth]).
// Spreads the Edge-safe base (auth.config.ts — Google + identity callbacks) and
// adds the Credentials provider, whose authorize pulls in Node-only deps (argon2,
// node:crypto, the Postgres client). The Edge middleware uses auth.config.ts
// directly, so those deps never reach the Edge bundle.
//
// Two providers share one identity model: a Google login's external id is the
// OAuth `sub`; a credentials login's is `credentials:<credential id>`. Both land
// in users.external_auth_id, so the downstream family-linking seam (lib/family.ts)
// is provider-agnostic.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    ...authConfig.providers,
    Credentials({
      // The fields are validated again in authorize; these just shape the default
      // form Auth.js would render (we render our own at /sign-in and /sign-up).
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      // Returns the session identity on success, null on ANY failure. authorize is
      // the only place a password is checked; it never reveals which field was
      // wrong (one null for no-such-email / wrong-password / unverified). This is
      // the chokepoint for EVERY credentials sign-in — the /sign-in action AND a
      // direct POST to /api/auth/callback/credentials — so the per-IP rate limit
      // lives here (not just in the action) to throttle brute-force on both paths.
      async authorize(raw) {
        const email = typeof raw?.email === 'string' ? raw.email : '';
        const password = typeof raw?.password === 'string' ? raw.password : '';
        if (!email || !password) {
          return null;
        }
        if (await authRateLimited()) {
          return null;
        }
        const identity = await authenticateCredential(email, password, db(), {
          requireVerified: requireEmailVerification(),
        });
        if (!identity) {
          return null;
        }
        return { id: identity.id, email: identity.email };
      },
    }),
    Credentials({
      // Passwordless magic-link sign-in — same identity model as the password
      // provider (`credentials:<id>`), so an existing email+password account is
      // reached by its link, and a first-time link find-or-creates the credential.
      id: 'magic-link',
      credentials: { token: { label: 'Token', type: 'text' } },
      // The chokepoint for EVERY magic-link sign-in — the /magic-link redeem action
      // AND a direct POST to /api/auth/callback/magic-link — so the per-IP rate
      // limit lives here (not only in the action) to throttle token guessing on
      // both paths. Returns null on ANY failure (limited, malformed, or a token
      // that is unknown / expired / already consumed) so Auth.js surfaces the same
      // CredentialsSignin the page maps to one generic "invalid or expired" error.
      async authorize(raw) {
        const token = typeof raw?.token === 'string' ? raw.token : '';
        if (!token) {
          return null;
        }
        if (await authRateLimited()) {
          return null;
        }
        const result = await consumeMagicLinkToken(token, db());
        if (!result.ok) {
          return null;
        }
        return { id: result.identity.id, email: result.identity.email };
      },
    }),
    Credentials({
      // The phone door (F14): a family that arrived by TEXT proving it holds the number
      // its account is already keyed to. Unlike the two providers above, this one does
      // NOT mint or find-or-create an identity — the account exists, and authorize
      // returns the external_auth_id it already has, so signing in by phone can never
      // fork a second account off the same family.
      id: 'claim-phone',
      credentials: {
        phone: { label: 'Phone', type: 'tel' },
        code: { label: 'Code', type: 'text' },
      },
      // The whole check (flag, per-IP throttle, OTP verify, both gates) lives in the
      // wrapper so this chokepoint is testable without standing up NextAuth.
      authorize: (raw) => authorizeClaimByPhone(raw),
    }),
    Credentials({
      // The phone door's LINK shape (the connector handoff): a single-use, 15-minute
      // token Hale texted into a verified parent's own thread. Like claim-phone — and
      // unlike the two email providers above — authorize can create nothing: it
      // resolves the external_auth_id the account already has, so redeeming a link can
      // never fork a second account off the same family.
      id: 'channel-link',
      credentials: { token: { label: 'Token', type: 'text' } },
      // The chokepoint for EVERY channel-link sign-in — the /connect redeem action AND
      // a direct POST to /api/auth/callback/channel-link — so the per-IP rate limit
      // lives here to throttle token guessing on both paths. Null on ANY failure
      // (limited, malformed, unknown / expired / already consumed) so Auth.js surfaces
      // one generic CredentialsSignin (rule #1: never which gate closed).
      async authorize(raw) {
        const token = typeof raw?.token === 'string' ? raw.token : '';
        if (!token) {
          return null;
        }
        if (await authRateLimited()) {
          return null;
        }
        const result = await consumeChannelSigninToken(token, db());
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
