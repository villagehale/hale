/**
 * Parent-facing strings for an authorized signup (VIL-375).
 *
 * The completed and stopped replies are not here: the reply model writes them
 * from the structured outcome (`outcome-reply.ts`, VIL-453). Only the assisted
 * handoff line remains.
 */

export const AUTHORIZED_SIGNUP_TEMPLATE_KEY = 'authorized_signup';

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
