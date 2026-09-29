/**
 * Parent-facing strings for authorized signup (VIL-375).
 *
 * TODO-Design — Sloane locks every string in this file. Do not replace a
 * placeholder with an invented sentence.
 *
 * Stop lines interpolate a reason code, the registration link, and the field
 * names already filled. They do not include child names, emails, or phone
 * numbers.
 *
 * The assisted-handoff line is the exception the parent needs in order to
 * finish the click themselves: the deep link, the session label, and the
 * minimum info pack (slot=value). The words around those facts are still a
 * placeholder.
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

/**
 * TODO-Design (Sloane): provider is not on the form-fill allowlist.
 * `{link}` `{session}` `{pack}` — pack values are the parent's own details.
 */
export function signupAssistedHandoffLine(input: {
  link: string;
  sessionLabel: string;
  pack: readonly { slot: string; value: string }[];
}): string {
  const session = input.sessionLabel.replace(/\s+/g, ' ').trim();
  const facts =
    input.pack.length > 0
      ? input.pack
          .map((item) => `${item.slot}=${item.value.replace(/\s+/g, ' ').trim()}`)
          .join('; ')
      : 'none';
  return `TODO-Design: assisted handoff link=${input.link} session=${session} pack=${facts}`;
}
