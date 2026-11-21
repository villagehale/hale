import { LOGIN_CODE_TTL_MS } from '../login-link/code';
import { TAKEOVER_MIN_WINDOW_MS, TAKEOVER_RESUME_MARGIN_MS } from './purpose';

/**
 * How long the link stays open: never past the card's own lifetime, and never closer to the
 * browser's end than {@link TAKEOVER_RESUME_MARGIN_MS}. Null when that leaves less than
 * {@link TAKEOVER_MIN_WINDOW_MS}: too little time to be worth a text.
 */
export function takeoverWindow(input: {
  now: Date;
  browserEndsAt: Date;
}): { expiresAt: Date; minutes: number } | null {
  const cardEnds = input.now.getTime() + LOGIN_CODE_TTL_MS;
  const browserEnds = input.browserEndsAt.getTime() - TAKEOVER_RESUME_MARGIN_MS;
  const expiresAt = Math.min(cardEnds, browserEnds);
  const left = expiresAt - input.now.getTime();
  if (left < TAKEOVER_MIN_WINDOW_MS) return null;
  return { expiresAt: new Date(expiresAt), minutes: Math.floor(left / 60_000) };
}
