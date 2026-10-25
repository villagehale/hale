import type { SignupOutcomeWriter } from './outcome-reply';

/**
 * The assisted handoff: a sign-up the parent has to do themselves. The reply
 * model writes it from the facts (the page, the session, and the prepared
 * pack). There is no fixed sentence; when the model writes nothing, nothing
 * is sent.
 */
export async function assistedHandoffReply(
  writer: SignupOutcomeWriter,
  input: {
    link: string;
    sessionLabel: string;
    pack: readonly { slot: string; value: string }[];
  },
): Promise<string | null> {
  return writer.write({
    outcome: 'assisted_handoff',
    reason: 'assisted_handoff',
    confirmed: false,
    sessionLabel: collapseSignupFact(input.sessionLabel) || null,
    link: input.link,
    prefilled: [],
    pack: input.pack.map((item) => ({ slot: item.slot, value: collapseSignupFact(item.value) })),
    rush: null,
    question: null,
    language: null,
  });
}

/** Collapse whitespace in a fact before it reaches the reply model. */
export function collapseSignupFact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
