import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { authConfig } from '~/auth.config';
import { authenticateCredential } from '~/lib/auth/credentials';
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
  ],
});
