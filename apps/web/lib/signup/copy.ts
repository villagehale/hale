/**
 * Parent-facing strings for an authorized signup (VIL-375).
 *
 * The completed line, each stop reason, and the assisted handoff are Sloane's
 * locked English from the design comment on PR #720. They are copied as written.
 *
 * The sentence that offers to book is not locked. It is not defined here.
 *
 * A stop line names fields already filled. It does not include a child name,
 * an email, or a phone number.
 */

export const AUTHORIZED_SIGNUP_TEMPLATE_KEY = 'authorized_signup';

/** Locked. `session` is the session label. */
export function signupCompletedLine(session: string): string {
  return `You're signed up for ${session}.`;
}

const COULD_NOT_GET_THROUGH = `I couldn't get through on my end.`;

/** Locked reason lines. An unknown reason uses the fallback she named. */
const REASON_LINES: Record<string, string> = {
  not_authorized: 'I need your okay on that one first.',
  no_offer: `I don't have a signup to finish for that yet.`,
  ambiguous_session: `I can't tell which session you mean. Which one?`,
  session_full: 'That session is full.',
  session_not_offered: `I couldn't find that session.`,
  price_not_approved: 'The price is more than you said yes to.',
  price_change: 'The price changed, so I stopped.',
  payment: `It's asking for payment, so that part is yours.`,
  captcha: `It wants a "not a robot" check, so that one's yours.`,
  login_wall: 'It wants you to log in, so I stopped.',
  waiver: `There's a waiver to read and sign, so that part's yours.`,
  medical: `It asks about health or allergies, so that's yours to answer.`,
  allergy: `It asks about health or allergies, so that's yours to answer.`,
  waiting_room: `It has a waiting room, so you'll need to be in it yourself.`,
  resident_verification: `It needs to verify you live there, so that's yours.`,
  timed_open: `Registration isn't open yet.`,
  unexpected_field: `The form asks something I wasn't expecting, so I stopped.`,
  missing_detail: `I'm missing a detail it asks for.`,
  teen_privacy: `It asks for a teen's details, so it's yours to fill in.`,
  unconfirmed: `I didn't see a confirmation page, so don't count on it yet.`,
  connector_failed: COULD_NOT_GET_THROUGH,
  browser_unavailable: COULD_NOT_GET_THROUGH,
  url_refused: COULD_NOT_GET_THROUGH,
  redirect: COULD_NOT_GET_THROUGH,
};

const UNKNOWN_REASON = 'I stopped before finishing.';

/**
 * One message: the reason line, then the page sentence when `link` is set,
 * then the filled-in sentence when `prefilled` is non-empty.
 */
export function signupHandbackLine(input: {
  reason: string;
  link: string;
  prefilled: readonly string[];
}): string {
  const parts = [REASON_LINES[input.reason] ?? UNKNOWN_REASON];
  if (input.link.length > 0) parts.push(`Here's the page: ${input.link}`);
  if (input.prefilled.length > 0) parts.push(`I filled in ${englishList(input.prefilled)}.`);
  return parts.join(' ');
}

function englishList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  const rest = items.slice(0, -1).join(', ');
  return `${rest}, and ${items[items.length - 1]}`;
}

/**
 * Two lines. The second line is omitted when `pack` is empty.
 * Facts are comma-joined as `slot: value`.
 */
export function signupAssistedHandoffLine(input: {
  link: string;
  sessionLabel: string;
  pack: readonly { slot: string; value: string }[];
}): string {
  const page = `This one has to be done by you. Here's the page: ${input.link}`;
  if (input.pack.length === 0) return page;
  const facts = input.pack.map((item) => `${item.slot}: ${item.value}`).join(', ');
  return `${page}\nFor ${input.sessionLabel}, you'll want ${facts}.`;
}
