/**
 * Parent-facing strings for authorized signup (VIL-375).
 *
 * TODO-Design — Sloane locks every string in this file. Do not replace a
 * placeholder with an invented sentence. Hand-back lines interpolate only
 * facts the parent needs in order to finish: a reason code, the registration
 * link, and the field names already filled. They do not include child names,
 * emails, or phone numbers.
 */

export const AUTHORIZED_SIGNUP_TEMPLATE_KEY = 'authorized_signup';

/** TODO-Design (Sloane): registration completed for the authorized session. */
export const SIGNUP_COMPLETED_LINE = 'TODO-Design: authorized signup completed';

/** TODO-Design (Sloane): stopped before submit. `{reason}` `{link}` `{prefilled}`. */
export function signupHandbackLine(input: {
  reason: string;
  link: string;
  prefilled: readonly string[];
}): string {
  const fields = input.prefilled.length > 0 ? input.prefilled.join(',') : 'none';
  const link = input.link.length > 0 ? ` link=${input.link}` : '';
  return `TODO-Design: reason=${input.reason}${link} prefilled=${fields}`;
}
