import { haleTextsHref } from '~/lib/channel/connect/hale-texts-href';
import type { LoginLinkPurpose } from './store';

/**
 * Static web UI copy for /l/<code>. Model-written SMS is a different surface, and so is the
 * card's preview in the thread: its words come from the notice writer (page.tsx).
 * The lock line says what is true: Hale decrypts the login on its own servers to sign
 * in for the parent, so it never claims the login stays on the device.
 */
export const LOGIN_PAGE_COPY = {
  goneTitle: "this link isn't here anymore",
  goneBody: 'Ask Hale for a fresh one.',
  heading: (host: string) => `Hale needs your login for ${host}`,
  opens: (local: string) => `opens ${local}`,
  finishing: (session: string | null) =>
    session ? `to finish signing up for ${session}` : 'to finish signing up',
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

/** The line under the page heading: the session and the open. Page chrome, never the preview. */
export function loginPurposeLine(purpose: LoginLinkPurpose | null): string | null {
  if (!purpose) return null;
  if (!purpose.opensAt) return LOGIN_PAGE_COPY.finishing(purpose.sessionLabel);
  const opens = LOGIN_PAGE_COPY.opens(purpose.opensAt.local);
  return purpose.sessionLabel ? `${purpose.sessionLabel} · ${opens}` : opens;
}

export function backToHaleHref(): string | null {
  return haleTextsHref();
}
