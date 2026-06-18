import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';

// Auth.js v5 root config. Google is the only provider (tripfix pattern: Google is
// the primary CTA). JWT session strategy — we provision into our own
// users/families tables (see lib/family.ts), so no DB adapter is needed.
//
// The identity Hale keys off is the Google account id (the OAuth `sub`), exposed
// on the JWT as `token.sub` and mirrored to `session.user.id`. That value lands in
// users.external_auth_id — the same column that previously held the Clerk id, so
// the provisioning seam is unchanged (no schema migration).
//
// Client id/secret come from GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.
// AUTH_SECRET signs the session JWT. trustHost is required behind the Vercel/proxy
// edge so the callback URL host is honored.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    }),
  ],
  session: { strategy: 'jwt' },
  trustHost: true,
  callbacks: {
    jwt({ token, account }) {
      // On sign-in, account.providerAccountId is the Google `sub` — the stable
      // external account id. Pin it as the JWT subject so session.user.id is the
      // Google sub, not a derived value.
      if (account) {
        token.sub = account.providerAccountId;
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
});
