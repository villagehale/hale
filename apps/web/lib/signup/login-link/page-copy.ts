import { haleTextsHref } from '~/lib/channel/connect/hale-texts-href';
import type { LoginLinkPurpose } from './store';

/**
 * Static web UI copy for /l/<code>. Model-written SMS is a different surface.
 * The lock line says what is true: Hale decrypts the login on its own servers to sign
 * in for the parent, so it never claims the login stays on the device.
 */
export const LOGIN_PAGE_COPY = {
  goneTitle: "this link isn't here anymore",
  goneBody: 'Ask Hale for a fresh one.',
  heading: (host: string) => `Hale needs your login for ${host}`,
  opens: (local: string) => `opens ${local}`,
  username: 'Username',
  password: 'Password',
  totp: 'Authenticator setup (optional)',
  totpError: "That key didn't work. Check it, or leave it blank.",
  formError: 'Check the username and password.',
  retryError: "Couldn't save. Try again.",
  save: 'Save',
  notNow: 'Not now',
  lockLine: (host: string, retentionDays: number) =>
    `Encrypted and stored by Hale. Used only to sign in to ${host} for you. Deleted after ${retentionDays} days unless a registration there is still open.`,
  savedHeading: 'saved',
  savedLine: (host: string) => `Hale can sign in to ${host} now`,
  backToHale: 'back to Hale',
} as const;

/** The line under the heading and in the card preview: the session and the open. */
export function loginPurposeLine(purpose: LoginLinkPurpose | null): string | null {
  if (!purpose) return null;
  const opens = LOGIN_PAGE_COPY.opens(purpose.opensAt.local);
  return purpose.sessionLabel ? `${purpose.sessionLabel} · ${opens}` : opens;
}

export function backToHaleHref(): string | null {
  return haleTextsHref();
}
