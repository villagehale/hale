/**
 * sms: link for "Back to your texts". Hale's number is already in config
 * (LINQ_FROM_E164). An unset or malformed value is not a link: the button is
 * omitted rather than rendered as a dead control.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

export function haleTextsHref(from = process.env.LINQ_FROM_E164): string | null {
  const value = from?.trim() ?? '';
  if (!E164.test(value)) return null;
  return `sms:${value}`;
}

/** The E.164 behind {@link haleTextsHref}, or '' when the line is not live. */
export function haleTextsNumber(from = process.env.LINQ_FROM_E164): string {
  const href = haleTextsHref(from);
  return href ? href.slice('sms:'.length) : '';
}
