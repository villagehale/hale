import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      // The Google account id (OAuth `sub`), mirrored into users.external_auth_id.
      id: string;
    } & DefaultSession['user'];
  }
}
