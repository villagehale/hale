/**
 * VIL-718 · the steps one takeover link covers: the parent signs in on the provider's own
 * page (`sign_in`), types a one-time code the site sent them by text or email (`code`), signs
 * in another way where the site wants a passkey their phone holds (`passkey`), or answers a
 * "prove you are human" check (`captcha`). Hale never does any of them: the parent does, in
 * Hale's own browser, through the link.
 */
export const TAKEOVER_PURPOSES = ['sign_in', 'code', 'passkey', 'captcha'] as const;

export type TakeoverPurpose = (typeof TAKEOVER_PURPOSES)[number];

/**
 * The link closes this long before the browser does, so a parent who taps done at the last
 * moment still leaves the minute sweep time to pick the same session back up.
 */
export const TAKEOVER_RESUME_MARGIN_MS = 2 * 60_000;

/** A takeover with less time than this left is not offered: the run ends as it does today. */
export const TAKEOVER_MIN_WINDOW_MS = 3 * 60_000;

/**
 * Takeovers one plan may ask for, counting each new step after a done. A run that stops on
 * the very step the parent just said they finished is not asked again at all.
 */
export const TAKEOVER_MAX_ROUNDS = 3;

export function isTakeoverPurpose(value: unknown): value is TakeoverPurpose {
  return typeof value === 'string' && (TAKEOVER_PURPOSES as readonly string[]).includes(value);
}

/**
 * What only the parent can do, read from where the run stopped. Null when the stop is not a
 * takeover: a checkout or filled-form hand-off, a waiver or medical form, a rejected account
 * password (that keeps its own saved-login card), or anything else.
 */
export function takeoverPurpose(outcome: string, detail: string): TakeoverPurpose | null {
  if (outcome !== 'needs_login' && outcome !== 'needs_human') return null;
  switch (detail) {
    case 'captcha':
      return 'captcha';
    case 'passkey':
      return 'passkey';
    case 'verification_code':
      return 'code';
    case 'login_wall':
      return 'sign_in';
    case 'none':
      return outcome === 'needs_login' ? 'sign_in' : null;
    default:
      return null;
  }
}
