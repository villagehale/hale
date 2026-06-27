import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

// Edge-safe Auth.js base config. The middleware runs on the Edge runtime, where
// the credential password check's Node-only deps (argon2, node:crypto, the
// Postgres client) can't load — so the Credentials provider and its authorize live
// ONLY in auth.ts (the Node API route), which spreads this base. This file must
// stay free of any Node-only import so the Edge middleware bundle compiles.
//
// The identity callbacks live here (not just in auth.ts) so the JWT the middleware
// reads carries the same `sub` → session.user.id mapping for both providers.
export const authConfig = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    }),
  ],
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: { signIn: '/sign-in' },
  callbacks: {
    jwt({ token, account, user }) {
      // Pin the stable external account id as the JWT subject so session.user.id
      // is that id. Google's is the OAuth `sub` (account.providerAccountId); the
      // Credentials authorize (auth.ts) returns `credentials:<id>` as user.id.
      if (account?.provider === 'google') {
        token.sub = account.providerAccountId;
      } else if (account?.provider === 'credentials' && user?.id) {
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
