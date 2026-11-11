import { haleTextsHref } from '~/lib/channel/connect/hale-texts-href';

/** Static web UI copy for /l/<code>. Model-written SMS is a different surface. */
export const LOGIN_PAGE_COPY = {
  goneTitle: "this link isn't here anymore",
  goneBody: 'Ask Hale for a fresh one.',
  vaultEyebrow: 'Hale',
  vaultHeading: 'city login',
  username: 'Username',
  password: 'Password',
  totp: 'Authenticator setup (optional)',
  save: 'Save',
  notNow: 'Not now',
  altLogin: 'or log in on the city site',
  lockLine: 'Hale encrypts this. It is only used to sign in for this registration.',
  savedHeading: 'saved',
  savedLine: (host: string) => `Hale can sign in to ${host} now`,
  backToHale: 'back to Hale',
} as const;

export function backToHaleHref(): string | null {
  return haleTextsHref();
}
