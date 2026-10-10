import type { NextAuthConfig } from 'next-auth';

// Edge-safe Auth.js base config. The middleware runs on the Edge runtime, where
// the phone providers' Node-only deps (node:crypto, the Postgres client) can't
// load — so those Credentials providers and their authorize live ONLY in auth.ts
// (the Node API route), which spreads this base. This file must stay free of any
// Node-only import so the Edge middleware bundle compiles.
//
// The identity callbacks live here (not just in auth.ts) so the JWT the middleware
// reads carries the same `sub` → session.user.id mapping for every provider.
// There is no Google sign-in provider. Gmail and Calendar connect through
// lib/integrations/google-oauth.ts, a separate OAuth client flow.
export const authConfig = {
  providers: [],
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: { signIn: '/sign-in' },
  callbacks: {
    jwt({ token, account, user }) {
      // Pin the stable external account id as the JWT subject so session.user.id
      // is that id. `claim-phone` and `channel-link` (the texted connect link)
      // both return the external_auth_id the account ALREADY holds —
      // `sms:<blind index>` for a text-onboarded family — which is what makes
      // signing in by phone land in that family rather than forking a new one.
      // Enumerated rather than left to Auth.js's default so the subject a
      // provider resolves to is a decision this file states, not one it inherits.
      if (
        (account?.provider === 'claim-phone' || account?.provider === 'channel-link') &&
        user?.id
      ) {
        token.sub = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
